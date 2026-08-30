import {
  CompatibilityError,
  ContractValidationError,
  type ValidationIssue,
} from "./errors.js";
export interface Caps {
  baseSlots: number;
  globalHardCap: number;
  perProviderHardCap: number;
  perAccountHardCap: number;
  perModelHardCap: number;
  interactiveReserve: number;
  backgroundReserve: number;
  queueCapacity: number;
  configuredHorizonMs: number;
}
export interface SensitivePolicy {
  enabled: boolean;
  modelAllowlist: string[];
}
export interface GlobalSettings {
  schemaVersion: 1;
  revision: number;
  enabled: boolean;
  sensitive: SensitivePolicy;
  caps: Caps;
  providerBurnWeights?: Record<string, number>;
  burnWeight: number;
  auditRetentionDays: number;
}
const issue = (
  path: string,
  safeMessage: string,
  code = "invalid_value",
): ValidationIssue => ({ code, path, message: safeMessage, safeMessage });
const uint = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function assertSchemaVersion(value: unknown): asserts value is 1 {
  if (value !== 1) {
    if (typeof value === "number" && value > 1)
      throw new CompatibilityError(value);
    throw new ContractValidationError([
      issue("/schemaVersion", "schemaVersion must equal 1"),
    ]);
  }
}
export function parseGlobalSettings(value: unknown): GlobalSettings {
  const e: ValidationIssue[] = [];
  if (!object(value))
    throw new ContractValidationError([issue("/", "Expected object")]);
  const allowed = new Set([
    "schemaVersion",
    "revision",
    "enabled",
    "sensitive",
    "caps",
    "providerBurnWeights",
    "burnWeight",
    "auditRetentionDays",
  ]);
  for (const k of Object.keys(value))
    if (!allowed.has(k))
      e.push(issue(`/${k}`, "Unknown property", "unknown_key"));
  assertSchemaVersion(value.schemaVersion);
  if (!uint(value.revision, 0, Number.MAX_SAFE_INTEGER))
    e.push(issue("/revision", "Expected uint64-safe integer"));
  if (typeof value.enabled !== "boolean")
    e.push(issue("/enabled", "Expected boolean"));
  const s = value.sensitive;
  if (
    !object(s) ||
    typeof s.enabled !== "boolean" ||
    !Array.isArray(s.modelAllowlist) ||
    s.modelAllowlist.length > 256 ||
    new Set(s.modelAllowlist).size !== s.modelAllowlist.length
  )
    e.push(issue("/sensitive", "Invalid sensitive policy"));
  const c = value.caps;
  if (!object(c)) e.push(issue("/caps", "Expected caps object"));
  else {
    const ranges: Record<string, [number, number]> = {
      baseSlots: [1, 64],
      globalHardCap: [2, 64],
      perProviderHardCap: [1, 64],
      perAccountHardCap: [1, 64],
      perModelHardCap: [1, 64],
      interactiveReserve: [1, 64],
      backgroundReserve: [1, 64],
      queueCapacity: [1, 4096],
      configuredHorizonMs: [3600000, 2678400000],
    };
    for (const [k, [a, b]] of Object.entries(ranges))
      if (!uint(c[k], a, b))
        e.push(issue(`/caps/${k}`, `Expected integer ${a}..${b}`));
    if (typeof c.globalHardCap === "number") {
      for (const k of [
        "baseSlots",
        "perProviderHardCap",
        "perAccountHardCap",
        "perModelHardCap",
      ])
        if (Number(c[k]) > c.globalHardCap)
          e.push(issue(`/caps/${k}`, "Must not exceed globalHardCap"));
      if (
        Number(c.interactiveReserve) + Number(c.backgroundReserve) >
        c.globalHardCap
      )
        e.push(issue("/caps", "Reserve sum exceeds globalHardCap"));
    }
  }
  if (!uint(value.burnWeight, 0, 4))
    e.push(issue("/burnWeight", "Expected number 0..4"));
  if (!uint(value.auditRetentionDays, 1, 30))
    e.push(issue("/auditRetentionDays", "Expected integer 1..30"));
  if (e.length) throw new ContractValidationError(e);
  return value as unknown as GlobalSettings;
}
export function compareAndSwap<T extends { revision: number }>(
  current: T,
  expectedRevision: number,
  update: ((value: T) => T) | T,
):
  | { success: true; value: T }
  | { success: false; code: "conflict"; currentRevision: number } {
  if (
    !Number.isSafeInteger(current.revision) ||
    !Number.isSafeInteger(expectedRevision) ||
    current.revision !== expectedRevision ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    return {
      success: false,
      code: "conflict",
      currentRevision: current.revision,
    };
  const next =
    typeof update === "function"
      ? (update as (value: T) => T)(structuredClone(current))
      : update;
  return { success: true, value: { ...next, revision: expectedRevision + 1 } };
}
export interface RouteRequirements {
  schemaVersion: 1;
  taskClass: string;
  requiredCapabilityIds: string[];
  requiredToolIds: string[];
  requiredModalities: string[];
  inputContextTokens: number;
  expectedOutputTokens: number;
  contextSafetyReserveTokens: number;
  minimumContextTokens: number;
  sensitive: boolean;
  allowedModelIds: string[];
}
export function validateGlobalSettings(value: unknown) {
  try {
    const input = value as Record<string, unknown>;
    const caps = {
      baseSlots: 1,
      globalHardCap: 8,
      perProviderHardCap: 4,
      perAccountHardCap: 4,
      perModelHardCap: 4,
      interactiveReserve: 1,
      backgroundReserve: 1,
      queueCapacity: 256,
      configuredHorizonMs: 604800000,
      ...(object(input?.caps) ? input.caps : {}),
    };
    return {
      success: true as const,
      data: parseGlobalSettings({
        ...input,
        caps,
        burnWeight: input?.burnWeight ?? 1,
        auditRetentionDays: input?.auditRetentionDays ?? 7,
      }),
    };
  } catch (error) {
    const errors =
      error instanceof ContractValidationError
        ? error.issues
        : [issue("/", "Invalid value")];
    return {
      success: false as const,
      errors: errors.map((x) =>
        x.path === "/caps" ? { ...x, code: "invariant" } : x,
      ),
    };
  }
}
export function negotiateSchemaVersion(actual: number, supported: number) {
  return actual <= supported
    ? { success: true as const, version: actual }
    : {
        success: false as const,
        errors: [
          issue(
            "/schemaVersion",
            "Unsupported schema version",
            "unsupported_version",
          ),
        ],
      };
}
export function validateRouteRequirements(value: unknown) {
  try {
    return { success: true as const, data: parseRouteRequirements(value) };
  } catch (error) {
    const errors =
      error instanceof ContractValidationError
        ? error.issues
        : [issue("/", "Invalid value")];
    return {
      success: false as const,
      errors: errors.map((x) =>
        x.path === "/minimumContextTokens" ? { ...x, code: "invariant" } : x,
      ),
    };
  }
}
export interface QuotaWindow {
  quotaClass: string;
  usedPercent?: number;
  resetsAt?: string;
}
export interface QuotaSnapshot {
  schemaVersion: 1;
  provider: string;
  account: string;
  quotaClass: string;
  supported: boolean;
  observedAt: string;
  source: string;
  confidence: "high" | "medium" | "low";
  model?: string;
  plan?: string;
  usedPercent?: number;
  resetsAt?: string;
  windows?: QuotaWindow[];
}
const quotaString = (value: unknown) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 200 &&
  value.trim() === value;
const rfc3339 = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const percent = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;
export function validateQuotaSnapshot(value: unknown) {
  const errors: ValidationIssue[] = [];
  if (!object(value)) errors.push(issue("/", "Expected object"));
  else {
    const allowed = new Set([
      "schemaVersion",
      "provider",
      "account",
      "quotaClass",
      "supported",
      "observedAt",
      "source",
      "confidence",
      "model",
      "plan",
      "usedPercent",
      "resetsAt",
      "windows",
    ]);
    for (const key of Object.keys(value))
      if (!allowed.has(key))
        errors.push(issue(`/${key}`, "Unknown property", "unknown_key"));
    if (value.schemaVersion !== 1)
      errors.push(issue("/schemaVersion", "schemaVersion must equal 1"));
    for (const key of ["provider", "account", "quotaClass", "source"])
      if (!quotaString(value[key]))
        errors.push(issue(`/${key}`, "Expected trimmed string"));
    for (const key of ["model", "plan"])
      if (value[key] !== undefined && !quotaString(value[key]))
        errors.push(issue(`/${key}`, "Expected trimmed string"));
    if (typeof value.supported !== "boolean")
      errors.push(issue("/supported", "Expected boolean"));
    if (!rfc3339(value.observedAt))
      errors.push(issue("/observedAt", "Expected RFC3339 UTC timestamp"));
    if (!(["high", "medium", "low"] as unknown[]).includes(value.confidence))
      errors.push(issue("/confidence", "Expected high, medium, or low"));
    if (value.usedPercent !== undefined && !percent(value.usedPercent))
      errors.push(issue("/usedPercent", "Expected finite percentage 0..100"));
    if (value.resetsAt !== undefined && !rfc3339(value.resetsAt))
      errors.push(issue("/resetsAt", "Expected RFC3339 UTC timestamp"));
    if (value.windows !== undefined) {
      if (!Array.isArray(value.windows) || value.windows.length > 32)
        errors.push(issue("/windows", "Expected at most 32 windows"));
      else
        value.windows.forEach((window, index) => {
          const path = `/windows/${index}`;
          if (!object(window))
            return errors.push(issue(path, "Expected object"));
          const windowAllowed = new Set([
            "quotaClass",
            "usedPercent",
            "resetsAt",
          ]);
          for (const key of Object.keys(window))
            if (!windowAllowed.has(key))
              errors.push(
                issue(`${path}/${key}`, "Unknown property", "unknown_key"),
              );
          if (!quotaString(window.quotaClass))
            errors.push(issue(`${path}/quotaClass`, "Expected trimmed string"));
          if (window.usedPercent !== undefined && !percent(window.usedPercent))
            errors.push(
              issue(`${path}/usedPercent`, "Expected finite percentage 0..100"),
            );
          if (window.resetsAt !== undefined && !rfc3339(window.resetsAt))
            errors.push(
              issue(`${path}/resetsAt`, "Expected RFC3339 UTC timestamp"),
            );
        });
    }
  }
  return errors.length
    ? { success: false as const, errors }
    : { success: true as const, data: value as QuotaSnapshot };
}
export function validateQuotaSnapshots(values: readonly unknown[]) {
  return values.map(validateQuotaSnapshot);
}
export function parseRouteRequirements(v: unknown): RouteRequirements {
  if (!object(v))
    throw new ContractValidationError([issue("/", "Expected object")]);
  assertSchemaVersion(v.schemaVersion);
  const fields = [
    "inputContextTokens",
    "expectedOutputTokens",
    "contextSafetyReserveTokens",
    "minimumContextTokens",
  ] as const;
  const e: ValidationIssue[] = [];
  for (const f of fields)
    if (!uint(v[f], 0, 10000000))
      e.push(issue(`/${f}`, "Expected token count 0..10000000"));
  const sum =
    Number(v.inputContextTokens) +
    Number(v.expectedOutputTokens) +
    Number(v.contextSafetyReserveTokens);
  if (!Number.isSafeInteger(sum) || v.minimumContextTokens !== sum)
    e.push(issue("/minimumContextTokens", "Must equal checked token sum"));
  if (e.length) throw new ContractValidationError(e);
  return v as unknown as RouteRequirements;
}
