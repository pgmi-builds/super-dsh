import * as React from 'react'
import { currentMountPath, fetchRoster, NATIVE_LINK, rosterFromGlobal, type AgentLink } from './roster.js'

/**
 * The app-level agent selector (`sidebar.footer.action`, just above Settings).
 *
 * AW-B URL scheme: each runtime owns a mount path, so this seat needs exactly
 * one fact — which paths exist — and renders pure navigation. Picking an agent
 * assigns its path; the browser then loads that world's own page. There is no
 * server-side selection value, no POST, and no data-plane swap: two tabs on two
 * agents can never step on each other.
 *
 * The roster is baked into the index by the hub (native index and every mounted
 * world). The read-only `/api/agent-runtime` face is only a fallback for a page
 * that somehow rendered without the row.
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
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const here = currentMountPath()
  const active = agents.find((agent) => agent.path === here) ?? NATIVE_LINK

  // The mount path IS the selection: a roster entry navigates to that world's
  // URL. Nothing is reset (no storage, no reload) — the new page boots its own
  // tree, which owns everything from that point on.


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
        title="Agent runtime — picking one opens that runtime's mount (/omp/, /codex/, …)"
        onClick={() => { setOpen((v) => !v) }}
      >
        {wide
          ? (<>
            <span aria-hidden>⌘</span>
            <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Agent · {active.label}
            </span>
            <span style={styleBadge}>open</span>
          </>)
          : (<span aria-hidden>⌘</span>)}
      </button>
      {open && (
        <div style={styleMenu}>
          {agents.map((agent) => (
            // A real hyperlink: the URL is the state, so the browser owns
            // navigation (middle-click, new tab, copy link all work) and no
            // script runs on the way out.
            <a
              key={agent.key}
              href={agent.path}
              style={{ ...styleItem(agent.path === here), textDecoration: 'none' }}
              aria-current={agent.path === here ? 'page' : undefined}
              onClick={() => { setOpen(false) }}
            >
              {agent.path === here ? `${agent.label} ✓` : agent.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
