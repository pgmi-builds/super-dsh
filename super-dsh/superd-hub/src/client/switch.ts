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
  createReadinessWaiter,
  createSwitchController,
  decidePreFlight,
  observeCachesRefreshed,
  runMachineDownFeedback,
  SESSIONS_CURRENT_KEY,
  FUSION_RELOAD_MARKER,
  fusionReloadDecision,
  type NavigationCacheFace,
  type RestoreCaches,
  type RestoreWorkspaceView,
  type PreFlightRow,
  type ReadinessWaiter,
  type SwitchHost,
} from '../switch-core.js'
import { showSuperdToast } from '../toast-core.js'
import { fetchMachines, reprobeMachine } from './mesh-api.js'
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
  initializeDefault(signal?: AbortSignal): Promise<{ workspaceId: string } | undefined>
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

/** Whether this page is a fusion page: the baked flag global is present. */
export function fusionPage(): boolean {
  return (globalThis as { __SUPERD_UI_FUSION__?: unknown }).__SUPERD_UI_FUSION__ === true
}

/**
 * The sessionStorage marker read (undefined-safe: a storage failure is
 * `false` — the probe then reloads without the loop guard, which only
 * matters for a host that reports fusion but never bakes the flag).
 */
function staleReloadMarker(): boolean {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage
    return storage?.getItem(FUSION_RELOAD_MARKER) !== null
  } catch {
    return false
  }
}

/**
 * Live-install staleness probe (2026-10-18): the ONE call the client entry
 * makes when the page does not carry the fusion flag. A flag-absent page is
 * either a pre-install page (the client half hot-loaded into HTML served
 * before the row mounted — the fresh-install case where the Hub row renders
 * but every switch affordance stays hidden until a manual restart) or a
 * deliberate flag-off deployment (T-E). The roster's additive `hub.fusion`
 * answers which; on an armed host the page re-boots ONCE — the marker keeps
 * a misbehaving host from ever looping the tab. Every failure mode (fetch
 * error, non-OK, old host without the field) degrades to no action: the
 * flag-off shapes below are the honest rendering of an unanswered probe.
 *
 * Fire-and-forget by contract — never throws, never blocks the apply.
 */
export function probeStaleFusionPage(): void {
  void (async () => {
    let hubFusion: unknown
    try {
      const response = await fetch('/api/agent-runtime', { credentials: 'same-origin' })
      if (!response.ok) return
      hubFusion = ((await response.json()) as { hub?: { fusion?: unknown } }).hub?.fusion
    } catch {
      return
    }
    if (fusionReloadDecision({ flagPresent: fusionPage(), markerPresent: staleReloadMarker(), hubFusion }) !== 'reload') return
    try {
      ;(globalThis as { sessionStorage?: Storage }).sessionStorage?.setItem(FUSION_RELOAD_MARKER, '1')
    } catch {
      /* private-mode storage: reload without the marker (a truthful host re-arms the page, ending the flow) */
    }
    ;(globalThis as { location?: { reload(): void } }).location?.reload()
  })()
}

/** The page atom, when the page carries one (it always does on a fusion page). */
export function uiState(): SuperdUiState | undefined {
  const state = (globalThis as { __SUPERD_UI_STATE__?: Partial<SuperdUiState> }).__SUPERD_UI_STATE__
  if (state === undefined) return undefined
  if (typeof state.setAgent !== 'function') return undefined
  if (typeof state.subscribe !== 'function' || typeof state.activeAgent !== 'string') return undefined
  return state as SuperdUiState
}

/**
 * One transient message through the official `Toast` primitive (C1 task 4:
 * the platform's top-center banner — dark surface in both themes, warn icon
 * seat — rendered by the host's React tree from the Hub sidebar row's
 * always-mounted owner; see client/toast.ts).
 */
function showToast(message: string): void {
  showSuperdToast(message)
}

/**
 * I1(c) feedback + I1(b) light probe (mesh P3 Task 5a): the machine-down
 * branch delegates to the pure {@link runMachineDownFeedback} — the
 * machines face (already part of the client half — the Hub machines panel's
 * own cheap same-origin GET) enriches the toast, bounded at 3s; after
 * toasting, ONE fire-and-forget reprobe POST per failed click refreshes the
 * hub's status table so the NEXT click can succeed without waiting for the
 * 5-minute sweep. Nothing here blocks the UI path.
 */
function reportMachineDown(label: string, row: PreFlightRow & { label?: string }): void {
  runMachineDownFeedback(label, row, {
    fetchMachines,
    reprobe: reprobeMachine,
    toast: showToast,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  })
}

