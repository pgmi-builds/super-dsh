import { officialCatalogForLaunch } from "./codex-oauth.js";
/**
 * codex-sdk-launch.ts — how a provider reaches the in-process Codex SDK
 * (2026-10-04 multi-provider rework).
 *
 * This is the SDK half of `agent-codex/codex-launch.ts`. That module turns a
 * provider into argv for a `codex app-server` child; this one turns the same
 * provider into the structured object the SDK's `CodexOptions.config` takes —
 * and underneath they are the same mechanism. The SDK's own type docs say it
 * "flatten[s] it into dotted paths and serialize[s] values as TOML literals so
 * they are compatible with the CLI's `--config` parsing", which is exactly the
 * `--config key=value` channel the app-server line drives by hand. A provider
 * therefore costs nothing on disk on this path either, and is scoped to the
 * process that builds the config, which is what a per-session provider choice
 * needs.
 *
 * The one transport difference is env. A spawned app-server child inherits the
 * process environment, so `codex-launch.ts` hands back ADDITIONS and its caller
 * spreads them (`env: { ...process.env, ...launch.env }`). The SDK's `env` is
 * REPLACE semantics — "When provided, the SDK will not inherit variables from
 * `process.env`" — so the caller must spread the same way before constructing
 * `Codex`. This module still hands back additions only: composing the full map
 * belongs to the caller, and keeping the addition set small is what makes the
 * synthetic-key branch legible in tests.
 *
 * The measured constraints `codex-launch.ts` encodes carry over unchanged (see
 * `docs/test-reports/2026-10-03-codex-provider-model-switch-probe.md`):
 *
 *  - a HYPHENATED id is fine in a dotted path (`model_providers.zhipu-cn.…`),
 *    so native table names survive verbatim as provider ids;
 *  - `model_catalog_json` is resolved against the process CWD when it arrives
 *    as an override, so the path is always absolute;
 *  - `env_key` is the one auth shape that never consults the auth manager, so a
 *    stored API key rides the child's environment under a synthetic variable
 *    name. That is also what makes a keyed provider usable behind a ChatGPT
 *    login, where `requires_openai_auth` is silently shadowed.
 *
 * @module agent-codex-sdk/codex-sdk-launch
 */

import type { CodexProviderEntry } from "./codex-providers.js";
import { writeProviderCatalog } from "./codex-native-config.js";

/** The environment variable prefix for a key this adapter injects itself. */
const SYNTHETIC_KEY_PREFIX = "SUPERD_CODEX_KEY_";

/** What one SDK turn needs to run on one provider. */
export interface CodexSdkLaunch {
  /** `--config` overrides handed to the SDK as its structured config object. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Environment for the `codex` child (the SDK does NOT inherit process.env when `env` is given). */
  readonly env: Readonly<Record<string, string>>;
  /** The provider this launch pins, or "" for "let the native config decide". */
  readonly providerId: string;
}

/** The launch for "no provider injection at all" (the native config applies). */
export const NATIVE_SDK_LAUNCH: CodexSdkLaunch = { config: {}, env: {}, providerId: "" };

/** The environment variable a stored API key is handed to the child as. */
export function syntheticKeyName(providerId: string): string {
  return `${SYNTHETIC_KEY_PREFIX}${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * The launch that pins one provider for the life of an SDK process.
 *
 * @param worldHome - the world's DSH home (our per-provider catalogs live there).
 * @param codexHome - the native codex home; READ ONLY (catalog template material).
 * @param provider - the provider the SDK must run on.
 * @returns the structured config, the environment additions, and the provider id they pin.
 */
export function providerSdkLaunch(
  worldHome: string,
  codexHome: string,
  provider: CodexProviderEntry,
): CodexSdkLaunch {
  if (provider.kind === "openai-oauth") {
    const catalog = officialCatalogForLaunch(codexHome);
    return {config: {model_provider: "openai", openai_base_url: "", ...(catalog === undefined ? {} : {model_catalog_json: catalog})}, env: {}, providerId: "openai"};
  }
  // The SDK serializes these values as TOML literals itself, so unlike the argv
  // line there is no hand-quoting here: a bare object is the whole override.
  const table: Record<string, unknown> = {
    name: provider.label,
    base_url: provider.baseUrl,
    wire_api: provider.protocol,
  };
  const env: Record<string, string> = {};

  if (provider.auth.kind === "env") {
    table["env_key"] = provider.auth.name;
  } else if (provider.auth.value !== "") {
    // A key we hold: never touch auth.json, never go through the auth manager.
    const name = syntheticKeyName(provider.id);
    table["env_key"] = name;
    env[name] = provider.auth.value;
  } else {
    // The seeded shape — the runtime's own auth.json already holds this key.
    table["requires_openai_auth"] = true;
  }

  // Top-level defaults for this process, so a thread that does not restate the
  // provider still lands on the right one. `model_providers` is nested rather
  // than pre-dotted: the SDK owns the flattening, and a nested table is what
  // its `CodexConfigObject` type describes.
  const config: Record<string, unknown> = {
    model_providers: { [provider.id]: table },
    model_provider: provider.id,
  };

  const catalog = writeProviderCatalog(worldHome, codexHome, provider);
  // Absolute on purpose: codex resolves this override against the process cwd
  // (`writeProviderCatalog` returns it under the absolute world home).
  if (catalog !== undefined) config["model_catalog_json"] = catalog;

  return { config, env, providerId: provider.id };
}
