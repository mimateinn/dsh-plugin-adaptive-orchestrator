import { describe, expect, it } from "vitest";
import {
  MemoryStateStore,
  createScheduler,
  deterministicBackoff,
  aggregateCapacity,
  scaleSafeSlots,
  desiredWorkerCount,
  type SchedulerState,
  type QueueRecord,
  type Lease,
  type DispatchFence,
} from "../../../src/scheduler/index.js";

const route = (
  id: string,
  provider = "p",
  account = "a",
  model = id,
  safeSlots = 4,
) => ({ id, provider, account, model, safeSlots });
const settleProvider = (
  scheduler: ReturnType<typeof createScheduler>,
  leaseId: string,
  attemptId: string,
  outcome: "succeeded" | "failed" | "cancelled",
) => {
  const token = scheduler.observeProviderTerminal(leaseId, attemptId, outcome);
  return token !== false && scheduler.settleProviderTerminal(token);
};
const req = (
  requestId: string,
  lane: "interactive" | "background",
  routeId = "r",
  attemptId = requestId,
) => ({
  requestId,
  attemptId,
  lane,
  routeId,
  payloadHash: "h-" + requestId,
  createdAt: 0,
  settingsRevision: 1,
  modelRevision: 1,
  capabilityRevision: 1,
});

