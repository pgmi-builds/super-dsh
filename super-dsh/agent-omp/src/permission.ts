/**
 * Dash permission preset ↔ OMP approval mode.
 *
 * OMP has no runtime approval control: `--approval-mode` is a launch flag, no
 * RPC changes it mid-session. Dash's 3-way permission preset is therefore
 * resolved ONCE, at the spawn of that session's `omp --mode rpc` child, and
 * mapped explicitly:
 *
 *   danger-full-access → `--approval-mode yolo`   (OMP's own native default)
 *   workspace-write    → `--approval-mode write`
 *   read-only          → `--approval-mode always-ask`
 *   no explicit preset → yolo (native default)
 *
 * "At the spawn" is load-bearing, not incidental. The Dash session is prepared
 * (and `pinInitialPermission`-stamped) only AFTER the transport wrapper exists,
 * and the new-chat permission pick arrives as a later `permission/preset` — the
 * child materializes on the first prompt, so the launch flag must be read from
 * the session at THAT moment, never frozen at create. See
 * {@link resolveSpawnPermission}.
 *
 * `OMP_APPROVAL_MODE` (a valid mode) overrides the mapping — headless test
 * runs pin the flag without composing a preset default.
 *
 * The preset is a Dash-side session fact OMP never records. It lives in the
 * dsh session log (`permission/preset`, the event `/permission` writes) and is
 * mirrored into the centralized index (`sessions.permission_preset`) at first
 * spawn; the index row is only a fallback for logs predating the event.
 */
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

/** The approval modes OMP actually implements (unknown modes degrade to yolo). */
const APPROVAL_MODES = ["write", "always-ask", "yolo"] as const;

/** The Dash preset table (mirrors the base bundle's permission plugin config). */
const PRESETS = {
  "danger-full-access": { sandbox: "danger-full-access", approval: "never", ompMode: "yolo" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask", ompMode: "write" },
  "read-only": { sandbox: "read-only", approval: "ask", ompMode: "always-ask" },
} as const;

/**
 * The two permission event keys this module reads/synthesizes that the
 * locally-resolved dsh-session build does not know (upstream declares them
 * in dsh-permission-presets / dsh-sandbox-policy, whose types this project
 * does not reference). Mirrored verbatim so `SessionEvent` narrows.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "permission/preset": { preset: string };
    "sandbox/mode": { mode: "read-only" | "workspace-write" | "danger-full-access"; source?: "delegation" };
  }
}

type PresetName = keyof typeof PRESETS;

/** Narrow an untrusted value to a known preset name. */
export function isPresetName(raw: unknown): raw is PresetName {
  return typeof raw === "string" && Object.hasOwn(PRESETS, raw);
}

/**
 * `OMP_APPROVAL_MODE` when it names a mode OMP implements, else undefined.
 * An invalid value is IGNORED (the preset mapping applies) — the old
 * fall-back-to-`write` behavior silently downgraded from OMP's native yolo.
 */
export function envApprovalMode(): string | undefined {
  const raw = process.env.OMP_APPROVAL_MODE;
  return raw !== undefined && (APPROVAL_MODES as readonly string[]).includes(raw) ? raw : undefined;
}

/** Map a preset onto OMP's `--approval-mode` flag value; no preset → yolo. */
export function ompApprovalMode(preset: string | undefined): string {
  return isPresetName(preset) ? PRESETS[preset].ompMode : "yolo";
}

/** The slice of `ctx.permissionPresets` the bridge reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service
 * resolves it (settings-backed; the profile patch pins the base default).
 * Undefined when the service is absent or its getter fails — callers fall
 * back to OMP's native default.
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

/**
 * Resolve a spawn's `--approval-mode` (and the preset to record for it) from
 * the session's OWN log, evaluated at the moment the child materializes.
 *
 * Order of authority: the last valid `permission/preset` (= the user's pick in
 * the new chat, or the draft's `pinInitialPermission` stamp) → `fallbackPreset`
 * (the composition default for a create, the bridge-index row for a resume of a
 * log that predates the event) → OMP's native default (`yolo`). An
 * `OMP_APPROVAL_MODE` env override (headless runs) still wins over all of them.
 *
 * @param events - the live session's events (never a stale create-time read).
 * @param fallbackPreset - used only when the log carries no valid preset.
 * @param envMode - `envApprovalMode()`; undefined when unset or invalid.
 * @returns the launch flag value plus the preset that produced it.
 */
export function resolveSpawnPermission(
  events: readonly SessionEvent[],
  fallbackPreset: string | undefined,
  envMode: string | undefined,
): { approvalMode: string; preset: string | undefined } {
  const preset = presetFromEvents(events) ?? (isPresetName(fallbackPreset) ? fallbackPreset : undefined);
  return { approvalMode: envMode ?? ompApprovalMode(preset), preset };
}

/**
 * The write slice of `ctx.permissionPresets` the `/permission` command mirrors:
 * `names`/`current` for the settled answers, `set` for the durable write (the
 * same public call the webhook plugin uses to pin a session's initial preset —
 * it appends `permission/preset` + the knob events and touches no live agent).
 */
export interface PermissionPresetsWriteSlice {
  readonly names: readonly string[];
  current(session: Session): string;
  set(session: Session, name: string): void;
}

/** One `/permission` outcome, shaped exactly as `dsh-commands` expects. */
export interface PermissionCommandOutcome {
  kind: "success" | "error";
  text: string;
}

/**
 * What the adapter's `/permission` shadow must do: `apply` writes the preset to
 * the session (the caller then returns `result`), `settled` returns it as-is.
 */
export type OmpPermissionDecision =
  | { action: "apply"; preset: string; result: PermissionCommandOutcome }
  | { action: "settled"; result: PermissionCommandOutcome };

/**
 * Decide a `/permission` invocation for one OMP session.
 *
 * A permission pick can only become real at the child's launch, so the shadow
 * accepts it exactly while no child exists (the new-chat draft, or a resumed
 * session before its first prompt) and refuses it afterwards — appending a
 * preset the running `omp` cannot honor would make the UI lie about the
 * session's effective policy.
 *
 * @param input.rawInput - the preset name as typed (may be empty or padded).
 * @param input.spawned - whether THIS session's `omp --mode rpc` child exists.
 * @param input.names - the host's advertised preset names.
 * @param input.current - the session's current preset (for the bare command).
 * @returns the decision; the caller performs the write for `apply`.
 */
export function ompPermissionCommand(input: {
  rawInput: string;
  spawned: boolean;
  names: readonly string[];
  current: string;
}): OmpPermissionDecision {
  const available = input.names.join(", ");
  const name = input.rawInput.trim();
  if (name === "") {
    return {
      action: "settled",
      result: { kind: "success", text: `current preset ${input.current} (available: ${available})` },
    };
  }
  if (!input.names.includes(name)) {
    return { action: "settled", result: { kind: "error", text: `unknown preset "${name}" (available: ${available})` } };
  }
  if (input.spawned) {
    return {
      action: "settled",
      result: {
        kind: "error",
        text: `the OMP session is already running with a fixed approval policy: pick "${name}" in a new chat, before the first prompt`,
      },
    };
  }
  return { action: "apply", preset: name, result: { kind: "success", text: `preset ${name}` } };
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

/**
 * The bridge's legacy per-session artifact path (the migration reads this to
 * import the old `dashSessionId` / `permissionPreset` once). Kept read-only;
 * nothing writes it after the migration.
 */
export function webuiArtifactPath(sessionFile: string): string {
  const base = sessionFile.split("/").pop() ?? sessionFile;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return join(dirname(sessionFile), stem, "webui.json");
}
