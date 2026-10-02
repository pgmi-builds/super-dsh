/**
 * agy-auth-gateway.ts — the adapter-owned Remote behind the Hub's Antigravity
 * settings panel (P3, 2026-10-02 user ruling).
 *
 * Why a Remote and not a hub route: the auth ladder, the probe results and the
 * native-settings mutation are ADAPTER config (agent-adapter-dev-rules §12), so
 * the adapter owns them and the hub only forwards. `TypertRemoteService` +
 * `@Remote` is the whole mechanism — standard (TC39) method decorators recorded
 * on the class prototype, read back at dispatch time by the gateway's
 * source-claim scan. There is NO codegen step and no compiler-injected
 * metadata, which is why a plain `tsc` adapter build can ship one.
 *
 * Wire contract (both halves are pinned by tests):
 *   request   POST /hub/api?agent=agy
 *             { type:'client-request', rpcId, method:'agyAuth/get'|'agyAuth/set',
 *               payload: { args: { request?: AgyAuthSetRequest } } }
 *   response  { type:'server-response', rpcId, result:{ ok:true, value:<view> } }
 *
 * The endpoint namespace is `agyAuth`; the hub's carrier forwards
 * `envelope.method` verbatim to this world's `typertGateway`.
 *
 * Side effects are deliberate and bounded (the 2026-10-02 ruling
 * 「拥抱用户自己的使用环境」): choosing a form rewrites the USER's real
 * `~/.gemini/antigravity-cli/settings.json` immediately, so their own TUI
 * behaves the same way afterwards. The SELECTION itself lives in the world home
 * (`agy-adapter.json`) — adapter state never leaks into the native home.
 *
 * @module agent-agy/agy-auth-gateway
 */

import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import {
  AGY_AUTH_LABELS,
  AGY_AUTH_ORDER,
  authSettingsMutation,
  nativeSettingsPath,
  resolveAuthMode,
  type AgyAuthAvailability,
  type AgyAuthMode,
} from "./agy-auth.js";
import { applyAgySettings } from "./agy-cli-client.js";
import { readAdapterState, writeAdapterState } from "./agy-store.js";

/** One auth option as the Hub panel renders it (`client/agent-settings.ts` parses this). */
export interface AgyAuthOptionView {
  /** Stable id the panel round-trips (`apiKey` | `oauth` | `adc`). */
  readonly key: AgyAuthMode;
  readonly label: string;
  /** Detected on THIS machine right now. */
  readonly available: boolean;
  /** Rendered but never selectable this round (OAuth). */
  readonly placeholder: boolean;
  readonly hint: string;
}

/** The panel's full state: the options, the choice, and what would actually run. */
export interface AgyAuthView {
  readonly methods: readonly AgyAuthOptionView[];
  /** The user's persisted choice; `null` when they have not made one. */
  readonly selected: AgyAuthMode | null;
  /** What a new session would use right now (ladder applied); `null` when nothing is available. */
  readonly effective: AgyAuthMode | null;
  /** The native file a selection rewrites — shown so the effect is never a surprise. */
  readonly settingsPath: string;
  /** Populated only when something needs explaining (stale choice, absent ADC). */
  readonly note?: string;
}

/** `agyAuth/set` payload (the gateway's single wire argument). */
export interface AgyAuthSetRequest {
  /**
   * The form to adopt. `null` clears the explicit choice and hands the decision
   * back to the ladder. Unknown values are rejected, never coerced.
   */
  readonly mode?: AgyAuthMode | null;
}

/**
 * OAuth is NOT a placeholder any more (measured 2026-10-02): it is the CLI's own
 * Google sign-in (Agent Platform), the plane headless actually runs on, and the
 * one that works on this machine with no key, no ADC and no `modelProvider`.
 * Selecting it means "let the CLI use the account it is already signed in as".
 */

function isMode(value: unknown): value is AgyAuthMode {
  return typeof value === "string" && (AGY_AUTH_ORDER as readonly string[]).includes(value);
}

/**
 * The adapter's auth-form Remote. One instance per world context.
 */
export class AgyAuthGateway extends TypertRemoteService {
  /**
   * @param ctx - the world context this service registers on (namespace `agyAuth`).
   * @param home - the world home holding adapter state (`agy-adapter.json`).
   * @param realHome - the USER's real home (native settings live there).
   * @param availability - probe of the current machine.
   */
  constructor(
    ctx: Context,
    private readonly home: string,
    private readonly realHome: () => string,
    private readonly availability: () => AgyAuthAvailability,
  ) {
    super(ctx, "agyAuth");
  }

  /**
   * Read the panel state. Pure read: no probe beyond what the caller injected,
   * no write, safe to call on every expand.
   * @returns the options, the persisted choice, and the effective form.
   */
  @Remote("get")
  async get(): Promise<AgyAuthView> {
    return this.view();
  }

