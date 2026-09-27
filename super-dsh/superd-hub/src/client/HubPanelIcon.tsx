import * as React from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { SuperdToastHost } from './toast.js'
import { HubGlyph } from './glyph.js'
import { currentMountPath, fetchRoster, NATIVE_LINK, rosterFromGlobal, type AgentLink } from './roster.js'
import { RuntimeMark } from './runtime-icons.js'
import { attemptSwitch, fusionPage, uiState } from './switch.js'
import { activeAgentName, hubRowActive, machineGroups, seatClickDecision, switchAffordance } from '../switch-core.js'

/**
 * The Hub sidebar row's icon share (`sidebar.panellist`, list id `hub`): the
 * mark plus — while the sidebar is wide — the agent selector pinned to the
 * row's right edge. The row's label stays the constant `Hub` (the registration
 * site passes it): the ACTIVE agent is read from the selector itself, whose
 * runtime mark sits beside its chevron. Clicking the row opens the Hub main
 * panel; only the selector and its menu are ours.
 *
 * The selector (native seat geometry, ui-agent-preset's AgentPresetSeat):
 * `[runtime mark][chevron]` in one 28px-tall pill, the whole pill the hit
 * target — the previous 20x20 arrow alone was small enough that most clicks
 * landed on the row behind it and opened the panel instead. It renders the
 * runtime mark of the page atom's active agent (`activeAgentName` names it in
 * the button's `title`), so the row and the menu agree on what is active.
 *
 * Switch surface (T-B, switch-only since T-C): the selector menu is half of
 * the sole agent-switch surface (the HubPage rows are the other half; the
 * sidebar-bottom seat is retired). Every menu click runs the
 * `seatClickDecision` table — intercepted, in-place `switchAgent`, NO
 * navigation ever; the selected row tracks the `__SUPERD_UI_STATE__` atom.
 * Flag off (T-E): the selector does not render — its menu's only purpose is
 * switching, and with no foreign entry in the product a flag-off page renders
 * the bare native row (opens the Hub panel) instead of a dead affordance
 * (`switchAffordance`).
 *
 * Menu look: the native `Menu` primitive (the same one the workspace list's
 * view-options dropdown uses) with `dense`, `portal` and `align="end"` — its
 * card, rows, section headings, hairlines and trailing check are the shell's
 * own, so this surface cannot drift from the native chrome. The roster is
 * grouped by machine (`machineGroups` — `AgentLink.machine`, the wire-carried
 * field the roster parser guarantees, groups in first-appearance order), each
 * group a heading row; every entry leads with the Hub page's runtime mark
 * (`RuntimeMark`) at menu-icon scale. Pure restyle — the click contract below
 * is untouched.
 *
 * Geometry: the native panel row renders this component inside its 16px glyph
 * span, so the selector is `position: fixed` against the row button's measured
 * box (re-measured on mount, on wide/rail flips, on window resize and on the
 * row's own box changes). Nothing outside this subtree is read or written.
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

/** The measured row box the fixed-position selector anchors to. */
interface RowBox {
  readonly top: number
  readonly bottom: number
  readonly right: number
}

/** Runtime-mark edge inside the selector, and the chevron's own default edge. */
const MARK_SIZE = 16
const CHEVRON_SIZE = 14
/**
 * Selector pill metrics (AgentPresetSeat's `.seat`): a 28px control with 8px
 * side padding and a 4px icon gap. Width is the sum, so the pill hugs its two
 * marks instead of leaving the mark floating in a fixed box.
 */
const SELECTOR_HEIGHT = 28
const SELECTOR_PAD = 8
const SELECTOR_GAP = 4
/** The row's own horizontal padding (native `.panelRow`): the selector's inset. */
const ROW_INSET = 8

