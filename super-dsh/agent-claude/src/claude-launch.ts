/**
 * claude-launch.ts — how a provider reaches the Claude Code CLI
 * (2026-10-04 multi-provider rework).
 *
 * Claude Code is a single-provider harness: its own `settings.json` env block
 * names exactly one `ANTHROPIC_BASE_URL` with one key, so the LIST of
 * configured providers lives in `claude-providers.ts` instead. This module is
 * the other end of that store: given the route the next turn will run (DSH's
 * own per-session model selection, read by `claude-route.ts`), the resolved
 * provider entry, and the resolved host binary, it produces the slice Task 9
 * merges into the SDK's `Options`.
 *
 * The child's environment is the ONE channel a provider's variables enter the
 * process through (spec §2.2) — AND, for a provider-pinned launch, the same env
 * is re-carried as a `--settings`-tier JSON string so the command-line tier
 * outranks the user's native `~/.claude/settings.json` env (2026-10-04 F-B).
 * Concretely, the env keys are:
 *
 *   - `ANTHROPIC_BASE_URL` — always, from the entry (validation guarantees a
 *     non-empty endpoint; an entry without one is not an entry).
 *   - `ANTHROPIC_AUTH_TOKEN` for `authToken` (Bearer), `ANTHROPIC_API_KEY` for
 *     `apiKey` (x-api-key) — exactly one, chosen by the entry's auth KIND, with
 *     the stored value verbatim. The kind names the channel, so the variable is
 *     present even when the value is empty ("keyed outside Super D"): the CLI
 *     reads both names with `.trim() || undefined` (measured in
 *     `@anthropic-ai/claude-agent-sdk` 2.1.263), so an empty value is unset
 *     rather than a fabricated secret.
 *   - `ANTHROPIC_MODEL` — the RAW route model id (`glm-5.2`), never the
 *     selector's composite key (`glm/glm-5.2`); the composite is a DSH catalog
 *     id and has no meaning on the wire.
 *   - `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` — ONLY for aliases the
 *     entry actually declares, and never an empty-string one: an alias the user
 *     did not write must not be invented, or the child silently answers on a
 *     model they never chose.
 *
 * The returned env holds ADDITIONS only. The caller composes the child
 * environment as `{ ...process.env, ...launch.env }` — the spread AFTER
 * `process.env` is the contract, and it is why this function never reads or
 * mutates `process.env` itself: it is a pure declaration, and the caller's
 * precedence is what makes it effective. `NATIVE_LAUNCH` is the same
 * declaration with nothing in it: `providerId: null` and an empty env, for a
 * route no provider entry answers (a legacy bare-id selection, the native
 * settings-only shape).
 *
 * The same reasoning makes `pathToClaudeCodeExecutable` optional and
 * conditional: it is set only when a host binary was actually resolved, so an
 * unresolved binary omits the key entirely and lets the SDK fall back to its
 * bundled payload (spec §2.1) instead of spawning an empty path.
 *
 * @module agent-claude/claude-launch
 */

import type { ClaudeProviderEntry } from "./claude-providers.js";
import type { RouteSelection } from "./claude-route.js";

/**
 * What one child needs to run on one provider: the `Options.env` additions,
 * the wire model, the host binary when one was resolved, and the provider they
 * pin. Every field but `providerId` is optional because the native shape has
 * none of them.
 */
export interface ClaudeLaunchSpec {
  /** The provider this launch pins, or `null` for "no injection at all". */
  readonly providerId: string | null;
  /** `ANTHROPIC_*` overrides; the caller spreads them AFTER `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** The same env carried as a `--settings`-tier JSON string (`{"env":{...}}`).
   *  The SDK's `Options.settings` accepts a JSON string, a settings object, or a
   *  file path; the command-line ("flag settings") tier outranks the user's
   *  native `~/.claude/settings.json` env, so a provider-pinned launch must ride
   *  this tier to defeat a native per-variable override. `NATIVE_LAUNCH` carries
   *  none. */
  readonly settings?: string;
  /** The raw model id for the wire (never the `<provider>/<model>` catalog key). */
  readonly model?: string;
  /** The resolved host CLI; absent means "let the SDK resolve its own payload". */
  readonly pathToClaudeCodeExecutable?: string;
}

/** The launch for "no provider injection at all" (the native settings apply). */
export const NATIVE_LAUNCH: ClaudeLaunchSpec = { providerId: null, env: {} };

/** The variable each auth kind authenticates through. */
const AUTH_ENV: Readonly<Record<ClaudeProviderEntry["auth"]["kind"], string>> = {
  authToken: "ANTHROPIC_AUTH_TOKEN",
  apiKey: "ANTHROPIC_API_KEY",
};

/** The alias slots an entry may declare, in catalog order. */
const ALIAS_ENV: readonly (readonly [keyof NonNullable<ClaudeProviderEntry["aliases"]>, string])[] = [
  ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
];

/**
 * Turn one resolved provider into the SDK `Options` slice for one route.
 *
 * Pure: reads no file, no env, no clock, and spawns nothing. The provider id
 * comes from the ENTRY (the caller resolves the entry BY `route.provider`, so
 * the label and the injected data stay one fact); the model comes from the
 * ROUTE, because that is what the session selected.
 *
 * @param route - the route the next turn runs (raw model half).
 * @param entry - the provider entry that route resolved to.
 * @param hostBinary - the resolved Claude Code binary, or `undefined` to let
 *   the SDK use its bundled payload.
 * @returns the env additions, the wire model, and the optional binary path.
 */
export function claudeLaunchFor(
  route: RouteSelection,
  entry: ClaudeProviderEntry,
  hostBinary?: string,
): ClaudeLaunchSpec {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: entry.baseUrl,
    [AUTH_ENV[entry.auth.kind]]: entry.auth.value,
    ANTHROPIC_MODEL: route.model,
  };

  // Declared aliases only: `undefined` means the entry never named that slot,
  // and "" is not a model id — emitting either would invent a choice.
  for (const [slot, name] of ALIAS_ENV) {
    const value = entry.aliases?.[slot];
    if (value !== undefined && value !== "") env[name] = value;
  }

  return {
    providerId: entry.id,
    env,
    settings: JSON.stringify({ env }),
    model: route.model,
    // Spread, not `pathToClaudeCodeExecutable: hostBinary`: an absent key must
    // not exist at all, or it would ride a spread into Options as `undefined`.
    ...(hostBinary !== undefined && hostBinary !== "" ? { pathToClaudeCodeExecutable: hostBinary } : {}),
  };
}
