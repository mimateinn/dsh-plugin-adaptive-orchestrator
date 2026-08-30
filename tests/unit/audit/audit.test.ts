import { describe, expect, it } from "vitest";
import {
  appendAudit,
  createAuditEvent,
  encodeAuditStore,
  parseAuditStore,
} from "../../../src/audit/index.js";
const event = (i = 0) =>
  createAuditEvent({
    eventId: `e${i}`,
    timestamp: new Date(i).toISOString(),
    kind: "route",
    reasonCodes: [],
    routeId: `r${i}`,
    salt: "s",
    normalizedMetrics: { pressure: 0.5 },
  });
describe("privacy-safe audit", () => {
  it("creates exact closed-schema privacy-safe events", () => {
    const e = event();
    expect(e.routeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(e)).not.toContain("r0");
    expect(() =>
      createAuditEvent({
        eventId: "e",
        timestamp: new Date(0).toISOString(),
        kind: "route",
        reasonCodes: [],
        routeId: "r",
        salt: "s",
        prompt: "secret",
      } as never),
    ).toThrow();
    expect(() =>
      createAuditEvent({
        eventId: "e",
        timestamp: new Date(0).toISOString(),
        kind: "route",
        reasonCodes: [],
        routeId: "r",
        salt: "s",
        normalizedMetrics: { pressure: 2 },
      }),
    ).toThrow();
  });
  it("rejects non-UTC and future timestamps", () => {
    expect(() =>
      createAuditEvent({
        eventId: "offset",
        timestamp: "2026-01-01T01:00:00+01:00",
        kind: "route",
        reasonCodes: [],
        routeId: "r",
        salt: "s",
      }),
    ).toThrow();
    const future = createAuditEvent({
      eventId: "future",
      timestamp: "2030-01-01T00:00:00Z",
      kind: "route",
      reasonCodes: [],
      routeId: "r",
      salt: "s",
    });
    expect(() =>
      appendAudit([], future, Date.parse("2029-01-01T00:00:00Z")),
    ).toThrow();
    expect(
      parseAuditStore(
        encodeAuditStore([future]),
        Date.parse("2029-01-01T00:00:00Z"),
      ),
    ).toMatchObject({ corrupted: true, degraded: true, action: "rotate" });
  });
  it("round trips a bounded checksummed envelope", () => {
    const raw = encodeAuditStore([event()]);
    expect(parseAuditStore(raw)).toEqual({
      records: [event()],
      corrupted: false,
      degraded: false,
      action: "none",
    });
  });
  it("rotates and degrades on checksum, schema, event, and size corruption", () => {
    const raw = encodeAuditStore([event()]);
    for (const bad of [
      "{bad",
      raw.replace(
        /"checksum":"[a-f0-9]+"/,
        '"checksum":"0000000000000000000000000000000000000000000000000000000000000000"',
      ),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ prompt: "secret" }],
        checksum: "x",
      }),
      "x".repeat(10_000 * 16 * 1024 + 1),
    ])
      expect(parseAuditStore(bad)).toMatchObject({
        records: [],
        corrupted: true,
        degraded: true,
        action: "rotate",
      });
  });
  it("rejects canonical-envelope tampering and unknown event fields", () => {
    const parsed = JSON.parse(encodeAuditStore([event()])) as Record<
      string,
      unknown
    >;
    const records = parsed.records as Array<Record<string, unknown>>;
    records[0] = { ...records[0], prompt: "secret" };
    expect(parseAuditStore(JSON.stringify(parsed))).toMatchObject({
      records: [],
      corrupted: true,
      degraded: true,
      action: "rotate",
    });
    expect(() =>
      createAuditEvent({
        eventId: "e",
        timestamp: new Date(0).toISOString(),
        kind: "route",
        reasonCodes: ["free text"],
        routeId: "r",
        salt: "s",
      }),
    ).toThrow();
  });
  it("uses the salt as part of the route pseudonym", () => {
    const first = event();
    const second = createAuditEvent({
      eventId: "e2",
      timestamp: new Date(0).toISOString(),
      kind: "route",
      reasonCodes: [],
      routeId: "r0",
      salt: "other",
    });
    expect(second.routeHash).not.toBe(first.routeHash);
  });
  it("honors configurable retention while defaulting to seven days", () => {
    const day = 86_400_000;
    const twoDaysOld = event(day);
    const current = event(3 * day);

    expect(appendAudit([twoDaysOld], current, 3 * day, 1)).toEqual([current]);
    expect(appendAudit([twoDaysOld], current, 3 * day)).toEqual([
      twoDaysOld,
      current,
    ]);
    expect(appendAudit([twoDaysOld], current, 3 * day, 7)).toEqual([
      twoDaysOld,
      current,
    ]);
  });
  it("rejects invalid retention days", () => {
    for (const retentionDays of [0, 31, 1.5, Number.NaN])
      expect(() => appendAudit([], event(), 0, retentionDays)).toThrow();
  });
  it("retains at most ten thousand records", () => {
    const xs = Array.from({ length: 10_005 }, (_, i) => event(i));
    expect(appendAudit(xs.slice(0, -1), xs.at(-1)!, 10_005)).toHaveLength(
      10_000,
    );
  });
});
