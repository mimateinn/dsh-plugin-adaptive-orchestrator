import { describe, expect, it } from "vitest";
import {
  computeQuotaMetrics,
  createHealthState,
  createRegistry,
  planRoute,
  recordHealthEvent,
} from "../../../src/core/index.js";
import type {
  WorkerCandidate,
  RouteRequirements,
} from "../../../src/core/index.js";

const now = Date.parse("2026-08-30T12:00:00Z");
const req: RouteRequirements = {
  enabled: true,
  taskClass: "code",
  requiredCapabilityIds: ["code"],
  requiredToolIds: ["shell"],
  requiredModalities: ["text"],
  minimumContextTokens: 1000,
  sensitive: false,
  allowedModelIds: [],
};
const candidate = (over: Partial<WorkerCandidate> = {}): WorkerCandidate => ({
  routeId: "r1",
  provider: "codex",
  account: "a",
  model: "m1",
  taskClass: "code",
  authenticated: true,
  enabled: true,
  capabilityIds: ["code"],
  tools: ["shell"],
  modalities: ["text"],
  capabilityFit: 1,
  healthConfidence: 1,
  expectedLatencyMs: 1000,
  maximumContextTokens: 2000,
  quotaSnapshots: [],
  health: { circuit: "closed" },
  ...over,
});

describe("quota pressure", () => {
  it("uses exact formula and provider weight", () => {
    const q = computeQuotaMetrics(
      [
        {
          supported: true,
          usedPercent: 20,
          resetsAt: now + 50,
          observedAt: now,
          confidence: "high",
        },
      ],
      { now: () => now, configuredHorizonMs: 100, providerWeight: 2 },
    );
    expect(q).toEqual({
      quotaHeadroom: 0.8,
      burnPressure: 0.4,
      hardExhausted: false,
      reasonCodes: ["QUOTA_FRESH", "QUOTA_HEADROOM", "BURN_PRESSURE"],
    });
  });
  it("makes stale and unknown quota neutral", () => {
    expect(
      computeQuotaMetrics([], {
        now: () => now,
        configuredHorizonMs: 100,
        providerWeight: 2,
      }),
    ).toMatchObject({ quotaHeadroom: 0.5, reasonCodes: ["QUOTA_UNKNOWN"] });
    expect(
      computeQuotaMetrics(
        [
          {
            supported: true,
            usedPercent: 99,
            resetsAt: now + 1,
            observedAt: now - 31 * 60_000,
            confidence: "low",
          },
        ],
        { now: () => now, configuredHorizonMs: 100, providerWeight: 2 },
      ),
    ).toMatchObject({
      quotaHeadroom: 0.5,
      burnPressure: 0,
      hardExhausted: false,
      reasonCodes: ["QUOTA_STALE"],
    });
  });
});
describe("registry and routing", () => {
  it("quarantines unknown models", () =>
    expect(createRegistry([]).status("new")).toBe("quarantined"));
  it("fails sensitive mode closed", () =>
    expect(
      planRoute([candidate()], { ...req, sensitive: true }, { now: () => now }),
    ).toMatchObject({
      kind: "no-route",
      reasonCodes: ["SENSITIVE_ALLOWLIST_EMPTY"],
    }));
  it("filters and produces stable ties", () => {
    const b = candidate({ routeId: "b" }),
      a = candidate({ routeId: "a" });
    expect(planRoute([b, a], req, { now: () => now })).toMatchObject({
      kind: "route",
      routeId: "a",
    });
  });
  it("rejects auth, open circuit and hard quota", () => {
    expect(
      planRoute([candidate({ authenticated: false })], req, { now: () => now }),
    ).toMatchObject({ kind: "no-route", reasonCodes: ["AUTH_UNAVAILABLE"] });
    expect(
      planRoute([candidate({ health: { circuit: "open" } })], req, {
        now: () => now,
      }),
    ).toMatchObject({ kind: "no-route", reasonCodes: ["CIRCUIT_OPEN"] });
    const q = {
      supported: true,
      usedPercent: 95,
      resetsAt: now + 100,
      observedAt: now,
      confidence: "high" as const,
    };
    expect(
      planRoute([candidate({ quotaSnapshots: [q] })], req, {
        now: () => now,
        configuredHorizonMs: 1000,
      }),
    ).toMatchObject({
      kind: "no-route",
      reasonCodes: ["QUOTA_HARD_THRESHOLD"],
    });
  });
});
describe("health controller", () => {
  it("401 disables account", () =>
    expect(
      recordHealthEvent(
        createHealthState(),
        { kind: "http", status: 401, at: now },
        { now: () => now, random: () => 0.5 },
      ),
    ).toMatchObject({ accountDisabled: true, safeSlots: 0 }));
  it("429 contracts and cools with Retry-After", () =>
    expect(
      recordHealthEvent(
        { ...createHealthState(), safeSlots: 4 },
        { kind: "http", status: 429, retryAfterMs: 60_000, at: now },
        { now: () => now, random: () => 0.5 },
      ),
    ).toMatchObject({
      safeSlots: 0,
      circuit: "open",
      cooldownUntil: now + 60_000,
    }));
  it("5xx opens circuit and cooldown expiry becomes half-open", () => {
    const s = recordHealthEvent(
      createHealthState(),
      { kind: "http", status: 503, at: now },
      { now: () => now, random: () => 0.5 },
    );
    expect(s.circuit).toBe("open");
    const h = recordHealthEvent(
      s,
      { kind: "tick", at: now + 20_000 },
      { now: () => now + 20_000, random: () => 0.5 },
    );
    expect(h).toMatchObject({ circuit: "half-open", safeSlots: 1 });
  });
  it("half-open success closes circuit", () =>
    expect(
      recordHealthEvent(
        { ...createHealthState(), circuit: "half-open", safeSlots: 1 },
        { kind: "success", latencyMs: 100, at: now },
        { now: () => now, random: () => 0.5 },
      ),
    ).toMatchObject({ circuit: "closed" }));
  it("clamps Retry-After and reopens failed half-open probes", () => {
    expect(
      recordHealthEvent(
        createHealthState(),
        { kind: "http", status: 429, retryAfterMs: Infinity, at: now },
        { now: () => now, random: () => 0.5 },
      ).cooldownUntil,
    ).toBe(now + 15_000);
    expect(
      recordHealthEvent(
        { ...createHealthState(), circuit: "half-open" },
        { kind: "http", status: 400, at: now },
        { now: () => now, random: () => 0.5 },
      ).circuit,
    ).toBe("open");
  });
  it("increases once after five stable successes", () => {
    let state = createHealthState();
    for (let i = 0; i < 5; i++)
      state = recordHealthEvent(
        state,
        { kind: "success", latencyMs: 100, at: now + i * 15_000 },
        { now: () => now + i * 15_000, random: () => 0.5 },
      );
    expect(state.safeSlots).toBe(2);
  });
});
