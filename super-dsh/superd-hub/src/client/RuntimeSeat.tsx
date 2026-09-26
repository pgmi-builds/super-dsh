import * as React from 'react'
import { currentMountPath, fetchRoster, NATIVE_LINK, rosterFromGlobal, type AgentLink } from './roster.js'
import { attemptSwitch, fusionPage, uiState } from './switch.js'
import { seatClickDecision } from '../switch-core.js'

/**
 * The app-level agent selector (`sidebar.footer.action`, just above Settings).
 *
 * AW-B URL scheme: each runtime owns a mount path, so this seat needs exactly
 * one fact — which paths exist — and renders pure navigation. Picking an agent
 * assigns its path; the browser then loads that world's own page. There is no
 * server-side selection value, no POST, and no data-plane swap: two tabs on two
 * agents can never step on each other.
 *
 * Fusion branch (native UI fusion, plan Task 4): on a page carrying the baked
 * `__SUPERD_UI_FUSION__` global (the ctx0 index when the gate is on), the seat
 * intercepts agent clicks and runs the switchAgent orchestration instead —
 * state switch in place, NO navigation; the active label comes from the
 * `__SUPERD_UI_STATE__` atom, not the URL. On every other page (each world's
 * own index, and ctx0 with the gate off) the flag global is absent, the branch
 * stays dormant, and the real hyperlinks are untouched (spec §5 双半边).
 *
 * The roster is baked into the index by the hub (native index and every mounted
 * world). The read-only `/api/agent-runtime` face is only a fallback for a page
 * that somehow rendered without the row — and in fusion mode it doubles as the
 * switch's control-plane probe (never rewritten).
 *
 * Props: the sidebar's owner share ({@link wide} column state).
 */

interface RuntimeSeatProps {
  /** Sidebar column state: expanded (true) or collapsed rail (false). */
  wide: boolean
}

export function RuntimeSeat({ wide }: RuntimeSeatProps): React.JSX.Element | null {
  const [agents, setAgents] = React.useState<AgentLink[]>(() => rosterFromGlobal() ?? [NATIVE_LINK])
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  // Baked before app boot and never mutated afterwards: per-page constant.
  const fusion = fusionPage()
  const [activeKey, setActiveKey] = React.useState<string>(
    () => (fusion ? (uiState()?.activeAgent ?? NATIVE_LINK.key) : NATIVE_LINK.key),
  )

  React.useEffect(() => {
    // The hub is asked every time: the baked global only seeds the first paint
    // (a world page's baked copy can be stale), the wire answer is authoritative.
    let cancelled = false
    fetchRoster()
      .then((list) => { if (!cancelled) setAgents(list) })
      .catch(() => { /* keep the last known list; the footer must never throw */ })
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    if (!fusion) return
    const state = uiState()
    if (state === undefined) return
    // The atom is the fusion selection: follow every switch (including one
    // issued from another surface or a revert of a failed attempt).
    return state.subscribe((label) => { setActiveKey(label) })
  }, [fusion])

  React.useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const here = currentMountPath()
  const isActive = (agent: AgentLink): boolean =>
    fusion ? agent.key === activeKey : agent.path === here
  const active = agents.find(isActive) ?? NATIVE_LINK

  // Non-fusion: the mount path IS the selection — a roster entry navigates to
  // that world's URL, the browser owns navigation, no script runs on the way
  // out. Fusion: the same `<a>` rows stay (middle-click / copy link keep
  // working), but EVERY left click is intercepted (review round 1 — the
  // active entry included) — state switch, never navigation; the href only
  // survives as the world-page arm and for opening a world page in a new tab.

  const styleBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: wide ? '7px 10px' : '7px 0',
    justifyContent: wide ? 'flex-start' : 'center',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
    position: 'relative',
  }
  const styleBadge: React.CSSProperties = {
    fontSize: 10,
    lineHeight: 1.4,
    padding: '1px 6px',
    borderRadius: 999,
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
    whiteSpace: 'nowrap',
  }
  const styleMenu: React.CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 6,
    right: 6,
    zIndex: 40,
    background: 'var(--dsh-surface, #26262b)',
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,.35)',
    overflow: 'hidden',
  }
  const styleItem = (isActive: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    background: isActive ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  })

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        style={styleBase}
        title={fusion
          ? 'Agent runtime — picking one switches this page to that runtime in place (no navigation)'
          : 'Agent runtime — picking one opens that runtime\'s mount (/omp/, /codex/, …)'}
        onClick={() => { setOpen((v) => !v) }}
      >
        {wide
          ? (<>
            <span aria-hidden>⌘</span>
            <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Agent · {active.label}
            </span>
            <span style={styleBadge}>{fusion ? 'switch' : 'open'}</span>
          </>)
          : (<span aria-hidden>⌘</span>)}
      </button>
      {open && (
        <div style={styleMenu}>
          {agents.map((agent) => (
            // A real hyperlink: on world pages the URL is the state and the
            // browser owns navigation. On a fusion page every left click is
            // intercepted — NO navigation, the active entry included (that
            // attempt is a no-op, but the click must still never fall through
            // to the anchor: an `href="/"` reload would discard the in-page
            // switch state, a foreign href would abandon the fused page;
            // review round 1). With the orchestration unbound the click is
            // swallowed, not navigated — the decision table lives in
            // `seatClickDecision` (switch-core), pinned by client-switch tests.
            <a
              key={agent.key}
              href={agent.path}
              style={{ ...styleItem(isActive(agent)), textDecoration: 'none' }}
              aria-current={isActive(agent) ? 'page' : undefined}
              onClick={(event) => {
                const decision = seatClickDecision({
                  fusion,
                  active: isActive(agent),
                  attempt: () => attemptSwitch(agent.key),
                })
                if (decision.preventDefault) event.preventDefault()
                setOpen(false)
              }}
            >
              {isActive(agent) ? `${agent.label} ✓` : agent.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
