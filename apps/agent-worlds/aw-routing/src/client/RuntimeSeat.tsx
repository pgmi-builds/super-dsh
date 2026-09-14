import * as React from 'react'

/**
 * The app-level runtime selector seat (`sidebar.footer.action`, just above
 * the Settings row). Shows the ACTIVE runtime for the whole app and lets
 * the user switch it: a POST to the routing host's `/api/agent-runtime`
 * face writes the one selector value; the client then reloads the world —
 * every surface (session list, model catalog, settings, composer) is a pure
 * projection of the newly selected runtime.
 *
 * Props: the sidebar's owner share ({@link wide} column state).
 */

interface RuntimeSeatProps {
  /** Sidebar column state: expanded (true) or collapsed rail (false). */
  wide: boolean
}

interface AgentRuntimeState {
  runtime: string
  available: string[]
}

const RUNTIME_LABELS: Record<string, string> = {
  native: 'Native (DSH)',
  omp: 'OMP (SDK)',
}

function label(key: string): string {
  return RUNTIME_LABELS[key] ?? key
}

export function RuntimeSeat({ wide }: RuntimeSeatProps): React.JSX.Element | null {
  const [state, setState] = React.useState<AgentRuntimeState>({ runtime: 'native', available: ['native'] })
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetch('/api/agent-runtime', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { runtime?: unknown; available?: unknown }) => {
        if (cancelled) return
        if (typeof j?.runtime === 'string') {
          setState({
            runtime: j.runtime,
            available: Array.isArray(j.available) ? j.available.filter((k): k is string => typeof k === 'string') : ['native'],
          })
        }
      })
      .catch(() => { /* keep last known; footer must never throw the shell */ })
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

  const pick = (key: string): void => {
    if (key === state.runtime || busy) return
    setBusy(true)
    setOpen(false)
    setError(undefined)
    fetch('/api/agent-runtime', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: key }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { runtime?: unknown }) => {
        if (typeof j?.runtime === 'string') {
          setState((prev) => ({ ...prev, runtime: j.runtime as string }))
          // Runtime switch accepted: rebuild the whole client. The UI is a
          // pure projection of the selected runtime — a React re-render
          // alone would repaint stale elements with the previous world's
          // data; a full root re-mount re-fetches every surface fresh from
          // the newly selected upstream.
          // Runtime switch accepted: rebuild the whole client. The UI is a
          // pure projection of the selected runtime — a React re-render
          // alone would repaint stale elements with the previous world's
          // data; a full root re-mount re-fetches every surface fresh from
          // the newly selected upstream. localStorage is a client-side
          // manifest cache (workspace trees, projections); wiping it on a
          // world switch prevents the previous world's cached manifests
          // from bleeding into the new one — every surface re-fetches and
          // self-heals after the reload. (Auth is cookie-based, not stored
          // in localStorage, so the browser session survives the wipe.)
          try { window.localStorage.clear() } catch { /* storage unavailable */ }
          setTimeout(() => { window.location.reload() }, 150)
        }
      })
      .catch((e: unknown) => { setError(String(e)) })
      .finally(() => { setBusy(false) })
  }

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
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.6 : 1,
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
  const styleItem = (active: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    background: active ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
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
        title="agent runtime — the one app-level selector; switching swaps the whole data plane"
        onClick={() => { setOpen((v) => !v) }}
      >
        {wide
          ? (<>
              <span aria-hidden>⌘</span>
              <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Agent · {state.runtime}
              </span>
              <span style={styleBadge}>switch</span>
            </>)
          : (<span aria-hidden title={`Agent · ${state.runtime}`}>⌘{state.runtime.slice(0, 1).toUpperCase()}</span>)}
      </button>
      {error !== undefined && wide
        ? (<div style={{ fontSize: 11, padding: '0 10px', opacity: 0.7 }}>{error}</div>)
        : null}
      {open
        ? (<div style={styleMenu} role="menu">
            {state.available.map((key) => (
              <button key={key} type="button" role="menuitem" style={styleItem(key === state.runtime)} onClick={() => { pick(key) }}>
                {label(key)}{key === state.runtime ? ' ✓' : ''}
              </button>
            ))}
          </div>)
        : null}
    </div>
  )
}
