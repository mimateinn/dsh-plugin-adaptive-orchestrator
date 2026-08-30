import { describe, expect, it } from "vitest";
import {
  SubscriptionUsageAdapter,
  NeutralUsageSource,
} from "../../../src/integrations/subscriptions.js";

const valid = {
  schemaVersion: 1,
  provider: "codex",
  account: "acct-1",
  quotaClass: "chat",
  supported: true,
  observedAt: "2026-01-01T00:00:00Z",
  source: "test",
  confidence: "high",
  usedPercent: 40,
  resetsAt: "2026-01-02T00:00:00Z",
};

describe("subscription usage adapter", () => {
  it("accepts valid snapshots and drops invalid ones with redacted diagnostics", async () => {
    const adapter = new SubscriptionUsageAdapter(async () => [
      valid,
      { ...valid, usedPercent: 150 },
      { ...valid, provider: 42 },
      "garbage",
    ]);
    const snapshots = await adapter.snapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ provider: "codex" });
    expect(adapter.diagnostics()).toMatchObject({ dropped: 3 });
  });

  it("returns zero snapshots when the usage RPC is unavailable", async () => {
    const adapter = new SubscriptionUsageAdapter(async () => {
      throw new Error("service absent");
    });
    expect(await adapter.snapshots()).toEqual([]);
    expect(adapter.diagnostics().dropped).toBe(1);
  });

  it("exposes a neutral source", async () => {
    expect(await new NeutralUsageSource().snapshots()).toEqual([]);
  });
});