describe("durable adaptive scheduler", () => {
  it("aggregates intersecting caps without double counting", () =>
    expect(
      aggregateCapacity(
        [route("a"), route("b", "p", "a", "b"), route("c", "q", "c", "c")],
        { global: 5, provider: 3, account: 2, model: 4 },
      ),
    ).toBe(4));
  it("requires the latest eligible 20 error rate to be strictly below five percent", () => {
    const outcomes = Array.from({ length: 20 }, (_, i) => ({
      result: (i === 0 ? "provider-error" : "success") as
        "provider-error" | "success",
      latencyMs: 100,
      finishedAt: i,
    }));
    expect(
      scaleSafeSlots({ safeSlots: 1, lastIncreaseAt: 0, outcomes }, 60000),
    ).toBe(1);
    expect(
      scaleSafeSlots(
        {
          safeSlots: 1,
          lastIncreaseAt: 0,
          outcomes: outcomes.map((o) => ({ ...o, result: "success" as const })),
        },
        60000,
      ),
    ).toBe(2);
  });
  it("grows after exactly five ordered trailing successes", () => {
    expect(
      scaleSafeSlots(
        {
          safeSlots: 1,
          lastIncreaseAt: 0,
          outcomes: [4, 1, 5, 2, 3].map((finishedAt) => ({
            result: "success" as const,
            latencyMs: 100,
            finishedAt,
          })),
        },
        60000,
      ),
    ).toBe(2);
  });
  it("scales out one per minute and halves immediately", () => {
    expect(
      scaleSafeSlots(
        {
          safeSlots: 1,
          lastIncreaseAt: 0,
          outcomes: Array.from({ length: 20 }, (_, i) => ({
            result: "success" as const,
            latencyMs: 100,
            finishedAt: i,
          })),
        },
        60000,
      ),
    ).toBe(2);
    expect(
      scaleSafeSlots(
        {
          safeSlots: 4,
          lastIncreaseAt: 0,
          outcomes: [{ result: "rate-limited", latencyMs: 1, finishedAt: 1 }],
        },
        2,
      ),
    ).toBe(2);
  });
  it("samples deterministic bounded exponential full jitter", () => {
    expect(deterministicBackoff("r", 3, 7)).toBe(
      deterministicBackoff("r", 3, 7),
    );
    expect(deterministicBackoff("r", 99, 7)).toBeLessThanOrEqual(900000);
  });
  it("admits idempotent duplicates, conflicts, and bounded overflow", () => {
    const s = createScheduler(new MemoryStateStore(), { queueLimit: 1 });
    expect(s.enqueue(req("1", "interactive")).kind).toBe("admitted");
    expect(s.enqueue(req("1", "interactive")).kind).toBe("duplicate");
    expect(s.enqueue({ ...req("1", "interactive"), attemptId: "x" }).kind).toBe(
      "conflict",
    );
    expect(s.enqueue(req("2", "interactive")).kind).toBe("full");
  });
  it("uses persistent WDRR 2:1, lending, and starvation promotion", () => {
    const s = createScheduler(new MemoryStateStore(), {
      globalCap: 3,
      interactiveReserve: 1,
      backgroundReserve: 1,
    });
    s.enqueue(req("i1", "interactive"));
    s.enqueue(req("i2", "interactive"));
    s.enqueue(req("b1", "background"));
    const leases = s.tick([route("r")], 0);
    expect(leases.map((x) => x.requestId)).toEqual(["i1", "i2", "b1"]);
    for (const lease of leases) {
      expect(
        s.consumeFence(
          lease.fenceId,
          { settings: 1, model: 1, capability: 1 },
          1,
        ),
      ).toBe(true);
      expect(
        settleProvider(s, lease.leaseId, lease.attemptId, "succeeded"),
      ).toBe(true);
    }
    s.enqueue(req("b2", "background"));
    const promoted = s.tick([route("r")], 40000)[0]!;
    expect(promoted.requestId).toBe("b2");
    expect(
      s.consumeFence(
        promoted.fenceId,
        { settings: 1, model: 1, capability: 1 },
        40001,
      ),
    ).toBe(true);
    expect(
      settleProvider(s, promoted.leaseId, promoted.attemptId, "succeeded"),
    ).toBe(true);
  });
  it("CAS rejects stale revisions", () => {
    const st = new MemoryStateStore();
    const a = st.read();
    expect(st.compareAndSwap(a.revision, a.state)).toBe(true);
    expect(st.compareAndSwap(a.revision, a.state)).toBe(false);
  });
  it("creates and consumes single-use fences with revision checks", () => {
    const s = createScheduler(new MemoryStateStore());
    s.enqueue(req("1", "interactive"));
    const lease = s.tick([route("r")], 0)[0]!;
    expect(
      s.consumeFence(
        lease.fenceId,
        { settings: 1, model: 1, capability: 1 },
        1,
      ),
    ).toBe(true);
    expect(
      s.consumeFence(
        lease.fenceId,
        { settings: 1, model: 1, capability: 1 },
        2,
      ),
    ).toBe(false);
  });
  it("releases only the exact lease and exact current attempt", () => {
    const s = createScheduler(new MemoryStateStore());
    s.enqueue(
      req("request-collides-with-lease", "interactive", "r", "attempt-current"),
    );
    const l = s.tick([route("r")], 0)[0]!;
    expect(settleProvider(s, l.leaseId, l.attemptId, "succeeded")).toBe(false);
    expect(
      s.consumeFence(l.fenceId, { settings: 1, model: 1, capability: 1 }, 1),
    ).toBe(true);
    expect(settleProvider(s, l.requestId, l.attemptId, "succeeded")).toBe(
      false,
    );
    expect(settleProvider(s, l.leaseId, "attempt-stale", "succeeded")).toBe(
      false,
    );
    expect(settleProvider(s, l.leaseId, l.attemptId, "succeeded")).toBe(true);
    expect(settleProvider(s, l.leaseId, l.attemptId, "succeeded")).toBe(false);
  });
  it("cancels queued work and revokes armed fences", () => {
    const s = createScheduler(new MemoryStateStore());
    s.enqueue(req("1", "interactive"));
    expect(s.cancel("1")).toBe(true);
    expect(s.tick([route("r")], 0)).toEqual([]);
    s.enqueue(req("2", "interactive"));
    const l = s.tick([route("r")], 0)[0]!;
    s.cancel("2");
    expect(
      s.consumeFence(l.fenceId, { settings: 1, model: 1, capability: 1 }, 1),
    ).toBe(false);
  });
  it("restart revokes armed fences, orphans consumed leases, and reclaims after grace", () => {
    const store = new MemoryStateStore();
    let s = createScheduler(store);
    s.enqueue(req("1", "interactive"));
    const l = s.tick([route("r")], 0)[0]!;
    s.consumeFence(l.fenceId, { settings: 1, model: 1, capability: 1 }, 1);
    s = createScheduler(store);
    expect(s.recover(10).orphaned).toBe(1);
    expect(s.recover(40001).reclaimed).toBe(1);
  });
});

