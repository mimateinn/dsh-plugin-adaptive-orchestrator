import {
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  validateGlobalSettings,
  type GlobalSettings,
} from "../../../src/contracts/schemas.js";
import { createEvaluation } from "../../../src/evaluation/index.js";
import {
  FileEvaluationStore,
  FileSettingsRepository,
  MAX_STORE_BYTES,
  LockTimeoutError,
  acquireReleaseLock,
  canonicalStorePath,
  PersistenceCorruptionError,
} from "../../../src/persistence/index.js";

const settings = (revision: number): GlobalSettings => ({
  ...validateGlobalSettings({
    schemaVersion: 1,
    revision,
    enabled: true,
    sensitive: { enabled: false, modelAllowlist: [] },
  }).data!,
});
const dir = () => mkdtemp(join(tmpdir(), "ao-persistence-"));

describe("file persistence", () => {
  it("serializes settings CAS and survives restart", async () => {
    const root = await dir(),
      repo = new FileSettingsRepository(root),
      next = settings(1);
    const results = await Promise.all([
      repo.compareAndSwap(0, next),
      repo.compareAndSwap(0, { ...next, enabled: false }),
    ]);
    expect(results.filter((x) => x.success)).toHaveLength(1);
    expect((await new FileSettingsRepository(root).read())?.revision).toBe(1);
    if (process.platform !== "win32")
      expect((await stat(repo.path)).mode & 0o777).toBe(0o600);
  });
  it("enforces settings revision transitions without mutating bytes", async () => {
    const root = await dir(),
      repo = new FileSettingsRepository(root);
    await expect(
      repo.compareAndSwap(0, settings(Number.MAX_SAFE_INTEGER)),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(readFile(repo.path)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(repo.compareAndSwap(0, settings(1))).resolves.toMatchObject({
      success: true,
    });
    const original = await readFile(repo.path, "utf8");
    for (const revision of [1, 0, 3])
      await expect(
        repo.compareAndSwap(1, settings(revision)),
      ).rejects.toBeInstanceOf(RangeError);
    expect(await readFile(repo.path, "utf8")).toBe(original);

    await writeFile(
      repo.path,
      JSON.stringify(settings(Number.MAX_SAFE_INTEGER)) + "\n",
    );
    const exhausted = await readFile(repo.path, "utf8");
    await expect(
      repo.compareAndSwap(
        Number.MAX_SAFE_INTEGER,
        settings(Number.MAX_SAFE_INTEGER),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await readFile(repo.path, "utf8")).toBe(exhausted);
  });

  it("enforces evaluation revision transitions without mutating bytes", async () => {
    const root = await dir(),
      store = new FileEvaluationStore(root),
      initial = createEvaluation("model-a", "v1", "code", "c1"),
      path = store.pathFor(initial);
    await expect(
      store.compareAndSwap(0, {
        ...initial,
        revision: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });

    const first = { ...initial, revision: 1 };
    await expect(store.compareAndSwap(0, first)).resolves.toMatchObject({
      success: true,
    });
    const original = await readFile(path, "utf8");
    for (const revision of [1, 0, 3])
      await expect(
        store.compareAndSwap(1, { ...initial, revision }),
      ).rejects.toBeInstanceOf(RangeError);
    expect(await readFile(path, "utf8")).toBe(original);

    await writeFile(
      path,
      JSON.stringify({ ...initial, revision: Number.MAX_SAFE_INTEGER }) + "\n",
    );
    const exhausted = await readFile(path, "utf8");
    await expect(
      store.compareAndSwap(Number.MAX_SAFE_INTEGER, {
        ...initial,
        revision: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await readFile(path, "utf8")).toBe(exhausted);
  });

  it("fails closed on corruption and never overwrites it", async () => {
    const root = await dir(),
      repo = new FileSettingsRepository(root);
    await mkdir(join(root, "adaptive-orchestrator"), { recursive: true });
    await writeFile(repo.path, "{broken", { mode: 0o600 });
    await expect(repo.compareAndSwap(0, settings(1))).rejects.toBeInstanceOf(
      PersistenceCorruptionError,
    );
    expect(await readFile(repo.path, "utf8")).toBe("{broken");
  });
  it("ignores and deterministically replaces interrupted temp files", async () => {
    const root = await dir(),
      repo = new FileSettingsRepository(root);
    await mkdir(join(root, "adaptive-orchestrator"), { recursive: true });
    await writeFile(repo.path + ".tmp", "partial");
    await expect(repo.read()).resolves.toBeNull();
    await repo.compareAndSwap(0, settings(1));
    await expect(readFile(repo.path + ".tmp", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("preserves destination and removes a stale temp during the next CAS", async () => {
    const root = await dir(),
      repo = new FileSettingsRepository(root);
    await repo.compareAndSwap(0, settings(1));
    const original = await readFile(repo.path, "utf8");
    await writeFile(repo.path + ".tmp", "stale");
    await expect(repo.compareAndSwap(0, settings(1))).resolves.toMatchObject({
      success: false,
    });
    expect(await readFile(repo.path, "utf8")).toBe(original);
    await repo.compareAndSwap(1, settings(2));
    await expect(readFile(repo.path + ".tmp")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("serializes stale writers through a directory symlink alias", async () => {
    const root = await dir(),
      alias = root + "-alias";
    try {
      await symlink(
        root,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        ["EPERM", "EACCES", "ENOTSUP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return;
      throw error;
    }
    const a = new FileSettingsRepository(root),
      b = new FileSettingsRepository(alias);
    const results = await Promise.all([
      a.compareAndSwap(0, settings(1)),
      b.compareAndSwap(0, { ...settings(1), enabled: false }),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
  });
  it("keys evaluations by hashed identity and restores them", async () => {
    const root = await dir(),
      store = new FileEvaluationStore(root);
    const initial = createEvaluation(
      "account/private-model",
      "v1",
      "code",
      "c1",
    );
    const next = { ...initial, revision: 1 };
    const results = await Promise.all([
      store.compareAndSwap(0, next),
      store.compareAndSwap(0, {
        ...next,
        state: "disabled" as const,
        status: "disabled" as const,
      }),
    ]);
    expect(results.filter((x) => x.success)).toHaveLength(1);
    expect(store.pathFor(initial)).not.toContain("account");
    expect((await new FileEvaluationStore(root).read(initial))?.revision).toBe(
      1,
    );
    const restarted = new FileEvaluationStore(root);
    await expect(
      restarted.compareAndSwap(1, { ...next, revision: 2 }),
    ).resolves.toMatchObject({ success: true });
  });
  it("rejects a valid evaluation stored under the wrong identity without overwriting", async () => {
    const root = await dir(),
      store = new FileEvaluationStore(root);
    const requested = createEvaluation("model-a", "v1", "code", "c1");
    const wrong = {
      ...createEvaluation("model-b", "v1", "code", "c1"),
      revision: 1,
    };
    const path = store.pathFor(requested);
    await mkdir(join(root, "adaptive-orchestrator", "evaluations"), {
      recursive: true,
    });
    const bytes = JSON.stringify(wrong) + "\n";
    await writeFile(path, bytes);
    await expect(
      store.compareAndSwap(1, { ...requested, revision: 2 }),
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
  it("fails closed on oversized and unknown-key evaluation records", async () => {
    const root = await dir(),
      store = new FileEvaluationStore(root);
    const value = createEvaluation("model-a", "v1", "code", "c1"),
      path = store.pathFor(value);
    await mkdir(join(root, "adaptive-orchestrator", "evaluations"), {
      recursive: true,
    });
    await writeFile(path, "x".repeat(MAX_STORE_BYTES + 1));
    await expect(
      store.compareAndSwap(0, { ...value, revision: 1 }),
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);
    await writeFile(path, JSON.stringify({ ...value, unknown: true }));
    await expect(
      store.compareAndSwap(0, { ...value, revision: 1 }),
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });
  it("serializes CAS across Node processes", async () => {
    const root = await dir();
    const moduleUrl = pathToFileURL(join(process.cwd(), "lib/index.mjs")).href;
    const barrier = join(root, "barrier");
    const script = `
      import { mkdir, access } from "node:fs/promises";
      import { join } from "node:path";
      import { FileSettingsRepository } from ${JSON.stringify(moduleUrl)};
      const barrier = process.argv[1];
      const target = process.argv[2];
      await mkdir(join(barrier, "ready-" + process.pid), { recursive: true });
      while (true) {
        try { await access(join(barrier, "go")); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
      }
      const repo = new FileSettingsRepository(target);
      const next = { schemaVersion: 1, revision: 1, enabled: process.pid % 2 === 0, sensitive: { enabled: false, modelAllowlist: [] }, caps: { baseSlots: 1, globalHardCap: 4, perProviderHardCap: 2, perAccountHardCap: 2, perModelHardCap: 2, interactiveReserve: 1, backgroundReserve: 1, queueCapacity: 100, configuredHorizonMs: 3600000 }, burnWeight: 1, auditRetentionDays: 7 };
      const result = await repo.compareAndSwap(0, next);
      const final = await repo.read();
      console.log(JSON.stringify({ result, final }));
    `;
    const target = root;
    const run = () =>
      new Promise<{
        result: { success: boolean };
        final: { revision: number };
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
            barrier,
            target,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(JSON.parse(stdout.trim()))
            : reject(new Error(stderr)),
        );
      });
    await mkdir(barrier);
    const started = [run(), run()];
    const readyDeadline = Date.now() + 10_000;
    while (true) {
      if (Date.now() > readyDeadline)
        throw new Error("children never became ready");
      const ready = await readdir(barrier).catch(() => [] as string[]);
      if (ready.filter((name) => name.startsWith("ready-")).length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await mkdir(join(barrier, "go"));
    // Parent independently reads while children are still contending: every
    // observed state must be a coherent committed value, never a partial file.
    const parent = new FileSettingsRepository(root);
    const readDeadline = Date.now() + 10_000;
    let observed = null;
    while (Date.now() <= readDeadline) {
      observed = await parent.read();
      expect(
        observed === null || observed.revision === 0 || observed.revision === 1,
      ).toBe(true);
      if (observed?.revision === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(observed?.revision).toBe(1);
    const results = await Promise.all(started);
    expect(results.filter((x) => x.result.success)).toHaveLength(1);
    expect(results.every((x) => x.final.revision === 1)).toBe(true);
    expect((await parent.read())?.revision).toBe(1);
  });

  it("aborts waiting without stealing and releases after action rejection", async () => {
    const root = await dir();
    const path = await canonicalStorePath(join(root, "abort.json"));
    const owner = acquireReleaseLock(path, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const controller = new AbortController();
    const waiter = acquireReleaseLock(path, async () => undefined, {
      timeoutMs: 500,
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(waiter).rejects.toThrow("cancelled");
    expect(await stat(path + ".lock")).toBeTruthy();
    await owner;
    await expect(
      acquireReleaseLock(path, async () => {
        throw new Error("action failed");
      }),
    ).rejects.toThrow("action failed");
    await expect(stat(path + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(acquireReleaseLock(path, async () => "ok")).resolves.toBe(
      "ok",
    );
  });

  it("times out without stealing live, unreachable, or corrupt locks", async () => {
    const root = await dir();
    const path = await canonicalStorePath(
      join(root, "adaptive-orchestrator", "locked.json"),
    );
    const lockPath = path + ".lock";
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        nonce: "owner",
        startedAt: new Date(),
      }),
    );
    await expect(
      acquireReleaseLock(path, async () => undefined, {
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await stat(lockPath)).toBeTruthy();

    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2 ** 30, nonce: "stale", startedAt: 0 }),
    );
    await expect(
      acquireReleaseLock(path, async () => undefined, {
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await stat(lockPath)).toBeTruthy();

    await writeFile(join(lockPath, "owner.json"), "{corrupt");
    await expect(
      acquireReleaseLock(path, async () => undefined, {
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await stat(lockPath)).toBeTruthy();
  });
});
