/**
 * Switch orchestration core (native UI fusion, plan Task 4) — the pure logic
 * behind the in-page agent switch: storage-namespace key computation, the
 * session landing decision over the persisted `dsh.sessions.current`
 * selection, the RuntimeSeat click-interception decision (a fusion page never
 * navigates on a left click — spec: 融合页 = state 切换，拦截 click，无导航),
 * and the fallback state machine (timeout or roster-probe failure
 * → revert to native + a visible toast, never a page lock).
 *
 * Host-half on purpose: plain TS with every effect injected through
 * {@link SwitchHost} — no DOM, no client imports — so `test/client-switch.test.mjs`
 * imports it from `dist/` like every other host module. The client half
 * (`src/client/switch.ts`) builds the real host face from the client context:
 * the `__SUPERD_UI_STATE__` atom (Task 3), `ctx.connection`,
 * `ctx.uiWorkspace`, the Task-3 namespaced `Storage`, the control-plane
 * roster fetch, and a minimal self-owned toast overlay.
 *
 * Orchestration sequence (spec §3.5 as amended 2026-09-26, T-A erratum;
 * user rulings 7/8):
 *   1. `setAgent(label)` — state + NS swap immediately; subsequent requests
 *      demux to the target world (Task 3's call-time patches read the atom).
 *   2. Session landing, split by the target NS's `dsh.sessions.current`:
 *      a navigable value is opened through the uiWorkspace face right away —
 *      session-targeted navigation resolves no workspace id, so it is
 *      correct against the retargeted plane before reconnect (the clean
 *      round-4 acceptance behavior). Anything else lands on new chat, but
 *      only once the target plane's wire-derived caches are fresh (see 3):
 *      upstream `startSession()` resolves `currentWorkspaceId ?? recent`
 *      from those caches (navigation.ts:223-238), and a pre-reconnect
 *      resolution reads the PREVIOUS plane's data → `workspace/not-found`
 *      toast + the view pinned to the dead previous session id (the
 *      2026-09-26 live-acceptance defect). The chat area is never cleared
 *      and no loading skeleton is inserted: old content stays in place
 *      awaiting the landing.
 *   3. `reconnect()` — the generation re-opens against the retargeted data
 *      plane; the gateway emits `connection/reset` on establishment, the
 *      designed "wire-derived caches must repull" signal, so sessions /
 *      config / theme re-derive on their own. Upstream's one-shot boot
 *      restore (`watchNavigation`'s `initial` flag) does not re-run after a
 *      reset, so this landing is the switch's only navigation authority.
 *      The deferred new-chat landing fires when the repull has LANDED — the
 *      first post-establishment baseline replacement in the workspace store
 *      ({@link observeCachesRefreshed}) — at which point `startSession()`
 *      resolves the target agent's own workspace exactly like the native
 *      new-chat button would on that plane.
 *   4. Fallback: no generation within {@link SWITCH_FALLBACK_MS}, or a failed
 *      roster probe → `setAgent('native')` + `reconnect()` back to the native
 *      plane + toast. A revert also cancels a pending new-chat landing — a
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
 *   - `uiWorkspace.openSession(target)` / `startSession()` — the navigation
 *     face (`packages/client/ui-workspace/src/client/navigation.ts:34-92`);
 *     `SessionTarget = SessionId | SubagentAddress`
 *     (`packages/api/session-controller/src/client/contract/sessions.ts:22`).
 *   - `startSession()`'s workspace resolution — `workspaceId ??
 *     currentWorkspaceId ?? recent` over the wire-derived `workspaces.list`
 *     / `sessions.list` snapshots (`navigation.ts:223-238`); the workspace
 *     store installs fresh data only through its follow-stream baseline
 *     (`packages/api/workspace-controller/src/client/model.ts`
 *     `replaceBaseline` → `installViews`, a new items array every install).
 *   - `dsh.sessions.current` — the per-tab last-selection store
 *     (`navigation.ts:130-131`); its restore reads `subagentAddress` first,
 *     then `sessionId` (`navigation.ts:319-330`) — {@link parseLandingTarget}
 *     keeps that precedence. The store hydrates once at page boot and
 *     persists on write (`packages/client/store/src/index.ts:155-174`), so
 *     the post-switch read must go through the namespaced `Storage` (Task 3
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
 * The landing decision over one raw persisted-selection read.
 *
 * A value is navigable when it parses to a ui-workspace `MainSelection`
 * carrying a usable `SessionTarget`: a non-null `subagentAddress` object
 * wins (upstream restore order), else a non-empty string `sessionId`.
 * Everything else — no value, a read failure (surfaced here as `null`), a
 * parse failure, an unusable shape — lands on new chat.
 *
 * @returns the exact `uiWorkspace.openSession` argument, or `null` for the
 *   new-chat (blank session) landing.
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

/** The structural face of the workspace projection store (upstream `ctx.workspaces.list`). */
export interface NavigationCacheFace {
  /** Read the current snapshot: the items array identity is the freshness token. */
  getSnapshot(): { items: readonly unknown[]; phase: unknown }
  /** Subscribe to snapshot invalidation; the returned disposer stops it. */
  subscribe(listener: () => void): () => void
}

