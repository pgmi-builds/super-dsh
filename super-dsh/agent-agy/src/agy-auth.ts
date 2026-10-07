/**
 * agy-auth.ts — the CLI adapter's auth-form detection, fallback ladder, and
 * the mutation it applies to the user's LOCAL Antigravity configuration.
 *
 * The Antigravity CLI has four auth channels (dev-rules §16a, re-probed
 * 2026-10-02 against `agy` 1.2.14):
 *
 *   1. account sign-in   default, `cloudcode-pa.googleapis.com`; the token
 *                        lives in the freedesktop Secret Service keyring
 *                        (`gnome-keyring-daemon`, `org.freedesktop.secrets`,
 *                        entry `service=gemini username=antigravity`) with a
 *                        file fallback at `~/.gemini/antigravity-cli/
 *                        antigravity-oauth-token`;
 *   2. Gemini API key    `modelProvider: "gemini"` in the CLI's settings.json
 *                        + `GEMINI_API_KEY` in the launch environment
 *                        (+ optional `GOOGLE_GEMINI_BASE_URL`);
 *   3. ADC               `AGY_ADC_AUTH=1` — `adc_auth.go` reports
 *                        "authenticated via adc (effective: adc)". Credentials
 *                        are `~/.config/gcloud/application_default_credentials
 *                        .json` (or a GCE metadata server). NOT the keyring;
 *   4. BYO gateway       `AGY_LLM_GATEWAY_*` (out of scope; see the spec).
 *
 * user ruling 2026-10-02 (supersedes the dev-rules §5 "never write the native
 * home" default for THIS adapter, under §12 per-adapter discretion):
 *
 *   「拥抱用户自己的使用环境」 — this adapter is deliberately the configuration
 *   surface for the user's LOCAL Antigravity. Selecting a form here really does
 *   rewrite their `~/.gemini/antigravity-cli/settings.json`, so the TUI they
 *   already use keeps working afterwards. Paths are hard-coded relative to the
 *   user's home for exactly that reason.
 *
 * Fallback order (same ruling) = Gemini API key → OAuth → ADC. OAuth stays a
 * PLACEHOLDER this round: no eligible account exists to characterise the
 * native fields a real sign-in stores, so nothing reports it present.
 *
 * Pure: every probe result is injected, so `node --test` pins the ladder; the
 * one filesystem-touching helper (`nativeSettingsPath`) is a pure path fold.
 *
 * @module agent-agy/agy-auth
 */

import { statSync } from "node:fs";
import { join } from "node:path";

/** The three forms this adapter arbitrates. */
export type AgyAuthMode = "apiKey" | "oauth" | "adc";

/** Which forms are present right now (probe result). */
export interface AgyAuthAvailability {
  readonly apiKey: boolean;
  readonly oauth: boolean;
  readonly adc: boolean;
}

/** Declared fallback order (user ruling 2026-10-02). Exported for the UI. */
export const AGY_AUTH_ORDER: readonly AgyAuthMode[] = ["apiKey", "oauth", "adc"];

/** Human labels, shared by the Hub settings panel and diagnostics. */
export const AGY_AUTH_LABELS: Readonly<Record<AgyAuthMode, string>> = {
  apiKey: "Gemini API key",
  oauth: "OAuth (account sign-in)",
  adc: "ADC (Vertex)",
};

/**
 * The CLI's own app-data directory, hard-coded under the USER's home — the
 * native Antigravity config we deliberately share with the TUI.
 *
 * @param realHome - the user's real `$HOME` (never an isolated override).
 * @returns the absolute app-data directory.
 */
export function nativeCliDir(realHome: string): string {
  return join(realHome, ".gemini", "antigravity-cli");
}

/**
 * The CLI's settings file. The binary documents the auth flip here: "To switch
 * back to signing in, remove `modelProvider` from settings.json and restart
 * the CLI."
 *
 * @param realHome - the user's real `$HOME`.
 * @returns the absolute settings.json path.
 */
export function nativeSettingsPath(realHome: string): string {
  return join(nativeCliDir(realHome), "settings.json");
}

/**
 * The credential file the CLI writes when a Google account signs in. This is
 * the **Agent Platform** plane: `auth_method: "gcp"`, a `project_id`, and an
 * access/refresh token pair. It is the backend the interactive TUI uses.
 *
 * @param realHome - the user's real `$HOME`.
 * @returns the absolute path of the CLI's stored sign-in credential.
 */
