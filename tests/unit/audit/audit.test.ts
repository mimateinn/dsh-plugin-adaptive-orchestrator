import { describe, expect, it } from "vitest";
import {
  appendAudit,
  createAuditEvent,
  parseAuditStore,
} from "../../../src/audit/index.js";

describe("privacy-safe audit", () => {
  it("stores only normalized reason codes and salted route hashes", () => {
    const e = createAuditEvent({
      at: 1,
      kind: "route",
      reasonCodes: ["EVALUATION_QUALIFIED"],
      routeId: "account:model",
      salt: "secret",
    });
    expect(e.routeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(e)).not.toContain("account:model");
    expect(() =>
      createAuditEvent({
        at: 1,
        kind: "route",
        reasonCodes: ["free text"],
        routeId: "r",
        salt: "s",
      }),
    ).toThrow();
  });
  it("rejects prohibited raw fields", () =>
    expect(() =>
      createAuditEvent({
        at: 1,
        kind: "route",
        reasonCodes: [],
        routeId: "r",
        salt: "s",
        prompt: "secret",
      } as never),
    ).toThrow());
  it("retains the smaller of seven days and 10000 records", () => {
    let xs = [] as ReturnType<typeof createAuditEvent>[];
    for (let i = 0; i < 10_005; i++)
      xs = appendAudit(
        xs,
        createAuditEvent({
          at: i,
          kind: "route",
          reasonCodes: [],
          routeId: String(i),
          salt: "s",
        }),
        10_005,
      );
    expect(xs).toHaveLength(10_000);
    expect(
      appendAudit(
        xs,
        createAuditEvent({
          at: 8 * 86_400_000,
          kind: "route",
          reasonCodes: [],
          routeId: "x",
          salt: "s",
        }),
        8 * 86_400_000,
      ),
    ).toHaveLength(1);
  });
  it("handles corruption deterministically without throwing", () =>
    expect(parseAuditStore("{bad")).toEqual({
      records: [],
      corrupted: true,
      action: "rotate",
    }));
});
