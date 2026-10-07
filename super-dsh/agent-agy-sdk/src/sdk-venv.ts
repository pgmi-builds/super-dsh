/**
 * sdk-venv.ts — the lazy, durable Python venv the SDK bridge runs on.
 *
 * 2026-10-02 user ruling (spec §4.2): this package declares NO Python
 * dependency and ships NO postinstall/allow-scripts hook. Nothing is fetched at
 * install time; the FIRST real use fetches the venv into the world home, where
 * it is durable across sessions, restarts and package upgrades. A second use
 * reuses it (idempotent), and a FAILED fetch leaves a trace on disk instead of
 * silently degrading into a confusing bridge crash.
 *
 * Why the world home rather than the package root: the package root is the
 * installed tarball — read-only in every real consumer install, and shared by
 * every world (the CLI one included). The world home is per-runtime, writable,
 * and already the home of this adapter's own state.
 *
 * The bootstrap is two idempotent steps, so a half-built venv heals in place
 * rather than being thrown away and re-downloaded:
 *   1. `<worldHome>/sdk-venv/bin/python` missing → `python3 -m venv <dir>`
 *   2. `<worldHome>/sdk-venv.json` marker missing → `pip install google-antigravity`
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The Python distribution the bridge imports (`bridge/agy_bridge.py`). */
export const SDK_PYTHON_PACKAGE = "google-antigravity";

/** Layout of the durable venv inside a world home. */
export interface SdkVenvLayout {
  /** The venv root. */
  dir: string;
  /** The interpreter the bridge is spawned with. */
  python: string;
  /** Used for the (idempotent) install step. */
  pip: string;
  /** Written last; its presence means the venv is complete. */
  marker: string;
  /** Failure trace — only ever written by a failed fetch. */
  errorLog: string;
  /** Bootstrap lock directory (mkdir is atomic on POSIX). */
  lock: string;
}

export function sdkVenvLayout(worldHome: string): SdkVenvLayout {
  const dir = join(worldHome, "sdk-venv");
  return {
    dir,
    python: join(dir, "bin", "python"),
    pip: join(dir, "bin", "pip"),
    marker: join(worldHome, "sdk-venv.json"),
    errorLog: join(worldHome, "sdk-venv.error.log"),
    lock: join(worldHome, "sdk-venv.lock"),
  };
}

export interface SdkVenvRecord {
  /** Installed distribution name. */
  package: string;
  /** Interpreter path (absolute) at install time. */
  python: string;
  /** ISO timestamp of the successful fetch. */
  installedAt: string;
  /** Interpreter used to create the venv. */
  createdWith: string;
}

