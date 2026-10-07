/**
 * sdk-runtime.ts — the lazy, durable Claude Agent SDK runtime (2026-10-04 spec §2.1).
 *
 * Zero declared dependency: the FIRST real prompt fetches
 * `@anthropic-ai/claude-agent-sdk` into <worldHome>/sdk-runtime/ and it stays
 * durable there. Two modes (user ruling 2026-10-04): host-binary (default,
 * `--omit=optional` — the 206 MB platform payload is never downloaded; the CLI
 * is the user's own binary) and bundled-payload (no local binary: the SDK's
 * own platform payload IS the CLI). A mode flip re-installs with the other
 * flag set (idempotent heal); a FAILED fetch writes sdk-runtime.error.log and
 * throws — never a silent degradation.
 *
 * Layout (the marker/lock/error-log mechanism is, in shape, the one
 * `agent-codex-sdk/src/sdk-runtime.ts` runs on):
 *
 *   <worldHome>/sdk-runtime/            npm tree (`--ignore-scripts`)
 *     package.json                 the ANCHOR we write before install
 *                                  (private, never published): npm otherwise
 *                                  resolves the nearest ancestor project and
 *                                  may exit 0 having landed nothing here
 *     node_modules/@anthropic-ai/claude-agent-sdk/
 *       sdk.mjs                         the entry `loadClaudeQuery` imports
 *   <worldHome>/sdk-runtime.json        marker — written LAST; a matching
 *                                       identity AND a live entry mean complete
 *   <worldHome>/sdk-runtime.lock        atomic (mkdir) bootstrap lock
 *   <worldHome>/sdk-runtime.error.log   written ONLY by a failed fetch
 *
 * Why the world home rather than the package root: the package root is the
 * installed tarball — read-only in every real consumer install and shared by
 * every world — while the world home is per-runtime, writable, and already the
 * home of this adapter's own DSH state.
 *
 * Mode is re-derived on EVERY call: the host binary is resolved again (it may
 * have appeared or vanished since the fetch), and a marker whose recorded mode
 * no longer matches re-installs under the other flag set.
 *
 * Every path derives from the explicit `worldHome` argument — this module never
 * reads the ambient `DSH_HOME` — and the SDK entry is imported BY RESOLVED PATH,
 * never by a bare specifier: the runtime lives in the world home while this
 * module lives in the plugin tarball, so a bare specifier could not resolve it
 * and would quietly reintroduce the dependency this module exists to delete.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** The coding-agent SDK this line drives (a plain npm package, never declared). */
export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The pin, written here rather than in `package.json` — the marker carries it. */
export const SDK_PACKAGE_VERSION = "0.3.291";

/**
 * How the CLI behind the SDK is obtained:
 * - `host-binary` — a `claude` executable was resolved locally, so the SDK's
 *   optional platform payload is omitted (`--omit=optional`, ≈4.9 MB).
 * - `bundled-payload` — no local binary, so the SDK's own platform payload IS
 *   the CLI and the optional dependency must be installed (≈206 MB, once).
 */
export type SdkRuntimeMode = "host-binary" | "bundled-payload";

/** Where the durable SDK runtime lives inside a world home. */
export interface SdkRuntimeLayout {
  /** The runtime root (holds `node_modules/`; created by the fetch). */
  dir: string;
  /** Written LAST; presence plus a matching identity means the runtime is complete. */
  marker: string;
  /** Bootstrap lock directory (mkdir is atomic on POSIX). */
  lock: string;
  /** Failure trace — only ever written by a failed fetch. */
  errorLog: string;
}

export function sdkRuntimeLayout(worldHome: string): SdkRuntimeLayout {
  return {
    dir: join(worldHome, "sdk-runtime"),
    marker: join(worldHome, "sdk-runtime.json"),
    lock: join(worldHome, "sdk-runtime.lock"),
    errorLog: join(worldHome, "sdk-runtime.error.log"),
  };
}

/** The install marker: which SDK, which pin, which mode, and when it landed. */
export interface SdkRuntimeRecord {
  /** Always {@link SDK_PACKAGE} — a marker for anything else is not ours. */
  sdkPackage: string;
  /** Installed version of {@link SDK_PACKAGE}. */
  sdkVersion: string;
  /** The mode the tree was installed under. */
  mode: SdkRuntimeMode;
  /** `deps.now()` at the successful fetch (epoch millis). */
  createdAt: number;
}

/** The entry `loadClaudeQuery` imports — the SDK's `exports["."]`. */
export function sdkEntryPath(worldHome: string): string {
  return join(sdkRuntimeLayout(worldHome).dir, "node_modules", SDK_PACKAGE, "sdk.mjs");
}

/** Read the install marker; undefined when absent, unreadable or not our shape. */
export function readSdkRuntimeRecord(worldHome: string): SdkRuntimeRecord | undefined {
  const { marker } = sdkRuntimeLayout(worldHome);
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<SdkRuntimeRecord>;
    if (record.sdkPackage !== SDK_PACKAGE) return undefined;
    if (typeof record.sdkVersion !== "string") return undefined;
    if (record.mode !== "host-binary" && record.mode !== "bundled-payload") return undefined;
    if (typeof record.createdAt !== "number") return undefined;
    return record as SdkRuntimeRecord;
  } catch {
    return undefined;
  }
}

