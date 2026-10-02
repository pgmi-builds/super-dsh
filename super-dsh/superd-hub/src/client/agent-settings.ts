/**
 * Runtime settings panels for the Hub's Agent Runtimes rows (P3, 2026-10-02
 * user ruling).
 *
 * Interaction contract the UI follows (ruling, verbatim intent):
 *   - clicking the ROW BODY expands that runtime's OWN settings inline
 *     (accordion: at most one row open at a time);
 *   - the row's existing right-hand `switch` affordance is the ONLY switch —
 *     the panel never carries a second one.
 *
 * Config belongs to the adapter (agent-adapter-dev-rules §12), so this module
 * owns only the presentation-side logic: which runtimes have a panel, the
 * accordion transition, and a defensive parse of whatever the adapter's
 * `*Auth/get` RPC returns. The adapter decides which auth methods exist, which
 * are available on this machine, and which one is in force.
 *
 * Node-safe by construction (no DOM, no React, no fetch) — the host tsconfig
 * dual-emits this file to `dist/client/agent-settings.js` so
 * test/client-agent-settings.test.mjs can pin the parse and accordion rules
 * under `node --test` (the roster.ts / mesh-api.ts precedent).
 *
 * @module superd-hub/client/agent-settings
 */

/** One selectable auth method as the adapter describes it. */
export interface AuthMethodOption {
  /** Stable id the RPC round-trips (`apiKey` | `oauth` | `adc`). */
  readonly key: string
  /** Human label rendered on the option. */
  readonly label: string
  /** Detected on THIS machine. Drives the availability annotation. */
  readonly available: boolean
  /**
   * Rendered but not selectable this round (the OAuth placeholder): the UI
   * shows the shape and says why it is inert, instead of hiding it.
   */
  readonly placeholder: boolean
  /** One short line explaining the option (or why it is inert). */
  readonly hint: string
}

/** The adapter's answer to `<runtime>Auth/get`. */
export interface RuntimeAuthView {
  readonly methods: readonly AuthMethodOption[]
  /** The user's explicit persisted choice; `null` when they have not made one. */
  readonly selected: string | null
  /** What a new session would ACTUALLY use right now (ladder fallback applied). */
  readonly effective: string | null
  /** Native file the adapter maintains for this runtime, when it owns one. */
  readonly settingsPath?: string
  /** Free-form note from the adapter (e.g. why a mode is unavailable). */
  readonly note?: string
}

/**
 * A runtime's settings panel: which adapter Remote answers for it.
 *
 * The namespace is the adapter's own service key — the hub forwards
 * `envelope.method` verbatim, so the client needs only the name. A runtime absent
 * from this table has no panel yet: its row still expands, to an explicit empty
 * state rather than a dead control (the interaction stays uniform, and a runtime
 * with nothing to configure SAYS so).
 */
export interface SettingsPanelSpec {
  /** The adapter's Remote namespace (`agyAuth`). */
  readonly namespace: string
}

const SETTINGS_PANELS: Readonly<Record<string, SettingsPanelSpec>> = {
  // The one runtime with a settings surface this round: the CLI adapter owns the
  // auth ladder and is the configuration surface for the user's local Antigravity.
  agy: { namespace: 'agyAuth' },
}

/** The panel spec for a runtime, or `undefined` when it has none yet. */
export function settingsPanelFor(agentKey: string): SettingsPanelSpec | undefined {
  return SETTINGS_PANELS[agentKey]
}

/** Whether this runtime's row body expands into a real settings panel. */
export function hasSettingsPanel(agentKey: string): boolean {
  return settingsPanelFor(agentKey) !== undefined
}

/**
 * Accordion transition: at most one row open. Clicking the open row closes it;
 * clicking another moves the panel there in one click.
 */
export function toggleExpanded(current: string | null, key: string): string | null {
  return current === key ? null : key
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function methodOption(raw: unknown): AuthMethodOption | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const key = str(record.key)
  const label = str(record.label)
  if (key === undefined || label === undefined) return undefined
  return {
    key,
    label,
    // Absent flags read as the conservative value: an older adapter that omits
    // `available` must not render an option as usable when we cannot tell.
    available: record.available === true,
    placeholder: record.placeholder === true,
    hint: str(record.hint) ?? '',
  }
}

/**
 * Defensive parse of the RPC answer. Returns `undefined` for anything that is
 * not a usable view (no methods, wrong shape, adapter absent) so the panel can
 * render an explicit failure instead of an empty list that looks like success.
 */
export function parseAuthView(raw: unknown): RuntimeAuthView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.methods)) return undefined
  const methods = record.methods.map(methodOption).filter((m): m is AuthMethodOption => m !== undefined)
  if (methods.length === 0) return undefined
  const settingsPath = str(record.settingsPath)
  const note = str(record.note)
  return {
    methods,
    selected: str(record.selected) ?? null,
    effective: str(record.effective) ?? null,
    ...(settingsPath === undefined ? {} : { settingsPath }),
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * The option the panel marks as in force: the effective one when the adapter
 * named it, else the explicit selection. `undefined` when neither is known —
 * the panel then marks nothing rather than guessing.
 */
export function activeMethod(view: RuntimeAuthView): AuthMethodOption | undefined {
  const wanted = view.effective ?? view.selected
  if (wanted === null) return undefined
  return view.methods.find((method) => method.key === wanted)
}

/** Whether an option may be picked (placeholders are rendered, never selected). */
export function selectable(option: AuthMethodOption): boolean {
  return !option.placeholder
}
