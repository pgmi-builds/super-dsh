/**
 * Switch orchestration core (native UI fusion, plan Task 4) — the pure logic
 * behind the in-page agent switch: storage-namespace key computation, the
 * session landing decision over the persisted `dsh.sessions.current`
 * selection, the agent-selector click-interception decision (a fusion page
 * never navigates on a left click — spec: 融合页 = state 切换，拦截 click，无导航;
 * T-B: consumed by the Hub UI surfaces, the sole switch surface since the
 * RuntimeSeat retirement), and the fallback state machine (timeout or
 * roster-probe failure → revert to native + a visible toast, never a page
 * lock).
 *
 * Host-half on purpose: plain TS with every effect injected through
 * {@link SwitchHost} — no DOM, no client imports — so `test/client-switch.test.mjs`
 * imports it from `dist/` like every other host module. The client half
 * (`src/client/switch.ts`) builds the real host face from the client context:
 * the `__SUPERD_UI_STATE__` atom (Task 3), `ctx.connection`,
 * `ctx.uiWorkspace`, the Task-3 namespaced `Storage`, the control-plane
 * roster fetch, and a minimal self-owned toast overlay.
 *
 * Orchestration sequence (spec §3.5 as amended 2026-09-26, T-A + T-F
 * errata; user rulings 7/8 and the T-F ruling "按原生的语义去理解…把这个
 * last visit session 也做一下"):
 *   1. `setAgent(label)` — state + NS swap immediately; subsequent requests
 *      demux to the target world (Task 3's call-time patches read the atom).
 *   2. `reconnect()` — the generation re-opens against the retargeted data
 *      plane; the gateway emits `connection/reset` on establishment, the
 *      designed "wire-derived caches must repull" signal, so sessions /
 *      config / theme re-derive on their own. Nothing navigates before the
 *      repull: the chat area is never cleared and no loading skeleton is
 *      inserted — old content stays in place awaiting the landing.
 *   3. Session landing (T-F: NATIVE restore semantics) — upstream's
 *      fresh-load restore is `watchNavigation`/`restoreSelection`
 *      (navigation.ts:284-347): it fires only when BOTH `workspaces.list`
 *      and `sessions.list` reached phase `'ready'`, and then walks
 *      `saved.subagentAddress` → `saved.sessionId` looked up in the FRESH
 *      `sessions.byId` (stale-proof) → recent-workspace → the fresh-boot
 *      default workspace. The landing replicates exactly that: it fires once
 *      when BOTH wire-derived caches have installed fresh post-establishment
 *      baselines ({@link observeCachesRefreshed} — the T-A gate watched
 *      `workspaces.list` alone, so a plane whose sessions list landed later
 *      served stale rows to the decision and broke native's own
 *      last-visited restore; T-G additionally holds the gate while a
 *      persisted pointer has not yet joined the freshly minted INCREMENTAL
 *      sessions list — membership via `byId` — firing on membership or on
 *      the quiet-window ladder, {@link LANDING_QUIET_MS}, so partial-list
 *      first edges stop laddering every switch into a brand-new session),
 *      then reads the target NS's persisted
 *      `dsh.sessions.current` (the NS swap has long since happened) and
 *      executes {@link planRestoreLanding}'s precedence through the public
 *      faces. The landing is BOUNDED: if the baselines never install within
 *      one further fallback window after the settle, a staleness watchdog
 *      disarms it — an armed landing never outlives its switch by more than
 *      that window (the safe direction: no landing at all beats a late
 *      surprise navigation).
 *   4. Fallback: no generation within {@link SWITCH_FALLBACK_MS}, or a failed
 *      roster probe → `setAgent('native')` + `reconnect()` back to the native
 *      plane + toast. A revert also cancels a pending landing — a
 *      reverted switch never lands.
 *
 * Upstream anchors (dsh-v0.1.7-rc.1):
 *   - `ctx.connection.reconnect()` — `packages/client/connection/src/client/index.ts`
 *     `ConnectionHandle.reconnect` (declared :148, wired :264-266); the
 *     controller resets retry progression and replaces the current attempt
 *     immediately (`connection.ts:113-121`).
 *   - `connection/reset` — emitted by the gateway client on every generation
 *     establishment (`packages/api/gateway/src/client/index.ts:169`),
 *     declared as the repull signal
 *     (`packages/client/connection/src/client/index.ts:9-17`).
 *   - `uiWorkspace.openSession(target)` / `startSession(workspaceId?)` /
 *     `openWorkspace(workspaceId)` — the navigation face
 *     (`packages/client/ui-workspace/src/client/navigation.ts:34-92`);
 *     `SessionTarget = SessionId | SubagentAddress`
 *     (`packages/api/session-controller/src/client/contract/sessions.ts:22`).
 *   - `watchNavigation` / `restoreSelection` — the fresh-load restore this
 *     landing replicates (`navigation.ts:284-347`): both-lists ready gate
 *     (:292), `subagentAddress` first (:320-323), the fresh-`byId` session
 *     lookup with the blank-reuse nuance (:324-335), `recentWorkspace`
 *     fallback (:337, the tie-break at :434-453), and
 *     `initializeDefaultWorkspace` on a fresh boot (:338-342, :349-361).
 *   - `startSession()`'s workspace resolution — `workspaceId ??
 *     currentWorkspaceId ?? recent` over the wire-derived `workspaces.list`
 *     / `sessions.list` snapshots (`navigation.ts:223-238`); `connectWorkspace`
 *     → `reuseOrCreateBlank` reuses the pointer's own blank whenever the
 *     private restore path would (:179-198).
 *   - The wire-derived stores: `workspaces.list` installs fresh data only
 *     through its follow-stream baseline (`packages/api/workspace-controller/src/client/model.ts`
 *     `replaceBaseline` → `installViews`, a new items array every install);
 *     `sessions.list` is projected with a fresh `ids` array on every manager
 *     change (`packages/api/session-controller/src/client/sessions/service.ts:607-677`)
 *     — array identity is the freshness token for both.
 *   - `dsh.sessions.current` — the per-tab last-selection store
 *     (`navigation.ts:130-131`); its restore reads `subagentAddress` first,
 *     then `sessionId` (`navigation.ts:319-330`) — {@link parseLandingTarget}
 *     keeps that precedence. The store hydrates once at page boot and
 *     persists on write (`packages/client/store/src/index.ts:155-174`), so
 *     the landing read must go through the namespaced `Storage` (Task 3
 *     patch 5), which prefixes `'<label>:'` at call time.
 *
 * @module @pgmi-builds/superd-hub/switch-core
 */

