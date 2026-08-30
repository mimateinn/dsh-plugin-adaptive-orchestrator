/** Public subscription usage source with redacted drop of invalid snapshots. */

import type { QuotaSnapshot } from "../contracts/schemas.js";
import { validateQuotaSnapshot } from "../contracts/schemas.js";

/** Normalized usage snapshots consumed by routing (never OAuth or private state). */
export interface UsageSource {
  snapshots(): Promise<QuotaSnapshot[]>;
}

/** Diagnostic summary of dropped snapshots (identities redacted). */
export interface RedactedDiagnostics {
  readonly dropped: number;
  readonly reasons: string[];
}

/**
 * Adapter over a documented typed usage RPC. The injected fetch performs the
 * public RPC call; invalid snapshots are dropped individually and reported
 * redacted, and an absent service contributes zero snapshots (neutral quota).
 */
export class SubscriptionUsageAdapter implements UsageSource {
  private readonly reasons = new Map<string, number>();

  constructor(
    private readonly fetchSnapshots: () => Promise<unknown[]>,
    private readonly now = Date.now,
  ) {}

  async snapshots(): Promise<QuotaSnapshot[]> {
    this.reasons.clear();
    let raw: unknown[];
    try {
      raw = await this.fetchSnapshots();
    } catch {
      this.reasons.set("usage-unavailable", 1);
      return [];
    }
    const accepted: QuotaSnapshot[] = [];
    for (const candidate of raw) {
      const result = validateQuotaSnapshot(candidate);
      if (result.success) accepted.push(result.data);
      else {
        this.reasons.set(
          "invalid-snapshot",
          (this.reasons.get("invalid-snapshot") ?? 0) + 1,
        );
      }
    }
    return accepted;
  }

  /** Redacted diagnostics for the last snapshots() call. */
  diagnostics(): RedactedDiagnostics {
    const dropped = [...this.reasons.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    return {
      dropped,
      reasons: [...this.reasons.entries()].map(
        ([code, count]) => `${code}:${count}`,
      ),
    };
  }
}

/** Neutral source: zero snapshots (quota headroom stays 0.5, confidence unknown). */
export class NeutralUsageSource implements UsageSource {
  async snapshots(): Promise<QuotaSnapshot[]> {
    return [];
  }
}