export function signinTokenPath(realHome: string): string {
  return join(nativeCliDir(realHome), "antigravity-oauth-token");
}

/**
 * Is the CLI's own Google sign-in in place?
 *
 * Measured 2026-10-02 (this machine): headless CLI reads this plane first, and
 * when it is present the transport works with NO Gemini API key, NO
 * `AGY_ADC_AUTH`, and NO `modelProvider` in settings — the run reaches
 * `result.status: SUCCESS`.
 *
 * This is what the auth ladder's middle rung means in practice: not a
 * placeholder, but "let the CLI use the account it is already signed in as".
 * It therefore must be DETECTED rather than assumed absent: treating it as
 * permanently unavailable is what pushed the ladder onto ADC, whose project
 * has `cloudcode-pa` disabled, and the adapter could never start a turn.
 *
 * @param realHome - the user's real `$HOME`.
 * @returns whether a non-empty sign-in credential is on disk.
 */
export function hasSigninCredential(realHome: string): boolean {
  try {
    return statSync(signinTokenPath(realHome)).size > 0;
  } catch {
    return false;
  }
}

/** A settings.json mutation: keys to set, keys to remove. */
export interface AgySettingsMutation {
  readonly set: Readonly<Record<string, unknown>>;
  readonly remove: readonly string[];
}

/**
 * The settings.json change one form needs.
 *
 * Key mode pins the Gemini provider. ADC and OAuth need the DEFAULT backend, so
 * `modelProvider` must be actively REMOVED — merely not setting it would leave
 * a previously selected key mode in force and the TUI stuck on "Gemini API key"
 * with no key exported.
 *
 * @param mode - the effective form.
 * @returns the mutation to apply.
 */
export function authSettingsMutation(mode: AgyAuthMode): AgySettingsMutation {
  return mode === "apiKey"
    ? { set: { modelProvider: "gemini" }, remove: [] }
    : { set: {}, remove: ["modelProvider"] };
}

/**
 * Is this mode usable at all right now?
 *
 * @param availability - probe result.
 * @param mode - the form to test.
 * @returns whether the form is present.
 */
export function authAvailable(availability: AgyAuthAvailability, mode: AgyAuthMode): boolean {
  return availability[mode];
}

/**
 * Resolve the effective mode: an explicit selection wins when that form is
 * actually present; otherwise the ladder supplies the first available form.
 * Nothing present ⇒ `undefined` (the caller gates into onboarding).
 *
 * A stale selection (user picked API key, key later removed) deliberately
 * falls through to the ladder instead of failing — the adapter must not wedge
 * on config that no longer matches the machine.
 *
 * @param availability - probe result.
 * @param selected - the user's persisted choice, when any.
 * @returns the effective form, or `undefined` when nothing is available.
 */
export function resolveAuthMode(
  availability: AgyAuthAvailability,
  selected?: AgyAuthMode | undefined,
): AgyAuthMode | undefined {
  if (selected !== undefined && authAvailable(availability, selected)) return selected;
  return AGY_AUTH_ORDER.find((mode) => authAvailable(availability, mode));
}

/**
 * The environment additions the spawned CLI needs for one mode.
 *
 * `AGY_CLI_DISABLE_AUTO_UPDATE=1` rides every mode: the CLI silently
 * self-updated 1.2.12 → 1.2.14 on this machine on 2026-10-02, which makes any
 * acceptance run unreproducible.
 *
 * NOTE there is no HOME handling here at all: the adapter runs the CLI against
 * the user's REAL home in every mode. Isolating HOME (the previous design) both
 * hid the very settings.json we now maintain and silently destroyed ADC
 * (`$HOME/.config/gcloud`) and the keyring — which is how this adapter
 * previously mis-concluded "the CLI cannot use ADC".
 *
 * @param mode - the effective form.
 * @param apiKey - the resolved key (env or adapter state); empty ⇒ omitted.
 * @returns env entries to ADD to the child's environment.
 */
export function authChildEnv(mode: AgyAuthMode, apiKey?: string | undefined): Record<string, string> {
  const env: Record<string, string> = { AGY_CLI_DISABLE_AUTO_UPDATE: "1" };
  if (mode === "adc") {
    env.AGY_ADC_AUTH = "1";
    return env;
  }
  if (mode === "apiKey" && apiKey !== undefined && apiKey !== "") {
    env.GEMINI_API_KEY = apiKey;
  }
  return env;
}
