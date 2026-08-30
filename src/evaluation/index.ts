export type EvaluationStatus = "quarantined" | "qualified" | "regressed";
export type EvaluationOutcome = {
  probeId: string;
  at: number;
  success: boolean;
  mandatoryToolPassed: boolean;
  safetyViolation: boolean;
  kind: "probe" | "production";
};
export interface ModelEvaluation {
  modelId: string;
  modelVersion: string;
  taskClass: string;
  status: EvaluationStatus;
  outcomes: EvaluationOutcome[];
  consecutiveMandatoryFailures: number;
}
const THIRTY_DAYS = 30 * 86_400_000;
export function createEvaluation(
  modelId: string,
  modelVersion: string,
  taskClass: string,
): ModelEvaluation {
  return {
    modelId,
    modelVersion,
    taskClass,
    status: "quarantined",
    outcomes: [],
    consecutiveMandatoryFailures: 0,
  };
}
export function qualificationDecision(
  state: ModelEvaluation,
  now: number,
): { status: EvaluationStatus; reasonCodes: string[] } {
  const current = state.outcomes.filter(
    (x) => x.kind === "probe" && now - x.at <= THIRTY_DAYS,
  );
  if (current.some((x) => x.safetyViolation))
    return { status: "regressed", reasonCodes: ["SAFETY_VIOLATION"] };
  if (current.length < 5)
    return { status: "quarantined", reasonCodes: ["PROBES_INCOMPLETE"] };
  if (!current.every((x) => x.mandatoryToolPassed))
    return { status: "quarantined", reasonCodes: ["MANDATORY_TOOL_FAILED"] };
  if (current.filter((x) => x.success).length / current.length < 0.8)
    return { status: "quarantined", reasonCodes: ["SUCCESS_THRESHOLD_FAILED"] };
  return { status: "qualified", reasonCodes: ["EVALUATION_QUALIFIED"] };
}
export function recordOutcome(
  state: ModelEvaluation,
  outcome: EvaluationOutcome,
): ModelEvaluation {
  const outcomes = [...state.outcomes, outcome];
  const consecutiveMandatoryFailures = outcome.mandatoryToolPassed
    ? 0
    : state.consecutiveMandatoryFailures + 1;
  const latest = outcomes.slice(-10),
    lowSuccess =
      latest.length === 10 &&
      latest.filter((x) => x.success).length / latest.length < 0.7;
  const status =
    outcome.safetyViolation || consecutiveMandatoryFailures >= 2 || lowSuccess
      ? "regressed"
      : state.status;
  return { ...state, outcomes, status, consecutiveMandatoryFailures };
}
export function canRunProbe(
  providerProbeTimes: readonly number[],
  now: number,
  dailyBudget = 3,
): boolean {
  return (
    providerProbeTimes.filter((at) => now - at >= 0 && now - at < 86_400_000)
      .length < dailyBudget
  );
}
