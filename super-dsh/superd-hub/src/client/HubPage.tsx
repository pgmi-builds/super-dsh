import * as React from 'react'
import { HubGlyph } from './glyph.js'
import { RuntimeMark } from './runtime-icons.js'
import { currentMountPath, fetchRoster, NATIVE_LINK, rosterFromGlobal, type AgentLink } from './roster.js'
import { freshMachineId, loadMachines, saveMachines, type HubMachine } from './machines-store.js'
import { attemptSwitch, fusionPage, uiState } from './switch.js'
import { hubRowActive, seatClickDecision, switchAffordance } from '../switch-core.js'

/**
 * The Hub main panel (`main`, key `hub`): the hub-functionality home page.
 * The hub is this tool as a whole; machines are the sources of agent
 * runtimes. Home lists the machines with the add-machine form, then the
 * agent-adapter roster the hub currently bridges. Machines are the UI-first
 * half of the concept — the client-side ledger owns them until the pairing
 * backend lands; the adapter list is the live `/api/agent-runtime` roster.
 *
 * Switch surface (T-B, switch-only since T-C): the Agent Runtimes rows are
 * the agent selector. Every row click runs the `seatClickDecision` table —
 * intercepted, in-place `switchAgent`, NO navigation ever; the active row
 * tracks the `__SUPERD_UI_STATE__` atom. There is no non-fusion navigation
 * arm: the per-label URL family is retired (path-separation T-C — `/hub` is
 * the sole entry), so a row never links anywhere. Flag off (T-E): the switch
 * affordance does not render at all — rows stay informational and carry the
 * degradation hint chip, never a dead control (`switchAffordance`).
 *
 * @module superd-hub/client/HubPage
 */

/** The add-machine form's editable fields. */
interface AddDraft {
  readonly name: string
  readonly url: string
}

const EMPTY_DRAFT: AddDraft = { name: '', url: '' }

/** Chip text: drop the trailing slash for concision ('/claude/' → '/claude'). */
function displayPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** Shared chip look (status pills, path tags). */
const chip: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.4,
  padding: '2px 7px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
  background: 'color-mix(in srgb, currentColor 10%, transparent)',
}

const chipSelf: React.CSSProperties = {
  ...chip,
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
  color: 'var(--dsw-alias-state-success-primary)',
}

const chipPending: React.CSSProperties = {
  ...chip,
  color: 'var(--dsw-alias-label-caption)',
}

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l3)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 11,
  color: 'var(--dsw-alias-label-caption)',
}

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

/** A row that lights its surface on hover (inline styles have no :hover). */
function HoverRow({ children, onClick, clickable }: {
  children: React.ReactNode
  /** Row-level click handler (the fusion switch wiring; absent on world pages). */
  onClick?: (event: React.MouseEvent) => void
  /** Pointer cursor while the row is a switch target. */
  clickable?: boolean
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false)
  return (
    <li
      onClick={onClick}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '0 -8px',
        padding: '9px 8px',
        borderRadius: 12,
        listStyle: 'none',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        cursor: clickable ? 'pointer' : undefined,
      }}
    >
      {children}
    </li>
  )
}

/** Section head: title, count, and a trailing action slot. */
function GroupHead({ title, count, action }: { title: string; count: number; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500 }}>{title}</h2>
      <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      <span style={{ flex: 1 }} />
      {action}
    </div>
  )
}

