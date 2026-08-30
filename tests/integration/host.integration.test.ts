/**
 * Headless integration smoke: apply() against a real Cordis context with
 * stubbed DSH seams. No GUI, no Web artifacts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { apply } from "../../src/index.js";
import { FileSettingsRepository } from "../../src/persistence/index.js";
import { defaultSettings } from "../../src/host/settings.js";
import { decideTool, OrchestrationAllowlist } from "../../src/host/policy.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const dir = () => {
  const root = mkdtempSync(join(tmpdir(), "ao-integration-"));
  roots.push(root);
  return root;
};

class FakeDelegationAdmission extends Service {
  registered = 0;
  taskClaimRegistered = 0;
  constructor(ctx: Context) {
    super(ctx, "delegationAdmission");
  }
  capabilities() {
    return {
      protocol: "delegation-admission" as const,
      version: 2,
      taskClaim: 2,
    };
  }
  handler?: (request: { provider: string }, signal: AbortSignal) => unknown;
  taskClaimHandler?: {
    prepare: (request: unknown, signal: AbortSignal) => unknown;
    reacquire: (request: unknown, signal: AbortSignal) => unknown;
  };
  register(
    handler: (request: { provider: string }, signal: AbortSignal) => unknown,
  ) {
    this.registered += 1;
    this.handler = handler;
    return () => undefined;
  }
  registerTaskClaim(handler: {
    prepare: (request: unknown, signal: AbortSignal) => unknown;
    reacquire: (request: unknown, signal: AbortSignal) => unknown;
  }) {
    this.taskClaimRegistered += 1;
    this.taskClaimHandler = handler;
    return () => undefined;
  }
}

class FakeSystemPrompt extends Service {
  sections: string[] = [];
  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }
  section(section: { name: string; text: string }) {
    this.sections.push(section.name);
    return () => undefined;
  }
}

class FakeTools extends Service {
  known = new Set<string>();
  constructor(ctx: Context) {
    super(ctx, "tools");
  }
  get(name: string) {
    return this.known.has(name) ? { name } : undefined;
  }
}

async function mount(config: Record<string, unknown>) {
  const ctx = new Context();
  // Service constructors register themselves on the current fiber.
  const admission = new FakeDelegationAdmission(ctx);
  const systemPrompt = new FakeSystemPrompt(ctx);
  const tools = new FakeTools(ctx);
  apply(ctx, config);
  return { ctx, admission, systemPrompt, tools };
}

describe("host integration smoke (headless)", () => {
  it("bypasses everything when Config.enabled is false", async () => {
    const { admission, systemPrompt } = await mount({ enabled: false });
    expect(admission.registered).toBe(0);
    expect(admission.taskClaimRegistered).toBe(0);
    expect(systemPrompt.sections).toEqual([]);
  });

  it("registers seams and enforces the captain decision path when enabled", async () => {
    const profileDirectory = dir();
    const repo = new FileSettingsRepository(profileDirectory);
    await repo.compareAndSwap(0, {
      ...defaultSettings(),
      revision: 1,
      enabled: true,
    });
    const { admission, systemPrompt } = await mount({
      enabled: true,
      profileDirectory,
      dshVersion: "test",
    });
    expect(systemPrompt.sections).toContain("adaptive-orchestrator");
    expect(admission.registered).toBe(1);
    expect(admission.taskClaimRegistered).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const allowlist = new OrchestrationAllowlist(["todo"]);
    const resolve = (name: string) => ({ name });
    expect(decideTool("captain", "todo", true, allowlist, resolve)).toEqual({
      kind: "allow",
    });
    expect(
      decideTool("captain", "fs_read", true, allowlist, resolve),
    ).toMatchObject({ kind: "deny" });
  });

  it("round-trips admission through the real scheduler gateway", async () => {
    const profileDirectory = dir();
    const repo = new FileSettingsRepository(profileDirectory);
    await repo.compareAndSwap(0, {
      ...defaultSettings(),
      revision: 1,
      enabled: true,
    });
    const { admission } = await mount({
      enabled: true,
      profileDirectory,
      dshVersion: "test",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(admission.handler).toBeDefined();
    expect(admission.taskClaimHandler).toBeDefined();
    const lease = await admission.handler!(
      { provider: "codex" },
      new AbortController().signal,
    );
    expect(lease).toBeDefined();
    await (lease as { release(): Promise<void> }).release();
    const prepared = await admission.taskClaimHandler!.prepare(
      {
        teamId: "team-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        ownerId: "owner-1",
      },
      new AbortController().signal,
    );
    const prep = prepared as {
      commit(): Promise<void>;
      rollback(): Promise<void>;
    };
    // Pre-commit rollback releases the scheduler lease (restart semantics).
    await prep.rollback();
    const reacquired = await admission.taskClaimHandler!.reacquire(
      {
        teamId: "team-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        ownerId: "owner-1",
      },
      new AbortController().signal,
    );
    await (reacquired as { rollback(): Promise<void> }).rollback();
    // Commit path keeps the lease; later rollback is an exact-once no-op.
    const committedPrep = await admission.taskClaimHandler!.prepare(
      {
        teamId: "team-1",
        taskId: "task-1",
        attemptId: "attempt-2",
        ownerId: "owner-1",
      },
      new AbortController().signal,
    );
    const committed = committedPrep as {
      commit(): Promise<void>;
      rollback(): Promise<void>;
    };
    await committed.commit();
    await committed.rollback();
    await committed.rollback();
  });

  it("denies captain calls until a real role is observed", async () => {
    const profileDirectory = dir();
    const repo = new FileSettingsRepository(profileDirectory);
    await repo.compareAndSwap(0, {
      ...defaultSettings(),
      revision: 1,
      enabled: true,
    });
    await mount({ enabled: true, profileDirectory, dshVersion: "test" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      decideTool(
        undefined,
        "todo",
        true,
        new OrchestrationAllowlist(["todo"]),
        () => ({ name: "todo" }),
      ),
    ).toMatchObject({ kind: "deny" });
  });
});
