/**
 * codex-launch.ts — how a provider reaches a `codex app-server` child
 * (2026-10-04 on-the-fly rework).
 *
 * The retired design put the provider in force by REWRITING the user's
 * `~/.codex/config.toml` before the child started. That made the user's native
 * home the switchboard: every switch was a disk write, only ever affected the
 * next child, and fought every other tool that owns the same file (cc-switch's
 * whole-config rewrites, the user's own hand edits).
 *
 * This module replaces it with process arguments. `codex app-server -c
 * <dotted.path>=<value>` overrides any `config.toml` value for THAT child
 * alone (the flag's own help text: "Override a configuration value that would
 * otherwise be loaded from `~/.codex/config.toml`. Use a dotted path."), and
 * `ThreadStartParams`/`ThreadResumeParams` accept the same object as `config`.
 * A provider therefore costs nothing on disk and is scoped to one process, which
 * is exactly what a per-session provider choice needs.
 *
 * Measured constraints this module encodes (see
 * `docs/test-reports/2026-10-03-codex-provider-model-switch-probe.md`):
 *
 *  - a HYPHENATED id is fine in a dotted path (`model_providers.zhipu-cn.…`),
 *    so native table names survive verbatim as provider ids;
 *  - `model_catalog_json` is resolved against the process CWD when it arrives
 *    as an override, so the path is always absolute;
 *  - `env_key` is the one auth shape that never consults the auth manager, so a
 *    stored API key rides the CHILD's environment under a synthetic variable
 *    name. That is also what makes a keyed provider usable behind a ChatGPT
 *    login, where `requires_openai_auth` is silently shadowed.
 *
 * @module agent-codex/codex-launch
 */

import type { CodexProviderEntry } from "./codex-providers.js";
import { tomlString, writeProviderCatalog } from "./codex-native-config.js";

/** The environment variable prefix for a key this adapter injects itself. */
const SYNTHETIC_KEY_PREFIX = "SUPERD_CODEX_KEY_";

/**
 * What one child needs to run on one provider: extra argv after `app-server`,
 * and extra environment. Both are empty for the "let the native config decide"
 * case, which is the historical `codex` route's fallback.
 */
export interface CodexLaunch {
  /** Arguments to place after `app-server`. */
  readonly argv: readonly string[];
  /** Additions to the child's environment (never replacements for `process.env`). */
  readonly env: Readonly<Record<string, string>>;
}

/** The launch for "no provider injection at all" (the native config applies). */
export const NATIVE_LAUNCH: CodexLaunch = { argv: [], env: {} };

/** The environment variable a stored API key is handed to the child as. */
export function syntheticKeyName(providerId: string): string {
  return `${SYNTHETIC_KEY_PREFIX}${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * The launch that pins one provider for the life of a child process.
 *
 * @param worldHome - the world's DSH home (our per-provider catalogs live there).
 * @param codexHome - the native codex home; READ ONLY (catalog template material).
 * @param provider - the provider the child must run on.
 * @returns the argv/env additions and the provider id they pin.
 */
export function providerLaunch(
  worldHome: string,
  codexHome: string,
  provider: CodexProviderEntry,
): CodexLaunch {
  const table = `model_providers.${provider.id}`;
  const argv: string[] = [
    "-c", `${table}.name=${tomlString(provider.label)}`,
    "-c", `${table}.base_url=${tomlString(provider.baseUrl)}`,
    "-c", `${table}.wire_api=${tomlString(provider.protocol)}`,
  ];
  const env: Record<string, string> = {};

  if (provider.auth.kind === "env") {
    argv.push("-c", `${table}.env_key=${tomlString(provider.auth.name)}`);
  } else if (provider.auth.value !== "") {
    // A key we hold: never touch auth.json, never go through the auth manager.
    const name = syntheticKeyName(provider.id);
    argv.push("-c", `${table}.env_key=${tomlString(name)}`);
    env[name] = provider.auth.value;
  } else {
    // The seeded shape — the runtime's own auth.json already holds this key.
    argv.push("-c", `${table}.requires_openai_auth=true`);
  }

  // Top-level defaults for this child, so a thread that does not restate the
  // provider still lands on the right one.
  argv.push("-c", `model_provider=${tomlString(provider.id)}`);

  const catalog = writeProviderCatalog(worldHome, codexHome, provider);
  if (catalog !== undefined) argv.push("-c", `model_catalog_json=${tomlString(catalog)}`);

  return { argv, env };
}
