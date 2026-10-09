import React from 'react'
import {callCompanion} from './companion-api.js'
import type {BetterDashStatus} from '../companion-contract.js'

/** Native plugin switches remain in Plugin Manager; this row provides explicit recovery. */
export function CompanionSettings() {
  const [status, setStatus] = React.useState<BetterDashStatus>()
  const [error, setError] = React.useState<string>()
  const [busy, setBusy] = React.useState(false)
  const live = React.useRef(false)
  const operation = React.useRef(false)

  React.useEffect(() => {
    live.current = true
    let reading = false
    const refresh = async () => {
      if (reading || operation.current) return
      reading = true
      try {
        const next = await callCompanion('getBetterDash')
        if (live.current) {setStatus(next); setError(next.error)}
      } catch (cause) {if (live.current) setError(cause instanceof Error ? cause.message : String(cause))}
      finally {reading = false}
    }
    void refresh()
    const timer = window.setInterval(() => {void refresh()}, 5000)
    return () => {live.current = false; window.clearInterval(timer)}
  }, [])

  const install = async () => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError(undefined)
    try {
      const next = await callCompanion('installBetterDash')
      if (live.current) {setStatus(next); setError(next.error)}
    } catch (cause) {if (live.current) setError(cause instanceof Error ? cause.message : String(cause))}
    finally {operation.current = false; if (live.current) setBusy(false)}
  }
  const installing = busy || status?.installing === true
  const label = status === undefined ? 'Loading…' : status.installed
    ? `Installed${status.version ? ' · ' + status.version : ''}${status.enabled === false ? ' · Disabled' : ''}`
    : 'Not installed'
  return (
    <div style={{borderRadius: 12, padding: '12px 14px', background: 'var(--dsw-alias-interactive-bg-hover)'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
        <div style={{flex: 1}}>
          <div style={{fontSize: 14, fontWeight: 600}}>Better Dash</div>
          <div role="status" style={{fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4}}>
            {installing ? 'Installing…' : label}
          </div>
        </div>
        <button type="button" disabled={installing || status?.installed === true}
          onClick={() => {void install()}} style={{padding: '6px 12px', borderRadius: 8, cursor: installing || status?.installed ? 'default' : 'pointer'}}>
          {installing ? 'Installing…' : status?.installed ? 'Installed' : 'Install'}
        </button>
      </div>
      {error && <p role="alert" style={{fontSize: 12, margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary)'}}>{error}</p>}
    </div>
  )
}
