import { canonicalJson, canonicalSha256 } from "../contracts/index.js";
export type AuditReasonCode =
  | "EVALUATION_QUALIFIED"
  | "PROBES_INCOMPLETE"
  | "MANDATORY_TOOL_FAILED"
  | "SUCCESS_THRESHOLD_FAILED"
  | "SAFETY_VIOLATION"
  | "AUDIT_STORE_CORRUPTED";
export interface AuditEvent {
  eventId: string;
  timestamp: string;
  kind: "route" | "evaluation" | "scheduler" | "diagnostic";
  reasonCodes: AuditReasonCode[];
  routeHash: string;
  normalizedMetrics: Record<string, number>;
}
interface AuditEnvelope {
  schemaVersion: 1;
  records: readonly AuditEvent[];
  checksum: string;
}
const MAX_BYTES = 16 * 1024,
  MAX_RECORDS = 10_000,
  DAY = 86_400_000;
const codes = new Set<AuditReasonCode>([
    "EVALUATION_QUALIFIED",
    "PROBES_INCOMPLETE",
    "MANDATORY_TOOL_FAILED",
    "SUCCESS_THRESHOLD_FAILED",
    "SAFETY_VIOLATION",
    "AUDIT_STORE_CORRUPTED",
  ]),
  kinds = new Set(["route", "evaluation", "scheduler", "diagnostic"]);
const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const string = (x: unknown) =>
  typeof x === "string" && x.length > 0 && x.length <= 200 && x.trim() === x;
const rfc3339Utc = (x: unknown) =>
  typeof x === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(x) &&
  Number.isFinite(Date.parse(x));
function validEvent(x: unknown): x is AuditEvent {
  if (
    !object(x) ||
    Object.keys(x).some(
      (k) =>
        ![
          "eventId",
          "timestamp",
          "kind",
          "reasonCodes",
          "routeHash",
          "normalizedMetrics",
        ].includes(k),
    )
  )
    return false;
  if (
    !string(x.eventId) ||
    !rfc3339Utc(x.timestamp) ||
    !kinds.has(x.kind as string) ||
    !Array.isArray(x.reasonCodes) ||
    x.reasonCodes.length > 32 ||
    !x.reasonCodes.every((c) => codes.has(c as AuditReasonCode)) ||
    typeof x.routeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(x.routeHash) ||
    !object(x.normalizedMetrics)
  )
    return false;
  return (
    Object.keys(x.normalizedMetrics).length <= 32 &&
    Object.entries(x.normalizedMetrics).every(
      ([k, v]) =>
        string(k) &&
        typeof v === "number" &&
        Number.isFinite(v) &&
        v >= 0 &&
        v <= 1,
    )
  );
}
export function createAuditEvent(input: {
  eventId?: string;
  timestamp?: string;
  at?: number;
  kind: AuditEvent["kind"];
  reasonCodes: string[];
  routeId: string;
  salt: string;
  normalizedMetrics?: Record<string, number>;
}): AuditEvent {
  const allowed = new Set([
    "eventId",
    "timestamp",
    "at",
    "kind",
    "reasonCodes",
    "routeId",
    "salt",
    "normalizedMetrics",
  ]);
  if (Object.keys(input).some((k) => !allowed.has(k)))
    throw new Error("Prohibited audit field");
  const timestamp =
    input.timestamp ??
    (Number.isFinite(input.at) ? new Date(input.at!).toISOString() : undefined);
  const event = {
    eventId:
      input.eventId ??
      canonicalSha256({
        timestamp,
        kind: input.kind,
        reasonCodes: input.reasonCodes,
        routeId: input.routeId,
      }).slice(0, 32),
    timestamp,
    kind: input.kind,
    reasonCodes: input.reasonCodes as AuditReasonCode[],
    routeHash: canonicalSha256(input.salt + "\0" + input.routeId),
    normalizedMetrics: input.normalizedMetrics ?? {},
  };
  if (
    !validEvent(event) ||
    new TextEncoder().encode(canonicalJson(event)).length > MAX_BYTES
  )
    throw new Error("Invalid audit event");
  return event;
}
export function appendAudit(
  records: readonly AuditEvent[],
  event: AuditEvent,
  now: number,
  retentionDays = 7,
): AuditEvent[] {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 30
  )
    throw new Error("Invalid audit retention days");
  if (!validEvent(event) || Date.parse(event.timestamp) > now)
    throw new Error("Invalid audit event");
  return [...records, event]
    .filter((x) => now - Date.parse(x.timestamp) <= retentionDays * DAY)
    .slice(-MAX_RECORDS);
}
export function encodeAuditStore(records: readonly AuditEvent[]): string {
  if (records.length > MAX_RECORDS || !records.every(validEvent))
    throw new Error("Invalid audit store");
  const payload = { schemaVersion: 1 as const, records };
  const envelope: AuditEnvelope = {
    ...payload,
    checksum: canonicalSha256(payload),
  };
  const raw = canonicalJson(envelope);
  if (new TextEncoder().encode(raw).length > MAX_RECORDS * MAX_BYTES)
    throw new Error("Audit store too large");
  return raw;
}
export function parseAuditStore(
  raw: string,
  now = Date.now(),
): {
  records: AuditEvent[];
  corrupted: boolean;
  degraded: boolean;
  action: "none" | "rotate";
} {
  try {
    if (new TextEncoder().encode(raw).length > MAX_RECORDS * MAX_BYTES)
      throw new Error();
    const x: unknown = JSON.parse(raw);
    if (
      !object(x) ||
      Object.keys(x).some(
        (k) => !["schemaVersion", "records", "checksum"].includes(k),
      ) ||
      x.schemaVersion !== 1 ||
      !Array.isArray(x.records) ||
      x.records.length > MAX_RECORDS ||
      !x.records.every(validEvent) ||
      x.records.some((record) => Date.parse(record.timestamp) > now) ||
      typeof x.checksum !== "string" ||
      x.checksum !== canonicalSha256({ schemaVersion: 1, records: x.records })
    )
      throw new Error();
    return {
      records: x.records,
      corrupted: false,
      degraded: false,
      action: "none",
    };
  } catch {
    return { records: [], corrupted: true, degraded: true, action: "rotate" };
  }
}
