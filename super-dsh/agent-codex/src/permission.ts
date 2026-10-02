/**
 * Dash permission preset ↔ Codex approval/sandbox mapping (app-server line,
 * 2026-10-03).
 *
 * The SDK line could only pin these at LAUNCH (`--approval-mode` →
 * `ThreadOptions.approvalPolicy`; no RPC changed them mid-session), which is
 * why this module used to be a one-shot mapping and why `/permission` was
 * shadowed with a refusal. The app-server line accepts `approvalPolicy` and
 * `sandboxPolicy` on EVERY `turn/start` ("Override the approval policy for this
 * turn and subsequent turns"), so the mapping is now folded from the DSH
 * session log once per turn and is therefore LIVE.
 *
 * Two independent folds, each with its own fallback (a session may carry only
 * one of the two events):
 *
 *   approvalPolicy  ← approval/policy {policy:'ask'|'never'}       (else preset)
 *                   ← CODEX_APPROVAL_MODE env override             (always wins)
 *   sandboxPolicy   ← sandbox/mode {mode:…}                       (else preset)
 *
 * The Dash preset table (mirrors the base bundle's permission plugin config):
 *
 *   danger-full-access → sandbox dangerFullAccess + approval never
 *   workspace-write    → sandbox workspaceWrite    + approval on-request
 *   read-only          → sandbox readOnly          + approval never
 *   no explicit preset → never (the profile pins danger-full-access; the
 *                        sandbox itself remains the constraint)
 *
 * `CODEX_APPROVAL_MODE` (a valid codex approval policy) overrides the mapping
 * — headless test runs pin the flag without composing a preset default. An
 * invalid value is IGNORED (the preset mapping applies).
 *
 * The preset is a Dash-side session fact Codex never records. It lives in the
 * session log (the `permission/preset` / `sandbox/mode` / `approval/policy`
 * events {@link permissionEventsFor} stamps); the rollout stays Codex's
 * transcript of record and is never written.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalPolicy, SandboxPolicy } from "./app-server-client.js";

/** The approval policies Codex actually implements (unknown values are ignored). */
const APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"] as const;

/** Dash sandbox modes as they appear in the `sandbox/mode` session event. */
export type SandboxModeName = "read-only" | "workspace-write" | "danger-full-access";

/** The Dash preset table (mirrors the base bundle's permission plugin config). */
const PRESETS = {
  "danger-full-access": { sandbox: "danger-full-access", approval: "never", codexPolicy: "never" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask", codexPolicy: "on-request" },
  "read-only": { sandbox: "read-only", approval: "ask", codexPolicy: "never" },
} as const;

/**
 * The permission event keys this module reads/synthesizes that the
 * locally-resolved dsh-session build does not know (upstream declares them
 * in dsh-permission-presets / dsh-sandbox-policy, whose types this project
 * does not reference). Mirrored verbatim so `SessionEvent` narrows.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "permission/preset": { preset: string };
    "sandbox/mode": { mode: SandboxModeName; source?: "delegation" };
  }
}

type PresetName = keyof typeof PRESETS;

/** Narrow an untrusted value to a known preset name. */
export function isPresetName(raw: unknown): raw is PresetName {
  return typeof raw === "string" && Object.hasOwn(PRESETS, raw);
}

/** Narrow an untrusted value to a known sandbox mode. */
export function isSandboxMode(raw: unknown): raw is SandboxModeName {
  return raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access";
}

/**
 * `CODEX_APPROVAL_MODE` when it names an approval policy Codex implements,
 * else undefined. An invalid value is IGNORED (the preset mapping applies).
 */
export function envApprovalMode(): string | undefined {
  const raw = process.env.CODEX_APPROVAL_MODE;
  return raw !== undefined && (APPROVAL_POLICIES as readonly string[]).includes(raw) ? raw : undefined;
}

/**
 * Map a preset onto Codex's launch approval policy; no preset → never.
 * A value that is ALREADY a codex approval policy (the env override rides
 * through the same folded call) passes through untouched; unknown preset
 * names degrade to never.
 *
 * Still used at create/resume for `thread/start|resume.approvalPolicy` — the
 * thread's initial posture before the first per-turn fold lands.
 */
export function codexApprovalMode(preset: string | undefined): string {
  if (preset !== undefined && (APPROVAL_POLICIES as readonly string[]).includes(preset)) return preset;
  return isPresetName(preset) ? PRESETS[preset].codexPolicy : "never";
}

/** The codex approval policy a Dash `approval/policy` value maps onto. */
export function approvalPolicyForDashPolicy(policy: "ask" | "never"): ApprovalPolicy {
  return policy === "ask" ? "on-request" : "never";
}

/** The structured codex sandbox policy for one Dash sandbox mode. */
export function sandboxPolicyFor(mode: SandboxModeName, cwd: string): SandboxPolicy {
  switch (mode) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

/** The Dash sandbox mode a preset pins (unknown/absent → danger-full-access, matching the profile pin). */
export function sandboxModeForPreset(preset: string | undefined): SandboxModeName {
  return isPresetName(preset) ? (PRESETS[preset].sandbox as SandboxModeName) : "danger-full-access";
}

/** The slice of `ctx.permissionPresets` the provider reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service
 * resolves it (settings-backed; the profile patch pins the base default).
 * Undefined when the service is absent or its getter fails — callers fall
 * back to the codex default policy.
 */
export function defaultPermissionPreset(ctx: Context): string | undefined {
  const service = ctx.get("permissionPresets") as PermissionPresetsSlice | undefined;
  if (service === undefined) return undefined;
  try {
    const preset = service.defaultPreset;
    return isPresetName(preset) ? preset : undefined;
  } catch {
    return undefined;
  }
}

/** The session's effective preset: the last `permission/preset` event. */
export function presetFromEvents(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "permission/preset" && isPresetName(event.data?.preset)) return event.data.preset;
  }
  return undefined;
}

