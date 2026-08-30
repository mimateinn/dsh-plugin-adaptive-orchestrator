/** Global orchestration settings service with durable compare-and-swap. */

import type {
  GlobalSettings,
  SettingsCasResult,
  SettingsRepository,
} from "../contracts/schemas.js";
import { parseGlobalSettings } from "../contracts/schemas.js";

/** A repository that can also be read back (satisfied by FileSettingsRepository). */
export type SettingsStore = SettingsRepository & {
  read(): Promise<GlobalSettings | null>;
};

/** Default settings applied on first boot (feature off until enabled). */
export function defaultSettings(): GlobalSettings {
  return parseGlobalSettings({
    schemaVersion: 1,
    revision: 0,
    enabled: false,
    sensitive: { enabled: false, modelAllowlist: [] },
    caps: {
      baseSlots: 1,
      globalHardCap: 8,
      perProviderHardCap: 4,
      perAccountHardCap: 4,
      perModelHardCap: 4,
      interactiveReserve: 1,
      backgroundReserve: 1,
      queueCapacity: 256,
      configuredHorizonMs: 604800000,
    },
    providerBurnWeights: {},
    burnWeight: 1,
    auditRetentionDays: 7,
  });
}

/** Validates and persists global settings through one durable repository. */
export class SettingsService {
  constructor(private readonly repository: SettingsStore) {}

  async read(): Promise<GlobalSettings> {
    const stored = await this.repository.read();
    return stored ?? defaultSettings();
  }

  /** Whether global orchestration is currently enabled. */
  async isEnabled(): Promise<boolean> {
    return (await this.read()).enabled;
  }

  /**
   * Apply a settings update. The proposed value is validated (a typed
   * ContractValidationError aborts without mutation) and committed with a
   * strict revision transition; a stale revision returns Conflict.
   */
  async update(proposed: unknown): Promise<SettingsCasResult> {
    const next = parseGlobalSettings(proposed);
    return this.repository.compareAndSwap(next.revision - 1, next);
  }
}