/** The structural face of the connection generation observable. */
export interface GenerationFace {
  /** The live generation, or `undefined` while no attempt has succeeded. */
  getSnapshot(): unknown
  /** Subscribe to generation changes; the returned disposer stops it. */
  subscribe(listener: () => void): () => void
}

/**
 * The caches-fresh gate behind the deferred new-chat landing: fires
 * `listener` exactly once, when the navigation caches demonstrably hold the
 * TARGET plane's data.
 *
 * The freshness token is the snapshot's `items` ARRAY IDENTITY: upstream's
 * workspace model mints a new array on every baseline install
 * (`installViews` → `[...installed.values()]`, model.ts:398) while carrier
 * churn (`handleCarrierFailure`) keeps the reference. The gate arms at the
 * first generation establishment OBSERVED BY ITS OWN subscription — the
 * anchor is retaken there, and nothing before that point can pass, so the
 * dying old plane's last increments racing the reconnect are absorbed; the
 * first replacement after establishment is the target plane's baseline. The
 * `phase === 'ready'` check rides along as a guard against a page whose
 * first baseline never arrived.
 *
 * Establishment strictly precedes any target-plane baseline (the follow
 * streams re-open on top of the established generation), so this single
 * edge implies both "generation established" and "repull landed" — the two
 * preconditions of a correct `startSession()` resolution.
 *
 * Host-half pure logic: the client binding composes it with the real
 * `ctx.workspaces.list` store and the connection generation observable; the
 * machine consumes it through {@link SwitchHost.onCachesRefreshed}.
 *
 * @returns the disposer stopping both subscriptions.
 */
export function observeCachesRefreshed(
  list: NavigationCacheFace,
  generation: GenerationFace,
  listener: () => void,
): () => void {
  let anchor = list.getSnapshot().items
  // Establishment is an event, not a level: a live OLD generation at arming
  // time must not open the gate to that plane's churn. Monotonic — a later
  // generation loss mints no arrays, a re-establishment retakes the anchor.
  let established = false
  const disposeGeneration = generation.subscribe(() => {
    if (generation.getSnapshot() === undefined) return
    established = true
    anchor = list.getSnapshot().items
  })
  const disposeList = list.subscribe(() => {
    if (!established) return
    const snapshot = list.getSnapshot()
    if (snapshot.phase === 'ready' && snapshot.items !== anchor) listener()
  })
  return () => {
    disposeList()
    disposeGeneration()
  }
}

/** The decision one roster-entry left click produces in the RuntimeSeat. */
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
   * The switch attempt (the seat's `attemptSwitch`). Invoked exactly when
   * `fusion && !active`; its return value is recorded but can never re-open
   * navigation — an unbound orchestration swallows the click instead of
   * abandoning the fused page (review round 1).
   */
  attempt: () => boolean
}

/**
 * The RuntimeSeat's click-interception contract as a pure table.
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
 * `dist/`; the seat maps `preventDefault` onto the DOM event.
 */
