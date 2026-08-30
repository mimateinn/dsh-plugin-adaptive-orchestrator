export type EvaluationStatus =
  "quarantined" | "evaluating" | "qualified" | "disabled" | "regressed";
export type EvaluationResult = "pass" | "fail" | "safety-violation";
export interface EvaluationOutcome {
  schemaVersion: 1;
  modelId: string;
  modelVersion: string;
  taskClass: string;
  probeId: string;
  probeCorpusVersion: string;
  sequence: number;
  startedAt: string;
  finishedAt: string;
  result: EvaluationResult;
  latencyMs: number;
  mandatoryTool: boolean;
  corpusHash: string;
}
export interface LegacyEvaluationOutcome {
  probeId: string;
  at: number;
  success: boolean;
  mandatoryToolPassed: boolean;
  safetyViolation: boolean;
  kind: "probe" | "production";
}
export interface ReplayMetadata {
  highestSequence: number;
  recentProbeIds: string[];
}
export interface ModelEvaluation {
  schemaVersion: 1;
  modelId: string;
  modelVersion: string;
  taskClass: string;
  state: EvaluationStatus;
  status: EvaluationStatus;
  probeCorpusVersion: string;
  revision: number;
  evidenceAt: string;
  outcomes: EvaluationOutcome[];
  replay: ReplayMetadata;
  consecutiveMandatoryFailures: number;
}
export type EvaluationCasResult =
  | { success: true; value: ModelEvaluation }
  | { success: false; code: "conflict"; currentRevision: number };
export interface EvaluationStore {
  compareAndSwap(
    expectedRevision: number,
    next: ModelEvaluation,
  ): Promise<EvaluationCasResult>;
}
const THIRTY_DAYS = 30 * 86_400_000,
  MAX_OUTCOMES = 100,
  MAX_REPLAY_IDS = 100;
const stateKeys = new Set([
  "schemaVersion",
  "modelId",
  "modelVersion",
  "taskClass",
  "state",
  "status",
  "probeCorpusVersion",
  "revision",
  "evidenceAt",
  "outcomes",
  "replay",
  "consecutiveMandatoryFailures",
]);
const replayKeys = new Set(["highestSequence", "recentProbeIds"]);
const outcomeKeys = new Set([
  "schemaVersion",
  "modelId",
  "modelVersion",
  "taskClass",
  "probeId",
  "probeCorpusVersion",
  "sequence",
  "startedAt",
  "finishedAt",
  "result",
  "latencyMs",
  "mandatoryTool",
  "corpusHash",
]);
const boundedString = (v: unknown) =>
  typeof v === "string" && v.length >= 1 && v.length <= 200 && v.trim() === v;
const rfc3339Utc = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const closed = (v: object, keys: Set<string>) =>
  Object.keys(v).length === keys.size &&
  Object.keys(v).every((k) => keys.has(k));
export function createEvaluation(
  modelId: string,
  modelVersion: string,
  taskClass: string,
  probeCorpusVersion = "unset",
  evidenceAt = new Date(0).toISOString(),
): ModelEvaluation {
  return {
    schemaVersion: 1,
    modelId,
    modelVersion,
    taskClass,
    state: "quarantined",
    status: "quarantined",
    probeCorpusVersion,
    revision: 0,
    evidenceAt,
    outcomes: [],
    replay: { highestSequence: -1, recentProbeIds: [] },
    consecutiveMandatoryFailures: 0,
  };
}
const validOutcome = (s: ModelEvaluation, o: EvaluationOutcome) =>
  typeof o === "object" &&
  o !== null &&
  closed(o, outcomeKeys) &&
  o.schemaVersion === 1 &&
  o.modelId === s.modelId &&
  o.modelVersion === s.modelVersion &&
  o.taskClass === s.taskClass &&
  o.probeCorpusVersion === s.probeCorpusVersion &&
  boundedString(o.probeId) &&
  ["pass", "fail", "safety-violation"].includes(o.result) &&
  Number.isSafeInteger(o.sequence) &&
  o.sequence >= 0 &&
  Number.isSafeInteger(o.latencyMs) &&
  o.latencyMs >= 0 &&
  typeof o.mandatoryTool === "boolean" &&
  rfc3339Utc(o.startedAt) &&
  rfc3339Utc(o.finishedAt) &&
  Date.parse(o.startedAt) <= Date.parse(o.finishedAt) &&
  /^[a-f0-9]{64}$/.test(o.corpusHash);