  /**
   * Adopt one form (or clear the choice), persist it to the world home, and
   * apply the matching mutation to the user's native settings.json right away.
   *
   * Applying immediately is the point of the 2026-10-02 ruling: leaving a
   * previously selected key mode pinned would strand the user's own TUI on
   * "Gemini API key" with no key exported.
   * @param request - the requested form.
   * @returns the panel state after the change.
   * @throws {TypeError} when `mode` is neither a known form nor null/absent.
   */
  @Remote("set")
  async set(request?: AgyAuthSetRequest | null): Promise<AgyAuthView> {
    const mode = normalizeSetRequest(request);

    const state = readAdapterState(this.home);
    if (mode === null) {
      const { authMode: _dropped, ...rest } = state;
      writeAdapterState(this.home, rest);
    } else {
      writeAdapterState(this.home, { ...state, authMode: mode });
    }

    // The native flip follows the EFFECTIVE form: clearing the choice (or
    // selecting a form that is not present) must still undo a stale key pin
    // rather than leave the user's TUI stuck on it.
    const effective = resolveAuthMode(this.availability(), mode ?? undefined);
    if (effective !== undefined) {
      applyAgySettings(this.realHome(), authSettingsMutation(effective));
    }
    return this.view();
  }

  /** Project the current probe + persisted choice into the panel's view model. */
  private view(): AgyAuthView {
    return buildAuthView({
      availability: this.availability(),
      selected: readAdapterState(this.home).authMode,
      settingsPath: nativeSettingsPath(this.realHome()),
    });
  }
}

/**
 * The panel's view model. Pure: the probe result, the persisted choice and the
 * settings path are all injected, which is what makes the ladder and the
 * annotation rules pinnable under `node --test` with no Cordis context and no
 * real home.
 *
 * @param input - probe, persisted selection (raw; unknown values are ignored), settings path.
 * @returns the options, the choice, and the form that would actually run.
 */
export function buildAuthView(input: {
  availability: AgyAuthAvailability;
  selected?: unknown;
  settingsPath: string;
}): AgyAuthView {
  const { availability, settingsPath } = input;
  const known = isMode(input.selected) ? input.selected : undefined;
  const effective = resolveAuthMode(availability, known) ?? null;
  const methods: AgyAuthOptionView[] = AGY_AUTH_ORDER.map((mode) => ({
    key: mode,
    label: AGY_AUTH_LABELS[mode],
    available: availability[mode],
    placeholder: false,
    hint: hintFor(mode, availability),
  }));
  const note = noteFor(known, effective, availability);
  return {
    methods,
    selected: known ?? null,
    effective,
    settingsPath,
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * Validate one `agyAuth/set` request into the mode to adopt.
 *
 * `null` means "clear the explicit choice and let the ladder decide" — a real
 * instruction, not a missing value, which is why an absent field and an
 * explicit `null` agree while an unknown string is rejected.
 *
 * @param request - the wire payload's `request` argument.
 * @returns the mode to persist, or `null` to clear the choice.
 * @throws {TypeError} on an unknown mode.
 */
export function normalizeSetRequest(request?: AgyAuthSetRequest | null): AgyAuthMode | null {
  const requested = request?.mode;
  if (requested === undefined || requested === null) return null;
  if (!isMode(requested)) {
    throw new TypeError(`agyAuth/set: unknown auth mode ${JSON.stringify(requested)}`);
  }
  return requested;
}

/** One short line per option: what makes it usable, or what is missing. */
function hintFor(mode: AgyAuthMode, availability: AgyAuthAvailability): string {
  if (mode === "oauth") {
    return availability.oauth
      ? "Uses the CLI's own Google sign-in (Agent Platform) — the default backend."
      : "No Google sign-in found; run `agy` once to sign in.";
  }
  if (mode === "apiKey") {
    return availability.apiKey
      ? "A key is available (saved for this runtime or GEMINI_API_KEY)."
      : "No key yet — save one, or export GEMINI_API_KEY.";
  }
  return availability.adc
    ? "Application Default Credentials found on this machine."
    : "No ADC found — run `gcloud auth application-default login`.";
}

/** Explain the one case the panel cannot show on its own: a stale selection. */
function noteFor(
  selected: AgyAuthMode | undefined,
  effective: AgyAuthMode | null,
  availability: AgyAuthAvailability,
): string | undefined {
  if (selected !== undefined && !availability[selected]) {
    return effective === null
      ? `${AGY_AUTH_LABELS[selected]} is no longer present on this machine, and no other form is available.`
      : `${AGY_AUTH_LABELS[selected]} is no longer present on this machine — falling back to ${AGY_AUTH_LABELS[effective]}.`;
  }
  if (effective === null) return "No auth form is available yet; sessions will ask for one.";
  return undefined;
}
