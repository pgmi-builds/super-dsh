/**
 * OMP CLI subprocess data plane — the model catalog and the `modelRoles` map
 * are read from (and written through) the operator's own `omp` binary, the
 * first-party entries the bridge uses instead of parsing OMP's files or
 * hitting frame-limited RPC:
 *
 * - `omp models --json`     → the credential-resolved AVAILABLE model catalog
 *   (documented selectability rule: provider not in `disabledProviders` and
 *   keyless or with a resolvable credential — 7-level precedence, including
 *   OAuth/login keys stored in agent.db that no config file reveals).
 * - `omp config get modelRoles --json` → the role→"provider/model[:effort]"
 *   map, including the persisted `default` selector (TUI semantics: the
 *   default model IS config state, surviving sessions).
 * - `omp config set modelRoles --json <obj>` → whole-object roundtrip write
 *   (dotted keys are rejected; the entire modelRoles object is the unit).
 *
 * All calls run with cwd = `OMP_HOME` (omp writes its own state db next to
 * the agent dir) and inherit the daemon environment. The binary is resolved
 * per call ({@link resolveOmpExecutable}), so `$OMP_EXECUTABLE` and PATH
 * changes take effect without a reload.
 *
 * Fail-soft: a missing, broken or unresponsive `omp` yields `undefined`
 * (reads) or `false` (write) — the provider never fails to boot because the
 * CLI is down.
 *
 * @module agent-omp/omp-cli
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { OMP_HOME } from "./knobs.js";
import { resolveOmpExecutable } from "./omp-executable.js";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** One raw model record as OMP's catalog describes it. */
export interface OmpCliModel {
  provider: string;
  id: string;
  [key: string]: unknown;
}

/** role → "provider/model[:effort]" selectors, from the live config. */
export interface OmpModelRoles {
  [role: string]: string;
}

// ---------------------------------------------------------------------------
// Subprocess plumbing (fail-soft: any failure → undefined/false)
// ---------------------------------------------------------------------------

/** One `omp <args>` invocation parsed as JSON; undefined on any failure. */
async function ompCliJson(args: string[]): Promise<unknown | undefined> {
  try {
    const { stdout } = await execFileAsync(resolveOmpExecutable(), args, {
      cwd: OMP_HOME,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** Synchronous variant of {@link ompCliJson} — the boot-time path. */
function ompCliJsonSync(args: string[]): unknown | undefined {
  try {
    const stdout = execFileSync(resolveOmpExecutable(), args, {
      cwd: OMP_HOME,
      timeout: TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** Validate an `omp models --json` payload; undefined when empty or invalid. */
function parseModels(json: unknown): OmpCliModel[] | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const out: OmpCliModel[] = [];
  for (const model of models) {
    if (model !== null && typeof model === "object" && typeof (model as { provider?: unknown }).provider === "string") {
      out.push(model as OmpCliModel);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate a `modelRoles` payload; undefined when unset, empty or invalid.
 *
 * `omp config get <key> --json` prints `{key, value, type, description}`, but
 * the bare value map appears in older builds, so both shapes are accepted. A
 * wrapped payload for a different key is rejected rather than misread as a
 * role map.
 */
function parseModelRoles(json: unknown): OmpModelRoles | undefined {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const record = json as Record<string, unknown>;
  let value: unknown = record;
  if ("key" in record || "value" in record) {
    if (typeof record.key === "string" && record.key !== "modelRoles") return undefined;
    value = record.value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: OmpModelRoles = {};
  for (const [role, selector] of Object.entries(value)) {
    if (typeof selector === "string" && selector !== "") out[role] = selector;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/**
 * Synchronous `omp models --json` — the boot-time variant (the adapter's
 * provider route list must be known before `registerAdapter` returns).
 * Blocks up to the timeout; prefer the async variant everywhere else.
 */
export function ompAvailableModelsSync(): OmpCliModel[] | undefined {
  return parseModels(ompCliJsonSync(["models", "--json"]));
}

/**
 * `omp models --json` — the AVAILABLE model catalog (credential-resolved,
 * `disabledProviders`-aware). `undefined` when the CLI fails; callers fall
 * back to the on-disk sources.
 */
export async function ompAvailableModels(): Promise<OmpCliModel[] | undefined> {
  return parseModels(await ompCliJson(["models", "--json"]));
}

// ---------------------------------------------------------------------------
// modelRoles
// ---------------------------------------------------------------------------

/**
 * Synchronous `omp config get modelRoles --json` — boot-time variant of
 * {@link ompModelRoles}.
 */
export function ompModelRolesSync(): OmpModelRoles | undefined {
  return parseModelRoles(ompCliJsonSync(["config", "get", "modelRoles", "--json"]));
}

/**
 * `omp config get modelRoles --json` — the current modelRoles object, read
 * fresh on every call (the OMP TUI may have rewritten config.yml). `undefined`
 * when unset or the CLI fails.
 */
export async function ompModelRoles(): Promise<OmpModelRoles | undefined> {
  return parseModelRoles(await ompCliJson(["config", "get", "modelRoles", "--json"]));
}

/**
 * `omp config set modelRoles --json <obj>` — the TUI-grade default-model
 * write: OMP persists `modelRoles.default` itself, so every new session
 * (TUI or Web) inherits the selection. Whole-object roundtrip: dotted keys
 * are rejected by the CLI. `false` on any failure (fail-soft).
 */
export async function ompSetModelRoles(roles: OmpModelRoles): Promise<boolean> {
  try {
    await execFileAsync(resolveOmpExecutable(), ["config", "set", "modelRoles", "--json", JSON.stringify(roles)], {
      cwd: OMP_HOME,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}
