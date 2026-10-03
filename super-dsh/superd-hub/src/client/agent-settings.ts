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
  /**
   * Which body the expanded row mounts. A runtime's config is not always a
   * choice among a fixed set: Antigravity picks one sign-in form from a ladder,
   * while Codex carries a LIST of providers the user adds, edits and removes
   * (2026-10-03 ruling; the former active/select toggle is gone — which provider
   * a Codex session runs on is DSH's own per-session model selection, not a
   * hub-side switch). One namespace, two shapes — the kind discriminates.
   */
  readonly kind: 'auth' | 'providers'
}

const SETTINGS_PANELS: Readonly<Record<string, SettingsPanelSpec>> = {
  // The one runtime with a settings surface this round: the CLI adapter owns the
  // auth ladder and is the configuration surface for the user's local Antigravity.
  agy: { namespace: 'agyAuth', kind: 'auth' },
  // Codex's own config.toml names exactly one `model_provider`, but that file
  // is the USER's and no longer the hub's toggle: Super D hosts the list
  // cc-switch otherwise holds (add / edit / remove) and the adapter owns both
  // the list and whatever it does with the native file.
  codex: { namespace: 'codexProviders', kind: 'providers' },
  // Both Codex lines host the SAME provider list (2026-10-04): the SDK half is
  // the same agent through a different transport, so it carries the same panel
  // and the same Remote namespace. The two worlds keep separate stores under
  // their own `agents/<key>/`, so neither sees the other's list.
  'codex-sdk': { namespace: 'codexProviders', kind: 'providers' },
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

// ------------------------------------------------------------- providers body

// The multi-provider surface of a single-provider harness (codex). Config is
// still the ADAPTER's (dev-rules §12), so nothing here knows what a provider is
// beyond the shape the adapter promises. The parse is defensive in the same way
// `parseAuthView` is, with two deliberate differences — an EMPTY provider list is
// a legitimate state (a fresh install), so the panel renders its "Add provider"
// affordance rather than an error; and a provider's `models` may be empty (one
// folded in from the user's config.toml that is not the one in force has no
// discoverable list), which the row states instead of rendering a blank. There
// is no `selected`/active half at all: choosing what a session runs is DSH's own
// model selection.

/** One model behind a provider, as the panel lists it. */
export interface ProviderModelOption {
  readonly id: string
  /** Human label; the adapter sends one, else the id stands in. */
  readonly label: string
  readonly contextWindow?: number
}

/** One configured provider, listed but never carrying its key. */
export interface ProviderOption {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly protocol: string
  readonly models: readonly ProviderModelOption[]
  readonly authKind: 'apiKey' | 'env'
  /** The variable an env-shaped provider expects. */
  readonly envName?: string
  /** Whether a key is available — the ONLY thing the wire says about it. */
  readonly hasKey: boolean
}

/** One wire protocol the adapter offers, and whether it may be picked. */
export interface ProviderProtocolOption {
  readonly value: string
  readonly label: string
  readonly available: boolean
  readonly hint: string
}

/** The files this surface reads and writes, shown so where an edit lands is never a surprise. */
export interface ProviderPaths {
  readonly store: string
  readonly config: string
  readonly auth: string
  readonly catalogs: string
}

/** The adapter's answer to `codexProviders/get` (and to every mutation). */
export interface RuntimeProvidersView {
  readonly providers: readonly ProviderOption[]
  /**
   * What the user's OWN ~/.codex/config.toml currently names. Informational
   * only — there is no action attached to it, and DSH's per-session model
   * selection (not this list) decides what a session runs.
   */
  readonly native: { readonly providerId?: string; readonly model?: string } | null
  readonly protocols: readonly ProviderProtocolOption[]
  readonly paths: ProviderPaths
  /** Epoch ms of the last reconcile against config.toml, when one has happened. */
  readonly syncedAt?: number
  readonly note?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function modelOption(raw: unknown): ProviderModelOption | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = nonEmpty(record.id)
  if (id === undefined) return undefined
  const contextWindow = record.contextWindow
  return {
    id,
    label: nonEmpty(record.displayName) ?? id,
    ...(typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {}),
  }
}

function providerOption(raw: unknown): ProviderOption | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = nonEmpty(record.id)
  const label = nonEmpty(record.label)
  const baseUrl = nonEmpty(record.baseUrl)
  if (id === undefined || label === undefined || baseUrl === undefined) return undefined
  const models = Array.isArray(record.models)
    ? record.models.map(modelOption).filter((entry): entry is ProviderModelOption => entry !== undefined)
    : []
  const envName = nonEmpty(record.envName)
  return {
    id,
    label,
    baseUrl,
    // An unknown protocol is never echoed into a control; the only value this
    // harness can actually run is the safe default.
    protocol: record.protocol === 'chat' ? 'chat' : 'responses',
    models,
    authKind: record.authKind === 'env' ? 'env' : 'apiKey',
    ...(envName === undefined ? {} : { envName }),
    hasKey: record.hasKey === true,
  }
}

function protocolOption(raw: unknown): ProviderProtocolOption | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const value = nonEmpty(record.value)
  const label = nonEmpty(record.label)
  if (value === undefined || label === undefined) return undefined
  return { value, label, available: record.available === true, hint: nonEmpty(record.hint) ?? '' }
}

function providerPaths(raw: unknown): ProviderPaths | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const store = nonEmpty(record.store)
  const config = nonEmpty(record.config)
  const auth = nonEmpty(record.auth)
  const catalogs = nonEmpty(record.catalogs)
  if (store === undefined || config === undefined || auth === undefined || catalogs === undefined) return undefined
  return { store, config, auth, catalogs }
}

/**
 * Defensive parse of the adapter's providers answer.
 *
 * `undefined` for anything that is not a usable view — but an empty `providers`
 * array WITH a usable protocol list is valid (a fresh install), and so is a
 * provider whose `models` array is empty.
 */
export function parseProvidersView(raw: unknown): RuntimeProvidersView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.providers)) return undefined
  if (!Array.isArray(record.protocols)) return undefined
  const protocols = record.protocols.map(protocolOption).filter((entry): entry is ProviderProtocolOption => entry !== undefined)
  if (protocols.length === 0) return undefined
  const paths = providerPaths(record.paths)
  if (paths === undefined) return undefined
  const providers = record.providers.map(providerOption).filter((entry): entry is ProviderOption => entry !== undefined)
  const syncedAt = record.syncedAt
  const note = nonEmpty(record.note)

  return {
    providers,
    native: nativeConfig(record.native),
    protocols,
    paths,
    ...(typeof syncedAt === 'number' && Number.isFinite(syncedAt) ? { syncedAt } : {}),
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * The user's own config.toml as the adapter last read it. `null` when the
 * adapter said nothing; otherwise an object carrying whichever halves were
 * named (an empty one is still news — the panel says the file names nothing).
 */
function nativeConfig(raw: unknown): RuntimeProvidersView['native'] {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const providerId = nonEmpty(record.providerId)
  const model = nonEmpty(record.model)
  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(model === undefined ? {} : { model }),
  }
}
