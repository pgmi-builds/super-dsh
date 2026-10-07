/**
 * sdk-runtime.ts — the lazy, durable SDK runtime the opt-in `omp-sdk` line runs on.
 *
 * 2026-10-03 user ruling (spec §2.4): this package declares NO SDK and NO `bun`
 * dependency and ships NO postinstall/allow-scripts hook. Nothing is fetched at
 * install time; the FIRST real prompt fetches the runtime into the world home,
 * where it is durable across sessions, restarts and package upgrades. A second
 * use reuses it (idempotent), and a FAILED fetch leaves a trace on disk instead
 * of silently degrading into a confusing sidecar crash.
 *
 * Why the world home rather than the package root: the package root is the
 * installed tarball — read-only in every real consumer install, and shared by
 * every world. The world home is per-runtime, writable, and already the home of
 * this adapter's own state.
 *
 * What lands where (bun resolves `node_modules` from the runtime dir, so the
 * sidecar must live there):
 *
 *   <worldHome>/sdk-runtime/
 *     bin/bun                      (a) the bun release, unzipped into place
 *     package.json / node_modules/ (b) installed with that bun
 *     sidecar/main.ts              (c) copied from this package
 *     dist/protocol.js             (c) copied from this package
 *   <worldHome>/sdk-runtime.json       marker — written LAST, its presence is the contract
 *   <worldHome>/sdk-runtime.lock       atomic (mkdir) bootstrap lock
 *   <worldHome>/sdk-runtime.error.log  written ONLY by a failed fetch
 *
 * Every step is idempotent, so a half-built runtime heals in place: an existing
 * `bin/bun` is not re-downloaded, and a missing marker simply re-runs the
 * remaining steps.
 *
 * Measured cost (2026-10-03 probe, spec §1 + §3.3). bun release zip 36.6 MB,
 * `bun add` ~2-5 s. A FULL install is 1133 MB / 114 packages, but the largest
 * chunk of that is dead weight here: `@huggingface/transformers` +
 * `onnxruntime-{node,web}` (~234 MB) come in through `optionalDependencies` and
 * their native postinstall is blocked by `--ignore-scripts` anyway.
 * `--omit=optional` alone is 535 MB but BREAKS the import — `@oh-my-pi/pi-natives`
 * declares its platform binding in `optionalDependencies`, so bun drops
 * `@oh-my-pi/pi-natives-<platform>` and the sidecar dies with `Failed to load
 * pi_natives native addon for <platform>`. Re-adding that platform package
 * explicitly is the fix: **899 MB / 84 packages, import passes**. Escape hatch:
 * `OMP_SDK_KEEP_OPTIONAL=1` drops `--omit=optional` and reinstates the full
 * 1133 MB tree.
 *
 * bun's install cache is another ~1.2 GB, so it is redirected to
 * `<runtime>/.cache` and deleted once the install succeeds.
 *
 * The pin defaults to 18.5.0 because 18.4.9 is BROKEN for source-level import:
 * its `src/sdk.ts` imports `./ratchet/prelude` extensionless, so bun resolves
 * the template file `src/ratchet/prelude.js` instead of the real module and
 * `bun -e 'await import("@oh-my-pi/pi-coding-agent")'` dies with
 * `SyntaxError: Export named 'createRatchetPrelude' not found in module
 * '.../src/ratchet/prelude.js'`. Upstream fixed it in 18.5.0 by renaming the
 * real module to `./ratchet/prelude-definition`. The smoke step in
 * {@link ensureSdkRuntime} pins that diagnosis down at fetch time; 18.2.11 is
 * the last known-good fallback (`OMP_SDK_PACKAGE_VERSION=18.2.11`).
 *
 * Probe evidence: 18.5.0 slim = 84 packages / 899 MB / smoke ✅; 18.5.0 full =
 * 114 packages / 1133 MB / smoke ✅; 18.4.9 = smoke ❌ (`createRatchetPrelude`);
 * 18.2.11 = smoke ✅ (no `src/ratchet/` at all).
 */

import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The coding-agent package the sidecar imports (same program as the `omp` binary). */
export const SDK_PACKAGE = "@oh-my-pi/pi-coding-agent";

