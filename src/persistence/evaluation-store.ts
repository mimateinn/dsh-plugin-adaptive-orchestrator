import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  parseModelEvaluation,
  type EvaluationCasResult,
  type EvaluationStore,
  type ModelEvaluation,
} from "../evaluation/index.js";
import {
  assertRevisionTransition,
  atomicWriteJson,
  acquireReleaseLock,
  canonicalStorePath,
  readBoundedJson,
  serialized,
  PersistenceCorruptionError,
} from "./atomic-json.js";

export interface EvaluationIdentity {
  modelId: string;
  modelVersion: string;
  taskClass: string;
}
const key = (identity: EvaluationIdentity) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        identity.modelId,
        identity.modelVersion,
        identity.taskClass,
      ]),
    )
    .digest("hex");
export class FileEvaluationStore implements EvaluationStore {
  constructor(private readonly profileDirectory: string) {}
  pathFor(identity: EvaluationIdentity): string {
    return join(
      this.profileDirectory,
      "adaptive-orchestrator",
      "evaluations",
      `${key(identity)}.json`,
    );
  }
  private async readValidated(
    path: string,
    identity: EvaluationIdentity,
  ): Promise<ModelEvaluation | null> {
    const value = await readBoundedJson(path, parseModelEvaluation);
    if (
      value &&
      (value.modelId !== identity.modelId ||
        value.modelVersion !== identity.modelVersion ||
        value.taskClass !== identity.taskClass)
    )
      throw new PersistenceCorruptionError(path);
    return value;
  }
  async read(identity: EvaluationIdentity): Promise<ModelEvaluation | null> {
    const path = await canonicalStorePath(this.pathFor(identity));
    return serialized(path, () => this.readValidated(path, identity));
  }
  compareAndSwap(
    expectedRevision: number,
    next: ModelEvaluation,
  ): Promise<EvaluationCasResult> {
    const value = parseModelEvaluation(next);
    return canonicalStorePath(this.pathFor(value)).then((path) =>
      serialized(path, () =>
        acquireReleaseLock(path, async () => {
          const current = await this.readValidated(path, value);
          const revision = current?.revision ?? 0;
          assertRevisionTransition(revision, expectedRevision, value.revision);
          if (revision !== expectedRevision)
            return {
              success: false,
              code: "conflict",
              currentRevision: revision,
            };
          await atomicWriteJson(path, value);
          return { success: true, value };
        }),
      ),
    );
  }
}
