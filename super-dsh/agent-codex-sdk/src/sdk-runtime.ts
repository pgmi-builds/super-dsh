/**
 * sdk-runtime.ts — the lazy, durable Codex SDK runtime the opt-in `codex-sdk`
 * line runs on.
 *
 * 2026-10-04 user ruling (dev-rules §7 note + super-dsh/AGENTS.md): this
 * package declares NO SDK dependency — not in `dependencies`, not in
 * `optionalDependencies`, and not in `peerDependencies` — and ships NO
 * postinstall/allow-scripts hook. Nothing is fetched at install time; the FIRST
 * real prompt fetches the runtime into the world home, where it is durable
 * across sessions, restarts and package upgrades. A second use reuses it
 * (idempotent), and a FAILED fetch leaves a trace on disk instead of silently
 * degrading into a confusing import crash at the first prompt.
 *
 * Why the world home rather than the package root: the package root is the
 * installed tarball — read-only in every real consumer install, and shared by
 * every world. The world home is per-runtime, writable, and already the home of
 * this adapter's own DSH state (`dsh-sessions.json`).
 *
 * Layout (the codex line is far simpler than the OMP one: the runtime is a
 * plain npm tree, so there is no bun, no sidecar, no per-platform native
 * binding dance):
 *
 *   <worldHome>/sdk-runtime/
 *     package.json                 written by us (private, never published)
 *     node_modules/                `npm install --exact --ignore-scripts --omit=dev`
 *     node_modules/@openai/codex-sdk/dist/index.js   the entry `loadCodexSdk` imports
 *   <worldHome>/sdk-runtime.json       marker — written LAST, its presence is the contract
 *   <worldHome>/sdk-runtime.lock       atomic (mkdir) bootstrap lock
 *   <worldHome>/sdk-runtime.error.log  written ONLY by a failed fetch
 *
 * Both packages are pinned together at 0.154.0 — the SDK resolves the native
 * `@openai/codex` binary package as its one dependency, so pinning only the
 * SDK would let a re-resolve drift the binary underneath it.
 *
 * The entry is imported BY RESOLVED PATH, never by bare specifier: the runtime
 * lives in the world home while this module lives in the plugin tarball, so a
 * bare-specifier form could not resolve it (and would quietly reintroduce the
 * dependency this module exists to delete). The package guard in
 * test/package-contract.test.mjs scans the EMITTED JS for that shape, so keep
 * this paragraph free of a literal import statement.
 *
 * Measured probe (2026-10-04): `@openai/codex-sdk@0.154.0` exports `"." ->
 * "./dist/index.js"` and its only dependency is `@openai/codex@0.154.0`.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** The coding-agent SDK this line drives (a plain npm package). */
export const SDK_PACKAGE = "@openai/codex-sdk";

/** The native binary package the SDK resolves at run time; pinned with the SDK. */
export const SDK_BINARY_PACKAGE = "@openai/codex";

/**
 * Pin of BOTH packages — the same 0.154.0 the app-server (primary) line pins,
 * so the two Codex faces agree on the wire behaviour they bridge.
 */
export const SDK_PACKAGE_VERSION = "0.154.0";

/** The entry `loadCodexSdk` imports, relative to the runtime dir. */
const SDK_ENTRY_RELATIVE = ["node_modules", SDK_PACKAGE, "dist", "index.js"];

/** Layout of the durable SDK runtime inside a world home. */
export interface SdkRuntimeLayout {
  /** The runtime root (holds `package.json` and `node_modules/`). */
  dir: string;
  /** The private manifest `npm install` adds the pinned packages to. */
  manifest: string;
  /** Where npm resolves the tree from (and the smoke import resolves into). */
  nodeModules: string;
  /** The installed SDK entry — present means the tree is usable. */
  entry: string;
  /** Written LAST; presence + matching identity means the runtime is complete. */
  marker: string;
  /** Bootstrap lock directory (mkdir is atomic on POSIX). */
  lock: string;
  /** Failure trace — only ever written by a failed fetch. */
  errorLog: string;
}

