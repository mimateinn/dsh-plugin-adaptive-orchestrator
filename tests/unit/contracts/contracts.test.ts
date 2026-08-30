import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Canonical,
  buildAdmissionPayload,
  hashAdmissionPayload,
  validateGlobalSettings,
  validateRouteRequirements,
  negotiateSchemaVersion,
  compareAndSwap,
  validateQuotaSnapshot,
} from "../../../src/contracts/index.js";

describe("Phase 1 contracts", () => {
  it("applies settings defaults and rejects cap invariants with JSON pointers", () => {
    const ok = validateGlobalSettings({
      schemaVersion: 1,
      revision: 0,
      enabled: true,
      sensitive: { enabled: false, modelAllowlist: [] },
      caps: {},
    });
    expect(ok).toMatchObject({
      success: true,
      data: { caps: { baseSlots: 1, globalHardCap: 8 }, auditRetentionDays: 7 },
    });
    const bad = validateGlobalSettings({
      schemaVersion: 1,
      revision: 0,
      enabled: true,
      sensitive: { enabled: false, modelAllowlist: [] },
      caps: { globalHardCap: 2, interactiveReserve: 2, backgroundReserve: 1 },
    });
    expect(bad.success).toBe(false);
    if (!bad.success)
      expect(bad.errors).toContainEqual(
        expect.objectContaining({ path: "/caps", code: "invariant" }),
      );
  });
  it("checks route token sum", () => {
    const r = validateRouteRequirements({
      schemaVersion: 1,
      taskClass: "code",
      requiredCapabilityIds: [],
      requiredToolIds: [],
      requiredModalities: [],
      inputContextTokens: 10,
      expectedOutputTokens: 20,
      contextSafetyReserveTokens: 30,
      minimumContextTokens: 61,
      sensitive: false,
      allowedModelIds: [],
    });
    expect(r).toMatchObject({
      success: false,
      errors: [{ path: "/minimumContextTokens", code: "invariant" }],
    });
  });
  it("returns safe structured provider errors", () => {
    const result = validateQuotaSnapshot({
      schemaVersion: 1,
      provider: " secret ",
      account: "a",
      quotaClass: "q",
      supported: true,
      observedAt: "bad",
      source: "rpc",
      confidence: "high",
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: "/observedAt" }),
      );
  });
  it("canonicalizes RFC 8785 and hashes UTF-8 bytes", () => {
    expect(canonicalJson({ z: 1, a: "€", nested: { b: 2, a: 1 } })).toBe(
      '{"a":"€","nested":{"a":1,"b":2},"z":1}',
    );
    expect(sha256Canonical({ hello: "world" })).toBe(
      "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588",
    );
  });
  it("rejects non-I-JSON Unicode and hashes typed admission payloads", () => {
    expect(() => canonicalJson("\ud800")).toThrow(/Unicode/);
    const routeRequirements = {
      schemaVersion: 1 as const,
      taskClass: "code",
      requiredCapabilityIds: [],
      requiredToolIds: [],
      requiredModalities: [],
      inputContextTokens: 1,
      expectedOutputTokens: 1,
      contextSafetyReserveTokens: 1,
      minimumContextTokens: 3,
      sensitive: false,
      allowedModelIds: [],
    };
    const input = {
      schemaVersion: 1 as const,
      requestId: "r",
      attemptId: "a",
      kind: "subagent" as const,
      parentAgentId: "p",
      lane: "interactive" as const,
      routeRequirements,
      deficitCost: 1,
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(buildAdmissionPayload(input)).not.toHaveProperty("createdAt");
    expect(hashAdmissionPayload(input)).toBe(
      hashAdmissionPayload({ ...input, createdAt: "2027-01-01T00:00:00Z" }),
    );
  });
  it("negotiates versions and performs immutable CAS", () => {
    expect(negotiateSchemaVersion(2, 1)).toMatchObject({
      success: false,
      errors: [{ code: "unsupported_version", path: "/schemaVersion" }],
    });
    const state = { revision: 4, value: "old" };
    expect(
      compareAndSwap(state, 3, (s) => ({ ...s, value: "new" })),
    ).toMatchObject({ success: false, code: "conflict", currentRevision: 4 });
    expect(state.value).toBe("old");
    expect(
      compareAndSwap(
        { revision: Number.MAX_SAFE_INTEGER, value: "old" },
        Number.MAX_SAFE_INTEGER,
        (s) => ({ ...s, value: "new" }),
      ),
    ).toMatchObject({ success: false, code: "conflict" });
    expect(
      compareAndSwap(state, 4, (s) => {
        s.value = "new";
        return s;
      }),
    ).toEqual({
      success: true,
      value: { revision: 5, value: "new" },
    });
  });
});
