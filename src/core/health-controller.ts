import type {
  Clock,
  HealthEvent,
  HealthOutcome,
  HealthState,
} from "./types.js";

export const createHealthState = (): HealthState => ({
  safeSlots: 1,
  circuit: "closed",
  accountDisabled: false,
  failureSequence: 0,
  outcomes: [],
  consecutiveSuccesses: 0,
});

const cooldown = (state: HealthState, at: number, random: () => number) =>
  at +
  Math.floor(Math.min(900_000, 30_000 * 2 ** state.failureSequence) * random());
const add = (state: HealthState, outcome: HealthOutcome) =>
  [...state.outcomes, outcome].sort((a, b) => a.at - b.at).slice(-20);
const p95 = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
};

export function recordHealthEvent(
  state: HealthState,
  event: HealthEvent,
  deps: { now: Clock["now"]; random: () => number },
): HealthState {
  const current = { ...state, outcomes: [...state.outcomes] };
  if (event.kind === "tick") {
    return current.circuit === "open" &&
      current.cooldownUntil !== undefined &&
      deps.now() >= current.cooldownUntil
      ? { ...current, circuit: "half-open", safeSlots: 1 }
      : current;
  }
  if (event.kind === "success") {
    const prior = current.latencyBaseline;
    const outcomes = add(current, {
      success: true,
      rateLimited: false,
      latencyMs: event.latencyMs,
      at: event.at,
    });
    const successes = outcomes.flatMap((outcome) =>
      outcome.success && outcome.latencyMs !== undefined
        ? [outcome.latencyMs]
        : [],
    );
    const consecutiveSuccesses = current.consecutiveSuccesses + 1;
    const canIncrease =
      successes.length >= 5 &&
      consecutiveSuccesses >= 5 &&
      !outcomes.some((outcome) => outcome.rateLimited) &&
      outcomes.filter((outcome) => !outcome.success).length / outcomes.length <
        0.05 &&
      prior !== undefined &&
      p95(successes) <= 1.5 * prior &&
      (current.lastIncreaseAt === undefined ||
        event.at - current.lastIncreaseAt >= 60_000);
    const next: HealthState = {
      ...current,
      outcomes,
      consecutiveSuccesses,
      latencyBaseline:
        prior === undefined
          ? event.latencyMs
          : 0.2 * event.latencyMs + 0.8 * prior,
      circuit: current.circuit === "half-open" ? "closed" : current.circuit,
      safeSlots: canIncrease ? current.safeSlots + 1 : current.safeSlots,
    };
    if (canIncrease) next.lastIncreaseAt = event.at;
    return next;
  }
  const outcomes = add(current, {
    success: false,
    rateLimited: event.status === 429,
    at: event.at,
  });
  const common = {
    ...current,
    outcomes,
    consecutiveSuccesses: 0,
    failureSequence: current.failureSequence + 1,
  };
  if (event.status === 401)
    return { ...common, accountDisabled: true, safeSlots: 0, circuit: "open" };
  if (event.status === 429) {
    const supplied = event.retryAfterMs;
    const valid =
      supplied !== undefined &&
      Number.isFinite(supplied) &&
      Number.isInteger(supplied) &&
      supplied >= 0;
    const cooldownUntil = valid
      ? event.at + Math.min(900_000, supplied)
      : cooldown(current, event.at, deps.random);
    return { ...common, safeSlots: 0, circuit: "open", cooldownUntil };
  }
  const recent = outcomes.slice(-10);
  const errorRate =
    recent.filter((outcome) => !outcome.success).length / recent.length;
  if (
    event.status >= 500 ||
    current.circuit === "half-open" ||
    errorRate >= 0.2
  ) {
    return {
      ...common,
      safeSlots: Math.max(1, Math.floor(current.safeSlots / 2)),
      circuit: "open",
      cooldownUntil: cooldown(current, event.at, deps.random),
    };
  }
  return common;
}
