/**
 * Client-half switch wiring (native UI fusion, plan Task 4): turns the pure
 * {@link createSwitchController} machine into the page's `switchAgent`.
 *
 * The host face is assembled from exactly the sanctioned surfaces:
 *   - the Task-3 page atom `__SUPERD_UI_STATE__` (setAgent = state + NS swap;
 *     every later request demuxes through the call-time patches);
 *   - the Task-3 namespaced `Storage` for the landing read — `getItem` is
 *     read at call time against the ACTIVE label's `'<label>:'` namespace,
 *     so the post-`setAgent` read of `dsh.sessions.current` lands in the
 *     target world's tree without this module ever prefixing keys itself;
 *   - `ctx.connection` (`reconnect()` + the generation observable — the
 *     establishment leg of `connection/reset`);
 *   - `ctx.uiWorkspace` (`openSession(target)` / `startSession(workspaceId?)`
 *     / `openWorkspace(workspaceId)` — the navigation face; T-F executes the
 *     restore precedence through these public faces only);
 *   - `ctx.workspaces` (`list` — the workspace projection; T-F also reads
 *     `initializeDefault` to mirror upstream's default-workspace boot path);
 *   - `ctx.sessions` (T-F: the session projection — its `list` store is the
 *     second freshness edge the landing gate watches, and its `ids`/`byId`
 *     are what upstream `restoreSelection` resolves the pointer against,
 *     navigation.ts:324; watching `workspaces.list` alone was the T-A gap
 *     that broke native's own last-visited restore);
 *   - `ctx.locale` (T-F: the active language for the default-workspace
 *     title, the one input upstream's `initializeDefaultWorkspace` derives
 *     from the context, navigation.ts:350-351);
 *   - the control-plane roster fetch (`/api/agent-runtime`, never rewritten)
 *     as the probe: the target must still be a live roster entry;
 *   - a minimal self-owned toast overlay for the revert feedback (upstream
 *     has no public toast service; the overlay reads nothing from any other
 *     component's DOM).
 *
 * The client entry (`index.ts`) binds once `connection` + `uiWorkspace`
 * exist. The Hub UI surfaces (HubPage rows + the HubPanelIcon chevron menu —
 * the sole switch surface since the T-B RuntimeSeat retirement) run every
 * click through {@link seatClickDecision} (switch-core): on a fusion page
 * the left click is intercepted with NO navigation — the orchestration bound
 * or not; on a world page the flag global is absent, the fusion arm never
 * runs, and the real hyperlink stays in charge (spec §5 双半边).
 *
 * @module superd-hub/client/switch
 */
import {
  createSwitchController,
  observeCachesRefreshed,
  SESSIONS_CURRENT_KEY,
  type NavigationCacheFace,
  type RestoreCaches,
  type RestoreWorkspaceView,
  type SwitchHost,
} from '../switch-core.js'
import { fetchRoster } from './roster.js'

/** The Task-3 page-level state atom the fused page boots with. */
export interface SuperdUiState {
  /** The active agent label: `'native'` or a runtime key. */
  readonly activeAgent: string
  setAgent(label: string): void
  subscribe(fn: (label: string) => void): () => void
}

/** Structural face of `ctx.connection` — the parts the switch machine needs. */
export interface SwitchConnection {
  reconnect(): void
  generation: {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
  }
}

/** Structural face of `ctx.uiWorkspace` — the navigation face (public only). */
export interface SwitchUiWorkspace {
  openSession(target: string | object): void
  openWorkspace(workspaceId: string): void | Promise<void>
  startSession(workspaceId?: string): void
}

/**
 * Structural face of `ctx.workspaces` — the workspace projection whose
 * baseline replacement is one of the TWO freshness edges the landing gate
 * watches, plus `initializeDefault` for the default-workspace mirror (the
 * same public method upstream's private `initializeDefaultWorkspace`
 * calls). Present wherever `uiWorkspace` is: upstream's ui-workspace injects
 * `workspaces` itself (ui-workspace/src/client/index.ts).
 */
export interface SwitchWorkspaces {
  readonly list: {
    getSnapshot(): { items: readonly RestoreWorkspaceView[]; phase: unknown }
    subscribe(listener: () => void): () => void
  }
  initializeDefault(request: {
    directoryName: string
    title: string
  }): Promise<{ workspaceId: string } | undefined>
}

