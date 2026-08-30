import { describe, expect, it } from "vitest";
import {
  canRunProbe,
  createEvaluation,
  qualificationDecision,
  recordOutcome,
} from "../../../src/evaluation/index.js";
import type {
  EvaluationOutcome,
  ModelEvaluation,
} from "../../../src/evaluation/index.js";
const now = Date.parse("2026-08-30T12:00:00Z"),
  hash = "a".repeat(64);
const outcome = (
  i: number,
  result: EvaluationOutcome["result"] = "pass",
  mandatoryTool = true,
): EvaluationOutcome => ({
  schemaVersion: 1,
  modelId: "m",
  modelVersion: "v1",
  taskClass: "code",
  probeId: `p${i}`,
  probeCorpusVersion: "c1",
  sequence: i,
  startedAt: new Date(now + i * 2).toISOString(),
  finishedAt: new Date(now + i * 2 + 1).toISOString(),
  result,
  latencyMs: 1,
  mandatoryTool,
  corpusHash: hash,
});
const fresh = () =>
  createEvaluation("m", "v1", "code", "c1", new Date(now).toISOString());
describe("model evaluation", () => {
  it("qualifies five distinct same-corpus probes", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++)
      s = recordOutcome(s, outcome(i), s.revision, now + 20);
    expect(qualificationDecision(s, now + 20).status).toBe("qualified");
    expect(() => recordOutcome(s, outcome(4), s.revision, now + 20)).toThrow();
    expect(createEvaluation("m", "v2", "code", "c1").state).toBe("quarantined");
  });
  it("enforces gates, expiry and hysteresis", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++)
      s = recordOutcome(
        s,
        outcome(i, i === 4 ? "fail" : "pass", i !== 4),
        s.revision,
        now + 20,
      );
    expect(qualificationDecision(s, now + 20).status).toBe("quarantined");
    expect(qualificationDecision(s, now + 31 * 86_400_000).status).toBe(
      "quarantined",
    );
    let q: ModelEvaluation = { ...fresh(), state: "qualified" };
    q = recordOutcome(q, outcome(0, "pass", false), q.revision, now + 20);
    expect(q.state).toBe("qualified");
    q = recordOutcome(q, outcome(1, "pass", false), q.revision, now + 20);
    expect(q.state).toBe("regressed");
    let safety: ModelEvaluation = { ...fresh(), state: "qualified" };
    safety = recordOutcome(
      safety,
      outcome(0, "safety-violation"),
      safety.revision,
      now + 20,
    );
    expect(safety.state).toBe("regressed");
  });
  it("rejects stale, future, mismatched evidence and bounds history", () => {
    const s = fresh();
    expect(() => recordOutcome(s, outcome(0), 1, now + 20)).toThrow("Conflict");
    expect(() =>
      recordOutcome(s, { ...outcome(0), modelVersion: "other" }, 0, now + 20),
    ).toThrow();
    expect(() => recordOutcome(s, outcome(0), 0, now)).toThrow();
    let many = fresh();
    for (let i = 0; i < 101; i++)
      many = recordOutcome(many, outcome(i), many.revision, now + 1000);
    expect(many.outcomes).toHaveLength(100);
    expect(() =>
      recordOutcome(many, outcome(0), many.revision, now + 1000),
    ).toThrow();
    const restored = structuredClone(many);
    expect(() =>
      recordOutcome(restored, outcome(0), restored.revision, now + 1000),
    ).toThrow();
    expect(() =>
      recordOutcome(
        many,
        { ...outcome(101), extra: true } as never,
        many.revision,
        now + 1000,
      ),
    ).toThrow();
  });
  it("rejects mixed corpus hashes and leaves state unchanged on CAS conflict", () => {
    let state = fresh();
    state = recordOutcome(state, outcome(0), state.revision, now + 20);
    const snapshot = structuredClone(state);
    expect(() => recordOutcome(state, outcome(1), 0, now + 20)).toThrow(
      "Conflict",
    );
    expect(state).toEqual(snapshot);
    for (let i = 1; i < 5; i++)
      state = recordOutcome(
        state,
        { ...outcome(i), corpusHash: i === 4 ? "b".repeat(64) : hash },
        state.revision,
        now + 20,
      );
    expect(qualificationDecision(state, now + 20)).toMatchObject({
      status: "quarantined",
      reasonCodes: ["PROBES_INCOMPLETE"],
    });
  });
  it("enforces default daily budget and ignores future budget timestamps", () => {
    expect(canRunProbe([now, now + 1, now + 2], now + 3)).toBe(false);
    expect(canRunProbe([now + 10], now)).toBe(true);
  });
});