/** Read the install marker; undefined when absent or unreadable. */
export function readSdkVenvRecord(worldHome: string): SdkVenvRecord | undefined {
  const { marker } = sdkVenvLayout(worldHome);
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as SdkVenvRecord;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Fast path: the complete venv already exists → the interpreter to use. */
export function resolveSdkPython(worldHome: string): string | undefined {
  const layout = sdkVenvLayout(worldHome);
  return existsSync(layout.python) && existsSync(layout.marker) ? layout.python : undefined;
}

export interface EnsureSdkVenvOptions {
  /** Interpreter used to CREATE the venv (default `python3`). */
  basePython?: string;
  /** Command runner (tests inject a fake; default is a synchronous exec). */
  run?: (cmd: string, args: string[]) => void;
  trace?: (...parts: unknown[]) => void;
  /** How long to wait for another process's bootstrap before giving up (ms). */
  lockTimeoutMs?: number;
  /** Poll interval while another process holds the lock (ms). */
  lockPollMs?: number;
  /** Lock older than this is treated as abandoned and stolen (ms). */
  lockStaleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  basePython: "python3",
  lockTimeoutMs: 30 * 60 * 1000,
  lockPollMs: 1000,
  lockStaleMs: 30 * 60 * 1000,
};

function defaultRun(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Return the interpreter path for `<worldHome>`'s durable venv, fetching it
 * first when it is absent or incomplete.
 *
 * Idempotent: a complete venv short-circuits without touching the network.
 * Failures append to `<worldHome>/sdk-venv.error.log` and throw a single
 * actionable error — never a partial venv left behind a success marker.
 */
export async function ensureSdkVenv(
  worldHome: string,
  opts: EnsureSdkVenvOptions = {},
): Promise<string> {
  const layout = sdkVenvLayout(worldHome);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = opts.run ?? defaultRun;

  const ready = resolveSdkPython(worldHome);
  if (ready !== undefined) return ready;

  mkdirSync(worldHome, { recursive: true });
  // `acquired === false` means a peer finished the fetch while we waited: the
  // lock is not ours and MUST NOT be released by this caller.
  const acquired = await acquireLock(worldHome, layout, now, sleep, opts);
  if (!acquired) return layout.python;
  try {
    // Re-check inside the lock: a concurrent bootstrap may have finished while
    // we waited, in which case this caller pays nothing.
    const done = resolveSdkPython(worldHome);
    if (done !== undefined) return done;

    const basePython = opts.basePython ?? process.env.AGY_SDK_BASE_PYTHON ?? DEFAULTS.basePython;
    const stale = existsSync(layout.python);
    try {
      opts.trace?.(`sdk-venv: fetching ${SDK_PYTHON_PACKAGE} into ${layout.dir}`);
      if (!stale) run(basePython, ["-m", "venv", layout.dir]);
      run(layout.pip, ["install", "-q", SDK_PYTHON_PACKAGE]);
      if (!existsSync(layout.python)) {
        throw new Error(`venv created but ${layout.python} is missing`);
      }
      const record: SdkVenvRecord = {
        package: SDK_PYTHON_PACKAGE,
        python: layout.python,
        installedAt: new Date(now()).toISOString(),
        createdWith: basePython,
      };
      writeFileSync(layout.marker, JSON.stringify(record, null, 2) + "\n");
      rmSync(layout.errorLog, { force: true });
      opts.trace?.(`sdk-venv: ready (${layout.python})`);
      return layout.python;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stamp = new Date(now()).toISOString();
      try {
        appendFileSync(layout.errorLog, `[${stamp}] ${SDK_PYTHON_PACKAGE} fetch failed: ${detail}\n`);
      } catch {
        /* the trace is best-effort; the throw below is the contract */
      }
      throw new Error(
        `agy-sdk: could not fetch the Python SDK venv (${SDK_PYTHON_PACKAGE}) at ${layout.dir}: ${detail}. ` +
        `Install it by hand with \`npm run fetch-venv\` (or set AGY_PYTHON to an interpreter that has it). ` +
        `Trace: ${layout.errorLog}`,
      );
    }
  } finally {
    rmSync(layout.lock, { recursive: true, force: true });
  }
}

/**
 * mkdir-based mutex with stale-lock reclamation.
 *
 * Resolves `true` when THIS caller owns the lock (and must release it), `false`
 * when a peer completed the fetch while we waited (nothing to release, the
 * venv is ready). Throws when the wait budget is exhausted.
 */
async function acquireLock(
  worldHome: string,
  layout: SdkVenvLayout,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  opts: EnsureSdkVenvOptions,
): Promise<boolean> {
  const timeout = opts.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs;
  const poll = opts.lockPollMs ?? DEFAULTS.lockPollMs;
  const staleMs = opts.lockStaleMs ?? DEFAULTS.lockStaleMs;
  const deadline = now() + timeout;
  for (;;) {
    try {
      mkdirSync(layout.lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Someone holds it. Another process may have finished the fetch already.
    if (resolveSdkPython(worldHome) !== undefined) return false;
    let ageMs = 0;
    try {
      ageMs = now() - statSync(layout.lock).mtimeMs;
    } catch {
      continue; // released between the mkdir attempt and the stat — retry now
    }
    if (ageMs > staleMs) {
      opts.trace?.(`sdk-venv: stealing stale lock (age ${Math.round(ageMs / 1000)}s)`);
      rmSync(layout.lock, { recursive: true, force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new Error(
        `agy-sdk: timed out waiting for a concurrent SDK venv fetch (lock ${layout.lock}). ` +
        `Remove the lock directory if no fetch is running.`,
      );
    }
    await sleep(poll);
  }
}