/** The active-agent label meaning the native (ctx0) data plane. */
export const NATIVE_AGENT = 'native'

/** The persisted last-selection key ui-workspace owns (survey §2.6). */
export const SESSIONS_CURRENT_KEY = 'dsh.sessions.current'

/**
 * The fallback window: how long a switch may wait for the target world's
 * generation (mux re-open + repull) before reverting to native. A
 * human-scale constant; Task 5's config face may expose it later.
 */
export const SWITCH_FALLBACK_MS = 10_000

/**
 * The membership-wait quiet window (T-G): after both navigation caches are
 * fresh, a persisted pointer the sessions list has not shown yet holds the
 * landing gate — the list is minted INCREMENTALLY post-reconnect (upstream
 * `handleSessionAdded` applies one session at a time, each application
 * re-projecting the store with a fresh `ids` array, service.ts:677), so the
 * first fresh edge sees a partial `byId` that legitimately lacks the
 * pointer's session. The gate fires on membership; while the pointer is
 * still absent, this window of list SILENCE (no `ids` identity change) is
 * the concession point: the gate fires anyway and the plan takes the ladder
 * — an honest miss, because a stored blank pointer legitimately never
 * appears (matching upstream's own boot restore of a stale/absent id). An
 * identity change during the window restarts it (the list is still growing).
 * The machine's post-settle staleness watchdog remains the hard bound on
 * the whole wait.
 */
export const LANDING_QUIET_MS = 600

/**
 * The storage namespace for an active agent: native prefixes nothing
 * (byte-identical to stock behavior), a foreign agent owns `'<label>:'`.
 * Mirrors Task 3's storage patch (`ns()` in fusion-transport).
 */
export function storageNamespace(label: string): string {
  return typeof label === 'string' && label !== '' && label !== NATIVE_AGENT ? `${label}:` : ''
}

/** The full storage key for `key` while `label` is the active agent. */
export function namespacedKey(label: string, key: string): string {
  return `${storageNamespace(label)}${key}`
}

/**
 * The persisted-selection parse feeding {@link planRestoreLanding}.
 *
 * A value is navigable when it parses to a ui-workspace `MainSelection`
 * carrying a usable `SessionTarget`: a non-null `subagentAddress` object
 * wins (upstream restore order), else a non-empty string `sessionId`.
 * Everything else — no value, a read failure (surfaced here as `null`), a
 * parse failure, an unusable shape — parses to `null` and the plan falls to
 * the recent-workspace / default-workspace ladder.
 *
 * @returns the subagent address object, the session id string, or `null`.
 */
export function parseLandingTarget(raw: string | null | undefined): string | object | null {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const selection = parsed as { sessionId?: unknown; subagentAddress?: unknown }
  if (selection.subagentAddress !== undefined && selection.subagentAddress !== null
    && typeof selection.subagentAddress === 'object') {
    return selection.subagentAddress
  }
  if (typeof selection.sessionId === 'string' && selection.sessionId !== '') return selection.sessionId
  return null
}

/** Structural slice of one `workspaces.list` row the landing plan reads. */
export interface RestoreWorkspaceView {
  readonly workspaceId: string
  readonly sessionIds: readonly string[]
  readonly createdAt?: string
}

/** Structural slice of one `sessions.list` `byId` row the landing plan reads. */
export interface RestoreSessionSummary {
  readonly id: string
  readonly blank?: boolean
  readonly updatedAt?: number
}

/**
 * The FRESH wire-derived navigation caches the landing decides over —
 * upstream `restoreSelection` receives exactly these two snapshots once both
 * phases are ready (navigation.ts:290-292, :318). The structural slices keep
 * this module host-half: the client binding projects the real
 * `ctx.workspaces.list` / `ctx.sessions.list` snapshots into it.
 */
export interface RestoreCaches {
  readonly workspaces: {
    readonly items: readonly RestoreWorkspaceView[]
    readonly phase: unknown
  }
  readonly sessions: {
    readonly ids: readonly string[]
    readonly byId: Readonly<Record<string, RestoreSessionSummary>>
    readonly phase: unknown
  }
}

/** One landing action, in upstream `restoreSelection`'s order of outcomes. */
export type RestoreLandingPlan =
  | { kind: 'open-session'; target: string | object }
  /**
   * The new-session flow through the public `uiWorkspace.startSession` face:
   * with a workspace id it connects THAT workspace (its `reuseOrCreateBlank`
   * reuses the pointer's own blank exactly when upstream's private
   * `reuseBlank` pre-check would pass); `undefined` inherits the
   * current-then-recent resolution.
   */
  | { kind: 'start-session'; workspaceId?: string }
  /** Upstream's `initializeDefaultWorkspace`: the fresh-boot empty-plane case. */
  | { kind: 'default-workspace' }

/**
 * The most-recent workspace per upstream `recentWorkspace`
 * (navigation.ts:434-453): the latest member-session `updatedAt` wins, a
 * workspace with no listed sessions falls back to its `createdAt`.
 */
function recentWorkspaceId(
  items: RestoreCaches['workspaces']['items'],
  byId: RestoreCaches['sessions']['byId'],
): string | undefined {
  let selected: string | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of items) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = byId[sessionId]
      if (session !== undefined && typeof session.updatedAt === 'number') {
        latest = Math.max(latest, session.updatedAt)
      }
    }
    if (latest === Number.NEGATIVE_INFINITY && workspace.createdAt !== undefined) {
      latest = Date.parse(workspace.createdAt)
    }
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

