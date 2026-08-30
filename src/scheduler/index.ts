import { createHash } from "node:crypto";

export type Lane = "interactive" | "background";
export type Route = {
  id: string;
  provider: string;
  account: string;
  model: string;
  safeSlots: number;
};
export type Request = {
  requestId: string;
  attemptId: string;
  lane: Lane;
  routeId: string;
  payloadHash: string;
  createdAt: number;
  settingsRevision: number;
  modelRevision: number;
  capabilityRevision: number;
  deficitCost?: number;
};
export type QueueRecord = Request & { sequence: number };
export type Lease = {
  leaseId: string;
  fenceId: string;
  requestId: string;
  attemptId: string;
  routeId: string;
  lane: Lane;
  state: "active" | "orphaned" | "released";
  orphanedAt?: number;
};
export type DispatchFence = {
  id: string;
  leaseId: string;
  state: "armed" | "consumed" | "revoked";
  expiresAt: number;
  settings: number;
  model: number;
  capability: number;
};
export type SchedulerState = {
  queue: QueueRecord[];
  leases: Lease[];
  fences: DispatchFence[];
  deficit: Record<Lane, number>;
  sequence: number;
  lastStart: Record<Lane, number>;
};
const initial = (): SchedulerState => ({
  queue: [],
  leases: [],
  fences: [],
  deficit: { interactive: 0, background: 0 },
  sequence: 0,
  lastStart: { interactive: 0, background: 0 },
});

export class MemoryStateStore {
  private revision = 0;
  private state = initial();
  read() {
    return { revision: this.revision, state: structuredClone(this.state) };
  }
  compareAndSwap(revision: number, state: SchedulerState) {
    if (revision !== this.revision) return false;
    this.state = structuredClone(state);
    this.revision++;
    return true;
  }
}

export function aggregateCapacity(
  routes: Route[],
  caps: { global: number; provider: number; account: number; model: number },
) {
  const allocated = new Map<string, number>();
  const providers = new Map<string, number>();
  const accounts = new Map<string, number>();
  const models = new Map<string, number>();
  let total = 0;
  let changed = true;
  while (changed && total < caps.global) {
    changed = false;
    for (const route of [...routes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        (allocated.get(route.id) ?? 0) >= route.safeSlots ||
        (providers.get(route.provider) ?? 0) >= caps.provider ||
        (accounts.get(route.account) ?? 0) >= caps.account ||
        (models.get(route.model) ?? 0) >= caps.model ||
        total >= caps.global
      )
        continue;
      allocated.set(route.id, (allocated.get(route.id) ?? 0) + 1);
      providers.set(route.provider, (providers.get(route.provider) ?? 0) + 1);
      accounts.set(route.account, (accounts.get(route.account) ?? 0) + 1);
      models.set(route.model, (models.get(route.model) ?? 0) + 1);
      total++;
      changed = true;
    }
  }
  return total;
}

type Outcome = {
  result: "success" | "provider-error" | "rate-limited" | "timed-out";
  latencyMs: number;
  finishedAt: number;
};
const percentile95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * 0.95) - 1)
  ] ?? 0;
export function desiredWorkerCount(x: {
  readyIndependentTasks: number;
  globalHardCap: number;
  aggregateSafeCapacity: number;
  baseSlots: number;
  maxEligibleBurnPressure: number;
}) {
  const base = Math.min(
    x.globalHardCap,
    Math.max(x.readyIndependentTasks > 0 ? 1 : 0, x.baseSlots),
  );
  const pressure = Math.min(1, Math.max(0, x.maxEligibleBurnPressure));
  const pressureSlots = base + Math.floor(pressure * (x.globalHardCap - base));
  return Math.max(
    0,
    Math.min(
      x.readyIndependentTasks,
      x.globalHardCap,
      x.aggregateSafeCapacity,
      pressureSlots,
    ),
  );
}

export function scaleSafeSlots(
  x: {
    safeSlots: number;
    lastIncreaseAt: number;
    outcomes: Outcome[];
    baselineLatencyMs?: number;
  },
  now: number,
) {
  const last = [...x.outcomes]
    .sort((a, b) => a.finishedAt - b.finishedAt)
    .slice(-20);
  const ten = last.slice(-10);
  const successes = last.filter((o) => o.result === "success");
  const p95 = percentile95(successes.map((o) => o.latencyMs));
  const baseline = x.baselineLatencyMs ?? successes[0]?.latencyMs ?? 0;
  if (
    last.at(-1)?.result === "rate-limited" ||
    (ten.length > 0 &&
      ten.filter((o) => o.result !== "success").length / ten.length >= 0.2) ||
    (baseline > 0 && p95 > baseline * 2)
  )
    return Math.max(1, Math.floor(x.safeSlots / 2));
  const lastFive = last.slice(-5);
  if (
    lastFive.length === 5 &&
    lastFive.every((o) => o.result === "success") &&
    !last.some((o) => o.result === "rate-limited") &&
    p95 <= baseline * 1.5 &&
    now - x.lastIncreaseAt >= 60000
  )
    return x.safeSlots + 1;
  return x.safeSlots;
}
export function deterministicBackoff(
  routeId: string,
  failureSequence: number,
  epoch: number | string,
) {
  const cap = Math.min(
    900000,
    30000 * 2 ** Math.min(Math.max(0, failureSequence - 1), 5),
  );
  const sample =
    createHash("sha256")
      .update(routeId + failureSequence + epoch)
      .digest()
      .readUInt32BE(0) / 0x100000000;
  return Math.floor(sample * cap);
}

