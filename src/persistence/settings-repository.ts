import { join } from "node:path";
import {
  parseGlobalSettings,
  type GlobalSettings,
  type SettingsCasResult,
  type SettingsRepository,
} from "../contracts/schemas.js";
import {
  assertRevisionTransition,
  atomicWriteJson,
  acquireReleaseLock,
  canonicalStorePath,
  readBoundedJson,
  serialized,
} from "./atomic-json.js";

export class FileSettingsRepository implements SettingsRepository {
  readonly path: string;
  constructor(profileDirectory: string) {
    this.path = join(
      profileDirectory,
      "adaptive-orchestrator",
      "settings.json",
    );
  }
  async read(): Promise<GlobalSettings | null> {
    const path = await canonicalStorePath(this.path);
    return serialized(path, () => readBoundedJson(path, parseGlobalSettings));
  }
  compareAndSwap(
    expectedRevision: number,
    next: GlobalSettings,
  ): Promise<SettingsCasResult> {
    const value = parseGlobalSettings(next);
    return canonicalStorePath(this.path).then((path) =>
      serialized(path, () =>
        acquireReleaseLock(path, async () => {
          const current = await readBoundedJson(path, parseGlobalSettings);
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