/**
 * The landing decision with NATIVE restore semantics (T-F): replicate
 * upstream `restoreSelection` (navigation.ts:318-347) against the fresh
 * caches and the parsed persisted selection ({@link parseLandingTarget}'s
 * result, which already applies the `subagentAddress`-first precedence).
 *
 *   - `subagentAddress` → open it directly, no cache consultation
 *     (navigation.ts:320-323).
 *   - `sessionId` found in the FRESH `byId`: non-blank — or blank but
 *     workspace-less — opens the id (navigation.ts:324-329); blank with a
 *     workspace resolves to that workspace (navigation.ts:333-335's private
 *     `reuseBlank` + :337's `workspace.workspaceId` target — the public
 *     `startSession(workspaceId)` face covers both: its `connectWorkspace`
 *     → `reuseOrCreateBlank` reuses the pointer's own blank whenever the
 *     private pre-check would pass, because the eligibility scan is the
 *     same).
 *   - A stale id (absent from the fresh `byId`) falls through to the
 *     no-pointer ladder exactly as upstream's `summary === undefined` does.
 *   - No pointer / stale pointer: the recent workspace gets the new-session
 *     flow (navigation.ts:337); both lists empty is the fresh boot and
 *     mirrors `initializeDefaultWorkspace` (navigation.ts:338-342).
 *   - `caches` unavailable (the host's read failed) → `undefined`: land
 *     nothing — no landing beats a wrong one. Same for the degenerate
 *     zero-workspaces-with-sessions shape, where upstream simply leaves the
 *     view as it is (no target, both-empty guard false, :337-342).
 *
 * @param parsed - the persisted-selection parse ({@link parseLandingTarget}).
 * @param caches - the fresh both-lists snapshots, or `undefined` unreadable.
 * @returns the action to execute, or `undefined` to land nothing.
 */
export function planRestoreLanding(
  parsed: string | object | null,
  caches: RestoreCaches | undefined,
): RestoreLandingPlan | undefined {
  if (caches === undefined) return undefined
  if (parsed !== null && typeof parsed === 'object') {
    return { kind: 'open-session', target: parsed }
  }
  if (typeof parsed === 'string' && parsed !== '') {
    const summary = caches.sessions.byId[parsed]
    if (summary !== undefined) {
      const workspace = caches.workspaces.items.find(
        (item) => item.sessionIds.includes(parsed),
      )
      if (summary.blank !== true || workspace === undefined) {
        return { kind: 'open-session', target: parsed }
      }
      return { kind: 'start-session', workspaceId: workspace.workspaceId }
    }
  }
  const target = recentWorkspaceId(caches.workspaces.items, caches.sessions.byId)
  if (target !== undefined) return { kind: 'start-session', workspaceId: target }
  if (caches.workspaces.items.length === 0 && caches.sessions.ids.length === 0) {
    return { kind: 'default-workspace' }
  }
  return undefined
}

/** The structural face of one wire-derived list store (workspaces or sessions). */
export interface NavigationCacheFace {
  /**
   * Read the current snapshot: the `items` ARRAY IDENTITY is the freshness
   * token. For `workspaces.list` this is the snapshot's items array; for
   * `sessions.list` the client binding adapts the projection's `ids` array
   * (a fresh array is minted on every projection — service.ts:607-677).
   */
  getSnapshot(): { items: readonly unknown[]; phase: unknown }
  /** Subscribe to snapshot invalidation; the returned disposer stops it. */
  subscribe(listener: () => void): () => void
  /**
   * T-G membership face: does the store's CURRENT snapshot contain `id` as
   * a listed session? The client binding answers from the sessions
   * projection's `byId` (the same face upstream's boot restore resolves the
   * pointer against, navigation.ts:324) — NOT from `ids`, and deliberately
   * not from a stale copy: `byId` can gain a row without a new `ids`
   * identity (publishRetention re-sets `byId` alone, service.ts:565), so
   * the face must read the live snapshot at call time. Optional; without
   * it the gate can never observe membership and the quiet window becomes
   * the pointer's only concession point (the watchdog still bounds it).
   */
  contains?(id: string): boolean
}

/** The structural face of the connection generation observable. */
export interface GenerationFace {
  /** The live generation, or `undefined` while no attempt has succeeded. */
  getSnapshot(): unknown
  /** Subscribe to generation changes; the returned disposer stops it. */
  subscribe(listener: () => void): () => void
}

/**
 * What the membership-aware gate needs beyond the two lists (T-G), all
 * injected so this module stays host-half pure. Every field is optional:
 * an absent/empty options object restores the T-F gate verbatim (fire on
 * the first fresh edge of both lists — the no-pointer fresh-boot path).
 */
