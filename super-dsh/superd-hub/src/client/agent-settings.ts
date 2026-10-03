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
  // Claude serves the same providers view shape as Codex with no protocol
  // dropdown: its adapter's view carries no `protocols` field (claude has no
  // wire-protocol choice to make), so the body degrades to what the view does
  // carry — two header auth kinds and its own native fact (2026-10-04).
  claude: { namespace: 'claudeProviders', kind: 'providers' },
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

// The multi-provider surface the provider-list harnesses mount (codex since
// 2026-10-03, claude since 2026-10-04 — two faces of one body). Config is
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

/**
 * The auth shapes the provider faces use between them: `apiKey` is shared,
 * codex adds `env` (the key lives in a named variable), claude adds
 * `authToken` (a Bearer token). Each face's adapter rejects the other's
 * addition on save, which is why the form offers kinds per view
 * (`authKindOptions`) instead of one fixed list.
 */
export type ProviderAuthKind = 'apiKey' | 'env' | 'authToken'

/** One configured provider, listed but never carrying its key. */
export interface ProviderOption {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly protocol: string
  readonly models: readonly ProviderModelOption[]
  /** Which key shape the entry stores — see `ProviderAuthKind`. */
  readonly authKind: ProviderAuthKind
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

/**
 * The files this surface reads and writes, shown so where an edit lands is
 * never a surprise. Only `store` is common: each face names its own native
 * files (codex: config/auth/catalogs; claude: settings), and a face that
 * lacks a slot simply omits it — the footer renders what is there.
 */
export interface ProviderPaths {
  readonly store: string
  readonly config?: string
  readonly auth?: string
  readonly catalogs?: string
  readonly settings?: string
}

/** The adapter's answer to `codexProviders/get` / `claudeProviders/get` (and to every mutation). */
export interface RuntimeProvidersView {
  readonly providers: readonly ProviderOption[]
  /**
   * What the user's OWN native config currently names (codex: the provider
   * `~/.codex/config.toml` selects; claude: the endpoint the `settings.json`
   * env pins). Informational only — there is no action attached to it, and
   * DSH's per-session model selection (not this list) decides what a session
   * runs.
   */
  readonly native: { readonly providerId?: string; readonly baseUrl?: string; readonly model?: string } | null
  /**
   * The wire protocols the adapter offers, in the order it offers them. Empty
   * for a face with no protocol choice (claude) — the panel then omits the
   * dropdown instead of inventing options the runtime cannot run.
   */
  readonly protocols: readonly ProviderProtocolOption[]
  readonly paths: ProviderPaths
  /** Epoch ms of the last reconcile against the native config, when one has happened. */
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

function providerAuthKind(raw: unknown): ProviderAuthKind {
  // An unstated or unknown kind reads as the shared conservative default,
  // never as the other face's shape.
  return raw === 'env' ? 'env' : raw === 'authToken' ? 'authToken' : 'apiKey'
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
    authKind: providerAuthKind(record.authKind),
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
  // The store is the only slot every face promises; the native files are the
  // face's own, and an absent one stays absent rather than blank.
  if (store === undefined) return undefined
  const config = nonEmpty(record.config)
  const auth = nonEmpty(record.auth)
  const catalogs = nonEmpty(record.catalogs)
  const settings = nonEmpty(record.settings)
  return {
    store,
    ...(config === undefined ? {} : { config }),
    ...(auth === undefined ? {} : { auth }),
    ...(catalogs === undefined ? {} : { catalogs }),
    ...(settings === undefined ? {} : { settings }),
  }
}

/**
 * Defensive parse of the adapter's providers answer.
 *
 * `undefined` for anything that is not a usable view — but an empty `providers`
 * array is valid (a fresh install), and so is a provider whose `models` array
 * is empty. `protocols` is the codex face's field: an ABSENT field (the claude
 * face) reads as "no protocol choice" and never fails the parse, while a
 * present-but-unusable list is a malformed codex answer and rejects as before.
 */
export function parseProvidersView(raw: unknown): RuntimeProvidersView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.providers)) return undefined
  // Absent `protocols` (the claude face) → nothing to offer, the panel omits
  // the dropdown. Present (the codex face) → must parse to at least one
  // option, exactly as before.
  let protocols: ProviderProtocolOption[] = []
  if (record.protocols !== undefined) {
    if (!Array.isArray(record.protocols)) return undefined
    protocols = record.protocols.map(protocolOption).filter((entry): entry is ProviderProtocolOption => entry !== undefined)
    if (protocols.length === 0) return undefined
  }
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
 * The user's own native config as the adapter last read it. `null` when the
 * adapter said nothing; otherwise an object carrying whichever halves were
 * named — codex names a provider id, claude an endpoint URL — and an empty
 * one is still news (the panel says the file names nothing).
 */
function nativeConfig(raw: unknown): RuntimeProvidersView['native'] {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const providerId = nonEmpty(record.providerId)
  const baseUrl = nonEmpty(record.baseUrl)
  const model = nonEmpty(record.model)
  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  }
}

// ------------------------------------------- the form's per-view auth shapes

/** One selectable auth shape for the add/edit form (`authKindOptions`). */
export interface ProviderAuthKindOption {
  readonly value: ProviderAuthKind
  readonly label: string
  readonly hint: string
}

/** The codex face: a stored key, or the name of a variable holding it. */
const KEY_OR_ENV: readonly ProviderAuthKindOption[] = [
  { value: 'apiKey', label: 'API key', hint: 'Stored with the provider; injected at launch.' },
  { value: 'env', label: 'Environment variable', hint: 'The child reads the key from a named variable.' },
]

/** The claude face: both kinds are literal keys, differing only in the header. */
const TWO_HEADER_SHAPES: readonly ProviderAuthKindOption[] = [
  { value: 'apiKey', label: 'API key (x-api-key)', hint: 'Sent as the x-api-key header.' },
  { value: 'authToken', label: 'Bearer token', hint: 'Sent as the Authorization header.' },
]

/**
 * The auth shapes the add/edit form may pick for a provider, in display order.
 *
 * The view carries no explicit vocabulary field, so the panel reads it off the
 * one field that distinguishes the faces today: `protocols`. The codex face
 * advertises wire protocols and offers key-or-env-var; the claude face carries
 * neither and offers its two header shapes instead. The list is per-view,
 * never a fixed union — each adapter rejects the other's kinds on save, so a
 * union dropdown would miscode silently. A third face extends the table.
 */
export function authKindOptions(view: RuntimeProvidersView): readonly ProviderAuthKindOption[] {
  return view.protocols.length > 0 ? KEY_OR_ENV : TWO_HEADER_SHAPES
}

/**
 * `provider / model` (codex) or `endpoint / model` (claude) — whichever halves
 * the user's own native config names, joined for the one-line fact the panel
 * states and never acts on.
 */
export function nativeDescription(native: RuntimeProvidersView['native']): string {
  const parts = [native?.providerId ?? native?.baseUrl, native?.model].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? 'no provider' : parts.join(' / ')
}

/**
 * The non-store paths joined for the panel's second footer line, in a fixed
 * slot order. `undefined` when the face named none — the line is omitted
 * entirely rather than rendered with blank slots.
 */
export function nativePathsLine(paths: ProviderPaths): string | undefined {
  const parts = [paths.config, paths.auth, paths.catalogs, paths.settings].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(' · ')
}
