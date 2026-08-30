import { describe, expect, it } from "vitest";
import {
  createEvaluation,
  migrateLegacyModelEvaluation,
  parseModelEvaluation,
  qualificationDecision,
  recordOutcome,
  transitionOutcome,
  type EvaluationOutcome,
  type EvaluationStore,
  type ModelEvaluation,
} from "../../../src/evaluation/index.js";
const now = Date.parse("2026-08-30T12:00:00Z"),
  hash = "a".repeat(64);
const outcome = (i: number): EvaluationOutcome => ({
  schemaVersion: 1,
  modelId: "m",
  modelVersion: "v1",
  taskClass: "code",
  probeId: `p${i}`,
  probeCorpusVersion: "c1",
  sequence: i,
  startedAt: new Date(now + i * 2).toISOString(),
  finishedAt: new Date(now + i * 2 + 1).toISOString(),
  result: "pass",
  latencyMs: 1,
  mandatoryTool: true,
  corpusHash: hash,
});
const fresh = () =>
  createEvaluation("m", "v1", "code", "c1", new Date(now).toISOString());
class MemoryStore implements EvaluationStore {
  constructor(private value: ModelEvaluation) {}
  async compareAndSwap(expectedRevision: number, next: ModelEvaluation) {
    if (this.value.revision !== expectedRevision)
      return {
        success: false as const,
        code: "conflict" as const,
        currentRevision: this.value.revision,
      };
    this.value = structuredClone(next);
    return { success: true as const, value: structuredClone(this.value) };
  }
  read() {
    return structuredClone(this.value);
  }
}
describe("model evaluation", () => {
  it("retains pure transitions and qualifies deterministic probes", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) s = transitionOutcome(s, outcome(i), now + 20);
    expect(qualificationDecision(s, now + 20).status).toBe("qualified");
  });
  it("allows only one of two concurrent stale writers", async () => {
    const initial = fresh(),
      store = new MemoryStore(initial);
    const results = await Promise.all([
      recordOutcome(store, initial, outcome(0), 0, now + 20),
      recordOutcome(store, initial, outcome(1), 0, now + 20),
    ]);
    expect(results.filter((x) => x.success)).toHaveLength(1);
    expect(store.read().revision).toBe(1);
  });
  it("requires closed bounded replay metadata on restore", () => {
    const valid = fresh();
    const missing = structuredClone(valid) as Partial<ModelEvaluation>;
    delete missing.replay;
    expect(() => parseModelEvaluation(missing)).toThrow();
    expect(parseModelEvaluation(valid)).toEqual(valid);
    expect(() =>
      parseModelEvaluation({
        ...valid,
        replay: {
          highestSequence: -1,
          recentProbeIds: Array.from({ length: 101 }, (_, i) => `p${i}`),
        },
      }),
    ).toThrow();
    expect(() =>
      parseModelEvaluation({
        ...valid,
        replay: { highestSequence: -1, recentProbeIds: [" bad "] },
      }),
    ).toThrow();
    expect(() => parseModelEvaluation({ ...valid, extra: true })).toThrow();
  });
  it("migrates legacy replay fields only through explicit migration", () => {
    const current = fresh();
    const legacy = { ...current, highestSequence: -1, evidenceIds: [] };
    delete (legacy as Partial<ModelEvaluation>).replay;
    expect(migrateLegacyModelEvaluation(legacy as never).replay).toEqual({
      highestSequence: -1,
      recentProbeIds: [],
    });
  });
  it("rejects revision exhaustion before store delegation", async () => {
    const exhausted = { ...fresh(), revision: Number.MAX_SAFE_INTEGER };
    let calls = 0;
    const store: EvaluationStore = {
      async compareAndSwap() {
        calls++;
        return { success: true, value: exhausted };
      },
    };
    await expect(
      recordOutcome(store, exhausted, outcome(0), exhausted.revision, now + 20),
    ).rejects.toThrow("revision exhausted");
    expect(calls).toBe(0);
  });
  it("rejects replay and malformed outcomes", () => {
    const s = fresh(),
      once = transitionOutcome(s, outcome(0), now + 20);
    expect(() => transitionOutcome(once, outcome(0), now + 20)).toThrow();
    expect(() =>
      transitionOutcome(
        s,
        { ...outcome(0), probeId: "x".repeat(201) },
        now + 20,
      ),
    ).toThrow();
    expect(() =>
      transitionOutcome(s, { ...outcome(0), extra: true } as never, now + 20),
    ).toThrow();
  });
});