/**
 * The fast path: the marker is present, is ours, carries the current pin, was
 * written under `wantedMode`, AND the SDK entry it promises still exists.
 *
 * The marker is written LAST, after a successful install, so its identity match
 * normally implies the tree underneath; but an identity match alone is not
 * enough. `fetchRuntime`'s failure path deletes the tree, a user may delete it
 * by hand, and a half-wiped install can leave the (separate) marker behind. The
 * entry `existsSync` is therefore the completeness contract: without it a stale
 * marker would hand back a record whose `sdk.mjs` is gone and every prompt would
 * fail `ERR_MODULE_NOT_FOUND` until someone removed the marker by hand. One stat
 * costs nothing next to a 206 MB re-download.
 */
function sdkRuntimeReady(worldHome: string, wantedMode: SdkRuntimeMode): SdkRuntimeRecord | undefined {
  const record = readSdkRuntimeRecord(worldHome);
  if (record === undefined) return undefined;
  if (record.sdkVersion !== SDK_PACKAGE_VERSION) return undefined;
  if (record.mode !== wantedMode) return undefined;
  if (!existsSync(sdkEntryPath(worldHome))) return undefined;
  return record;
}

/**
 * Resolve the host Claude Code binary, most specific first:
 * `CLAUDE_EXECUTABLE` (only when it exists) > `claude` on `PATH` >
 * `~/.local/bin/claude` > `/usr/local/bin/claude`.
 *
 * `undefined` means "no local binary" and is the trigger for
 * `bundled-payload` — never a bare `"claude"` fallback, which would pretend a
 * host binary exists and make the SDK spawn a name that is not on `PATH`.
 */
