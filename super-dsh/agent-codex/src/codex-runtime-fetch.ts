/**
 * codex-runtime-fetch.ts — the lazy, durable Codex runtime the app-server line
 * falls back to when the operator has NO codex of their own.
 *
 * 2026-10-06 user ruling (amends the 2026-10-05 core-discovery order): the
 * exact-pin `@openai/codex` package must NEVER ride the installation — it went
 * out as a real `dependencies` entry in 0.1.11, so every registry consumer
 * downloaded the pinned CLI binary package AND its six aliased platform
 * binaries (linux-x64/arm64, darwin-x64/arm64, win32-x64/arm64) at install
 * time. That is the omp-sdk/agy-sdk/codex-sdk rule violated one week after it
 * was written: SDKs and binaries are second-class — anything a line needs, it
 * fetches at RUNTIME into its world home, and installs stay clean (no
 * postinstall, no allow-build, no dependency that ships a binary).
 *
 * So the discovery order in codex-runtime.ts is
 *   CODEX_BIN → PATH CLI → desktop core → world-home runtime (this module),
 * and this module is the only supplier of that last tier: on the first real
 * prompt, when override, CLI and desktop all missed, the pinned
 * `@openai/codex@0.160.0` tree is fetched into
 *
 *   <worldHome>/codex-runtime/
 *     package.json                 written by us (private, never published)
 *     node_modules/                `npm install --exact --ignore-scripts --omit=dev`
 *     node_modules/@openai/codex/bin/codex.js   the entry discovery returns
 *   <worldHome>/codex-runtime.json       marker — written LAST, after the smoke run
 *   <worldHome>/codex-runtime.lock       atomic (mkdir) bootstrap lock
 *   <worldHome>/codex-runtime.error.log  written ONLY by a failed fetch
 *
 * Why the world home rather than the package root: the package root is the
 * installed tarball — read-only in every real consumer install, and shared by
 * every world. The world home (`<dshHome>/agents/codex`) is per-runtime,
 * writable, and already the home of this adapter's own DSH state.
 *
 * Readiness is the ENTRY FILE (checked on every discovery, zero network) plus
 * the marker's package version: a pin bump in a future adapter must refetch,
 * and the sync resolver alone would happily keep using the old tree.
 *
 * The npm invocation is deliberately `--ignore-scripts`: the codex packages
 * ship their binaries inside the tarballs, so a fetch needs zero lifecycle
 * scripts — exactly the property this ruling exists to protect.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveCodexRuntime, type CodexRuntime } from "./codex-runtime.js";

/** The pinned Codex CLI package this line fetches (ships the app-server binary). */
export const CODEX_RUNTIME_PACKAGE = "@openai/codex";

/** Pin of {@link CODEX_RUNTIME_PACKAGE}; bumping it must refetch the tree. */
export const CODEX_RUNTIME_VERSION = "0.160.0";

/** The entry `resolveCodexRuntime` returns, relative to the runtime dir. */
const CODEX_ENTRY_RELATIVE = ["node_modules", CODEX_RUNTIME_PACKAGE, "bin", "codex.js"];

/** Layout of the durable runtime inside a world home. */
export interface CodexRuntimeLayout {
  /** The runtime root (holds `package.json` and `node_modules/`). */
  dir: string;
  /** The private manifest `npm install` adds the pinned package to. */
  manifest: string;
  /** The installed JavaScript entry — present means the tree is usable. */
  entry: string;
  /** Written LAST, after the smoke run; carries the fetch identity. */
  marker: string;
  /** Bootstrap lock directory (mkdir is atomic on POSIX). */
  lock: string;
  /** Failure trace — only ever written by a failed fetch. */
  errorLog: string;
}

export function codexRuntimeLayout(worldHome: string): CodexRuntimeLayout {
  const dir = join(worldHome, "codex-runtime");
  return {
    dir,
    manifest: join(dir, "package.json"),
    entry: join(dir, ...CODEX_ENTRY_RELATIVE),
    marker: join(worldHome, "codex-runtime.json"),
    lock: join(worldHome, "codex-runtime.lock"),
    errorLog: join(worldHome, "codex-runtime.error.log"),
  };
}