/** Prefix of the per-platform native binding package (`-<platform>` is appended). */
export const SDK_NATIVES_PACKAGE_PREFIX = "@oh-my-pi/pi-natives";

/**
 * Pin of {@link SDK_PACKAGE} (and of the native binding package). Defaults to
 * the operator's local `omp --version` family (18.5.0) so both OMP faces run
 * the same code; `OMP_SDK_PACKAGE_VERSION` overrides it. Do not go back to
 * 18.4.9 — see the module doc (broken source-level import).
 */
export const SDK_PACKAGE_VERSION = process.env.OMP_SDK_PACKAGE_VERSION ?? "18.5.0";

/** The bun release the sidecar runs on; `OMP_SDK_BUN_VERSION` overrides it. */
export const SDK_BUN_VERSION = process.env.OMP_SDK_BUN_VERSION ?? "1.4.2";

/** The bun release platform archive this adapter fetches (worlds run on linux-x64). */
export const SDK_BUN_PLATFORM = "linux-x64";

/** `@oh-my-pi/pi-natives` ships one binding package per platform tuple. */
export type SdkNativesPlatform =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "win32-x64"
  | "win32-arm64";

/**
 * Pure `process.platform`/`process.arch` → natives binding key.
 * Throws for a tuple `@oh-my-pi/pi-natives` does not publish (fail loud rather
 * than install a runtime whose addon cannot load).
 */
export function sdkNativesPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): SdkNativesPlatform {
  switch (`${platform}-${arch}`) {
    case "linux-x64":
    case "linux-arm64":
    case "darwin-x64":
    case "darwin-arm64":
    case "win32-x64":
    case "win32-arm64":
      return `${platform}-${arch}` as SdkNativesPlatform;
    default:
      throw new Error(
        `omp-sdk: @oh-my-pi/pi-natives publishes no binding for ${platform}-${arch}`,
      );
  }
}

/** The exact natives binding package name for a platform key. */
export function sdkNativesPackage(platform: SdkNativesPlatform): string {
  return `${SDK_NATIVES_PACKAGE_PREFIX}-${platform}`;
}

/**
 * The install argv (pure, so the slim-install recipe is testable).
 *
 * `--omit=optional` drops the ~234 MB transformers/onnxruntime weight; the
 * explicit natives package restores the one optional dependency the import
 * actually needs. `keepOptional` (env `OMP_SDK_KEEP_OPTIONAL=1`) reinstates the
 * full tree.
 */
export function sdkInstallArgv(
  packageVersion: string,
  platform: SdkNativesPlatform,
  keepOptional = false,
): string[] {
  const args = ["add", "--exact", "--ignore-scripts"];
  if (!keepOptional) args.push("--omit=optional");
  args.push(
    `${SDK_PACKAGE}@${packageVersion}`,
    `${sdkNativesPackage(platform)}@${packageVersion}`,
  );
  return args;
}