export interface LandingGateOptions {
  /**
   * Read the landing pointer's plain session id at DECISION time — on every
   * gate check, not once at arming. `undefined` means no navigable pointer
   * OR a subagent-address pointer (which opens directly, upstream
   * navigation.ts:320-323, and needs no cache consultation): either way the
   * gate falls back to the T-F first-fresh-edge behavior. A throwing read
   * is an honest `undefined` (the machine's own landing read treats a
   * storage failure as `null` → the same ladder).
   */
  pointerSessionId?(): string | undefined
  /** The quiet window in ms; defaults to {@link LANDING_QUIET_MS}. */
  quietMs?: number
  /** Timer injection for the quiet window (the SwitchHost faces in practice). */
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

/**
 * The caches-fresh gate behind the deferred landing (T-F; T-G made it
 * pointer-membership-aware): fires `listener` AT MOST once, when BOTH
 * navigation caches demonstrably hold the TARGET plane's data — the
 * client-face equivalent of upstream's both-lists ready gate
 * (`watchNavigation`, navigation.ts:292: `workspace.phase !== 'ready'
 * || sessions.phase !== 'ready'` → return).
 *
 * The freshness token is each snapshot's `items` ARRAY IDENTITY: upstream's
 * workspace model mints a new array on every baseline install
 * (`installViews` → `[...installed.values()]`, model.ts:398) and the session
 * list projection mints a fresh `ids` array on every manager change
 * (service.ts:607-677), while carrier churn keeps references. The gate arms
 * at the first generation establishment OBSERVED BY ITS OWN subscription —
 * the anchors are retaken there, and nothing before that point can pass, so
 * the dying old plane's last increments racing the reconnect are absorbed;
 * the first replacements after establishment are the target plane's
 * baselines. The `phase === 'ready'` checks ride along as a guard against a
 * page whose first baseline never arrived. Both edges are tracked
 * independently, in either arrival order (the T-A gap: watching workspaces
 * alone let a late sessions baseline leave the pointer lookup reading stale
 * `byId` rows).
 *
 * T-G — the pointer holds the gate. The sessions list is minted
 * INCREMENTALLY after the reconnect (one `handleSessionAdded` per session,
 * each re-projecting the store with a fresh `ids` array), so the first fresh
 * edge sees a partial `byId` that legitimately lacks the pointer's session;
 * consuming the landing there laddered every switch into a brand-new
 * session (the browser-proven defect). When a pointer exists (the injected
 * {@link LandingGateOptions.pointerSessionId} face, read at decision time),
 * the gate therefore does NOT fire on the first fresh edge. It fires when:
 *   - the sessions list CONTAINS the pointer's session — the membership
 *     face (`byId`, consulted on EVERY sessions notification: `byId` can
 *     gain a row without a new `ids` identity, service.ts:565), or
 *   - the sessions list has gone QUIET — no `ids` identity change for the
 *     configured quiet window ({@link LANDING_QUIET_MS}; an identity change
 *     during the window restarts it) while the pointer is still absent:
 *     the honest miss, firing with the ladder exactly like upstream's boot
 *     restore of a stored id its fresh list does not know.
 * No pointer → the first fresh edge fires, byte-identical to T-F (the
 * fresh-boot path). The machine's post-settle staleness watchdog bounds the
 * whole membership wait: it disposes this gate, which also cancels a
 * running quiet window.
 *
 * Establishment strictly precedes any target-plane baseline (the follow
 * streams re-open on top of the established generation), so a fire implies
 * both "generation established" and "repull landed" — the two preconditions
 * of a correct landing resolution.
 *
 * Host-half pure logic: the client binding composes it with the real
 * `ctx.workspaces.list` + `ctx.sessions.list` stores and the connection
 * generation observable; the machine consumes it through
 * {@link SwitchHost.onCachesRefreshed}.
 *
 * @returns the disposer stopping all three subscriptions (and the quiet window).
 */
export function observeCachesRefreshed(
  workspaces: NavigationCacheFace,
  sessions: NavigationCacheFace,
  generation: GenerationFace,
  listener: () => void,
  gate: LandingGateOptions = {},
): () => void {
  // Establishment is an event, not a level: a live OLD generation at arming
  // time must not open the gate to that plane's churn. Monotonic — a later
  // generation loss mints no arrays, a re-establishment retakes the anchors.
  let established = false
  // At most once per subscription — the SwitchHost contract. (The machine
  // also disposes its gate at fire time; this flag makes the factory honest
  // on its own.)
  let fired = false
  let workspacesAnchor = workspaces.getSnapshot().items
  let sessionsAnchor = sessions.getSnapshot().items
  let workspacesFresh = false
  let sessionsFresh = false
  // The quiet window's live handle, `undefined` while not holding.
  let quietTimer: unknown
  const quietMs = gate.quietMs ?? LANDING_QUIET_MS
  const clearQuiet = (): void => {
    if (quietTimer === undefined) return
    if (gate.clearTimeout !== undefined) gate.clearTimeout(quietTimer)
    quietTimer = undefined
  }
  const fire = (): void => {
    if (fired) return
    fired = true
    clearQuiet()
    listener()
  }
  const pointerSessionId = (): string | undefined => {
    try {
      return gate.pointerSessionId?.()
    } catch {
      return undefined // a pointer read failure is the no-pointer path (same ladder)
    }
  }
  /**
   * The decision point, run on every workspaces/sessions notification once
   * establishment happened. `sessionsIdentityChanged` distinguishes a real
   * list growth (restarts the quiet window) from a same-identity
   * notification like publishRetention's byId-only set (consults
   * membership, must NOT restart the window).
   */
  const check = (sessionsIdentityChanged: boolean): void => {
    if (fired || !established || !workspacesFresh || !sessionsFresh) return
    const pointer = pointerSessionId()
    if (pointer === undefined) {
      fire() // no pointer: the T-F first-fresh-edge behavior (fresh-boot path)
      return
    }
    if (sessions.contains?.(pointer)) {
      fire() // membership: the pointer's session has arrived in the fresh list
      return
    }
    // Holding: the pointer has not shown up in the (possibly still growing)
    // list. A real identity change restarts the window; so does arriving
    // here with no window running (the first hold).
    if (sessionsIdentityChanged || quietTimer === undefined) {
      clearQuiet()
      if (gate.setTimeout !== undefined) {
        quietTimer = gate.setTimeout(() => {
          quietTimer = undefined
          fire() // quiet + still no membership → the honest miss (the ladder)
        }, quietMs)
      }
      // Without a timer face the hold is membership-only; the machine's
      // watchdog remains the bound (it disposes this gate).
    }
  }
  const disposeGeneration = generation.subscribe(() => {
    if (generation.getSnapshot() === undefined) return
    established = true
    workspacesFresh = false
    sessionsFresh = false
    clearQuiet() // a re-establishment re-anchors: the old window's silence says nothing now
    workspacesAnchor = workspaces.getSnapshot().items
    sessionsAnchor = sessions.getSnapshot().items
  })
  const disposeWorkspaces = workspaces.subscribe(() => {
    if (!established) return
    const snapshot = workspaces.getSnapshot()
    if (snapshot.phase === 'ready' && snapshot.items !== workspacesAnchor) workspacesFresh = true
    check(false)
  })
  const disposeSessions = sessions.subscribe(() => {
    if (!established) return
    const snapshot = sessions.getSnapshot()
    let identityChanged = false
    if (snapshot.phase === 'ready' && snapshot.items !== sessionsAnchor) {
      sessionsFresh = true
      identityChanged = true
      // Retake the anchor so the NEXT same-reference notification is not
      // mistaken for growth (quiet-window restart discipline).
      sessionsAnchor = snapshot.items
    }
    check(identityChanged)
  })
  return () => {
    clearQuiet()
    disposeWorkspaces()
    disposeSessions()
    disposeGeneration()
  }
}

/** The decision one roster-entry left click produces in the agent selector. */
export interface SeatClickDecision {
  /**
   * `true` = the anchor's default action must be prevented: a fusion page
   * never navigates on a left click (the href survives only for middle-click
   * / open-in-new-tab / copy link). `false` = the world-page arm — the URL is
   * the state and the browser owns navigation, byte-identical to stock.
   */
  preventDefault: boolean
  /** Whether the switch orchestration was invoked for the clicked entry. */
  attempted: boolean
}

/** The inputs of one seat click: the page mode, the entry, the attempt. */
export interface SeatClickInput {
  /** The page carries the baked `__SUPERD_UI_FUSION__` flag global. */
  fusion: boolean
  /** The clicked roster entry is the currently active agent. */
  active: boolean
  /**
   * The switch attempt (`attemptSwitch`). Invoked exactly when
   * `fusion && !active`; its return value is recorded but can never re-open
   * navigation — an unbound orchestration swallows the click instead of
   * abandoning the fused page (review round 1).
   */
  attempt: () => boolean
}

/**
 * The agent-selector click-interception contract as a pure table (native UI
 * fusion; originally landed for the sidebar-bottom RuntimeSeat, which T-B
 * retired — the Hub UI surfaces (HubPage rows + the HubPanelIcon chevron
 * menu) are now the sole switch surface and consume this SAME table, so the
 * contract below is inherited verbatim).
 *
 *   - World page (`fusion: false`): no interception, no orchestration — the
 *     real hyperlink navigates (spec §5 双半边).
 *   - Fusion page, active entry: intercepted, no attempt — switching to the
 *     active agent is a no-op, and the click must never fall through to the
 *     anchor (an `href="/"` reload would discard the in-page switch state; a
 *     foreign `href` would abandon the fused page entirely).
 *   - Fusion page, inactive entry: intercepted and the attempt runs. The
 *     attempt's `false` (orchestration unbound) still keeps the page: a
 *     swallowed click beats silent navigation away from the fusion surface.
 *
 * Host-half pure logic so `test/client-switch.test.mjs` pins the table from
 * `dist/`; the Hub surfaces map `preventDefault` onto the DOM event.
 */
export function seatClickDecision(input: SeatClickInput): SeatClickDecision {
  if (!input.fusion) return { preventDefault: false, attempted: false }
  if (input.active) return { preventDefault: true, attempted: false }
  const attempted = input.attempt() === true
  return { preventDefault: true, attempted }
}

/** The inputs of one Hub UI roster row's active indication. */
export interface HubRowActiveInput {
  /** The page carries the baked `__SUPERD_UI_FUSION__` flag global. */
  fusion: boolean
  /** The row's roster key (`'native'` or a runtime key). */
  agentKey: string
  /** The row's mount path. */
  agentPath: string
  /** The page atom's active agent (fusion pages; absent otherwise). */
  activeAgent?: string
  /** The page's normalized mount path (world pages). */
  mountPath: string
}

/**
 * Which Hub UI roster row shows as the active agent (T-B: the Hub surfaces —
 * HubPage rows and the HubPanelIcon chevron menu — are the sole switch
 * surface after the RuntimeSeat retirement).
 *
 *   - Fusion page: the page atom's `activeAgent` — the switch state — decides
 *     by roster key; the URL is irrelevant on a fused page. The `native`
 *     entry participates like any other key.
 *   - Non-fusion page (flag off; the UI's navigation arm is retired since
 *     T-C): the mount path is the selection — the entry whose path equals
 *     the page's normalized mount. The pure arm survives as contract; no
 *     served page can hit the foreign case anymore.
 *
 * Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
 */
export function hubRowActive(input: HubRowActiveInput): boolean {
  if (input.fusion) return input.agentKey === input.activeAgent
  return input.agentPath === input.mountPath
}

/** The degradation hint a Hub UI surface shows while the flag is off (T-E). */
export const FUSION_OFF_HINT = 'fusion off — no foreign entry'

/** What one Hub UI surface renders as its switch affordance (T-E closeout). */
export interface SwitchAffordance {
  /** Whether the in-place switch affordance may render at all. */
  available: boolean
  /** The degradation hint; non-empty exactly when {@link available} is false. */
  hint: string
}

/**
 * The flag-off shape of the Hub UI switch surfaces (path-separation Part 2
 * T-E closeout). With the per-label URL family retired (T-C) and the world
 * web UIs disabled (T-D), a flag-OFF ctx0 page has NO foreign entry at all —
 * and since T-C the Hub UI ships no hyperlinks either, so the smallest honest
 * rendering is an inert roster with a visible degradation hint instead of a
 * silently dead control:
 *
 *   - `available: true` (fusion page): the affordance renders — the HubPage
 *     `switch` action and the HubPanelIcon chevron menu.
 *   - `available: false` (flag off): the affordance is NOT rendered; the
 *     roster stays informational and the surface shows the degradation hint
 *     ({@link FUSION_OFF_HINT}) once (HubPage: a single chip under the
 *     section head, not one per row). Nothing navigates — there is
 *     nothing to navigate to.
 *
 * Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
 */
export function switchAffordance(fusion: boolean): SwitchAffordance {
  return fusion ? { available: true, hint: '' } : { available: false, hint: FUSION_OFF_HINT }
}

/**
 * Structural slice of one roster row the Hub UI helpers read (the client
 * roster's `AgentLink` shape mirrored structurally — this module never imports
 * from the client half).
 */
export interface HubRosterRow {
  /** The roster key (`'native'` or a runtime key). */
  readonly key: string
  /** The display label the roster projected for the key. */
  readonly label: string
  /** The row's mount path. */
  readonly path: string
  /**
   * Machine the runtime comes from (mesh P2): `'local'` for this machine's
   * rows, the owning machine's m4 for federated rows. Optional — the wire
   * may omit it and the grouping now lives client-side (mesh-groups.ts,
   * fed the machines API's label map).
   */
  readonly machine?: string
}

/**
 * The active agent's display name for the Hub row's right-edge selector: the
 * roster label of the atom's `activeAgent` key — the name the selector's
 * `title` carries, since the row label itself is the constant `Hub`. A key the
 * (seeded) roster does not know degrades to the raw key. `undefined`/empty
 * (flag off, or no atom read) means "no active agent".
 *
 * Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
 */
export function activeAgentName(activeAgent: string | undefined, roster: readonly HubRosterRow[]): string | undefined {
  if (activeAgent === undefined || activeAgent === '') return undefined
  return roster.find((row) => row.key === activeAgent)?.label ?? activeAgent
}

/**
 * What the machine hands the host's gate composition (T-G): the machine-side
 * ingredients of {@link LandingGateOptions}. Structurally a full
 * `LandingGateOptions` — the binding passes it straight through after adding
 * its own membership face on the sessions store.
 */
export interface LandingGateRequest {
  /**
   * The persisted pointer's plain session id, read at DECISION time through
   * this host's {@link readPersistedSelection} + {@link parseLandingTarget}
   * — the same storage face and precedence the landing callback itself uses
   * at fire time. `undefined` for no pointer or a subagent-address pointer.
   */
  pointerSessionId(): string | undefined
  /** The quiet window ({@link SwitchOptions.quietWindowMs} ?? {@link LANDING_QUIET_MS}). */
  quietMs: number
  /** This host's timer faces, so the quiet window is drivable in tests. */
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * The effects the switch machine needs, all injected. Every method used by
 * the guarded steps ({@link setAgent}, the landing reads/writes,
 * {@link reconnect}, {@link toast}) may throw; the machine contains the
 * damage — a broken effect degrades its own step, never the orchestration
 * and never the page. Timer and generation-subscription arming are the
 * wiring's own faces (host `setTimeout`, the connection's generation
 * observable) and are used directly.
 */
export interface SwitchHost {
  /** Swap the state atom (+ NS) to `label` — orchestration step 1. */
  setAgent(label: string): void
  /**
   * Read the active NS's persisted `dsh.sessions.current` raw value. The
   * machine reads it at LANDING time — inside the both-lists gate callback,
   * long after the NS swap, exactly where upstream `restoreSelection` reads
   * its hydrated selection store relative to its ready gate. A read failure
   * may be reported either by throwing or by returning `null`.
   */
  readPersistedSelection(): string | null
  /** Navigate the main view to a parsed landing target (open-session plan). */
  openSession(target: string | object): void
  /**
   * Run the new-session flow (the public `uiWorkspace.startSession` face):
   * with a workspace id the flow targets that workspace (blank reuse
   * included); without, the inherited current-then-recent resolution —
   * which on a fresh, plane-consistent cache set IS the recent-workspace
   * ladder. Executed for the start-session plan.
   */
  startSession(workspaceId?: string): void
  /**
   * Mirror upstream `initializeDefaultWorkspace` (navigation.ts:349-361)
   * through the public faces: prepare the default workspace and open it.
   * Executed for the default-workspace plan. Asynchronous upstream; a
   * failure is feedback, never a revert.
   */
  openDefaultWorkspace(): void
  /**
   * Read the target plane's fresh navigation caches — the `workspaces.list`
   * and `sessions.list` snapshots the landing plan decides over. The both-
   * lists gate has already fired, so both phases are ready; a read failure
   * may throw (a failed read lands nothing).
   */
  readRestoreCaches(): RestoreCaches
  /**
   * Observe the target plane's wire-derived navigation caches being replaced
   * after the switch began — BOTH stores' post-`connection/reset` repull
   * baselines landed (workspaces and sessions, either order), AND — T-G —
   * when the landing pointer exists, the sessions list contains its session
   * or has gone quiet for {@link LandingGateRequest.quietMs}. The all-clear
   * for the landing: only then do the snapshots hold the target agent's data
   * and upstream's resolution faces read the target plane. The listener must
   * fire at most once per subscription; the returned disposer stops it (and
   * any running quiet window).
   *
   * The `gate` request carries what the MACHINE owns — the pointer face
   * (over this host's {@link readPersistedSelection}), the quiet window from
   * {@link SwitchOptions.quietWindowMs}, and this host's own timers — so the
   * binding can compose the membership-aware {@link observeCachesRefreshed}
   * by adding only its membership face (`sessions.list` `byId`).
   */
  onCachesRefreshed(listener: () => void, gate: LandingGateRequest): () => void
  /** Replace the connection attempt immediately (step 3, and the revert). */
  reconnect(): void
  /**
   * Observe generation establishment (post-`connection/reset`). The listener
   * fires whenever a generation exists again; the returned disposer stops it.
   */
  onGenerationEstablished(listener: () => void): () => void
  /**
   * The roster probe: resolve `true` while `label` is still a live roster
   * entry on the control plane. Reject or resolve `false` = probe failure.
   */
  probeTarget(label: string): Promise<boolean>
  /** One visible toast/message; the revert's user feedback. */
  toast(message: string): void
  /** Timers, injected so tests drive time by hand. */
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Options; every field optional. */
export interface SwitchOptions {
  /** Fallback window in ms; defaults to {@link SWITCH_FALLBACK_MS}. */
  fallbackMs?: number
  /**
   * T-G: the landing gate's membership-wait quiet window in ms; defaults to
   * {@link LANDING_QUIET_MS}. Ridden through {@link LandingGateRequest} to
   * the gate the binding composes.
   */
  quietWindowMs?: number
}

/** The produced orchestration interface (brief: `switchAgent(label): Promise<void>`). */
export interface SwitchController {
  /**
   * Run the full switch lifecycle for `label`: state swap, landing,
   * reconnect, then settle on generation establishment or revert on the
   * fallback. Resolves when the attempt ends — a revert is a handled
   * outcome, not a rejection. A new run supersedes any prior attempt —
   * pending or already settled — silently (cancelled, no revert) and kills
   * its still-armed deferred landing through the controller-scope handle,
   * so a settled switch can never land over a newer one.
   */
  run(label: string): Promise<void>
}

/**
 * One run's control block. `finished` governs the settle/fallback lifetime;
 * `dead` governs the landing lifetime — a reverted or superseded attempt
 * never lands, even when the settle already happened and the deferred
 * landing is still pending (the landing intentionally outlives the settle:
 * the target plane's baseline arrives after the generation).
 */
interface AttemptState {
  finished: boolean
  dead: boolean
  /** Disarm the fallback, release the settle subscription, resolve. */
  finish(): void
  /**
   * Kill a pending deferred landing (subscription + staleness watchdog);
   * idempotent, safe before/after firing.
   */
  cancelLanding(): void
}

/**
 * Build the switch machine over an injected {@link SwitchHost}.
 *
 * Only one attempt is ever armed at a time: starting a new switch finishes
 * the previous one silently (timer cleared, subscription released, promise
 * resolved) and cancels its pending landing, so a stale attempt can never
 * revert or land over a newer switch. The landing cancel is held at
 * CONTROLLER scope, not reached through the current-attempt pointer: the
 * deferred landing deliberately survives the settle — which removes the
 * attempt from `current` — so a supersede must still kill the armed landing
 * of a PRIOR, ALREADY-SETTLED attempt (final-review round 2: without the
 * controller-scope handle, a settled switch's landing fired over the newer
 * switch's pointer-restored view).
 */
export function createSwitchController(host: SwitchHost, options: SwitchOptions = {}): SwitchController {
  const fallbackMs = options.fallbackMs ?? SWITCH_FALLBACK_MS
  const quietWindowMs = options.quietWindowMs ?? LANDING_QUIET_MS
  let current: AttemptState | undefined
  // The cancel closure of the latest attempt's still-armed deferred landing,
  // surviving that attempt's settle. Every subsequent run() disarms it first
  // (and clears it the moment the landing fires), whatever state the arming
  // attempt is in.
  let armedLanding: (() => void) | undefined

  return {
    run(label: string): Promise<void> {
      const prior = current
      return new Promise<void>((resolve) => {
        let timer: unknown
        // The landing staleness watchdog: armed at settle while the landing
        // is still pending; one more fallback window later the landing is
        // disarmed. A baseline that never installs must not leave a landing
        // armed forever — a much-later unrelated cache replacement would
        // otherwise fire a surprise blank chat long after the switch.
        let watchdog: unknown
        let disposer: () => void = () => {}
        let disposeLanding: () => void = () => {}
        let landingArmed = false
        const cancelWatchdog = (): void => {
          if (watchdog === undefined) return
          host.clearTimeout(watchdog)
          watchdog = undefined
        }
        const attempt: AttemptState = {
          finished: false,
          dead: false,
          cancelLanding(): void {
            attempt.dead = true
            landingArmed = false
            disposeLanding()
            disposeLanding = () => {}
            cancelWatchdog()
          },
          /** The one exit: disarm, release, resolve — a revert only adds effects first. */
          finish(): void {
            if (attempt.finished) return
            attempt.finished = true
            host.clearTimeout(timer)
            disposer()
            if (current === attempt) current = undefined
            // The landing survives the settle — but not indefinitely: while
            // still pending, bound it to one more fallback window.
            if (landingArmed) watchdog = host.setTimeout(() => { attempt.cancelLanding() }, fallbackMs)
            resolve()
          },
        }
        // Supersede, landing first: the previous attempt's still-armed
        // deferred landing dies through the controller-scope handle —
        // INCLUDING a settled attempt, which is already out of `current`
        // (the landing outlives the settle by design). The newer switch owns
        // the page from here; a stale landing must never fire over it.
        if (armedLanding !== undefined) {
          const cancelPriorLanding = armedLanding
          armedLanding = undefined
          cancelPriorLanding()
        }
        if (prior !== undefined && !prior.finished) prior.finish()
        current = attempt
        const revert = (reason: 'timeout' | 'probe'): void => {
          if (attempt.finished || current !== attempt) return
          attempt.cancelLanding()
          try {
            host.setAgent(NATIVE_AGENT)
          } catch { /* keep going: the fallback must land the page somewhere */ }
          try {
            host.reconnect()
          } catch { /* the native plane's own recovery loop stays in charge */ }
          try {
            host.toast(`Super D: switch to ${label} failed (${reason === 'timeout' ? 'no response' : 'target not reachable'}) — back to native.`)
          } catch { /* feedback is best-effort */ }
          attempt.finish()
        }
        // Step 1: state + NS swap — subsequent requests demux to `label`.
        try {
          host.setAgent(label)
        } catch { /* the atom face is guarded; landing still reads the old NS */ }
        // Step 2: replace the generation attempt against the retargeted plane.
        // Nothing navigates here (T-F): every landing — the pointer included —
        // defers to the both-lists gate, because native restore semantics
        // resolve ONLY against fresh, plane-consistent data (the pre-reconnect
        // pointer landing read stale sessions and broke native's own
        // last-visited restore).
        try {
          host.reconnect()
        } catch { /* fallback below still applies */ }
        // Step 3: the fallback race — generation establishment settles, the
        // timer and the roster probe revert.
        timer = host.setTimeout(() => { revert('timeout') }, fallbackMs)
        disposer = host.onGenerationEstablished(() => {
          if (attempt.finished || current !== attempt) return
          attempt.finish()
        })
        // The landing (T-F): NATIVE restore semantics. Fires once BOTH
        // wire-derived caches are fresh, then reads the target NS's persisted
        // selection (the NS swap happened in step 1; the active agent only
        // changes again on a revert, which kills this landing first) and
        // executes the restoreSelection precedence through the public faces.
        // Deliberately NOT released by `finish()`: the baselines land after
        // the generation, so the landing must survive the settle; a revert
        // kills it directly and a supersede kills it through the
        // controller-scope handle (a settled attempt included — see the
        // run() preamble). Fires at most once; the settle arms the staleness
        // watchdog that disarms it if the baselines never install.
        landingArmed = true
        const cancelThisLanding = (): void => { attempt.cancelLanding() }
        armedLanding = cancelThisLanding
        // T-G: the machine's side of the membership-aware gate. The pointer
        // face reads the SAME persisted-selection source the landing callback
        // below reads at fire time — at gate DECISION time the NS swap has
        // long since happened (step 1 precedes the reconnect), and the active
        // agent only changes again on a revert/supersede, both of which kill
        // this landing before the read could go stale. A throwing read is
        // `undefined`: the no-pointer path, the same ladder a failed read
        // reaches through the callback's own guard.
        const gateRequest: LandingGateRequest = {
          pointerSessionId: () => {
            let parsed: string | object | null
            try {
              parsed = parseLandingTarget(host.readPersistedSelection())
            } catch {
              return undefined
            }
            return typeof parsed === 'string' && parsed !== '' ? parsed : undefined
          },
          quietMs: quietWindowMs,
          setTimeout: (fn, ms) => host.setTimeout(fn, ms),
          clearTimeout: (handle) => host.clearTimeout(handle),
        }
        disposeLanding = host.onCachesRefreshed(() => {
          if (attempt.dead) return
          if (armedLanding === cancelThisLanding) armedLanding = undefined
          landingArmed = false
          cancelWatchdog()
          disposeLanding()
          disposeLanding = () => {}
          let caches: RestoreCaches | undefined
          try {
            caches = host.readRestoreCaches()
          } catch {
            caches = undefined // unreadable caches land nothing (safe direction)
          }
          let raw: string | null = null
          try {
            raw = host.readPersistedSelection()
          } catch {
            raw = null
          }
          const plan = planRestoreLanding(parseLandingTarget(raw), caches)
          if (plan === undefined) return
          try {
            if (plan.kind === 'open-session') host.openSession(plan.target)
            else if (plan.kind === 'start-session') host.startSession(plan.workspaceId)
            else host.openDefaultWorkspace()
          } catch { /* landing never throws */ }
        }, gateRequest)
        void host.probeTarget(label).then(
          (alive) => { if (alive !== true) revert('probe') },
          () => { revert('probe') },
        )
      })
    },
  }
}

// ---- C1: the switch pre-flight (readiness gate) ----------------------------
//
// The roster lists a world from mount registration — before its data plane
// answers. attemptSwitch therefore consults the row BEFORE running the
// machine: a not-ready world holds the UI on native with "starting…"
// feedback and polls; a failed world reports and never switches; a ready
// (or unknown/native) row runs the machine unchanged (the machine's own
// probe stays the fallback for roster misses).

/** What attemptSwitch does with a roster row: run the machine / report failure / wait for readiness. */
export type PreFlightDecision = 'run' | 'failed' | 'wait'

/** The roster fields the pre-flight reads (the projection carries both since C1 task 3). */
export interface PreFlightRow {
  ready?: boolean
  failed?: boolean
}

/**
 * The pure pre-flight decision. `native` always runs; an absent row (roster
 * fetch failed, or the key is not listed) also runs — the machine's roster
 * probe is the authority on unknown targets, exactly as before C1.
 */
export function decidePreFlight(label: string, row: PreFlightRow | undefined): PreFlightDecision {
  if (label === NATIVE_AGENT) return 'run'
  if (row === undefined) return 'run'
  if (row.failed === true) return 'failed'
  if (row.ready !== true) return 'wait'
  return 'run'
}

/** Default bound on one readiness wait (the page never locks behind a stuck world). */
export const WAIT_BOUND_MS = 120_000
/** Default poll interval for one readiness wait. */
export const WAIT_POLL_MS = 1_000

/** The waiter's injected faces (tests drive time and the roster by hand). */
export interface ReadinessWaiterFaces {
  /** Read the target's roster row; undefined on any failure. */
  fetchRow(): Promise<PreFlightRow | undefined>
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** One bounded readiness wait. */
export interface ReadinessWaiter {
  /** Resolves when the row flips ready ('ready'), reports failure ('failed'), the bound expires ('bound'), or the waiter is cancelled ('cancelled'). */
  wait(label: string): Promise<'ready' | 'failed' | 'bound' | 'cancelled'>
  /** A newer switch attempt cancels a pending wait (it resolves 'cancelled'). */
  cancel(): void
}

/**
 * Build a bounded readiness waiter over injected faces. The poll re-reads
 * the roster row every {@link ReadinessWaiterOptions.pollMs}; `failed`
 * short-circuits immediately; the bound always terminates the wait.
 */
export function createReadinessWaiter(faces: ReadinessWaiterFaces, options: { boundMs?: number; pollMs?: number } = {}): ReadinessWaiter {
  const boundMs = options.boundMs ?? WAIT_BOUND_MS
  const pollMs = options.pollMs ?? WAIT_POLL_MS
  let pending: ((outcome: 'ready' | 'failed' | 'bound' | 'cancelled') => void) | undefined
  let pollHandle: unknown
  let boundHandle: unknown
  let settled = false
  const settle = (outcome: 'ready' | 'failed' | 'bound' | 'cancelled'): void => {
    if (settled) return
    settled = true
    if (pollHandle !== undefined) faces.clearTimeout(pollHandle)
    if (boundHandle !== undefined) faces.clearTimeout(boundHandle)
    pending?.(outcome)
    pending = undefined
  }
  return {
    wait(label: string): Promise<'ready' | 'failed' | 'bound' | 'cancelled'> {
      return new Promise((resolve) => {
        pending = resolve
        boundHandle = faces.setTimeout(() => { settle('bound') }, boundMs)
        const tick = (): void => {
          if (settled) return
          void faces.fetchRow().then(
            (row) => {
              if (settled) return
              if (row?.failed === true) { settle('failed'); return }
              if (row?.ready === true) { settle('ready'); return }
              pollHandle = faces.setTimeout(tick, pollMs)
            },
            () => { if (!settled) pollHandle = faces.setTimeout(tick, pollMs) },
          )
        }
        tick()
      })
    },
    cancel(): void { settle('cancelled') },
  }
}