/** The install marker: what landed, where, and when. */
export interface CodexRuntimeRecord {
  /** Version of this adapter package at fetch time. */
  pluginVersion: string;
  /** Installed version of {@link CODEX_RUNTIME_PACKAGE}. */
  packageVersion: string;
  /** Absolute path of the entry discovery resolves. */
  entryPath: string;
  /** First line of the smoke run's `--version` output. */
  smokeVersion: string;
  /** ISO timestamp of the successful fetch. */
  installedAt: string;
}

/** Read the install marker; undefined when absent or unreadable. */
export function readCodexRuntimeRecord(worldHome: string): CodexRuntimeRecord | undefined {
  const { marker } = codexRuntimeLayout(worldHome);
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as CodexRuntimeRecord;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The marker half a caller can compare before fetching (pin-bump healing). */
export interface CodexRuntimeIdentity {
  pluginVersion: string;
  packageVersion: string;
}

/**
 * Fast path: a fetched runtime exists, matches `identity`, and its entry file
 * is still on disk. Everything else must (re)fetch or (re)discover.
 */
export function codexRuntimeCurrent(worldHome: string, identity: CodexRuntimeIdentity): CodexRuntimeRecord | undefined {
  const record = readCodexRuntimeRecord(worldHome);
  if (record === undefined) return undefined;
  if (record.pluginVersion !== identity.pluginVersion) return undefined;
  if (record.packageVersion !== identity.packageVersion) return undefined;
  if (!existsSync(codexRuntimeLayout(worldHome).entry)) return undefined;
  return record;
}

/** Options for one injected command invocation. */
export interface CodexRuntimeRunOptions {
  /** Working directory (the runtime dir for the npm install). */
  cwd?: string;
  /** Hard wall-clock cap (the smoke run uses one; a wedged binary must not hang a turn). */
  timeoutMs?: number;
}

/**
 * Everything {@link ensureCodexRuntime} touches outside its own filesystem
 * work, injected so the bootstrap is testable with zero network and zero real
 * npm — the same seam `agent-codex-sdk/src/sdk-runtime.ts` uses.
 */
export interface CodexRuntimeFetchDeps {
  /**
   * Extra discovery-boundary overrides (tests neutralize the desktop ladder
   * with `desktopCandidates: []`); the world-home entry candidate is always
   * supplied by {@link discoverWith} itself.
   */
  discovery?: Partial<import("./codex-runtime.js").CodexRuntimeDiscovery>;
  /** Run a command to completion; must throw on a non-zero exit. */
  run(cmd: string, args: string[], opts?: CodexRuntimeRunOptions): Promise<void>;
  /** Run a command and return its stdout (the smoke run). */
  smoke(cmd: string, args: string[], opts?: CodexRuntimeRunOptions): Promise<string>;
  /** Version of this adapter package — part of the marker identity. */
  pluginVersion: string;
  /** One human-readable progress line. */
  log(line: string): void;
  /** Environment the discovery pass sees (the transport's child env). */
  env?: NodeJS.ProcessEnv;
}

/** The npm argv the runtime tree is installed with (kept pure for the test). */
export function codexInstallArgv(packageVersion: string = CODEX_RUNTIME_VERSION): string[] {
  return [
    "install",
    "--save-exact",
    "--ignore-scripts",
    "--omit=dev",
    `${CODEX_RUNTIME_PACKAGE}@${packageVersion}`,
  ];
}

/** A held lock older than this is treated as abandoned and reclaimed. */
const LOCK_STALE_MS = 30 * 60 * 1000;

/** The smoke run's wall-clock cap: `--version` must never wedge a turn. */
const SMOKE_TIMEOUT_MS = 60_000;

const execFileAsync = promisify(execFile);

/**
 * The PRODUCTION {@link CodexRuntimeFetchDeps}: real npm/Node invocations plus
 * the marker identity read from this package's own manifest. Kept IN THE
 * MODULE so the manual pre-warm script and the first-prompt lazy fetch share
 * ONE implementation — a second copy is exactly how the two paths would drift.
 */
export function createCodexRuntimeDeps(options: { env?: NodeJS.ProcessEnv; pluginDir?: string } = {}): CodexRuntimeFetchDeps {
  const pluginDir = options.pluginDir ?? dirname(dirname(fileURLToPath(import.meta.url)));
  return {
    run: async (cmd, args, opts) => {
      await execFileAsync(cmd, args, { cwd: opts?.cwd, env: options.env, maxBuffer: 64 * 1024 * 1024 });
    },
    smoke: async (cmd, args, opts) => {
      const { stdout } = await execFileAsync(cmd, args, {
        cwd: opts?.cwd,
        env: options.env,
        timeout: opts?.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    },
    pluginVersion: readPluginVersion(pluginDir),
    log: (line) => process.stderr.write(`[agent-codex] ${line}\n`),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

/** The version of the adapter package at `pluginDir` (the marker identity half). */
export function readPluginVersion(pluginDir: string): string {
  const raw = readFileSync(join(pluginDir, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`codex: ${join(pluginDir, "package.json")} carries no version`);
  }
  return parsed.version;
}

/**
 * Sync discovery across the whole ladder INCLUDING the fetched runtime; a
 * miss throws (which is the fetch trigger, never surfaced to the user).
 */
function discoverWith(worldHome: string, deps: CodexRuntimeFetchDeps): CodexRuntime {
  return resolveCodexRuntime({
    ...(deps.discovery ?? {}),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    packageEntryCandidates: [codexRuntimeLayout(worldHome).entry],
  });
}

/**
 * Return a usable Codex runtime for `<worldHome>`, fetching the pinned
 * package first when the operator's own CODEX_BIN / PATH CLI / desktop core
 * all miss.
 *
 * Idempotent: an operator-provided runtime short-circuits without touching
 * the network, and so does a complete, matching fetched runtime. Concurrent
 * callers: the bootstrap is guarded by a `mkdir` lock — a second caller that
 * finds a FRESH lock throws a clear "fetch in progress" error, while an
 * abandoned lock (older than {@link LOCK_STALE_MS}) is reclaimed so a crashed
 * fetch cannot brick the line.
 *
 * Failures append to `<worldHome>/codex-runtime.error.log` and throw a single
 * actionable error — never a partial runtime behind a success marker.
 */
export async function ensureCodexRuntime(worldHome: string, deps: CodexRuntimeFetchDeps): Promise<CodexRuntime> {
  const usable = (() => {
    try {
      return discoverWith(worldHome, deps);
    } catch {
      return undefined;
    }
  })();
  // An operator runtime (override/CLI/desktop) is always taken as-is; a fetched
  // runtime is taken only when its pin still matches — a bumped pin refetches.
  if (usable !== undefined && usable.source !== "package") return usable;
  const identity: CodexRuntimeIdentity = { pluginVersion: deps.pluginVersion, packageVersion: CODEX_RUNTIME_VERSION };
  if (usable !== undefined && codexRuntimeCurrent(worldHome, identity) !== undefined) return usable;

  const layout = codexRuntimeLayout(worldHome);
  mkdirSync(worldHome, { recursive: true });
  acquireLock(layout, deps);
  try {
    // Re-check inside the lock: a peer may have completed the fetch in the
    // window between our check and the lock, in which case we pay nothing.
    const raced = (() => {
      try {
        return discoverWith(worldHome, deps);
      } catch {
        return undefined;
      }
    })();
    if (raced !== undefined && (raced.source !== "package" || codexRuntimeCurrent(worldHome, identity) !== undefined)) return raced;

    try {
      await buildRuntime(layout, deps, identity);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stamp = new Date().toISOString();
      try {
        appendFileSync(layout.errorLog, `[${stamp}] codex runtime fetch failed: ${detail}\n`);
      } catch {
        /* the trace is best-effort; the throw below is the contract */
      }
      throw new Error(
        `codex: could not fetch the runtime (${CODEX_RUNTIME_PACKAGE}@${CODEX_RUNTIME_VERSION}) at ${layout.dir}: ${detail}. ` +
          `Pre-warm it by hand with \`npm run fetch-codex-runtime\`, or install a Codex CLI and set CODEX_BIN. Trace: ${layout.errorLog}`,
      );
    }
    const resolved = discoverWith(worldHome, deps);
    deps.log(`codex: runtime ready at ${layout.dir} (${CODEX_RUNTIME_PACKAGE}@${CODEX_RUNTIME_VERSION})`);
    return resolved;
  } finally {
    rmSync(layout.lock, { recursive: true, force: true });
  }
}

/** The idempotent build steps; the marker is written last, after the smoke run. */
async function buildRuntime(layout: CodexRuntimeLayout, deps: CodexRuntimeFetchDeps, identity: CodexRuntimeIdentity): Promise<void> {
  mkdirSync(layout.dir, { recursive: true });

  // npm needs a manifest to own the tree; `private` + a throwaway version keep
  // it unambiguously not-a-publishable-package, and an existing one is left
  // alone so a later install can still be reproduced by hand.
  if (!existsSync(layout.manifest)) {
    writeFileSync(
      layout.manifest,
      JSON.stringify({ name: "codex-runtime", private: true, version: "0.0.0" }, null, 2) + "\n",
    );
  }

  deps.log(`codex: fetching ${CODEX_RUNTIME_PACKAGE}@${CODEX_RUNTIME_VERSION} into ${layout.dir}`);
  await deps.run("npm", codexInstallArgv(), { cwd: layout.dir });

  if (!existsSync(layout.entry)) {
    throw new Error(`npm install produced no ${layout.entry} (the package layout changed?)`);
  }
  // Smoke step: run the fetched entry's `--version`. This exercises the real
  // platform-binary pick the entry performs at run time — a tree whose binary
  // does not match this host fails HERE, at the fetch, with a trace on disk,
  // instead of at the first prompt inside the agent's cold-start error path.
  // The entry is resolved ABSOLUTE before the cwd switch — the smoke run
  // changes the working directory, and a relative worldHome would otherwise
  // re-resolve against it (same trap as the `-c model_catalog_json` lesson).
  const smokeEntry = resolve(layout.entry);
  deps.log(`codex: smoke-running ${CODEX_RUNTIME_PACKAGE}@${CODEX_RUNTIME_VERSION} --version`);
  const stdout = await deps.smoke(process.execPath, [smokeEntry, "--version"], { cwd: layout.dir, timeoutMs: SMOKE_TIMEOUT_MS });
  const smokeVersion = stdout.trim().split("\n")[0]?.trim() ?? "";
  if (smokeVersion === "") {
    throw new Error(`smoke run of ${layout.entry} --version produced no output`);
  }

  // Marker LAST — a crash before this point leaves an incomplete runtime that
  // the next call heals, never a false success.
  const record: CodexRuntimeRecord = {
    ...identity,
    entryPath: layout.entry,
    smokeVersion,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(layout.marker, JSON.stringify(record, null, 2) + "\n");
  rmSync(layout.errorLog, { force: true });
}

/**
 * mkdir-based mutex. Returns owning the lock; throws when a fresh lock is held
 * by someone else; reclaims a lock older than {@link LOCK_STALE_MS}.
 */
function acquireLock(layout: CodexRuntimeLayout, deps: CodexRuntimeFetchDeps): void {
  for (;;) {
    try {
      mkdirSync(layout.lock);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(layout.lock).mtimeMs;
    } catch {
      continue; // released between the mkdir attempt and the stat — retry now
    }
    if (ageMs > LOCK_STALE_MS) {
      deps.log(`codex: reclaiming stale runtime lock (age ${Math.round(ageMs / 1000)}s)`);
      rmSync(layout.lock, { recursive: true, force: true });
      continue;
    }
    throw new Error(
      `codex: another runtime fetch is already in progress (lock ${layout.lock}). ` +
        `Retry once it finishes; if no fetch is running, remove that lock directory.`,
    );
  }
}