export function HubPanelIcon({ size }: HubPanelIconProps): React.JSX.Element {
  // The sidebar hands the glyph 16px wide / 18px rail; the rail row has no
  // room for an affordance, so the selector and menu are wide-only.
  const wide = size <= 16
  const rootRef = React.useRef<HTMLSpanElement | null>(null)
  const selectorRef = React.useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const [box, setBox] = React.useState<RowBox | null>(null)
  const [agents, setAgents] = React.useState<AgentLink[]>(() => rosterFromGlobal() ?? [NATIVE_LINK])
  // Baked before app boot and never mutated afterwards: per-page constant.
  const fusion = fusionPage()
  // The flag-off shape (T-E): the selector is a switch affordance; with no
  // foreign entry in the product it does not render on a flag-off page. The
  // glyph still renders — everything that only serves the selector/menu (row
  // measurement, the open-menu wiring and its roster fetch) early-outs.
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
    // Identity-preserving: the observers below fire far more often than the
    // row actually moves, and a fresh object would re-render on each one.
    setBox((prev) => prev !== null && prev.top === rect.top && prev.bottom === rect.bottom && prev.right === rect.right
      ? prev
      : { top: rect.top, bottom: rect.bottom, right: rect.right })
  }, [])

  // Measurement only anchors the selector and the portaled menu — both
  // flag-off absent, so a flag-off page skips the work entirely (the glyph
  // needs no box). The row's own box is observed as well as the window: the
  // column's width can change without a window resize.
  React.useLayoutEffect(() => {
    if (!wide || !switchUi.available) return
    measure()
    const row = rootRef.current?.closest('button') ?? null
    let observer: ResizeObserver | undefined
    if (row !== null && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => { measure() })
      observer.observe(row)
    }
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [wide, switchUi.available, measure])

  React.useEffect(() => {
    // Unreachable while flag-off (the selector that flips `open` never
    // renders), guarded anyway so the roster refresh can never run without an
    // affordance. The menu owns dismissal (outside pointerdown, Escape).
    if (!open || !switchUi.available) return
    let cancelled = false
    void fetchRoster()
      .then((list) => { if (!cancelled) setAgents(list) })
      .catch(() => { /* keep the seeded roster; the row must never throw */ })
    return () => { cancelled = true }
  }, [open, switchUi.available])

  // A rail flip unmounts the selector (and the Menu with it): the stale `open`
  // would otherwise re-present the menu on the next expand.
  React.useEffect(() => {
    if (!wide || !switchUi.available) setOpen(false)
  }, [wide, switchUi.available])

  // Stable identity: the Menu re-places the portaled card from this callback,
  // and a fresh closure on every hover would restart that work.
  const anchorRect = React.useCallback((): DOMRect | null => selectorRef.current?.getBoundingClientRect() ?? null, [])

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

  // The menu's rows: one heading per machine group (the native view-options
  // dropdown's label rows), a hairline between groups, and one leading-icon row
  // per runtime.
  const items: MenuEntry[] = []
  machineGroups(agents).forEach((group, groupIndex) => {
    if (groupIndex > 0) items.push({ type: 'separator', id: `machine-divider:${group.machine}` })
    items.push({ type: 'label', id: `machine:${group.machine}`, text: group.machine })
    for (const agent of group.agents) {
      items.push({ id: agent.key, label: agent.label, icon: <RuntimeMark agentKey={agent.key} size={14} /> })
    }
  })

  /**
   * A menu pick. The row is a `menuitem` button — there is no anchor default
   * to cancel — but the shared table still owns whether the attempt runs
   * (the active entry is a no-op, the fusion arm never navigates).
   */
  const select = (id: string): void => {
    setOpen(false)
    const agent = agents.find((row) => row.key === id)
    if (agent === undefined) return
    seatClickDecision({ fusion, active: isActive(agent), attempt: () => attemptSwitch(agent.key) })
  }

  const activeLabel = activeAgentName(activeKey, agents)
  const selectorWidth = SELECTOR_PAD * 2 + CHEVRON_SIZE + (activeKey === undefined ? 0 : MARK_SIZE + SELECTOR_GAP)

  return (
    <span
      ref={rootRef}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Exactly the size the sidebar asks for (16 wide / 18 rail) — the same
          treatment as the native Plugins row. */}
      <HubGlyph size={size} />
      {/* C1: the always-mounted owner of the official Toast primitive —
          the banner portals to body top-center from here. */}
      <SuperdToastHost />
      {wide && box !== null && switchUi.available && (
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={items}
          selectedIds={activeKey === undefined ? [] : [activeKey]}
          onSelect={select}
          dense
          portal
          align="end"
          // The selector is fixed-positioned, so the Menu's own wrapper span
          // measures 0x0: the anchor rect has to come from the pill itself.
          getAnchorRect={anchorRect}
          anchor={(
            <span
              ref={selectorRef}
              role="button"
              tabIndex={0}
              aria-label="Agent selector"
              aria-haspopup="menu"
              aria-expanded={open}
              // The native seat's own hint channel: `title`, not a Tooltip.
              title={activeLabel === undefined ? 'Agent selector' : `Agent selector: ${activeLabel}`}
              style={{
                position: 'fixed',
                left: box.right - ROW_INSET - selectorWidth,
                top: box.top + (box.bottom - box.top) / 2,
                transform: 'translateY(-50%)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: SELECTOR_GAP,
                boxSizing: 'border-box',
                width: selectorWidth,
                height: SELECTOR_HEIGHT,
                padding: `0 ${SELECTOR_PAD}px`,
                borderRadius: 16,
                background: hover || open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                color: 'var(--dsw-alias-label-caption)',
                cursor: 'pointer',
                zIndex: 50,
              }}
              onMouseEnter={() => { setHover(true) }}
              onMouseLeave={() => { setHover(false) }}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') toggle(event)
              }}
            >
              {/* The active agent's own mark: the row's answer to "which agent
                  am I in", with the label moved into the `title`. */}
              {activeKey !== undefined && <RuntimeMark agentKey={activeKey} size={MARK_SIZE} />}
              {/* Explicit size: the pill's width math reads the same constant. */}
              <IconChevronDownOutlineRegular size={CHEVRON_SIZE} />
            </span>
          )}
        />
      )}
    </span>
  )
}
