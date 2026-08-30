import type { Clock, QuotaSnapshot } from "./types.js";
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
export function computeQuotaMetrics(
  windows: QuotaSnapshot[],
  options: {
    now: Clock["now"];
    configuredHorizonMs: number;
    providerWeight: number;
  },
) {
  const now = options.now();
  const fresh = windows.filter(
    (w) =>
      w.supported &&
      w.confidence !== "low" &&
      now - w.observedAt <= 30 * 60_000 &&
      w.usedPercent !== undefined,
  );
  if (!fresh.length) {
    const stale = windows.some(
      (w) =>
        w.supported &&
        (w.confidence === "low" || now - w.observedAt > 30 * 60_000),
    );
    return {
      quotaHeadroom: 0.5,
      burnPressure: 0,
      hardExhausted: false,
      reasonCodes: [stale ? "QUOTA_STALE" : "QUOTA_UNKNOWN"],
    };
  }
  let headroom = 1,
    pressure = 0,
    hard = false;
  for (const w of fresh) {
    const remaining = clamp(1 - w.usedPercent! / 100);
    headroom = Math.min(headroom, remaining);
    hard ||= w.usedPercent! >= 95;
    if (w.resetsAt !== undefined && w.resetsAt >= now) {
      const ratio = clamp((w.resetsAt - now) / options.configuredHorizonMs);
      pressure = Math.max(
        pressure,
        clamp((remaining * (1 - ratio) * options.providerWeight) / 2),
      );
    }
  }
  return {
    quotaHeadroom: headroom,
    burnPressure: pressure,
    hardExhausted: hard,
    reasonCodes: ["QUOTA_FRESH", "QUOTA_HEADROOM", "BURN_PRESSURE"],
  };
}
