import { randomBytes } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const locks = new Map<string, Promise<void>>();
export const MAX_STORE_BYTES = 1_048_576;

export interface LockOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export class LockTimeoutError extends Error {
  readonly code = "LockTimeout";
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(`Timed out waiting for persistence lock: ${lockPath}`);
    this.lockPath = lockPath;
    this.name = "LockTimeoutError";
  }
}

export function assertRevisionTransition(
  currentRevision: number,
  expectedRevision: number,
  nextRevision: number,
): void {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 0 ||
    currentRevision === Number.MAX_SAFE_INTEGER ||
    nextRevision !== expectedRevision + 1
  )
    throw new RangeError("Invalid persistence revision transition");
}

export class PersistenceCorruptionError extends Error {
  readonly code = "PersistenceCorruption";
  constructor(
    public readonly filePath: string,
    options?: ErrorOptions,
  ) {
    super("Persisted state is corrupt", options);
    this.name = "PersistenceCorruptionError";
  }
}

export async function canonicalStorePath(path: string): Promise<string> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalPath = join(await realpath(parent), basename(path));
  }
  return process.platform === "win32"
    ? canonicalPath.toLowerCase()
    : canonicalPath;
}

export async function serialized<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => current);
  locks.set(path, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(path) === tail) locks.delete(path);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function acquireReleaseLock<T>(
  storePath: string,
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = storePath + ".lock";
  const markerPath = join(lockPath, "owner.json");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const owner = {
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
    startedAt: new Date().toISOString(),
  };

  for (;;) {
    options.signal?.throwIfAborted();
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(markerPath, JSON.stringify(owner) + "\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        if (Date.now() >= deadline) throw error;
        await delay(pollMs, options.signal);
        continue;
      }
      try {
        options.signal?.throwIfAborted();
        return await action();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Existing, missing, or corrupt owner markers all fail closed. PID reuse and
      // cross-platform liveness ambiguity make automatic stealing unsafe.
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
      await delay(
        Math.min(pollMs, Math.max(0, deadline - Date.now())),
        options.signal,
      );
    }
  }
}

export async function readBoundedJson<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    const info = await stat(path);
    if (info.size > MAX_STORE_BYTES) throw new PersistenceCorruptionError(path);
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_STORE_BYTES)
      throw new PersistenceCorruptionError(path);
    return parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof PersistenceCorruptionError) throw error;
    throw new PersistenceCorruptionError(path, { cause: error });
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  const data = Buffer.from(JSON.stringify(value) + "\n");
  if (data.byteLength > MAX_STORE_BYTES)
    throw new RangeError("Persisted state exceeds size limit");
  const parent = dirname(path),
    temp = path + ".tmp";
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rm(temp, { force: true });
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close();
    await rm(temp, { force: true });
    throw error;
  }
}