export function resolveClaudeBinary(): string | undefined {
  const override = process.env.CLAUDE_EXECUTABLE;
  if (override && existsSync(override)) return override;
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, "claude");
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [join(homedir(), ".local/bin/claude"), "/usr/local/bin/claude"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The npm argv the runtime tree is installed with (kept pure for the test). */
export function sdkInstallArgv(version: string, mode: SdkRuntimeMode): string[] {
  const argv = [
    "install",
    "--save-exact",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    `${SDK_PACKAGE}@${version}`,
  ];
  if (mode === "host-binary") argv.push("--omit=optional");
  return argv;
}

/**
 * Everything {@link ensureSdkRuntime} touches outside its own filesystem work,
 * injected so the bootstrap is testable with zero network and zero real npm.
 */
export interface SdkRuntimeDeps {
  /** Run a command to completion; must reject on a non-zero exit. */
  install(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void>;
  /** Clock for the marker's `createdAt`. */
  now(): number;
}

/** A held lock older than this is treated as abandoned and reclaimed. */
const LOCK_STALE_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

/**
 * The production `install`: `SUPERD_SDK_NPM` (so the fetch can be pointed at
 * pnpm/corepack) over an otherwise inherited environment, run in the runtime
 * dir. `maxBuffer` is raised for npm's progress output.
 */
async function defaultInstall(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Return the record for `<worldHome>`'s durable SDK runtime, fetching it first
 * when it is absent, stale or was installed under the other mode.
 *
 * Idempotent: a complete, matching runtime short-circuits without touching the
 * network. Concurrent callers are separated by a `mkdir` lock — a second caller
 * that finds a FRESH lock fails with a clear "fetch in progress" error (the SDK
 * handle is a per-process singleton; the real race is another dsh process on
 * the same world home), while an abandoned lock (older than
 * {@link LOCK_STALE_MS}) is reclaimed so a crashed fetch cannot brick the line.
 *
 * A failure appends to `<worldHome>/sdk-runtime.error.log`, drops the partial
 * tree and throws one actionable error — never a marker, so the next call heals.
 */
export async function ensureSdkRuntime(
  worldHome: string,
  deps?: Partial<SdkRuntimeDeps>,
): Promise<SdkRuntimeRecord> {
  const install = deps?.install ?? defaultInstall;
  const now = deps?.now ?? Date.now;
  const layout = sdkRuntimeLayout(worldHome);
  const wantedMode: SdkRuntimeMode = resolveClaudeBinary() !== undefined ? "host-binary" : "bundled-payload";

  const ready = sdkRuntimeReady(worldHome, wantedMode);
  if (ready !== undefined) return ready;

  mkdirSync(worldHome, { recursive: true });
  acquireLock(layout);
  try {
    // Re-check inside the lock: a peer may have completed the fetch in the
    // window between our check and the lock, in which case we pay nothing.
    const done = sdkRuntimeReady(worldHome, wantedMode);
    if (done !== undefined) return done;

    try {
      return await fetchRuntime(worldHome, layout, wantedMode, install, now);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        appendFileSync(
          layout.errorLog,
          `[${new Date().toISOString()}] agent-claude SDK runtime fetch failed: ${detail}\n`,
        );
      } catch {
        /* the trace is best-effort; the throw below is the contract */
      }
      rmSync(layout.dir, { recursive: true, force: true });
      throw new Error(
        `agent-claude: could not fetch the SDK runtime ` +
        `(${SDK_PACKAGE}@${SDK_PACKAGE_VERSION}, ${wantedMode} mode) at ${layout.dir}: ${detail}. ` +
        `Trace: ${layout.errorLog}`,
      );
    }
  } finally {
    rmSync(layout.lock, { recursive: true, force: true });
  }
}

/** The private manifest that anchors npm to the runtime dir (never published). */
const RUNTIME_MANIFEST = '{"name":"superd-claude-sdk-runtime","private":true}\n';

/**
 * The idempotent install step. npm is anchored to the runtime dir by a private
 * manifest BEFORE install (without one, npm resolves the nearest ANCESTOR
 * project and may exit 0 having landed nothing here), and the entry is
 * verified on disk BEFORE the marker is written — exit 0 alone is not success.
 */
async function fetchRuntime(
  worldHome: string,
  layout: SdkRuntimeLayout,
  mode: SdkRuntimeMode,
  install: SdkRuntimeDeps["install"],
  now: SdkRuntimeDeps["now"],
): Promise<SdkRuntimeRecord> {
  mkdirSync(layout.dir, { recursive: true });

  // ANCHOR — npm resolves a tree from the nearest ancestor holding a
  // package.json; with none in the runtime dir it walks up (on the real
  // machine: to the repo root), reports "up to date" against THAT project,
  // exits 0 and lands no tree here — yet the marker used to be written anyway,
  // so every later loadClaudeQuery failed and each "heal" re-hit the same
  // no-op install (reproduced twice, 2026-10-04). The private manifest pins
  // the install to THIS directory; written only when missing or not
  // byte-exact, so a re-run never rewrites a manifest that is already correct.
  const manifest = join(layout.dir, "package.json");
  let manifestExact = false;
  if (existsSync(manifest)) {
    try {
      manifestExact = readFileSync(manifest, "utf8") === RUNTIME_MANIFEST;
    } catch {
      manifestExact = false; // unreadable ⇒ treat as absent and re-anchor
    }
  }
  if (!manifestExact) writeFileSync(manifest, RUNTIME_MANIFEST);

  const npm = process.env.SUPERD_SDK_NPM ?? "npm";
  await install(npm, sdkInstallArgv(SDK_PACKAGE_VERSION, mode), { cwd: layout.dir });

  // VERIFY — a zero exit is not success: an unanchored (or no-op) install
  // resolves without producing the entry. Fail BEFORE the marker — it must
  // only ever exist with the entry verifiably on disk, or the self-healing
  // loop never converges. The catch in `ensureSdkRuntime` appends the trace
  // (the note below names the cause) and wipes this partial tree.
  const entry = sdkEntryPath(worldHome);
  if (!existsSync(entry)) {
    throw new Error(
      `npm install exited 0 but produced no entry at ${entry} — ` +
        `the install was not anchored to the runtime dir ` +
        `(npm likely resolved an ancestor project's tree instead of ${manifest})`,
    );
  }

  // Marker LAST — a crash before this point leaves an incomplete runtime that
  // the next call heals, never a false success.
  const record: SdkRuntimeRecord = {
    sdkPackage: SDK_PACKAGE,
    sdkVersion: SDK_PACKAGE_VERSION,
    mode,
    createdAt: now(),
  };
  writeFileSync(layout.marker, JSON.stringify(record, null, 2) + "\n");
  rmSync(layout.errorLog, { force: true });
  return record;
}

/**
 * mkdir-based mutex: returns owning the lock, throws when a FRESH lock is held
 * by someone else, reclaims a lock older than {@link LOCK_STALE_MS}.
 */
function acquireLock(layout: SdkRuntimeLayout): void {
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
      rmSync(layout.lock, { recursive: true, force: true });
      continue;
    }
    throw new Error(
      `agent-claude: another SDK runtime fetch is already in progress (lock ${layout.lock}). ` +
      `Retry once it finishes; if no fetch is running, remove that lock directory.`,
    );
  }
}

/**
 * Ensure the durable runtime and return the installed SDK entry's `query`
 * function — the ONE function the client's default factory drives, and the only
 * place a real download/install happens on the lazy path.
 *
 * The entry is imported by resolved path (see the header) and its shape is
 * checked here: a tree that installs but exposes no `query` fails at fetch
 * time, loud and near the cause, rather than inside the agent's first prompt.
 */
export async function loadClaudeQuery(
  worldHome: string,
): Promise<(o: { prompt: unknown; options: unknown }) => unknown> {
  await ensureSdkRuntime(worldHome);
  const entry = sdkEntryPath(worldHome);
  const module = (await import(pathToFileURL(entry).href)) as { query?: unknown };
  if (typeof module.query !== "function") {
    throw new Error(`agent-claude: ${entry} exposes no query function`);
  }
  return module.query as (o: { prompt: unknown; options: unknown }) => unknown;
}