/**
 * Build the `SwitchHost.openDefaultWorkspace` action.
 *
 * dsh 0.2.0-rc.2 removed the request object from the Host's
 * `workspaces.initializeDefault` Remote: the first-use directory and stored
 * title are fixed and language-neutral (`default-workspace` under
 * `<Documents>/deepseek-harness`), so the caller passes only its own lifetime
 * signal. This module shipped the pre-0.2 `{ directoryName, title }` shape for
 * a release cycle; the Host then received a plain object where it feeds
 * `AbortSignal.any(...)`, EVERY empty-plane landing rejected, and the browser
 * surfaced "Unable to create default workspace". Root-caused 2026-10-02 on
 * the Hermes world — the only world whose registry was still empty after the
 * 0.2.0-rc.2 upgrade, hence the only one that took the default-workspace
 * branch. Exported so the call shape is unit-testable without the
 * module-level single-bind guard.
 *
 * @param deps - the workspace projection and the navigation face.
 * @param toast - the feedback sink; a refusal is feedback, never a revert.
 * @returns the host action.
 */
export function openDefaultWorkspaceFor(
  deps: { workspaces: SwitchWorkspaces; uiWorkspace: SwitchUiWorkspace },
  toast: (message: string) => void,
): () => void {
  return () => {
    void deps.workspaces.initializeDefault()
      .then((prepared) => {
        if (prepared !== undefined) deps.uiWorkspace.openWorkspace(prepared.workspaceId)
      })
      .catch(() => { toast('Super D: unable to create the default workspace.') })
  }
}

/** The bound `switchAgent`, or `undefined` until the entry binds it. */
let bound: ((label: string) => Promise<void>) | undefined

/**
 * Bind the page's switch agent from the client services. Idempotent; a no-op
 * without the page atom (a non-fusion page never has one).
 * @param deps - the `connection`, `uiWorkspace`, `workspaces` and `sessions`
 *   services (structural; the stock client tree always has all four —
 *   upstream's ui-workspace injects the same set).
 */
export function bindSwitchAgent(deps: {
  connection: SwitchConnection
  uiWorkspace: SwitchUiWorkspace
  workspaces: SwitchWorkspaces
  sessions: SwitchSessions
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
  // through the public faces; the call contract and its 2026-10-02 regression
  // live in `openDefaultWorkspaceFor`.
  const openDefaultWorkspace = openDefaultWorkspaceFor(deps, showToast)
  const host: SwitchHost = {
    setAgent(label) { state.setAgent(label) },
    readPersistedSelection() {
      // The Task-3 storage patch prefixes the ACTIVE label's namespace at
      // call time — the landing reads long after setAgent, so this read
      // lands in the target world's `'<label>:dsh.sessions.current'`.
      const storage = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage
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
let pendingWait: ReadinessWaiter | undefined

/**
 * The Hub switch surfaces' entry point. Attempts the in-page switch for
 * `label`, gated on the target world's readiness (C1): a not-ready world
 * holds the UI on native with starting feedback and a bounded poll; a
 * failed world reports and never switches; a ready/native/unknown target
 * runs the machine (whose roster probe stays the fallback). A not-ready
 * FEDERATED row skips all of that — an immediate machine-error toast
 * (I1(c), `machine-down`), never a wait loop.
 *
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
  // A newer attempt supersedes any pending readiness wait.
  pendingWait?.cancel()
  pendingWait = undefined
  void (async () => {
    let row: PreFlightRow | undefined
    try {
      row = (await fetchRoster()).find((agent) => agent.key === label)
    } catch { row = undefined }
    const decision = decidePreFlight(label, row)
    if (decision === 'failed') {
      showToast(`Super D: ${label} failed to start — see the service log.`)
      return
    }
    // I1(c): a degraded FEDERATED row fails fast — the hub's own probe
    // already knows the machine is unreachable/auth-expired, so "starting…"
    // plus the 120s wait would be a lie. Actionable toast, no wait loop, no
    // revert (the page stays where it is, like the failed branch).
    if (decision === 'machine-down') {
      if (row !== undefined) reportMachineDown(label, row)
      return
    }

    if (decision === 'wait') {
      showToast(`Super D: ${label} is starting…`)
      const waiter = createReadinessWaiter({
        fetchRow: async () => {
          try { return (await fetchRoster()).find((agent) => agent.key === label) } catch { return undefined }
        },
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
      })
      pendingWait = waiter
      const outcome = await waiter.wait(label)
      if (pendingWait === waiter) pendingWait = undefined
      if (outcome === 'ready') {
        void run(label).catch(() => { /* the machine resolves, never rejects */ })
        return
      }
      if (outcome === 'failed') showToast(`Super D: ${label} failed to start — see the service log.`)
      else if (outcome === 'bound') showToast(`Super D: ${label} is still starting — try again in a moment.`)
      // 'cancelled': a newer attempt owns the page — silence.
      return
    }
    void run(label).catch(() => { /* the machine resolves, never rejects */ })
  })()
  return true
}