export function parseModelEvaluation(value: unknown): ModelEvaluation {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !closed(value, stateKeys)
  )
    throw new Error("Invalid model evaluation");
  const v = value as Record<string, unknown>,
    replay = v.replay;
  if (
    v.schemaVersion !== 1 ||
    !boundedString(v.modelId) ||
    !boundedString(v.modelVersion) ||
    !boundedString(v.taskClass) ||
    ![
      "quarantined",
      "evaluating",
      "qualified",
      "disabled",
      "regressed",
    ].includes(String(v.state)) ||
    v.status !== v.state ||
    !boundedString(v.probeCorpusVersion) ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 0 ||
    !rfc3339Utc(v.evidenceAt) ||
    !Array.isArray(v.outcomes) ||
    v.outcomes.length > MAX_OUTCOMES ||
    typeof replay !== "object" ||
    replay === null ||
    Array.isArray(replay) ||
    !closed(replay, replayKeys) ||
    !Number.isSafeInteger((replay as ReplayMetadata).highestSequence) ||
    (replay as ReplayMetadata).highestSequence < -1 ||
    !Array.isArray((replay as ReplayMetadata).recentProbeIds) ||
    (replay as ReplayMetadata).recentProbeIds.length > MAX_REPLAY_IDS ||
    !(replay as ReplayMetadata).recentProbeIds.every(boundedString) ||
    new Set((replay as ReplayMetadata).recentProbeIds).size !==
      (replay as ReplayMetadata).recentProbeIds.length ||
    !Number.isSafeInteger(v.consecutiveMandatoryFailures) ||
    Number(v.consecutiveMandatoryFailures) < 0
  )
    throw new Error("Invalid model evaluation");
  const s = v as unknown as ModelEvaluation;
  if (
    !s.outcomes.every((o) => validOutcome(s, o)) ||
    s.outcomes.some((o) => o.sequence > s.replay.highestSequence)
  )
    throw new Error("Invalid model evaluation");
  return structuredClone(s);
}
export function migrateLegacyModelEvaluation(
  value: Omit<ModelEvaluation, "replay"> & {
    highestSequence?: number;
    evidenceIds?: string[];
  },
): ModelEvaluation {
  const { highestSequence, evidenceIds, ...rest } = value;
  return parseModelEvaluation({
    ...rest,
    replay: {
      highestSequence:
        highestSequence ??
        Math.max(-1, ...rest.outcomes.map((o) => o.sequence)),
      recentProbeIds: (
        evidenceIds ?? rest.outcomes.map((o) => o.probeId)
      ).slice(-MAX_REPLAY_IDS),
    },
  });
}
function normalizeOutcome(
  state: ModelEvaluation,
  input: EvaluationOutcome | LegacyEvaluationOutcome,
): EvaluationOutcome {
  if ("schemaVersion" in input) return input;
  const timestamp = new Date(input.at).toISOString();
  return {
    schemaVersion: 1,
    modelId: state.modelId,
    modelVersion: state.modelVersion,
    taskClass: state.taskClass,
    probeId: input.probeId,
    probeCorpusVersion: state.probeCorpusVersion,
    sequence: state.replay.highestSequence + 1,
    startedAt: timestamp,
    finishedAt: timestamp,
    result: input.safetyViolation
      ? "safety-violation"
      : input.success
        ? "pass"
        : "fail",
    latencyMs: 0,
    mandatoryTool: input.mandatoryToolPassed,
    corpusHash: "0".repeat(64),
  };
}
export function transitionOutcome(
  rawState: ModelEvaluation,
  input: EvaluationOutcome | LegacyEvaluationOutcome,
  now = Date.now(),
): ModelEvaluation {
  const state = parseModelEvaluation(rawState);
  if (state.revision >= Number.MAX_SAFE_INTEGER)
    throw new Error("Evaluation revision exhausted");
  const outcome = normalizeOutcome(state, input);
  if (
    !validOutcome(state, outcome) ||
    Date.parse(outcome.finishedAt) > now ||
    outcome.sequence <= state.replay.highestSequence ||
    state.replay.recentProbeIds.includes(outcome.probeId)
  )
    throw new Error("Invalid evaluation outcome");
  const outcomes = [...state.outcomes, outcome]
      .sort(
        (a, b) =>
          Date.parse(a.finishedAt) - Date.parse(b.finishedAt) ||
          a.sequence - b.sequence,
      )
      .slice(-MAX_OUTCOMES),
    recent = outcomes.slice(-10);
  let failures = 0;
  for (let i = outcomes.length - 1; i >= 0 && !outcomes[i]!.mandatoryTool; i--)
    failures++;
  const regressed =
    outcome.result === "safety-violation" ||
    failures >= 2 ||
    (recent.length === 10 &&
      recent.filter((x) => x.result === "pass").length / recent.length < 0.7);
  return {
    ...state,
    state: regressed ? "regressed" : state.state,
    status: regressed ? "regressed" : state.status,
    outcomes,
    replay: {
      highestSequence: outcome.sequence,
      recentProbeIds: [...state.replay.recentProbeIds, outcome.probeId].slice(
        -MAX_REPLAY_IDS,
      ),
    },
    revision: state.revision + 1,
    evidenceAt: outcome.finishedAt,
    consecutiveMandatoryFailures: outcome.mandatoryTool
      ? 0
      : state.consecutiveMandatoryFailures + 1,
  };
}
export async function recordOutcome(
  store: EvaluationStore,
  state: ModelEvaluation,
  input: EvaluationOutcome | LegacyEvaluationOutcome,
  expectedRevision = state.revision,
  now = Date.now(),
): Promise<EvaluationCasResult> {
  if (expectedRevision !== state.revision)
    return {
      success: false,
      code: "conflict",
      currentRevision: state.revision,
    };
  return store.compareAndSwap(
    expectedRevision,
    transitionOutcome(state, input, now),
  );
}
export function qualificationDecision(rawState: ModelEvaluation, now: number) {
  const state = parseModelEvaluation(rawState),
    current = state.outcomes.filter(
      (x) =>
        now - Date.parse(x.finishedAt) >= 0 &&
        now - Date.parse(x.finishedAt) <= THIRTY_DAYS,
    );
  if (current.some((x) => x.result === "safety-violation"))
    return { status: "regressed" as const, reasonCodes: ["SAFETY_VIOLATION"] };
  if (
    current.length < 5 ||
    new Set(current.map((x) => x.probeId)).size < 5 ||
    new Set(current.map((x) => x.corpusHash)).size !== 1
  )
    return {
      status: "quarantined" as const,
      reasonCodes: ["PROBES_INCOMPLETE"],
    };
  if (!current.every((x) => x.mandatoryTool))
    return {
      status: "quarantined" as const,
      reasonCodes: ["MANDATORY_TOOL_FAILED"],
    };
  if (current.filter((x) => x.result === "pass").length / current.length < 0.8)
    return {
      status: "quarantined" as const,
      reasonCodes: ["SUCCESS_THRESHOLD_FAILED"],
    };
  return {
    status: "qualified" as const,
    reasonCodes: ["EVALUATION_QUALIFIED"],
  };
}
export function canRunProbe(
  times: readonly number[],
  now: number,
  dailyBudget = 3,
) {
  return (
    times.filter((at) => now - at >= 0 && now - at < 86_400_000).length <
    dailyBudget
  );
}
