/// <reference types="node" />
import { createHash } from "node:crypto";
import type { RouteRequirements } from "./schemas.js";

function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function canonical(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (!validUnicode(value))
      throw new TypeError("JCS requires valid Unicode scalar values");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JCS requires finite I-JSON numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported JCS value");
  if (seen.has(value))
    throw new TypeError("JCS does not support cyclic values");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return "[" + value.map((x) => canonical(x, seen)).join(",") + "]";
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const key of keys)
      if (!validUnicode(key))
        throw new TypeError("JCS requires valid Unicode property names");
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonical(record[k], seen))
        .join(",") +
      "}"
    );
  } finally {
    seen.delete(value);
  }
}
export function canonicalJson(value: unknown): string {
  return canonical(value, new Set());
}
export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}
export const sha256Canonical = canonicalSha256;
export interface AdmissionPayload {
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  kind: "subagent" | "agent-team-member";
  parentAgentId: string;
  lane: "interactive" | "background";
  routeRequirements: RouteRequirements;
  deficitCost: number;
}
export type AdmissionPayloadInput = AdmissionPayload & { createdAt?: string };
export function buildAdmissionPayload(
  input: AdmissionPayloadInput,
): AdmissionPayload {
  return {
    schemaVersion: input.schemaVersion,
    requestId: input.requestId,
    attemptId: input.attemptId,
    kind: input.kind,
    parentAgentId: input.parentAgentId,
    lane: input.lane,
    routeRequirements: structuredClone(input.routeRequirements),
    deficitCost: input.deficitCost,
  };
}
export function hashAdmissionPayload(input: AdmissionPayloadInput): string {
  return canonicalSha256(buildAdmissionPayload(input));
}
