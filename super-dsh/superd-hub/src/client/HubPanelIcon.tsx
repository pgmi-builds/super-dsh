import * as React from 'react'
import { HubGlyph } from './glyph.js'
import { currentMountPath, fetchRoster, NATIVE_LINK, rosterFromGlobal, type AgentLink } from './roster.js'
import { RuntimeMark } from './runtime-icons.js'
import { attemptSwitch, fusionPage, uiState } from './switch.js'
import { hubRowActive, machineGroups, seatClickDecision, switchAffordance } from '../switch-core.js'

/**
 * The Hub sidebar row's icon share (`sidebar.panellist`, list id `hub`): the
 * mark plus — while the sidebar is wide — a chevron pinned to the row's right
 * edge that expands the agent-runtime selector (the same roster the Hub page
 * lists). The row itself stays native: clicking it opens the Hub main panel;
 * only the chevron and the menu are ours. The row's LABEL is the registration
 * site's (client/index.ts): base `Hub`, suffixed ` > ` the active agent's
 * display name on a fusion page (`hubRowLabel`, the page atom subscribed at
 * the registration), plain `Hub` with the fusion flag off.
 *
 * Switch surface (T-B, switch-only since T-C): the chevron menu is half of
 * the sole agent-switch surface (the HubPage rows are the other half; the
 * sidebar-bottom seat is retired). Every menu click runs the
 * `seatClickDecision` table — intercepted, in-place `switchAgent`, NO
 * navigation ever; the active row tracks the `__SUPERD_UI_STATE__` atom.
 * There is no non-fusion navigation arm: the per-label URL family is retired
 * (path-separation T-C — `/hub` is the sole entry). Flag off (T-E): the
 * chevron does not render — its menu's only purpose is switching, and with
 * no foreign entry in the product a flag-off page renders the bare native
 * row (opens the Hub panel) instead of a dead affordance
 * (`switchAffordance`).
 *
 * Menu look (native workspace-list reference): no outer card border; the
 * roster grouped by machine (`machineGroups` — `AgentLink.machine ?? 'local'`,
 * groups in first-appearance order) with a very light divider line between
 * groups; every row leads with the Hub page's runtime mark (`RuntimeMark`)
 * at menu scale. Pure restyle — the click contract below is untouched.
 *
 * Geometry: the native panel row renders this component inside its glyph
 * span, so the chevron and the menu are `position: fixed` against the row
 * button's measured box (re-measured on mount, on wide/rail flips, on open,
 * and on window resize). Nothing outside this subtree is read or written.
 *
 * @module superd-hub/client/HubPanelIcon
 */

/** Owner share of a `sidebar.panellist` entry (ui-sidebar contract). */
interface HubPanelIconProps {
  /** Requested square glyph edge: 16 wide, 18 on the collapsed rail. */
  readonly size: number
  /** Whether this panel is selected in the main column. */
  readonly active: boolean
}

/** The measured row box the fixed-position chevron and menu anchor to. */
interface RowBox {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly width: number
}