export function HubPage(): React.JSX.Element {
  const [machines, setMachines] = React.useState<HubMachine[]>(() => loadMachines())
  const [showAdd, setShowAdd] = React.useState(false)
  const [draft, setDraft] = React.useState<AddDraft>(EMPTY_DRAFT)
  const [agents, setAgents] = React.useState<AgentLink[] | null>(() => rosterFromGlobal() ?? null)
  const [rosterFailed, setRosterFailed] = React.useState(false)
  const [tab, setTab] = React.useState<'home' | 'workflows' | 'settings'>('home')
  // Baked before app boot and never mutated afterwards: per-page constant.
  const fusion = fusionPage()
  // The flag-off shape (T-E): with no /<label>/ routes and no world UIs left
  // in the product, a flag-off page has NO foreign entry — the switch
  // affordance does not render and the rows stay informational with the
  // degradation hint (never a dead control; no hrefs ship either way).
  const switchUi = switchAffordance(fusion)
  // The fusion selection: the page atom is the authority (the URL is
  // irrelevant on a fused page). The atom seeds the first paint and the
  // subscription follows every switch — including one issued from another
  // surface or the revert of a failed attempt.
  const [activeKey, setActiveKey] = React.useState<string | undefined>(
    () => (fusion ? uiState()?.activeAgent : undefined),
  )

  React.useEffect(() => {
    let cancelled = false
    void fetchRoster()
      .then((list) => { if (!cancelled) { setAgents(list); setRosterFailed(false) } })
      .catch(() => {
        if (!cancelled) {
          setAgents((prev) => prev ?? [NATIVE_LINK])
          setRosterFailed(true)
        }
      })
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    if (!fusion) return
    const state = uiState()
    if (state === undefined) return
    return state.subscribe((label) => { setActiveKey(label) })
  }, [fusion])

  const here = currentMountPath()
  const isActive = (agent: AgentLink): boolean => hubRowActive({
    fusion,
    agentKey: agent.key,
    agentPath: agent.path,
    activeAgent: activeKey,
    mountPath: here,
  })

  /**
   * The row's click decision — the SAME table the retired sidebar seat ran:
   * on a fusion page EVERY left click is intercepted (active entry included),
   * the attempt runs for non-active entries only, and `preventDefault` keeps
   * the page exactly where it is. Non-fusion pages have no navigation arm to
   * fall back to (T-C retired the URL family), so the pass-through decision
   * is simply inert.
   */
  const rowDecision = (agent: AgentLink, event: React.MouseEvent): void => {
    const decision = seatClickDecision({
      fusion,
      active: isActive(agent),
      attempt: () => attemptSwitch(agent.key),
    })
    if (decision.preventDefault) event.preventDefault()
  }

  const persist = (next: readonly HubMachine[]): void => {
    const list = [...next]
    setMachines(list)
    saveMachines(list)
  }

  const addMachine = (): void => {
    const name = draft.name.trim()
    const url = draft.url.trim()
    if (name === '' || url === '') return
    persist([...machines, {
      id: freshMachineId(),
      name,
      label: name,
      url,
      self: false,
      addedAt: Date.now(),
    }])
    setDraft(EMPTY_DRAFT)
    setShowAdd(false)
  }

  const removeMachine = (id: string): void => {
    persist(machines.filter((machine) => machine.id !== id))
  }

  const draftValid = draft.name.trim() !== '' && draft.url.trim() !== ''

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '28px clamp(24px, 4vw, 48px) 48px',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Head */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <HubGlyph size={36} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' }}>Hub</h1>
            <p style={{ margin: '2px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>
              Multi-agent across machines in one hub by SuperD
            </p>
          </div>
        </div>

        {/* Sub-tab strip: Home is the machine/roster overview; Workflows is
            the orchestration surface (placeholder until the hub service
            lands). */}
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l3)' }}>
          {([['home', 'Home'], ['workflows', 'Workflows'], ['settings', 'Settings']] as const).map(([id, label]) => {
            const active = tab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => { setTab(id) }}
                style={{
                  padding: '8px 10px',
                  border: 'none',
                  background: 'transparent',
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 500 : 400,
                  color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  borderBottom: `2px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
                  marginBottom: -1,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {tab === 'workflows' && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GroupHead title="Workflows" count={0} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
              Orchestration across the machines and runtimes above — workflow authoring lands with the hub service.
            </p>
          </section>
        )}

        {tab === 'settings' && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GroupHead title="Settings" count={0} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
              Hub preferences — pairing, runtime visibility, and orchestration defaults land with the hub service.
            </p>
          </section>
        )}

        {tab === 'home' && (<>

        {/* Machines */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <GroupHead
            title="Machines"
            count={machines.length}
            action={(
              <button
                type="button"
                onClick={() => { setShowAdd((value) => !value) }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  font: 'inherit',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <path d="M5.5 1.5V9.5M1.5 5.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                Add machine
              </button>
            )}
          />
          <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
            Add another DSH from remote machines, provide the token URL.
          </p>
          <ul style={listStyle}>
            {machines.map((machine) => (
              <HoverRow key={machine.id}>
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    flex: 'none',
                    background: machine.self
                      ? 'var(--dsw-alias-state-success-primary)'
                      : 'var(--dsw-alias-label-caption)',
                  }}
                />
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{machine.name}</span>
                {machine.label !== machine.name && <span style={chip}>{machine.label}</span>}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  {machine.url}
                </span>
                <span style={machine.self ? chipSelf : chipPending}>{machine.self ? 'self' : 'link pending'}</span>
                {!machine.self && (
                  <button
                    type="button"
                    aria-label={`Remove ${machine.name}`}
                    onClick={() => { removeMachine(machine.id) }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-caption)',
                      font: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                      <path d="M2.5 2.5L8.5 8.5M8.5 2.5L2.5 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </HoverRow>
            ))}
          </ul>
          {showAdd && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '0.5fr 1.4fr',
                gap: 10,
                padding: 12,
                margin: '0 -8px',
                borderRadius: 12,
                border: '1px solid var(--dsw-alias-border-l3)',
              }}
            >
              <label>
                <span style={fieldLabel}>Name</span>
                <input
                  style={inputStyle}
                  value={draft.name}
                  placeholder="dev3"
                  onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }}
                />
              </label>
              <label>
                <span style={fieldLabel}>URL</span>
                <input
                  style={inputStyle}
                  value={draft.url}
                  placeholder="http://192.0.2.130:4999"
                  onChange={(event) => { setDraft({ ...draft, url: event.target.value }) }}
                />
              </label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setDraft(EMPTY_DRAFT) }}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    font: 'inherit',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!draftValid}
                  onClick={() => { addMachine() }}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'color-mix(in srgb, currentColor 16%, transparent)',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: draftValid ? 'pointer' : 'default',
                    opacity: draftValid ? 1 : 0.5,
                  }}
                >
                  Add machine
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Agent runtimes */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <GroupHead title="Agent Runtimes" count={agents?.length ?? 0} />
          {rosterFailed && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' }}>
              Live roster unavailable — showing the last known list.
            </p>
          )}
          <ul style={listStyle}>
            {agents === null && (
              <li style={{ padding: '9px 8px', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', listStyle: 'none' }}>
                Loading roster…
              </li>
            )}
            {agents?.map((agent) => (
              <HoverRow
                key={agent.key}
                clickable={switchUi.available}
                onClick={switchUi.available ? (event) => { rowDecision(agent, event) } : undefined}
              >
                <RuntimeMark agentKey={agent.key} size={20} />
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{agent.label}</span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12.5,
                    color: 'var(--dsw-alias-label-tertiary)',
                  }}
                >
                  {agent.machine ?? 'local'}
                </span>
                <span
                  style={{
                    ...chip,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 10.5,
                  }}
                >
                  {displayPath(agent.path)}
                </span>
                {isActive(agent) && <span style={chipSelf}>current</span>}
                {/* Switch affordance (T-C switch-only; T-E flag-off shape):
                    fusion page: the `switch` action, no href — every click
                    runs the seatClickDecision table (intercept + in-place
                    switch; the handler stops propagation so the row-level
                    handler does not double-run the attempt — one click, one
                    decision). Flag off: the affordance does NOT render — a
                    hint chip explains the inert roster instead of a dead
                    control (no /<label>/ route exists to reach, and no href
                    ships anywhere in the Hub UI). */}
                {switchUi.available ? (
                  <a
                    aria-current={isActive(agent) ? 'page' : undefined}
                    style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', cursor: 'pointer' }}
                    onClick={(event) => {
                      event.stopPropagation()
                      rowDecision(agent, event)
                    }}
                  >
                    switch
                  </a>
                ) : (
                  <span
                    title={`SUPERD_UI_FUSION is off — ${switchUi.hint}`}
                    style={{ ...chip, color: 'var(--dsw-alias-label-caption)' }}
                  >
                    {switchUi.hint}
                  </span>
                )}
              </HoverRow>
            ))}
          </ul>
        </section>
        </>)}
      </div>
    </div>
  )
}