export function sdkRuntimeLayout(worldHome: string): SdkRuntimeLayout {
  const dir = join(worldHome, "sdk-runtime");
  return {
    dir,
    manifest: join(dir, "package.json"),
    nodeModules: join(dir, "node_modules"),
    entry: join(dir, ...SDK_ENTRY_RELATIVE),
    marker: join(worldHome, "sdk-runtime.json"),
    lock: join(worldHome, "sdk-runtime.lock"),
    errorLog: join(worldHome, "sdk-runtime.error.log"),
  };
}

/** The install marker: identity of the runtime plus where/when it landed. */
export interface SdkRuntimeRecord {
  /** Version of this adapter package at fetch time. */
  pluginVersion: string;
  /** Installed version of {@link SDK_PACKAGE}. */
  packageVersion: string;
  /** Installed version of {@link SDK_BINARY_PACKAGE}. */
  binaryVersion: string;
  /** Absolute path of the entry the runtime was smoke-imported from. */
  entryPath: string;
  /** ISO timestamp of the successful fetch. */
  installedAt: string;
}

/** The part of a record a caller can know before fetching (used for the compare). */
export interface SdkRuntimeIdentity {
  pluginVersion: string;
  packageVersion: string;
  binaryVersion: string;
}

/** Read the install marker; undefined when absent or unreadable. */
export function readSdkRuntimeRecord(worldHome: string): SdkRuntimeRecord | undefined {
  const { marker } = sdkRuntimeLayout(worldHome);
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as SdkRuntimeRecord;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fast path: the runtime is complete AND matches `identity` → its record.
 *
 * Returns undefined when the marker is absent/corrupt, when any identity field
 * differs (the adapter or a pin changed — a pin bump must refetch), or when the
 * recorded entry file is gone. In every such case the caller must (re)fetch.
 */
export function sdkRuntimeReady(worldHome: string, identity: SdkRuntimeIdentity): SdkRuntimeRecord | undefined {
  const record = readSdkRuntimeRecord(worldHome);
  if (record === undefined) return undefined;
  if (record.pluginVersion !== identity.pluginVersion) return undefined;
  if (record.packageVersion !== identity.packageVersion) return undefined;
  if (record.binaryVersion !== identity.binaryVersion) return undefined;
  if (!existsSync(sdkRuntimeLayout(worldHome).entry)) return undefined;
  return record;
}

/** Options for a single {@link SdkRuntimeDeps.run} invocation. */
export interface SdkRuntimeRunOptions {
  /** Working directory for the command (the runtime dir for the npm install). */
  cwd?: string;
  /**
   * Environment OVERRIDES merged on top of the inherited environment (so PATH
   * and npm's own config survive); an `undefined` value REMOVES the key.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Everything {@link ensureSdkRuntime} touches outside its own filesystem work,
 * injected so the bootstrap is testable with zero network and zero real npm.
 */
export interface SdkRuntimeDeps {
  /** Run a command to completion; must throw on a non-zero exit. */
  run(cmd: string, args: string[], opts?: SdkRuntimeRunOptions): Promise<void>;
  /** Version of this adapter package — part of the marker identity. */
  pluginVersion: string;
  /** Absolute path of this package's root (`package.json` lives there). */
  pluginDir: string;
  /** One human-readable progress line. */
  log(line: string): void;
}

/** A held lock older than this is treated as abandoned and reclaimed. */
const LOCK_STALE_MS = 30 * 60 * 1000;

/** The npm command the runtime tree is installed with (kept pure for the test). */
export function sdkInstallArgv(packageVersion: string = SDK_PACKAGE_VERSION): string[] {
  return [
    "install",
    "--exact",
    "--ignore-scripts",
    "--omit=dev",
    `${SDK_PACKAGE}@${packageVersion}`,
    `${SDK_BINARY_PACKAGE}@${packageVersion}`,
  ];
}

/**
 * The PRODUCTION {@link SdkRuntimeDeps}: the npm invocation plus the marker
 * identity read from this package's own manifest.
 *
 * Kept IN THE MODULE (not in `scripts/fetch-sdk-runtime.mjs`) so the manual
 * pre-warm script and the first-prompt lazy fetch (`loadCodexSdk`) share ONE
 * implementation: a second copy is exactly how the two paths would drift.
 *
 * `pluginDir` defaults to this package's root (the parent of the compiled
 * `dist/`), from which the marker identity reads the package's own version.
 *
 * @param pluginDir - package root holding `package.json`.
 * @returns deps for {@link ensureSdkRuntime}.
 */
export function createSdkRuntimeDeps(pluginDir: string = dirname(dirname(fileURLToPath(import.meta.url)))): SdkRuntimeDeps {
  return {
    run: runCommand,
    pluginVersion: readPluginVersion(pluginDir),
    pluginDir,
    log: (line) => process.stderr.write(`[agent-codex-sdk] ${line}\n`),
  };
}

/** The version of the adapter package at `pluginDir` (the marker identity half). */
export function readPluginVersion(pluginDir: string): string {
  const raw = readFileSync(join(pluginDir, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`codex-sdk: ${join(pluginDir, "package.json")} carries no version`);
  }
  return parsed.version;
}

const execFileAsync = promisify(execFile);

/**
 * Run a command to completion, inheriting the environment except for the
 * explicit overrides ({@link SdkRuntimeRunOptions.env}); an `undefined`
 * override REMOVES the key from the child. Rejects on a non-zero exit.
 */
async function runCommand(cmd: string, args: string[], opts?: SdkRuntimeRunOptions): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts?.env !== undefined) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  await execFileAsync(cmd, args, { cwd: opts?.cwd, env, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Return the record for `<worldHome>`'s durable SDK runtime, fetching it first
 * when it is absent, incomplete or does not match the running adapter.
 *
 * Idempotent: a complete, matching runtime short-circuits without touching the
 * network. Concurrent callers: the bootstrap is guarded by a `mkdir` lock — a
 * second caller that finds a FRESH lock throws a clear "fetch in progress"
 * error (no waiting; the SDK handle is a per-process singleton and the real
 * race is another dsh process on the same world home), while an abandoned lock
 * (older than {@link LOCK_STALE_MS}) is reclaimed so a crashed fetch cannot
 * brick the line.
 *
 * Failures append to `<worldHome>/sdk-runtime.error.log` and throw a single
 * actionable error — never a partial runtime behind a success marker.
 */
export async function ensureSdkRuntime(worldHome: string, deps: SdkRuntimeDeps): Promise<SdkRuntimeRecord> {
  const layout = sdkRuntimeLayout(worldHome);
  const identity: SdkRuntimeIdentity = {
    pluginVersion: deps.pluginVersion,
    packageVersion: SDK_PACKAGE_VERSION,
    binaryVersion: SDK_PACKAGE_VERSION,
  };

  const ready = sdkRuntimeReady(worldHome, identity);
  if (ready !== undefined) {
    deps.log(`codex-sdk: runtime ready (${SDK_PACKAGE}@${ready.packageVersion})`);
    return ready;
  }

  mkdirSync(worldHome, { recursive: true });
  acquireLock(layout, deps);
  try {
    // Re-check inside the lock: a peer may have completed the fetch in the
    // window between our check and the lock, in which case we pay nothing.
    const done = sdkRuntimeReady(worldHome, identity);
    if (done !== undefined) return done;

    try {
      return await buildRuntime(layout, deps, identity);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stamp = new Date().toISOString();
      try {
        appendFileSync(layout.errorLog, `[${stamp}] codex-sdk runtime fetch failed: ${detail}\n`);
      } catch {
        /* the trace is best-effort; the throw below is the contract */
      }
      throw new Error(
        `codex-sdk: could not fetch the SDK runtime ` +
          `(${SDK_PACKAGE}@${SDK_PACKAGE_VERSION} + ${SDK_BINARY_PACKAGE}@${SDK_PACKAGE_VERSION}) at ${layout.dir}: ${detail}. ` +
          `Pre-warm it by hand with \`npm run fetch-sdk-runtime\`. Trace: ${layout.errorLog}`,
      );
    }
  } finally {
    rmSync(layout.lock, { recursive: true, force: true });
  }
}

/** The idempotent build steps; the marker is written last, after the smoke check. */
async function buildRuntime(
  layout: SdkRuntimeLayout,
  deps: SdkRuntimeDeps,
  identity: SdkRuntimeIdentity,
): Promise<SdkRuntimeRecord> {
  mkdirSync(layout.dir, { recursive: true });

  // npm needs a manifest to own the tree; `private` + a throwaway version keep
  // it unambiguously not-a-publishable-package, and an existing one is left
  // alone so a later install can still be reproduced by hand.
  if (!existsSync(layout.manifest)) {
    writeFileSync(
      layout.manifest,
      JSON.stringify({ name: "codex-sdk-runtime", private: true, version: "0.0.0" }, null, 2) + "\n",
    );
  }

  deps.log(`codex-sdk: installing ${SDK_PACKAGE}@${SDK_PACKAGE_VERSION} + ${SDK_BINARY_PACKAGE}@${SDK_PACKAGE_VERSION}`);
  await deps.run("npm", sdkInstallArgv(), { cwd: layout.dir });

  // Smoke step: import the installed entry through its RESOLVED path and
  // require a constructor. Without it a broken tree would only surface at the
  // first prompt, inside the agent's cold-start error path, far from the fetch
  // that produced it.
  if (!existsSync(layout.entry)) {
    throw new Error(`npm install produced no ${layout.entry} (the package layout changed?)`);
  }
  deps.log(`codex-sdk: smoke-importing ${SDK_PACKAGE}@${SDK_PACKAGE_VERSION}`);
  const module = (await import(pathToFileURL(layout.entry).href)) as { Codex?: unknown };
  if (typeof module.Codex !== "function") {
    throw new Error(`smoke import of ${SDK_PACKAGE}@${SDK_PACKAGE_VERSION} exposed no Codex constructor`);
  }

  // Marker LAST — a crash before this point leaves an incomplete runtime that
  // the next call heals, never a false success.
  const record: SdkRuntimeRecord = {
    ...identity,
    entryPath: layout.entry,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(layout.marker, JSON.stringify(record, null, 2) + "\n");
  rmSync(layout.errorLog, { force: true });
  deps.log(`codex-sdk: runtime ready at ${layout.dir}`);
  return record;
}

/** The minimal structural shape of the SDK entry module (never statically imported). */
export interface CodexSdkModule {
  /** The SDK entry object the client's default factory constructs. */
  Codex: new (options?: { env?: Record<string, string> }) => unknown;
}

/**
 * Ensure the durable runtime and return the installed SDK module — the ONE
 * function the client's default factory calls, and the only place a real
 * download/install happens on the lazy path.
 *
 * The returned module is a real ESM namespace; the caller treats it
 * structurally (the client declares its own interfaces and never imports this
 * package's types).
 */
export async function loadCodexSdk(worldHome: string): Promise<CodexSdkModule> {
  await ensureSdkRuntime(worldHome, createSdkRuntimeDeps());
  const { entry } = sdkRuntimeLayout(worldHome);
  const module = (await import(pathToFileURL(entry).href)) as { Codex?: unknown };
  if (typeof module.Codex !== "function") {
    throw new Error(`codex-sdk: ${entry} exposes no Codex constructor`);
  }
  return module as CodexSdkModule;
}

/**
 * mkdir-based mutex. Returns owning the lock; throws when a fresh lock is held
 * by someone else; reclaims a lock older than {@link LOCK_STALE_MS}.
 */
function acquireLock(layout: SdkRuntimeLayout, deps: SdkRuntimeDeps): void {
  for (; ;) {
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
      deps.log(`codex-sdk: reclaiming stale runtime lock (age ${Math.round(ageMs / 1000)}s)`);
      rmSync(layout.lock, { recursive: true, force: true });
      continue;
    }
    throw new Error(
      `codex-sdk: another SDK runtime fetch is already in progress (lock ${layout.lock}). ` +
        `Retry once it finishes; if no fetch is running, remove that lock directory.`,
    );
  }
}