export function HubPanelIcon({ size }: HubPanelIconProps): React.JSX.Element {
  // The sidebar hands the glyph 16px wide / 18px rail; the rail row has no
  // room for an affordance, so the chevron and menu are wide-only.
  const wide = size <= 16
  const rootRef = React.useRef<HTMLSpanElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = React.useState(false)
  const [box, setBox] = React.useState<RowBox | null>(null)
  const [agents, setAgents] = React.useState<AgentLink[]>(() => rosterFromGlobal() ?? [NATIVE_LINK])
  // Baked before app boot and never mutated afterwards: per-page constant.
  const fusion = fusionPage()
  // The flag-off shape (T-E): the chevron is a switch affordance; with no
  // foreign entry in the product it does not render on a flag-off page. The
  // glyph still renders — everything that only serves the chevron/menu
  // (row measurement, the open-menu wiring and its roster fetch) early-outs.
  const switchUi = switchAffordance(fusion)
  // The fusion selection: the page atom is the authority; the subscription
  // follows every switch (another surface's included) and every revert.
  const [activeKey, setActiveKey] = React.useState<string | undefined>(
    () => (fusion ? uiState()?.activeAgent : undefined),
  )

  React.useEffect(() => {
    if (!fusion) return
    const state = uiState()
    if (state === undefined) return
    return state.subscribe((label) => { setActiveKey(label) })
  }, [fusion])

  const measure = React.useCallback((): void => {
    const row = rootRef.current?.closest('button') ?? null
    if (row === null) {
      setBox(null)
      return
    }
    const rect = row.getBoundingClientRect()
    setBox({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width })
  }, [])

  // Measurement only anchors the chevron and the fixed-position menu — both
  // flag-off absent, so a flag-off page skips the work entirely (the glyph
  // needs no box).
  React.useLayoutEffect(() => {
    if (!wide || !switchUi.available) return
    measure()
  }, [wide, switchUi.available, measure])

  React.useEffect(() => {
    // Unreachable while flag-off (the chevron that flips `open` never
    // renders), guarded anyway so the menu wiring — measure, roster fetch,
    // outside-click listeners — can never run without an affordance.
    if (!open || !switchUi.available) return
    let cancelled = false
    measure()
    void fetchRoster()
      .then((list) => { if (!cancelled) setAgents(list) })
      .catch(() => { /* keep the seeded roster; the row must never throw */ })
    const owns = (node: Node | null): boolean =>
      (rootRef.current !== null && rootRef.current.contains(node))
      || (menuRef.current !== null && menuRef.current.contains(node))
    const onDown = (event: MouseEvent): void => {
      if (!owns(event.target as Node | null)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', measure)
    return () => {
      cancelled = true
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', measure)
    }
  }, [open, switchUi.available, measure])

  const here = currentMountPath()
  const isActive = (agent: AgentLink): boolean => hubRowActive({
    fusion,
    agentKey: agent.key,
    agentPath: agent.path,
    activeAgent: activeKey,
    mountPath: here,
  })
  const toggle = (event: React.MouseEvent | React.KeyboardEvent): void => {
    event.stopPropagation()
    if (event.type !== 'keydown') event.preventDefault()
    setOpen((value) => !value)
  }

  return (
    <span
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Exactly the size the sidebar asks for (16 wide / 18 rail) — the same
          treatment as the native Plugins row. */}
      <HubGlyph size={size} />
      {wide && box !== null && switchUi.available && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Agent selector"
          aria-expanded={open}
          title="Agent selector"
          style={{
            position: 'fixed',
            left: box.right - 24,
            top: box.top + (box.bottom - box.top) / 2,
            transform: 'translateY(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: 6,
            color: open ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-caption)',
            cursor: 'pointer',
            zIndex: 50,
          }}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') toggle(event)
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 3.6L5 6.4L8 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
      {open && box !== null && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: box.bottom + 6,
            left: box.left,
            width: box.width,
            zIndex: 60,
            background: 'var(--dsh-surface, #26262b)',
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            overflow: 'hidden',
            padding: 4,
            color: 'var(--dsw-alias-label-primary)',
          }}
        >
          {machineGroups(agents).map((group, groupIndex) => (
            // Native workspace-list grouping: one block per machine
            // (`AgentLink.machine ?? 'local'`), a very light divider line
            // between groups (hairline, slightly inset — the reference's
            // treatment). Presentation only; the click contract below is
            // byte-identical to the flat list it replaces.
            <React.Fragment key={group.machine}>
              {groupIndex > 0 && (
                <div
                  style={{
                    height: 1,
                    margin: '3px 6px',
                    background: 'color-mix(in srgb, currentColor 10%, transparent)',
                  }}
                />
              )}
              {group.agents.map((agent) => (
                // Switch-only (T-C): the per-label URL family is retired — /hub
                // is the sole entry — so a menu entry is no longer a hyperlink
                // and there is no navigation arm (no middle-click /
                // open-in-new-tab target either). Every click runs the
                // seatClickDecision table — intercept + in-place switch, the
                // active entry included. The menu only exists on a fusion page
                // (the chevron is gated by switchAffordance, T-E), so the
                // non-fusion arm of the table is unreachable here.
                <a
                  key={agent.key}
                  aria-current={isActive(agent) ? 'page' : undefined}
                  onClick={(event) => {
                    const decision = seatClickDecision({
                      fusion,
                      active: isActive(agent),
                      attempt: () => attemptSwitch(agent.key),
                    })
                    if (decision.preventDefault) event.preventDefault()
                    // The menu is a DOM child of the native row button: on a
                    // fusion page the switch must not co-open the Hub panel, so
                    // the bubble stops here.
                    if (fusion) event.stopPropagation()
                    setOpen(false)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 7,
                    textDecoration: 'none',
                    color: 'inherit',
                    fontSize: 13,
                    cursor: 'pointer',
                    background: isActive(agent) ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
                  }}
                >
                  {/* The Hub page's runtime mark (cool assets + subagent
                      fallback + native fish) at menu scale — the reference
                      list's icon-left-of-label row shape. */}
                  <RuntimeMark agentKey={agent.key} size={16} />
                  <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {agent.label}
                  </span>
                  {isActive(agent) && <span aria-hidden>✓</span>}
                </a>
              ))}
            </React.Fragment>
          ))}
        </div>
      )}
    </span>
  )
}
