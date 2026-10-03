/**
 * claude-native-config.ts — reading the foreign runtime's own settings, the
 * read-only half of the multi-provider split (2026-10-04).
 *
 * Claude Code is a single-provider harness: its `settings.json` `env` block
 * names exactly ONE `ANTHROPIC_BASE_URL` with at most one key variable, so the
 * LIST of providers a user has configured has nowhere to live natively and
 * lives in the adapter's store instead (`claude-providers.ts`). This module is
 * the other half of that split — the sole authority on what the user's own
 * file actually says.
 *
 * The direction is one-way: `settings.json` is a SOURCE. Nothing here writes
 * it — this module has no write path at all — and cc-switch can still own the
 * file; the sync in `claude-provider-gateway.ts` picks up whatever it leaves
 * there. The `.bak-*` manual-switch layers are never folded (they are not the
 * live file). Compare `agent-codex/src/codex-native-config.ts`, the structural
 * port source; claude needs none of codex's per-provider catalog machinery
 * because a settings env block IS its whole catalog.
 *
 * Two reads live here:
 *
 *  - `readNativeProviders` — the `env` block as a provider table, 0 or 1
 *    entries. An env block without `ANTHROPIC_BASE_URL` declares no provider:
 *    the store's identity IS the endpoint URL, and with nothing to dedupe by
 *    there is no entry to make.
 *  - `readNativeModel` — `env.ANTHROPIC_MODEL`, the model the user's own CLI
 *    runs. Independent of the provider read: a native setup on the default
 *    Anthropic endpoint carries no base URL but a perfectly meaningful model.
 *
 * Auth is classified by the VARIABLE NAME, and an explicitly-empty variable
 * reads as unset — the same env semantics the codex port applies to an empty
 * `env_key` — so `ANTHROPIC_AUTH_TOKEN` (Bearer) wins only when it carries a
 * value, and a base URL whose env names no usable key variable folds as the
 * real "keyed outside Super D" state `{kind:"apiKey", value:""}` rather than
 * being rejected.
 *
 * Non-string env values (a hand-edited file may carry numbers or booleans)
 * are read in their string forms — everything downstream of an env block is a
 * string, process-env semantics — and shapes with no string form worth
 * honoring (objects, arrays, null) are skipped.
 *
 * Every read is fail-soft: an absent file, an unreadable file, unparsable
 * JSON, or a wrong shape all degrade to "nothing declared" and never throw.
 *
 * @module agent-claude/claude-native-config
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ClaudeProviderAliases, type ClaudeProviderAuth, type ClaudeProviderModel } from "./claude-providers.js";

// The home resolver stays canonical in claude-home.ts (it has its own tests
// and its own callers); this re-export is the non-duplicating way to give the
// native-config consumers the one-face import the plan's Interfaces pin.
export { resolveClaudeHome } from "./claude-home.js";

const SETTINGS_FILE = "settings.json";

/**
 * One provider the native settings env declares.
 *
 * `baseUrl` and `auth` are optional only because the interface is consumed
 * defensively; in practice a table is emitted solely when a usable
 * `ANTHROPIC_BASE_URL` exists, and `auth` then always carries the fold
 * (a key variable's shape, or the keyed-outside `apiKey:""`).
 */
export interface NativeProviderTable {
  readonly baseUrl?: string;
  readonly auth?: ClaudeProviderAuth;
  /** The deduplicated `ANTHROPIC_DEFAULT_*_MODEL` alias values; empty when the env declares none. */
  readonly models: ClaudeProviderModel[];
  /** sonnet/opus/haiku ← `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`; only present aliases land. */
  readonly aliases?: ClaudeProviderAliases;
}

/** Read a file, or `undefined` when it is absent or unreadable. */
function readIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * One env value as the process would see it. Strings pass verbatim; numbers
 * and booleans coerce to their string forms; objects, arrays, null, and
 * empty/whitespace strings are unusable (an empty credential is not a
 * credential — see the module header).
 */
function envString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

/** The settings.json `env` block, or `undefined` when anything above it fails. */
function readEnvBlock(claudeHome: string): Record<string, unknown> | undefined {
  const text = readIfExists(join(claudeHome, SETTINGS_FILE));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return undefined;
  const env = (parsed as Record<string, unknown>)["env"];
  if (env === null || Array.isArray(env) || typeof env !== "object") return undefined;
  return env as Record<string, unknown>;
}

/**
 * Parse the native settings env into the sync's source tables.
 *
 * The output is 0 or 1 entries, in the only order there is. `models` is the
 * DEDUPLICATED sequence of the alias values (sonnet, opus, haiku) — the only
 * model ids a settings env reveals; `ANTHROPIC_MODEL` deliberately does not
 * become one (it is `readNativeModel`'s own view, and folding it would invent
 * a catalog entry the aliases never named).
 *
 * @param claudeHome - the NATIVE claude home (`~/.claude`).
 * @returns the declared provider table, or `[]` when the env declares none.
 */
export function readNativeProviders(claudeHome: string): NativeProviderTable[] {
  const env = readEnvBlock(claudeHome);
  if (env === undefined) return [];

  const baseUrl = envString(env["ANTHROPIC_BASE_URL"]);
  // No endpoint is not a provider: there is nothing to dedupe the entry by in
  // a list whose identity IS the endpoint URL.
  if (baseUrl === undefined) return [];

  // Key-variable precedence: AUTH_TOKEN (Bearer) over API_KEY (x-api-key),
  // an empty variable counting as unset, and no usable variable at all
  // folding as the keyed-outside-Super-D state rather than an error.
  const token = envString(env["ANTHROPIC_AUTH_TOKEN"]);
  const key = envString(env["ANTHROPIC_API_KEY"]);
  const auth: ClaudeProviderAuth = token !== undefined
    ? { kind: "authToken", value: token }
    : key !== undefined
      ? { kind: "apiKey", value: key }
      : { kind: "apiKey", value: "" };

  const sonnet = envString(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]);
  const opus = envString(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]);
  const haiku = envString(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"]);

  const models: ClaudeProviderModel[] = [];
  const seen = new Set<string>();
  for (const id of [sonnet, opus, haiku]) {
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push({ id });
  }

  const table: NativeProviderTable = {
    baseUrl,
    auth,
    models,
    ...(sonnet === undefined && opus === undefined && haiku === undefined ? {} : {
      aliases: {
        ...(sonnet === undefined ? {} : { sonnet }),
        ...(opus === undefined ? {} : { opus }),
        ...(haiku === undefined ? {} : { haiku }),
      },
    }),
  };
  return [table];
}

/**
 * The model the user's own settings env puts in force (`env.ANTHROPIC_MODEL`).
 *
 * Read independently of the provider tables: it is the panel's passive "your
 * own Claude runs this" line, meaningful even when no endpoint is declared.
 *
 * @param claudeHome - the NATIVE claude home (`~/.claude`).
 * @returns the model id, or `undefined` when the env names none.
 */
export function readNativeModel(claudeHome: string): string | undefined {
  const env = readEnvBlock(claudeHome);
  if (env === undefined) return undefined;
  return envString(env["ANTHROPIC_MODEL"]);
}