/** The session's effective sandbox mode: the last `sandbox/mode` event. */
export function sandboxModeFromEvents(events: readonly SessionEvent[]): SandboxModeName | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "sandbox/mode" && isSandboxMode(event.data?.mode)) return event.data.mode;
  }
  return undefined;
}

/** The session's effective approval policy: the last `approval/policy` event. */
export function approvalPolicyFromEvents(events: readonly SessionEvent[]): ApprovalPolicy | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "approval/policy") {
      const policy = event.data?.policy;
      if (policy === "ask" || policy === "never") return approvalPolicyForDashPolicy(policy);
    }
  }
  return undefined;
}

/** The per-turn codex overrides folded from the session log. */
export interface CodexTurnPolicy {
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandbox: SandboxPolicy;
}

/**
 * Fold the session's live permission state into the codex overrides for the
 * NEXT `turn/start`. Never throws; every unknown value degrades to the
 * fallback preset, and the env override wins for the approval half.
 *
 * @param events - the session log (or any suffix ending at the current state).
 * @param fallbackPreset - the preset to use when the log carries no event
 *   (the recorded preset from the identity map, else the service default).
 * @param cwd - the session workspace, used for `workspaceWrite.writableRoots`.
 */
export function turnPolicyFromEvents(events: readonly SessionEvent[], fallbackPreset: string | undefined, cwd: string): CodexTurnPolicy {
  const preset = isPresetName(fallbackPreset) ? fallbackPreset : undefined;
  const presetSpec = preset === undefined ? undefined : PRESETS[preset];
  const sandboxMode = sandboxModeFromEvents(events) ?? (presetSpec?.sandbox as SandboxModeName | undefined) ?? "danger-full-access";
  const fromEvents = approvalPolicyFromEvents(events);
  const envMode = envApprovalMode();
  const approvalPolicy: ApprovalPolicy =
    envMode === "never" || envMode === "on-request" || envMode === "untrusted"
      ? envMode
      : fromEvents ?? (codexApprovalMode(preset) as ApprovalPolicy);
  return { approvalPolicy, sandbox: sandboxPolicyFor(sandboxMode, cwd) };
}

/**
 * The three Dash events `pinInitialPermission` stamps for a fresh session,
 * in its append order (preset, sandbox, approval). Cold replay prepends
 * them so the UI shows the session's permission after wrapper restarts.
 */
export function permissionEventsFor(preset: PresetName, time: number): SessionEvent[] {
  const spec = PRESETS[preset];
  return [
    { type: "permission/preset", time, data: { preset } },
    { type: "sandbox/mode", time, data: { mode: spec.sandbox } },
    { type: "approval/policy", time, data: { policy: spec.approval } },
  ] as unknown as SessionEvent[];
}
