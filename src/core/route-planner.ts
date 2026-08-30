import type {
  Clock,
  RouteRequirements,
  RouteResult,
  WorkerCandidate,
} from "./types.js";
import { computeQuotaMetrics } from "./quota-pressure.js";
const hasAll = (have: string[], need: string[]) =>
  need.every((x) => have.includes(x));
export function planRoute(
  candidates: WorkerCandidate[],
  req: RouteRequirements,
  options: {
    now: Clock["now"];
    configuredHorizonMs?: number;
    burnWeight?: number;
    providerWeights?: Record<string, number>;
  },
): RouteResult {
  if (!req.enabled)
    return { kind: "no-route", reasonCodes: ["ORCHESTRATION_DISABLED"] };
  if (req.sensitive && !req.allowedModelIds.length)
    return { kind: "no-route", reasonCodes: ["SENSITIVE_ALLOWLIST_EMPTY"] };
  const rejected: string[] = [];
  const eligible = candidates
    .flatMap((c) => {
      let reason: string | undefined;
      if (!c.authenticated || c.health.accountDisabled)
        reason = "AUTH_UNAVAILABLE";
      else if (!c.enabled) reason = "ROUTE_DISABLED";
      else if (c.health.circuit === "open") reason = "CIRCUIT_OPEN";
      else if (
        c.capabilityFit <= 0 ||
        c.healthConfidence <= 0 ||
        c.taskClass !== req.taskClass ||
        !hasAll(c.capabilityIds, req.requiredCapabilityIds)
      )
        reason = "CAPABILITY_MISMATCH";
      else if (req.sensitive && !req.allowedModelIds.includes(c.model))
        reason = "SENSITIVE_MODEL_DENIED";
      else if (!hasAll(c.tools, req.requiredToolIds))
        reason = "TOOL_UNSUPPORTED";
      else if (!hasAll(c.modalities, req.requiredModalities))
        reason = "MODALITY_UNSUPPORTED";
      else if (c.maximumContextTokens < req.minimumContextTokens)
        reason = "CONTEXT_INSUFFICIENT";
      const q = computeQuotaMetrics(c.quotaSnapshots, {
        now: options.now,
        configuredHorizonMs: options.configuredHorizonMs ?? 7 * 864e5,
        providerWeight:
          options.providerWeights?.[c.provider] ??
          (c.provider === "codex" || c.provider === "grok" ? 2 : 1),
      });
      if (!reason && q.hardExhausted) reason = "QUOTA_HARD_THRESHOLD";
      if (reason) {
        rejected.push(reason);
        return [];
      }
      const latency = Math.min(600, Math.max(0.1, c.expectedLatencyMs / 1000));
      const score =
        (c.capabilityFit *
          c.healthConfidence *
          q.quotaHeadroom *
          (1 + (options.burnWeight ?? 1) * q.burnPressure)) /
        latency;
      return [
        {
          c,
          score,
          reasons: [
            "CAPABILITY_FIT",
            "HEALTH_CONFIDENCE",
            ...q.reasonCodes,
            "LATENCY_FACTOR",
          ],
        },
      ];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.c.capabilityFit - a.c.capabilityFit ||
        a.c.expectedLatencyMs - b.c.expectedLatencyMs ||
        (a.c.routeId < b.c.routeId ? -1 : a.c.routeId > b.c.routeId ? 1 : 0),
    );
  const best = eligible[0];
  return best
    ? {
        kind: "route",
        routeId: best.c.routeId,
        score: best.score,
        reasonCodes: best.reasons,
        decidedAt: options.now(),
      }
    : { kind: "no-route", reasonCodes: [...new Set(rejected)] };
}