describe("adversarial scheduler specification", () => {
  it("never scans a record from the wrong lane", () => {
    const s = createScheduler(new MemoryStateStore(), { globalCap: 2 });
    s.enqueue({ ...req("b", "background"), deficitCost: 2 });
    s.enqueue(req("i", "interactive"));
    expect(s.tick([route("r")], 0).map((x) => x.requestId)).toEqual(["i"]);
  });
  it("enforces active lane reservations and lends an empty lane reservation", () => {
    const s = createScheduler(new MemoryStateStore(), {
      globalCap: 3,
      interactiveReserve: 1,
      backgroundReserve: 1,
    });
    for (const id of ["i1", "i2", "i3"]) s.enqueue(req(id, "interactive"));
    s.enqueue(req("b", "background"));
    expect(s.tick([route("r")], 0).map((x) => x.requestId)).toEqual([
      "i1",
      "i2",
      "b",
    ]);
    const only = createScheduler(new MemoryStateStore(), {
      globalCap: 3,
      interactiveReserve: 1,
      backgroundReserve: 1,
    });
    for (const id of ["i1", "i2", "i3"]) only.enqueue(req(id, "interactive"));
    expect(only.tick([route("r")], 0)).toHaveLength(3);
  });
  it("represents pressure slots and progressive desired worker growth", () => {
    expect(
      desiredWorkerCount({
        readyIndependentTasks: 20,
        globalHardCap: 8,
        aggregateSafeCapacity: 8,
        baseSlots: 1,
        maxEligibleBurnPressure: 0.5,
      }),
    ).toBe(4);
    expect(
      desiredWorkerCount({
        readyIndependentTasks: 20,
        globalHardCap: 8,
        aggregateSafeCapacity: 2,
        baseSlots: 1,
        maxEligibleBurnPressure: 1,
      }),
    ).toBe(2);
  });
  it("applies optional pressure demand to actual tick starts", () => {
    const low = createScheduler(new MemoryStateStore(), { globalCap: 8 });
    const high = createScheduler(new MemoryStateStore(), { globalCap: 8 });
    for (let i = 0; i < 8; i++) {
      low.enqueue(req(String(i), "interactive"));
      high.enqueue(req(String(i), "interactive"));
    }
    expect(
      low.tick([route("r", "p", "a", "m", 8)], 0, {
        baseSlots: 1,
        maxEligibleBurnPressure: 0,
      }),
    ).toHaveLength(1);
    expect(
      high.tick([route("r", "p", "a", "m", 8)], 0, {
        baseSlots: 1,
        maxEligibleBurnPressure: 0.5,
      }),
    ).toHaveLength(2);
  });
  it("counts active lease lanes when preserving reservations across ticks", () => {
    const s = createScheduler(new MemoryStateStore(), {
      globalCap: 3,
      interactiveReserve: 1,
      backgroundReserve: 1,
    });
    s.enqueue(req("b-active", "background"));
    const active = s.tick([route("r")], 0)[0]!;
    expect(active.lane).toBe("background");
    s.enqueue(req("i", "interactive"));
    s.enqueue(req("b", "background"));
    expect(
      s
        .tick([route("r")], 1, { maxEligibleBurnPressure: 1 })
        .map((x) => x.requestId),
    ).toEqual(["i", "b"]);
  });
  it("validates hard caps and lane reservations", () => {
    expect(() =>
      createScheduler(new MemoryStateStore(), { globalCap: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createScheduler(new MemoryStateStore(), { providerCap: 65 }),
    ).toThrow(/providerCap/);
    expect(() =>
      createScheduler(new MemoryStateStore(), {
        globalCap: 1,
        interactiveReserve: 1,
        backgroundReserve: 1,
      }),
    ).toThrow(/reservations/);
  });
  it("revokes and releases an unconsumed fence on revision mismatch", () => {
    const s = createScheduler(new MemoryStateStore());
    s.enqueue(req("mismatch", "interactive"));
    const lease = s.tick([route("r")], 0)[0]!;
    expect(
      s.consumeFence(
        lease.fenceId,
        { settings: 2, model: 1, capability: 1 },
        1,
      ),
    ).toBe(false);
    expect(settleProvider(s, lease.leaseId, lease.attemptId, "succeeded")).toBe(
      false,
    );
  });
  it("uses the exact SHA-256 seed bytes for deterministic full jitter", () => {
    expect(deterministicBackoff("r", 3, 7)).toBe(30625);
    expect(deterministicBackoff("r", 99, 7)).toBe(483013);
  });
  it("orders provider observation before later cancellation at settlement", () => {
    const store = new MemoryStateStore();
    const s = createScheduler(store);
    s.enqueue(req("observed-first", "interactive"));
    const lease = s.tick([route("r")], 0)[0]!;
    expect(
      s.consumeFence(
        lease.fenceId,
        { settings: 1, model: 1, capability: 1 },
        1,
      ),
    ).toBe(true);
    const token = s.observeProviderTerminal(
      lease.leaseId,
      lease.attemptId,
      "succeeded",
    );
    expect(token).toEqual(expect.any(String));
    if (token === false) throw new Error("provider observation rejected");
    expect(s.cancel(lease.requestId)).toBe(true);
    expect(s.settleProviderTerminal(token)).toBe(true);
    expect(
      store.read().state.leases.find((x) => x.leaseId === lease.leaseId)
        ?.terminalOutcome,
    ).toBe("succeeded");
  });
  it("orders cancellation before later provider observation at settlement", () => {
    const store = new MemoryStateStore();
    const s = createScheduler(store);
    s.enqueue(req("cancelled-first", "interactive"));
    const lease = s.tick([route("r")], 0)[0]!;
    expect(
      s.consumeFence(
        lease.fenceId,
        { settings: 1, model: 1, capability: 1 },
        1,
      ),
    ).toBe(true);
    expect(s.cancel(lease.requestId)).toBe(true);
    const token = s.observeProviderTerminal(
      lease.leaseId,
      lease.attemptId,
      "succeeded",
    );
    if (token === false) throw new Error("provider observation rejected");
    expect(s.settleProviderTerminal(token)).toBe(true);
    expect(
      store.read().state.leases.find((x) => x.leaseId === lease.leaseId)
        ?.terminalOutcome,
    ).toBe("cancelled");
  });
  it("rejects forged, stale, and duplicate provider observation tokens", () => {
    const s = createScheduler(new MemoryStateStore());
    s.enqueue(req("token", "interactive"));
    const lease = s.tick([route("r")], 0)[0]!;
    expect(
      s.observeProviderTerminal(lease.leaseId, lease.attemptId, "succeeded"),
    ).toBe(false);
    expect(
      s.consumeFence(
        lease.fenceId,
        { settings: 1, model: 1, capability: 1 },
        1,
      ),
    ).toBe(true);
    expect(s.observeProviderTerminal(lease.leaseId, "stale", "succeeded")).toBe(
      false,
    );
    const token = s.observeProviderTerminal(
      lease.leaseId,
      lease.attemptId,
      "succeeded",
    );
    expect(s.settleProviderTerminal("forged-token")).toBe(false);
    if (token === false) throw new Error("provider observation rejected");
    expect(s.settleProviderTerminal(token)).toBe(true);
    expect(s.settleProviderTerminal(token)).toBe(false);
  });
  it.each(["cancel", "pause", "remove", "missing"] as const)(
    "%s after consumption records cancellation and waits for provider terminal release",
    (reason) => {
      const store = new MemoryStateStore();
      const s = createScheduler(store);
      s.enqueue(req(reason, "interactive"));
      const l = s.tick([route("r")], 0)[0]!;
      expect(
        s.consumeFence(l.fenceId, { settings: 1, model: 1, capability: 1 }, 1),
      ).toBe(true);
      expect(s.cancel(reason, reason)).toBe(true);
      const pending = store
        .read()
        .state.leases.find((x) => x.leaseId === l.leaseId)!;
      expect(pending).toMatchObject({ state: "active", cancellation: reason });
      expect(settleProvider(s, l.leaseId, l.attemptId, "succeeded")).toBe(true);
      expect(
        store.read().state.leases.find((lease) => lease.leaseId === l.leaseId)
          ?.terminalOutcome,
      ).toBe("cancelled");
      expect(settleProvider(s, l.leaseId, l.attemptId, "succeeded")).toBe(
        false,
      );
    },
  );
  it("revokes and releases an expired armed fence when consumption is attempted", () => {
    const s = createScheduler(new MemoryStateStore());
    s.enqueue(req("1", "interactive"));
    const l = s.tick([route("r")], 0)[0]!;
    expect(
      s.consumeFence(
        l.fenceId,
        { settings: 1, model: 1, capability: 1 },
        30001,
      ),
    ).toBe(false);
    expect(settleProvider(s, l.leaseId, "1", "succeeded")).toBe(false);
  });
  it("restart releases armed fences and repeated recovery preserves the original orphan deadline", () => {
    const store = new MemoryStateStore();
    let s = createScheduler(store);
    s.enqueue(req("armed", "interactive"));
    s.tick([route("r")], 0);
    s = createScheduler(store);
    expect(s.recover(10)).toEqual({
      orphaned: 0,
      reclaimed: 0,
      armedReleased: 1,
    });
    s.enqueue(req("used", "interactive"));
    const l = s.tick([route("r")], 20)[0]!;
    s.consumeFence(l.fenceId, { settings: 1, model: 1, capability: 1 }, 21);
    expect(s.recover(100).orphaned).toBe(1);
    expect(s.recover(20000).orphaned).toBe(0);
    expect(s.recover(30100).reclaimed).toBe(1);
  });
  it("exposes durable queue, lease, fence, and scheduler state contracts", () => {
    const state: SchedulerState = new MemoryStateStore().read().state;
    const lane: QueueRecord["lane"] = "interactive";
    const lease: Lease = {
      leaseId: "l",
      fenceId: "f",
      requestId: "r",
      attemptId: "a",
      routeId: "x",
      lane: "interactive",
      state: "active",
    };
    const fence: DispatchFence = {
      id: "f",
      leaseId: "l",
      state: "armed",
      expiresAt: 1,
      settings: 1,
      model: 1,
      capability: 1,
    };
    expect([state.queue, lane, lease.state, fence.state]).toBeTruthy();
  });
});