export function seatClickDecision(input: SeatClickInput): SeatClickDecision {
  if (!input.fusion) return { preventDefault: false, attempted: false }
  if (input.active) return { preventDefault: true, attempted: false }
  const attempted = input.attempt() === true
  return { preventDefault: true, attempted }
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
   * Read the active NS's persisted `dsh.sessions.current` raw value. A read
   * failure may be reported either by throwing or by returning `null` — both
   * land on new chat.
   */
  readPersistedSelection(): string | null
  /** Navigate the main view to a parsed landing target (step 2, session case). */
  openSession(target: string | object): void
  /** Navigate the main view to a new chat / blank session (step 2, fallback). */
  openNewChat(): void
  /**
   * Observe the target plane's wire-derived navigation caches being replaced
   * after the switch began — the post-`connection/reset` repull landing its
   * baseline. The all-clear for the deferred new-chat landing: only then is
   * upstream's `startSession()` workspace resolution guaranteed to read the
   * target agent's data instead of the previous agent's. The listener must
   * fire at most once per subscription; the returned disposer stops it.
   */
  onCachesRefreshed(listener: () => void): () => void
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
}

/** The produced orchestration interface (brief: `switchAgent(label): Promise<void>`). */
export interface SwitchController {
  /**
   * Run the full switch lifecycle for `label`: state swap, landing,
   * reconnect, then settle on generation establishment or revert on the
   * fallback. Resolves when the attempt ends — a revert is a handled
   * outcome, not a rejection. A new run supersedes a pending one (cancelled
   * silently, no revert).
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
  /** Kill a pending deferred landing; idempotent, safe before/after firing. */
  cancelLanding(): void
}

/**
 * Build the switch machine over an injected {@link SwitchHost}.
 *
 * Only one attempt is ever armed at a time: starting a new switch finishes
 * the previous one silently (timer cleared, subscription released, promise
 * resolved) and cancels its pending landing, so a stale attempt can never
 * revert or land over a newer switch.
 */
export function createSwitchController(host: SwitchHost, options: SwitchOptions = {}): SwitchController {
  const fallbackMs = options.fallbackMs ?? SWITCH_FALLBACK_MS
  let current: AttemptState | undefined

  return {
    run(label: string): Promise<void> {
      const prior = current
      return new Promise<void>((resolve) => {
        let timer: unknown
        let disposer: () => void = () => {}
        let disposeLanding: () => void = () => {}
        const attempt: AttemptState = {
          finished: false,
          dead: false,
          cancelLanding(): void {
            attempt.dead = true
            disposeLanding()
            disposeLanding = () => {}
          },
          /** The one exit: disarm, release, resolve — a revert only adds effects first. */
          finish(): void {
            if (attempt.finished) return
            attempt.finished = true
            host.clearTimeout(timer)
            disposer()
            if (current === attempt) current = undefined
            resolve()
          },
        }
        // A superseded attempt finishes silently: no revert, no toast, no
        // deferred landing — the newer switch owns the page from here.
        if (prior !== undefined) {
          prior.cancelLanding()
          if (!prior.finished) prior.finish()
        }
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
        // Step 2: land. The pointer case navigates immediately —
        // session-targeted, no workspace resolution, correct before
        // reconnect (round 4). The new-chat case DEFERS: upstream
        // `startSession()` would resolve a workspace from caches still
        // holding the previous agent's plane (the T-A defect); it fires
        // once the target plane's caches are fresh (armed below).
        let raw: string | null = null
        try {
          raw = host.readPersistedSelection()
        } catch {
          raw = null
        }
        const target = parseLandingTarget(raw)
        let deferNewChat = true
        if (target !== null) {
          try {
            host.openSession(target)
            deferNewChat = false
          } catch {
            deferNewChat = true // degrade to the deferred blank landing
          }
        }
        // Step 3: replace the generation attempt against the retargeted plane.
        try {
          host.reconnect()
        } catch { /* fallback below still applies */ }
        // Step 4: the fallback race — generation establishment settles, the
        // timer and the roster probe revert.
        timer = host.setTimeout(() => { revert('timeout') }, fallbackMs)
        disposer = host.onGenerationEstablished(() => {
          if (attempt.finished || current !== attempt) return
          attempt.finish()
        })
        // The deferred new-chat landing. Deliberately NOT released by
        // `finish()`: the baseline lands after the generation, so the
        // landing must survive the settle; a revert or a supersede kills it
        // via `cancelLanding()`. Fires at most once.
        if (deferNewChat) {
          disposeLanding = host.onCachesRefreshed(() => {
            if (attempt.dead) return
            disposeLanding()
            disposeLanding = () => {}
            try {
              host.openNewChat()
            } catch { /* landing never throws */ }
          })
        }
        void host.probeTarget(label).then(
          (alive) => { if (alive !== true) revert('probe') },
          () => { revert('probe') },
        )
      })
    },
  }
}