/** The exact GitHub release asset URL of a bun version's linux-x64 build. */
export function bunReleaseZipUrl(bunVersion: string): string {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-${SDK_BUN_PLATFORM}.zip`;
}

/** Layout of the durable SDK runtime inside a world home. */
export interface SdkRuntimeLayout {
  /** The runtime root (holds `bin/`, `node_modules/`, `sidecar/`, `dist/`). */
  dir: string;
  /** The fetched bun binary the sidecar is spawned with. */
  bun: string;
  /** Written LAST; presence + matching identity means the runtime is complete. */
  marker: string;
  /** Bootstrap lock directory (mkdir is atomic on POSIX). */
  lock: string;
  /** Failure trace — only ever written by a failed fetch. */
  errorLog: string;
  /** Destination directory of the copied sidecar. */
  sidecarDir: string;
  /** The sidecar entrypoint inside the runtime dir (bun resolves modules from here). */
  sidecarEntry: string;
  /** Destination directory of the copied compiled protocol module. */
  protocolDir: string;
}

export function sdkRuntimeLayout(worldHome: string): SdkRuntimeLayout {
  const dir = join(worldHome, "sdk-runtime");
  return {
    dir,
    bun: join(dir, "bin", "bun"),
    marker: join(worldHome, "sdk-runtime.json"),
    lock: join(worldHome, "sdk-runtime.lock"),
    errorLog: join(worldHome, "sdk-runtime.error.log"),
    sidecarDir: join(dir, "sidecar"),
    sidecarEntry: join(dir, "sidecar", "main.ts"),
    protocolDir: join(dir, "dist"),
  };
}

/** Destination of the compiled protocol module copied beside the sidecar. */
export function sdkRuntimeProtocolEntry(layout: SdkRuntimeLayout): string {
  return join(layout.protocolDir, "protocol.js");
}

/** The install marker: identity of the runtime plus where/when it landed. */
export interface SdkRuntimeRecord {
  /** Version of this adapter package at fetch time. */
  pluginVersion: string;
  /** Installed version of {@link SDK_PACKAGE}. */
  packageVersion: string;
  /** Installed bun version. */
  bunVersion: string;
  /** Absolute path of the fetched bun binary. */
  bunPath: string;
  /** ISO timestamp of the successful fetch. */
  installedAt: string;
}

/** The part of a record a caller can know before fetching (used for the compare). */
export interface SdkRuntimeIdentity {
  pluginVersion: string;
  packageVersion: string;
  bunVersion: string;
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
 * differs (the adapter or a pin changed), or when the recorded bun binary is
 * gone — in every such case the caller must (re)fetch.
 */
export function sdkRuntimeReady(
  worldHome: string,
  identity: SdkRuntimeIdentity,
): SdkRuntimeRecord | undefined {
  const record = readSdkRuntimeRecord(worldHome);
  if (record === undefined) return undefined;
  if (record.pluginVersion !== identity.pluginVersion) return undefined;
  if (record.packageVersion !== identity.packageVersion) return undefined;
  if (record.bunVersion !== identity.bunVersion) return undefined;
  if (!existsSync(sdkRuntimeLayout(worldHome).bun)) return undefined;
  return record;
}

/** Options for a single {@link SdkRuntimeDeps.run} invocation. */
export interface SdkRuntimeRunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /**
   * Environment OVERRIDES merged on top of the inherited environment (so PATH
   * and friends survive). Used to redirect bun's install cache and to keep the
   * smoke import out of the operator's native `~/.omp`.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Everything {@link ensureSdkRuntime} touches outside its own filesystem work,
 * injected so the bootstrap is testable with zero network and zero real bun.
 */
export interface SdkRuntimeDeps {
  /** Fetch `url` to the file `dest` (real implementation shells out to curl). */
  download(url: string, dest: string): Promise<void>;
  /** Run a command to completion; must throw on a non-zero exit. */
  run(cmd: string, args: string[], opts?: SdkRuntimeRunOptions): Promise<void>;
  /** Copy a regular file (the sidecar source and the compiled protocol module). */
  copy(from: string, to: string): void;
  /** Version of this adapter package — part of the marker identity. */
  pluginVersion: string;
  /** Absolute path of this package's root (`sidecar/`, `dist/` sources live there). */
  pluginDir: string;
  /** One human-readable progress line. */
  log(line: string): void;
}

/** A held lock older than this is treated as abandoned and reclaimed. */
const LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * The PRODUCTION {@link SdkRuntimeDeps}: everything the bootstrap touches
 * outside its own filesystem work, wired to real OS primitives.
 *
 * Kept IN THE MODULE (not in `scripts/fetch-sdk-runtime.mjs`) so the manual
 * pre-warm script and the first-prompt lazy fetch (sidecar `start()`) share ONE
 * implementation: a second copy is exactly how the two paths would drift.
 *
 * `pluginDir` defaults to this package's root (the parent of the compiled
 * `dist/`), from which the sidecar source and the compiled protocol module are
 * copied into the runtime; the marker identity reads the package's own version.
 *
 * @param pluginDir - package root holding `sidecar/main.ts` + `dist/protocol.js`.
 * @returns deps for {@link ensureSdkRuntime}.
 */
export function createSdkRuntimeDeps(pluginDir: string = pathDirname(fileURLToPath(import.meta.url), "..")): SdkRuntimeDeps {
  return {
    download: downloadToFile,
    run: runCommand,
    copy: (from, to) => {
      mkdirSync(pathDirname(to), { recursive: true });
      copyFileSync(from, to);
    },
    pluginVersion: readPluginVersion(pluginDir),
    pluginDir,
    log: (line) => process.stderr.write(`[agent-omp-sdk] ${line}\n`),
  };
}

/** The version of the adapter package at `pluginDir` (the marker identity half). */
export function readPluginVersion(pluginDir: string): string {
  const raw = readFileSync(join(pluginDir, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`omp-sdk: ${join(pluginDir, "package.json")} carries no version`);
  }
  return parsed.version;
}

/** `dirname` without importing it twice under two names. */
function pathDirname(...parts: string[]): string {
  return dirname(join(...parts));
}

const execFileAsync = promisify(execFile);

/**
 * Run a command to completion, inheriting the environment except for the
 * explicit overrides ({@link SdkRuntimeRunOptions.env}); an `undefined`
 * override REMOVES the key from the child (needed for the smoke import's
 * redirected agent dir). Rejects on a non-zero exit.
 */
async function runCommand(
  cmd: string,
  args: string[],
  opts?: SdkRuntimeRunOptions,
): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts?.env !== undefined) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  await execFileAsync(cmd, args, { cwd: opts?.cwd, env, maxBuffer: 64 * 1024 * 1024 });
}

/** Stream `url` to the file `dest` (curl-free — Node's own fetch). */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  if (response.body === null) throw new Error(`download failed: empty body for ${url}`);
  mkdirSync(pathDirname(dest), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
  } catch (error) {
    await rm(dest, { force: true });
    throw error;
  }
}

/**
 * Return the record for `<worldHome>`'s durable SDK runtime, fetching it first
 * when it is absent, incomplete or does not match the running adapter.
 *
 * Idempotent: a complete, matching runtime short-circuits without touching the
 * network. Concurrent callers: the bootstrap is guarded by a `mkdir` lock — a
 * second caller that finds a FRESH lock throws a clear "fetch in progress"
 * error (no waiting; the SDK transport is a per-process singleton, so the real
 * race is another dsh process on the same world home), while an abandoned lock
 * (older than {@link LOCK_STALE_MS}) is reclaimed so a crashed fetch cannot
 * brick the line.
 *
 * Failures append to `<worldHome>/sdk-runtime.error.log` and throw a single
 * actionable error — never a partial runtime behind a success marker.
 */
export async function ensureSdkRuntime(
  worldHome: string,
  deps: SdkRuntimeDeps,
): Promise<SdkRuntimeRecord> {
  const layout = sdkRuntimeLayout(worldHome);
  const identity: SdkRuntimeIdentity = {
    pluginVersion: deps.pluginVersion,
    packageVersion: SDK_PACKAGE_VERSION,
    bunVersion: SDK_BUN_VERSION,
  };

  const ready = sdkRuntimeReady(worldHome, identity);
  if (ready !== undefined) {
    deps.log(
      `omp-sdk: runtime ready (${SDK_PACKAGE}@${ready.packageVersion}, bun ${ready.bunVersion})`,
    );
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
        appendFileSync(
          layout.errorLog,
          `[${stamp}] omp-sdk runtime fetch failed: ${detail}\n`,
        );
      } catch {
        /* the trace is best-effort; the throw below is the contract */
      }
      throw new Error(
        `omp-sdk: could not fetch the SDK runtime ` +
        `(${SDK_PACKAGE}@${SDK_PACKAGE_VERSION} + bun ${SDK_BUN_VERSION}) at ${layout.dir}: ${detail}. ` +
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

  // (a) bun — skipped when a previous attempt already landed the binary.
  if (!existsSync(layout.bun)) {
    const zip = join(layout.dir, `bun-${SDK_BUN_PLATFORM}.zip`);
    const staging = join(layout.dir, ".bun-unzip");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const url = bunReleaseZipUrl(SDK_BUN_VERSION);
    deps.log(`omp-sdk: downloading bun ${SDK_BUN_VERSION} (${url})`);
    await deps.download(url, zip);
    await deps.run("unzip", ["-o", zip, "-d", staging], { cwd: layout.dir });
    mkdirSync(join(layout.dir, "bin"), { recursive: true });
    deps.copy(join(staging, `bun-${SDK_BUN_PLATFORM}`, "bun"), layout.bun);
    rmSync(staging, { recursive: true, force: true });
    rmSync(zip, { force: true });
    if (!existsSync(layout.bun)) {
      throw new Error(`bun archive produced no ${layout.bun} (unzip layout changed?)`);
    }
    deps.log(`omp-sdk: bun ${SDK_BUN_VERSION} ready at ${layout.bun}`);
  }

  // (b) the SDK package, installed WITH the fetched bun (cwd = the runtime dir),
  // so `node_modules` lands where the sidecar will resolve it from. Slim
  // install: --omit=optional plus the explicit platform binding (see module doc).
  const manifest = join(layout.dir, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      JSON.stringify({ name: "omp-sdk-runtime", private: true, version: "0.0.0" }, null, 2) + "\n",
    );
  }
  const platform = sdkNativesPlatform();
  const argv = sdkInstallArgv(
    SDK_PACKAGE_VERSION,
    platform,
    process.env.OMP_SDK_KEEP_OPTIONAL === "1",
  );
  const cacheDir = join(layout.dir, ".cache");
  deps.log(`omp-sdk: installing ${SDK_PACKAGE}@${SDK_PACKAGE_VERSION} (${platform})`);
  await deps.run(layout.bun, argv, { cwd: layout.dir, env: { BUN_INSTALL_CACHE_DIR: cacheDir } });
  // The bun install cache is install-only (~1.2 GB against a ~0.9 GB tree):
  // keeping it would roughly double the disk footprint for nothing.
  rmSync(cacheDir, { recursive: true, force: true });

  // (c) sidecar + compiled protocol live beside node_modules.
  mkdirSync(layout.sidecarDir, { recursive: true });
  deps.copy(join(deps.pluginDir, "sidecar", "main.ts"), layout.sidecarEntry);
  mkdirSync(layout.protocolDir, { recursive: true });
  deps.copy(join(deps.pluginDir, "dist", "protocol.js"), sdkRuntimeProtocolEntry(layout));

  // (c2) smoke: the pin must be importable from source level, or the sidecar
  // would only die on its first import at the first prompt. 18.4.9 fails here
  // (see the module doc) — fail loud now, naming the override. The agent dir is
  // pointed INSIDE the runtime tree so the operator's native `~/.omp` is never
  // touched by a check.
  const smokeDir = join(layout.dir, ".smoke");
  mkdirSync(smokeDir, { recursive: true });
  deps.log(`omp-sdk: smoke-importing ${SDK_PACKAGE}@${SDK_PACKAGE_VERSION}`);
  try {
    await deps.run(layout.bun, ["-e", `await import(${JSON.stringify(SDK_PACKAGE)})`], {
      cwd: layout.dir,
      env: { PI_CODING_AGENT_DIR: smokeDir, OMP_HOME: smokeDir },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `smoke import of ${SDK_PACKAGE}@${SDK_PACKAGE_VERSION} failed ` +
      `(override with OMP_SDK_PACKAGE_VERSION — e.g. 18.2.11 — and refetch): ${detail}`,
    );
  } finally {
    rmSync(smokeDir, { recursive: true, force: true });
  }

  // (d) marker LAST — a crash before this point leaves an incomplete runtime
  // that the next call heals, never a false success.
  const record: SdkRuntimeRecord = {
    ...identity,
    bunPath: layout.bun,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(layout.marker, JSON.stringify(record, null, 2) + "\n");
  rmSync(layout.errorLog, { force: true });
  deps.log(`omp-sdk: runtime ready at ${layout.dir}`);
  return record;
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
      deps.log(`omp-sdk: reclaiming stale runtime lock (age ${Math.round(ageMs / 1000)}s)`);
      rmSync(layout.lock, { recursive: true, force: true });
      continue;
    }
    throw new Error(
      `omp-sdk: another SDK runtime fetch is already in progress (lock ${layout.lock}). ` +
      `Retry once it finishes; if no fetch is running, remove that lock directory.`,
    );
  }
}