/** Structural slice of one `ctx.sessions.list` `byId` row the landing reads. */
export interface SwitchSessionSummary {
  readonly id: string
  readonly blank?: boolean
  readonly updatedAt?: number
}

/**
 * Structural face of `ctx.sessions` (T-F) — the session projection the
 * landing pointer resolves against (upstream `restoreSelection` reads
 * `sessions.byId`, navigation.ts:324) and the second freshness edge of the
 * both-lists gate (the T-A gap: without it the gate could fire while `byId`
 * still held the previous plane's rows). T-G: its `byId` is also the gate's
 * membership face — the list is minted incrementally post-reconnect, so the
 * gate holds until the pointer's session joins `byId` (or the list goes
 * quiet) instead of trusting the first partial-list edge.
 */
export interface SwitchSessions {
  readonly list: {
    getSnapshot(): {
      ids: readonly string[]
      byId: Readonly<Record<string, SwitchSessionSummary>>
      phase: unknown
    }
    subscribe(listener: () => void): () => void
  }
}

/** Structural face of `ctx.locale` — the active-language read. */
export interface SwitchLocale {
  getSnapshot(): { active: string }
}

/** Whether this page is a fusion page: the baked flag global is present. */
export function fusionPage(): boolean {
  return (globalThis as { __SUPERD_UI_FUSION__?: unknown }).__SUPERD_UI_FUSION__ === true
}

/** The page atom, when the page carries one (it always does on a fusion page). */
export function uiState(): SuperdUiState | undefined {
  const state = (globalThis as { __SUPERD_UI_STATE__?: Partial<SuperdUiState> }).__SUPERD_UI_STATE__
  if (state === undefined) return undefined
  if (typeof state.setAgent !== 'function') return undefined
  if (typeof state.subscribe !== 'function' || typeof state.activeAgent !== 'string') return undefined
  return state as SuperdUiState
}

/** How long one revert toast stays on screen. */
const TOAST_HOLD_MS = 6_000

/**
 * One transient message, fixed above the sidebar footer. Self-owned
 * presentation only — no read from any foreign DOM, nothing is a state input.
 */
function showToast(message: string): void {
  try {
    const doc = (globalThis as { document?: Document }).document
    if (doc === undefined || doc.body === null) return
    const el = doc.createElement('div')
    el.textContent = message
    el.setAttribute('style', [
      'position:fixed',
      'left:50%',
      'bottom:64px',
      'transform:translateX(-50%)',
      'z-index:9999',
      'max-width:80vw',
      'padding:10px 14px',
      'border-radius:8px',
      'background:rgba(24,24,28,.94)',
      'color:#ececf0',
      'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
    ].join(';'))
    doc.body.appendChild(el)
    globalThis.setTimeout(() => {
      try {
        el.remove()
      } catch { /* already gone */ }
    }, TOAST_HOLD_MS)
  } catch { /* feedback is best-effort: never break the page */ }
}

/** The bound `switchAgent`, or `undefined` until the entry binds it. */
let bound: ((label: string) => Promise<void>) | undefined

/**
 * Bind the page's switch agent from the client services. Idempotent; a no-op
 * without the page atom (a non-fusion page never has one).
 * @param deps - the `connection`, `uiWorkspace`, `workspaces`, `sessions`
 *   and `locale` services (structural; the stock client tree always has all
 *   five — upstream's ui-workspace injects the same set).
 */
