import { describe, expect, it } from "vitest";
import {
  compatibilityReport,
  type HostCapabilities,
} from "../../../src/host/compatibility.js";
import {
  SettingsService,
  defaultSettings,
} from "../../../src/host/settings.js";
import {
  BUILTIN_CAPTAIN_TOOLS,
  decideTool,
  OrchestrationAllowlist,
} from "../../../src/host/policy.js";
import {
  createDelegationHandler,
  createTaskClaimHandler,
  type SchedulerGateway,
} from "../../../src/host/admission.js";
import type {
  GlobalSettings,
  SettingsCasResult,
} from "../../../src/contracts/schemas.js";

describe("host compatibility", () => {
  it("reports supported when every required seam is present", () => {
    const caps: HostCapabilities = {
      admissionProtocol: "delegation-admission",
      admissionVersion: 2,
      taskClaim: 2,
      agentRole: true,
    };
    const report = compatibilityReport(
      { capabilities: () => caps },
      "test-1",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(report.supported).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("fails closed with visible reasons for each missing seam", () => {
    const report = compatibilityReport(
      { capabilities: () => ({}) },
      "test-1",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(report.supported).toBe(false);
    expect(report.failures.map((f) => f.code).sort()).toEqual([
      "ADMISSION_PROTOCOL",
      "ADMISSION_VERSION",
      "AGENT_ROLE",
      "TASK_CLAIM",
    ]);
  });

  it("fails closed on version mismatch", () => {
    const caps: HostCapabilities = {
      admissionProtocol: "delegation-admission",
      admissionVersion: 1,
      taskClaim: 2,
      agentRole: true,
    };
    expect(
      compatibilityReport({ capabilities: () => caps }, "x").failures.map(
        (f) => f.code,
      ),
    ).toContain("ADMISSION_VERSION");
  });
});

describe("host settings", () => {
  const memory = (
    initial: GlobalSettings | null,
  ): {
    repo: {
      read(): Promise<GlobalSettings | null>;
      compareAndSwap(e: number, n: GlobalSettings): Promise<SettingsCasResult>;
    };
    store: GlobalSettings | null;
  } => {
    let store = initial;
    return {
      store,
      repo: {
        read: async () => store,
        compareAndSwap: async (expected, next) => {
          const current = store?.revision ?? 0;
          if (current !== expected)
            return {
              success: false,
              code: "conflict",
              currentRevision: current,
            };
          store = next;
          return { success: true, value: next };
        },
      },
    };
  };

  it("defaults to disabled on an empty store", async () => {
    const m = memory(null);
    const service = new SettingsService(m.repo);
    expect((await service.read()).enabled).toBe(false);
    expect(await service.isEnabled()).toBe(false);
  });

  it("commits a validated update and rejects stale revisions", async () => {
    const m = memory(null);
    const service = new SettingsService(m.repo);
    const next = { ...defaultSettings(), revision: 1, enabled: true };
    expect((await service.update(next)).success).toBe(true);
    expect(await service.isEnabled()).toBe(true);
    expect((await service.update({ ...next, revision: 2 })).success).toBe(true);
    const stale = { ...next, revision: 2 };
    expect(await service.update(stale)).toMatchObject({
      success: false,
      code: "conflict",
    });
  });

  it("rejects invalid settings without mutation", async () => {
    const m = memory(null);
    const service = new SettingsService(m.repo);
    await expect(
      service.update({ schemaVersion: 9, revision: 1 }),
    ).rejects.toThrow();
    expect(m.store).toBeNull();
  });
});

describe("captain policy", () => {
  const builtin = () => new OrchestrationAllowlist(BUILTIN_CAPTAIN_TOOLS);

  it("allows orchestration tools and denies execution tools for captains", () => {
    expect(decideTool("captain", "todo", true, builtin())).toEqual({
      kind: "allow",
    });
    expect(decideTool("captain", "fs_read", true, builtin())).toMatchObject({
      kind: "deny",
    });
    expect(decideTool("captain", "shell_bash", true, builtin())).toMatchObject({
      kind: "deny",
    });
  });

  it("lets workers through and bypasses when disabled", () => {
    expect(decideTool("worker", "fs_read", true, builtin())).toEqual({
      kind: "allow",
    });
    expect(decideTool("captain", "fs_read", false, builtin())).toEqual({
      kind: "allow",
    });
  });

  it("denies unknown tool names for captains", () => {
    expect(
      decideTool("captain", "future_unknown_tool", true, builtin()),
    ).toMatchObject({ kind: "deny" });
  });

  it("fails closed when the caller role is unavailable", () => {
    expect(decideTool(undefined, "todo", true, builtin())).toMatchObject({
      kind: "deny",
    });
  });

  it("denies an allowlisted name until explicitly registered by trusted code", () => {
    const allowlist = new OrchestrationAllowlist(["trusted_only"]);
    expect(decideTool("captain", "todo", true, allowlist)).toMatchObject({
      kind: "deny",
    });
    expect(decideTool("captain", "trusted_only", true, allowlist)).toEqual({
      kind: "allow",
    });
    allowlist.add("later");
    expect(decideTool("captain", "later", true, allowlist)).toEqual({
      kind: "allow",
    });
  });

  it("binds trust to the registry-resolved definition, not the call name string", () => {
    const allowlist = new OrchestrationAllowlist(["todo"]);
    expect(
      decideTool("captain", "todo", true, allowlist, () => undefined),
    ).toMatchObject({ kind: "deny" });
    expect(
      decideTool("captain", "todo", true, allowlist, () => ({ name: "other" })),
    ).toMatchObject({ kind: "deny" });
    expect(
      decideTool("captain", "todo", true, allowlist, () => ({ name: "todo" })),
    ).toEqual({ kind: "allow" });
  });
});

describe("admission bridge", () => {
  const gateway = (): {
    gateway: SchedulerGateway;
    acquired: string[];
    released: string[];
  } => {
    const acquired: string[] = [];
    const released: string[] = [];
    return {
      acquired,
      released,
      gateway: {
        acquire: async (request) => {
          acquired.push(request.attemptId);
          return { leaseId: "lease-" + request.attemptId };
        },
        release: async (leaseId, attemptId) => {
          released.push(attemptId);
        },
      },
    };
  };

  it("maps delegation acquire and release exactly once", async () => {
    const m = gateway();
    const handler = createDelegationHandler({
      gateway: m.gateway,
      resolveRoute: () => "codex",
    });
    const lease = await handler(
      { provider: "codex" },
      new AbortController().signal,
    );
    expect(m.acquired).toHaveLength(1);
    await lease.release();
    await lease.release();
    expect(m.released).toHaveLength(1);
  });

  it("fails closed when no route resolves for the provider", async () => {
    const handler = createDelegationHandler({
      gateway: gateway().gateway,
      resolveRoute: () => undefined,
    });
    await expect(
      handler({ provider: "unknown" }, new AbortController().signal),
    ).rejects.toThrow("no eligible route");
  });

  it("maps task-claim prepare commit rollback and reacquire", async () => {
    const m = gateway();
    const handler = createTaskClaimHandler({
      gateway: m.gateway,
      resolveRoute: () => "codex",
    });
    const request = {
      teamId: "team-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      ownerId: "owner-1",
    };
    const prepared = await handler.prepare(
      request,
      new AbortController().signal,
    );
    expect(m.acquired).toHaveLength(1);
    await prepared.rollback();
    await prepared.rollback();
    expect(m.released).toHaveLength(1);
    const prepared2 = await handler.prepare(
      request,
      new AbortController().signal,
    );
    await prepared2.commit();
    await prepared2.rollback();
    expect(m.released).toHaveLength(1);
    const reacquired = await handler.reacquire(
      request,
      new AbortController().signal,
    );
    expect(m.acquired).toHaveLength(3);
    await reacquired.rollback();
    expect(m.released).toHaveLength(2);
  });
});