export function createScheduler(
  store: MemoryStateStore,
  config: {
    queueLimit?: number;
    globalCap?: number;
    providerCap?: number;
    accountCap?: number;
    modelCap?: number;
    interactiveReserve?: number;
    backgroundReserve?: number;
  } = {},
) {
  const caps = {
    global: config.globalCap ?? 8,
    provider: config.providerCap ?? 4,
    account: config.accountCap ?? 4,
    model: config.modelCap ?? 4,
  };
  const interactiveReserve = config.interactiveReserve ?? 1;
  const backgroundReserve = config.backgroundReserve ?? 1;
  for (const [name, value] of Object.entries(caps))
    if (!Number.isInteger(value) || value < 1 || value > 64)
      throw new RangeError(`${name}Cap must be an integer from 1 to 64`);
  for (const [name, value] of [
    ["interactiveReserve", interactiveReserve],
    ["backgroundReserve", backgroundReserve],
  ] as const)
    if (!Number.isInteger(value) || value < 0 || value > 64)
      throw new RangeError(`${name} must be an integer from 0 to 64`);
  if (interactiveReserve + backgroundReserve > caps.global)
    throw new RangeError("lane reservations cannot exceed globalCap");

  const mutate = <T>(fn: (s: SchedulerState) => T): T => {
    for (;;) {
      const snapshot = store.read();
      const result = fn(snapshot.state);
      if (store.compareAndSwap(snapshot.revision, snapshot.state))
        return result;
    }
  };
  const active = (s: SchedulerState) =>
    s.leases.filter((l) => l.state !== "released");
  return {
    enqueue(r: Request) {
      return mutate((s) => {
        const q = s.queue.find((x) => x.requestId === r.requestId);
        const lease = s.leases.find(
          (x) => x.requestId === r.requestId && x.state !== "released",
        );
        if (q)
          return {
            kind:
              q.attemptId === r.attemptId && q.payloadHash === r.payloadHash
                ? "duplicate"
                : "conflict",
            record: q,
          };
        if (lease) return { kind: "conflict", record: lease };
        if (s.queue.length >= (config.queueLimit ?? 256))
          return { kind: "full" };
        const record = {
          ...r,
          deficitCost: r.deficitCost ?? 1,
          sequence: ++s.sequence,
        };
        s.queue.push(record);
        return { kind: "admitted", record };
      });
    },
    tick(
      routes: Route[],
      now: number,
      demand: { baseSlots?: number; maxEligibleBurnPressure?: number } = {},
    ) {
      return mutate((s) => {
        const out: Lease[] = [];
        const capacity = aggregateCapacity(routes, caps);
        const cap =
          demand.baseSlots === undefined &&
          demand.maxEligibleBurnPressure === undefined
            ? capacity
            : desiredWorkerCount({
                readyIndependentTasks: active(s).length + s.queue.length,
                globalHardCap: caps.global,
                aggregateSafeCapacity: capacity,
                baseSlots: demand.baseSlots ?? 1,
                maxEligibleBurnPressure: demand.maxEligibleBurnPressure ?? 0,
              });
        const hasInteractive = s.queue.some((q) => q.lane === "interactive");
        const hasBackground = s.queue.some((q) => q.lane === "background");
        for (const lane of ["interactive", "background"] as const) {
          const hasLane =
            lane === "interactive" ? hasInteractive : hasBackground;
          const otherEmpty =
            lane === "interactive" ? !hasBackground : !hasInteractive;
          const quantum = lane === "interactive" ? 2 : 1;
          s.deficit[lane] = hasLane
            ? Math.min(
                64,
                s.deficit[lane] +
                  quantum +
                  (otherEmpty &&
                  demand.baseSlots === undefined &&
                  demand.maxEligibleBurnPressure === undefined
                    ? lane === "interactive"
                      ? 1
                      : 2
                    : 0),
              )
            : 0;
        }
        while (active(s).length < cap) {
          let began = false;
          const queuedLanes = (["interactive", "background"] as Lane[]).filter(
            (l) => s.queue.some((q) => q.lane === l),
          );
          const starving = queuedLanes.find(
            (l) => now - s.lastStart[l] >= 30000 && s.lastStart[l] !== now,
          );
          const order = starving
            ? [starving, ...queuedLanes.filter((l) => l !== starving)]
            : queuedLanes;
          for (const lane of order) {
            const other: Lane =
              lane === "interactive" ? "background" : "interactive";
            const reserve =
              other === "interactive" ? interactiveReserve : backgroundReserve;
            const remaining = cap - active(s).length;
            const activeOther = active(s).filter(
              (lease) => lease.lane === other,
            ).length;
            if (
              s.queue.some((q) => q.lane === other) &&
              activeOther < reserve &&
              remaining <= reserve - activeOther
            )
              continue;
            const usageRoutes = active(s)
              .map((l) => routes.find((r) => r.id === l.routeId))
              .filter((r): r is Route => !!r);
            const i = s.queue.findIndex((q) => {
              if (q.lane !== lane) return false;
              const r = routes.find((x) => x.id === q.routeId);
              if (!r || s.deficit[lane] < (q.deficitCost ?? 1)) return false;
              return (
                usageRoutes.filter((x) => x.provider === r.provider).length <
                  caps.provider &&
                usageRoutes.filter((x) => x.account === r.account).length <
                  caps.account &&
                usageRoutes.filter((x) => x.model === r.model).length <
                  caps.model &&
                usageRoutes.filter((x) => x.id === r.id).length < r.safeSlots
              );
            });
            if (i < 0) continue;
            const q = s.queue.splice(i, 1)[0]!;
            const lease: Lease = {
              leaseId: "lease-" + q.sequence,
              fenceId: "fence-" + q.sequence,
              requestId: q.requestId,
              attemptId: q.attemptId,
              routeId: q.routeId,
              lane: q.lane,
              state: "active",
            };
            s.leases.push(lease);
            s.fences.push({
              id: lease.fenceId,
              leaseId: lease.leaseId,
              state: "armed",
              expiresAt: now + 30000,
              settings: q.settingsRevision,
              model: q.modelRevision,
              capability: q.capabilityRevision,
            });
            s.deficit[lane] -= q.deficitCost ?? 1;
            s.lastStart[lane] = now;
            out.push(lease);
            began = true;
            break;
          }
          if (!began) break;
        }
        return out;
      });
    },
    consumeFence(
      id: string,
      revisions: { settings: number; model: number; capability: number },
      now: number,
    ) {
      return mutate((s) => {
        const f = s.fences.find((x) => x.id === id);
        if (!f || f.state !== "armed") return false;
        if (now > f.expiresAt) {
          f.state = "revoked";
          const lease = s.leases.find((x) => x.leaseId === f.leaseId);
          if (lease?.state === "active") lease.state = "released";
          return false;
        }
        if (
          f.settings !== revisions.settings ||
          f.model !== revisions.model ||
          f.capability !== revisions.capability
        ) {
          f.state = "revoked";
          const lease = s.leases.find((x) => x.leaseId === f.leaseId);
          if (lease?.state === "active") lease.state = "released";
          return false;
        }
        f.state = "consumed";
        return true;
      });
    },
    cancel(requestId: string) {
      return mutate((s) => {
        const i = s.queue.findIndex((q) => q.requestId === requestId);
        if (i >= 0) {
          s.queue.splice(i, 1);
          return true;
        }
        const l = s.leases.find(
          (x) => x.requestId === requestId && x.state !== "released",
        );
        if (!l) return false;
        const f = s.fences.find((x) => x.leaseId === l.leaseId);
        if (f?.state === "armed") {
          f.state = "revoked";
          l.state = "released";
        }
        return true;
      });
    },
    release(leaseId: string, attemptId: string) {
      return mutate((s) => {
        const l = s.leases.find(
          (x) => x.leaseId === leaseId || x.requestId === leaseId,
        );
        if (!l || l.attemptId !== attemptId || l.state === "released")
          return false;
        l.state = "released";
        return true;
      });
    },
    recover(now: number) {
      return mutate((s) => {
        let orphaned = 0,
          reclaimed = 0,
          armedReleased = 0;
        for (const f of s.fences)
          if (f.state === "armed") {
            f.state = "revoked";
            const l = s.leases.find((x) => x.leaseId === f.leaseId);
            if (l && l.state === "active") {
              l.state = "released";
              armedReleased++;
            }
          }
        for (const l of s.leases) {
          const f = s.fences.find((x) => x.leaseId === l.leaseId);
          if (l.state === "active" && f?.state === "consumed") {
            l.state = "orphaned";
            l.orphanedAt = now;
            orphaned++;
          } else if (
            l.state === "orphaned" &&
            now - (l.orphanedAt ?? now) >= 30000
          ) {
            l.state = "released";
            reclaimed++;
          }
        }
        return { orphaned, reclaimed, armedReleased };
      });
    },
  };
}