export function bindSwitchAgent(deps: {
  connection: SwitchConnection
  uiWorkspace: SwitchUiWorkspace
  workspaces: SwitchWorkspaces
  sessions: SwitchSessions
  locale: SwitchLocale
}): void {
  if (bound !== undefined) return
  const state = uiState()
  if (state === undefined) return
  const readRestoreCaches = (): RestoreCaches => {
    const workspaces = deps.workspaces.list.getSnapshot()
    const sessions = deps.sessions.list.getSnapshot()
    return {
      workspaces: { items: workspaces.items, phase: workspaces.phase },
      sessions: { ids: sessions.ids, byId: sessions.byId, phase: sessions.phase },
    }
  }
  // Upstream `initializeDefaultWorkspace` (navigation.ts:349-361) mirrored
  // through the public faces: the same language branch, the same request
  // payload, then `openWorkspace` instead of the private `connectWorkspace`
  // (both funnel into `reuseOrCreateBlank`). A refusal is feedback (the
  // upstream notice's meaning), never a revert; `undefined` (first-use
  // initialization ineligible) leaves the view as it is, like upstream.
  const openDefaultWorkspace = (): void => {
    const language = deps.locale.getSnapshot().active.toLowerCase().split('-')[0]
    const title = language === 'zh' ? '默认工作区' : 'Default workspace'
    const directoryName = language === 'zh' || language === 'en' ? title : 'default-workspace'
    void deps.workspaces.initializeDefault({ directoryName, title })
      .then((prepared) => {
        if (prepared !== undefined) deps.uiWorkspace.openWorkspace(prepared.workspaceId)
      })
      .catch(() => { showToast('Super D: unable to create the default workspace.') })
  }
  const host: SwitchHost = {
    setAgent(label) { state.setAgent(label) },
    readPersistedSelection() {
      // The Task-3 storage patch prefixes the ACTIVE label's namespace at
      // call time — the landing reads long after setAgent, so this read
      // lands in the target world's `'<label>:dsh.sessions.current'`.
      const storage = (globalThis as { localStorage?: Storage }).localStorage
      return storage === undefined ? null : storage.getItem(SESSIONS_CURRENT_KEY)
    },
    openSession(target) { deps.uiWorkspace.openSession(target) },
    startSession(workspaceId) { deps.uiWorkspace.startSession(workspaceId) },
    openDefaultWorkspace,
    readRestoreCaches,
    onCachesRefreshed(listener, gate) {
      // The T-F freshness gate over the real stores, extended T-G with the
      // membership face: the first post-establishment baseline replacement
      // in BOTH `workspaces.list` and `sessions.list` — upstream's
      // watchNavigation ready gate (navigation.ts:292) — held until the
      // persisted pointer's session JOINS the freshly (incrementally) minted
      // list, or the list goes quiet. The sessions store adapts its
      // projection's `ids` array to the freshness token (a fresh array is
      // minted on every projection); membership answers from the LIVE `byId`
      // snapshot — the face upstream's boot restore resolves the pointer
      // against (navigation.ts:324), and the only one that can gain a row
      // without a new `ids` identity (publishRetention, service.ts:565).
      // The machine's gate request (pointer face, quiet window, timers)
      // rides through structurally — it is a full LandingGateOptions.
      const sessionsFace: NavigationCacheFace = {
        getSnapshot: () => {
          const snapshot = deps.sessions.list.getSnapshot()
          return { items: snapshot.ids, phase: snapshot.phase }
        },
        subscribe: (fn) => deps.sessions.list.subscribe(fn),
        contains: (id) => deps.sessions.list.getSnapshot().byId[id] !== undefined,
      }
      return observeCachesRefreshed(deps.workspaces.list, sessionsFace, deps.connection.generation, listener, gate)
    },
    reconnect() { deps.connection.reconnect() },
    onGenerationEstablished(listener) {
      const generation = deps.connection.generation
      // The observable fires on establishment, replacement, and loss; only
      // an existing generation settles the attempt.
      return generation.subscribe(() => {
        if (generation.getSnapshot() !== undefined) listener()
      })
    },
    async probeTarget(label) {
      try {
        // Control plane, never rewritten: the roster always talks to ctx0.
        const roster = await fetchRoster()
        return roster.some((agent) => agent.key === label)
      } catch {
        return false
      }
    },
    toast: showToast,
    setTimeout(fn, ms) { return globalThis.setTimeout(fn, ms) },
    clearTimeout(handle) { globalThis.clearTimeout(handle as number) },
  }
  const controller = createSwitchController(host)
  bound = (label) => controller.run(label)
}

/**
 * The Hub switch surfaces' entry point. Attempts the in-page switch for
 * `label`.
 * @returns `true` when the fusion switch took the click over; `false` when
 *   this page is not a fusion page or the orchestration is unbound.
 *   Informational only — the interception contract (`seatClickDecision`)
 *   prevents navigation on every fusion-page left click regardless: a
 *   `false` means the click is swallowed, never that the anchor navigates
 *   the fused page away (review round 1).
 */
export function attemptSwitch(label: string): boolean {
  const run = bound
  if (run === undefined || !fusionPage()) return false
  void run(label).catch(() => { /* the machine resolves, never rejects */ })
  return true
}
