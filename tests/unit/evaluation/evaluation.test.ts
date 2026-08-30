import { describe, expect, it } from "vitest";
import {
  createEvaluation,
  recordOutcome,
  qualificationDecision,
  canRunProbe,
} from "../../../src/evaluation/index.js";
import type { ModelEvaluation } from "../../../src/evaluation/index.js";

const day = 86_400_000,
  now = Date.parse("2026-08-30T12:00:00Z");
const probe = (
  i: number,
  success = true,
  mandatoryToolPassed = true,
  safetyViolation = false,
) => ({
  probeId: `p${i}`,
  at: now + i,
  success,
  mandatoryToolPassed,
  safetyViolation,
  kind: "probe" as const,
});

describe("model evaluation", () => {
  it("quarantines each model-version/task-class identity until five probes qualify", () => {
    let s = createEvaluation("m", "v1", "code");
    for (let i = 0; i < 5; i++) s = recordOutcome(s, probe(i));
    expect(qualificationDecision(s, now + 10)).toMatchObject({
      status: "qualified",
      reasonCodes: ["EVALUATION_QUALIFIED"],
    });
    expect(createEvaluation("m", "v2", "code").status).toBe("quarantined");
    expect(createEvaluation("m", "v1", "research").status).toBe("quarantined");
  });
  it("requires 100% mandatory tools, 80% success and zero safety violations", () => {
    let tools = createEvaluation("m", "v", "code");
    [true, true, true, true, false].forEach(
      (ok, i) => (tools = recordOutcome(tools, probe(i, true, ok))),
    );
    expect(qualificationDecision(tools, now + 10).status).toBe("quarantined");
    let success = createEvaluation("m", "v", "code");
    [true, true, true, false, false].forEach(
      (ok, i) => (success = recordOutcome(success, probe(i, ok))),
    );
    expect(qualificationDecision(success, now + 10).status).toBe("quarantined");
    expect(
      qualificationDecision(
        recordOutcome(
          createEvaluation("m", "v", "code"),
          probe(0, true, true, true),
        ),
        now,
      ).status,
    ).toBe("regressed");
  });
  it("expires evidence after 30 days", () => {
    let s = createEvaluation("m", "v", "code");
    for (let i = 0; i < 5; i++) s = recordOutcome(s, probe(i));
    expect(qualificationDecision(s, now + 30 * day + 5).status).toBe(
      "quarantined",
    );
  });
  it("demotes with hysteresis: two mandatory failures or below 70% of latest ten", () => {
    let s = createEvaluation("m", "v", "code");
    for (let i = 0; i < 5; i++) s = recordOutcome(s, probe(i));
    s = { ...s, status: "qualified" };
    s = recordOutcome(s, {
      ...probe(6),
      kind: "production",
      mandatoryToolPassed: false,
    });
    expect(s.status).toBe("qualified");
    s = recordOutcome(s, {
      ...probe(7),
      kind: "production",
      mandatoryToolPassed: false,
    });
    expect(s.status).toBe("regressed");
    let t: ModelEvaluation = {
      ...createEvaluation("m", "v", "code"),
      status: "qualified",
    };
    for (let i = 0; i < 10; i++)
      t = recordOutcome(t, { ...probe(i, i < 6), kind: "production" });
    expect(t.status).toBe("regressed");
  });
  it("enforces default provider daily probe budget of three", () =>
    expect(canRunProbe([now, now + 1, now + 2], now + 3)).toBe(false));
});
