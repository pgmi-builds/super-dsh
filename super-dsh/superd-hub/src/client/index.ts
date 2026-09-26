/**
 * Client half entry: the app-level Super D surfaces.
 *
 * - `main` (key `hub`) + `sidebar.panellist` (id `hub`, below Plugins) — the
 *   Hub global panel: the sidebar row opens the hub home page (machines +
 *   agent adapters); the row's chevron expands the agent selector. The row's
 *   label is registered here and re-registered on active-agent changes
 *   (fusion pages: `Hub > <active agent>`; flag off: plain `Hub`) — the
 *   sidebar projects labels from registration metadata, so the re-register
 *   is the one sanctioned lever that refreshes it. The Hub
 *   UI is the SOLE agent-switch surface (T-B, user ruling: the sidebar-bottom
 *   RuntimeSeat is retired): both the HubPage rows and the chevron menu
 *   intercept clicks into the in-place `switchAgent` orchestration (no
 *   navigation — and since T-C no non-fusion href arm either: the per-label
 *   URL family is retired, so a click can never navigate away).
 *
 * The plugin shape mirrors the cordis client-plugin contract: an `inject`
 * declaration of required services plus an `apply(ctx)`.
 *
 * @module superd-hub/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { HubPage } from './HubPage.js'
import { HubPanelIcon } from './HubPanelIcon.js'
import { NATIVE_LINK, rosterFromGlobal } from './roster.js'
import {
  activeAgentName,
  hubRowLabel,
} from '../switch-core.js'
import {
  bindSwitchAgent,
  fusionPage,
  uiState,
  type SwitchConnection,
  type SwitchLocale,
  type SwitchSessions,
  type SwitchUiWorkspace,
  type SwitchWorkspaces,
} from './switch.js'

/** Required services (cordis fiber inject): the slot registry. */
export const inject = ['slots']

type SlotsScope = ClientContext & {
  slots: {
    inject(slot: string, factory: () => () => void): () => void
    register(def: { name: string; id?: string; key?: string; order?: number; label?: string }, component: unknown): () => void
  }
  effect(fn: () => () => void, label?: string): () => void
}

/**
 * Mount the client surfaces. Degrades silently when the slot service is
 * absent (a composition without the sidebar renders nothing — every seat
 * here is an optional occupant by contract).
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (raw) => {
    const scope = raw as SlotsScope
    scope.effect(() => scope.slots.inject('main', () => scope.slots.register(
      { name: 'main', key: 'hub' },
      HubPage,
    )), 'superd-hub: hub main panel')
    scope.effect(() => scope.slots.inject('sidebar.panellist', () => {
      // The row label (native-workspace-look round): base `Hub`, suffixed
      // ` > ` the ACTIVE agent's display name on a fusion page
      // (`hubRowLabel(activeAgentName(...))` over the page atom + the seeded
      // roster); plain `Hub` with the flag off (no atom — the label helper
      // never sees an active agent). The sidebar projects panellist
      // metadata only on registry events (its `syncPanels` re-resolves the
      // label on every projection), so a label change is PUSHED by
      // re-registering the entry: dispose + register inside one tick lands
      // as ONE microtask-batched projection (SlotCore.markDirty), never a
      // row-less intermediate frame. The atom subscription follows the
      // components' subscribe pattern — released with the registration on
      // unmount (the inject effect's disposer).
      let disposeRow: (() => void) | undefined
      let shownLabel: string | undefined
      const registerRow = (): void => {
        const label = hubRowLabel(
          'Hub',
          activeAgentName(uiState()?.activeAgent, rosterFromGlobal() ?? [NATIVE_LINK]),
        )
        if (label === shownLabel) return
        shownLabel = label
        disposeRow?.()
        disposeRow = scope.slots.register(
          { name: 'sidebar.panellist', id: 'hub', order: 1, label },
          HubPanelIcon,
        )
      }
      registerRow()
      const state = fusionPage() ? uiState() : undefined
      const unbind = state?.subscribe(() => { registerRow() })
      return () => {
        unbind?.()
        disposeRow?.()
        disposeRow = undefined
      }
    }), 'superd-hub: hub sidebar row')
  })
  // Native UI fusion Task 4 (+ T-A, T-F): bind the switchAgent orchestration
  // once the connection, uiWorkspace, workspaces, sessions and locale
  // services exist (structural faces; the stock client tree always has all
  // five — upstream's ui-workspace injects the same set itself). T-F: the
  // landing resolves against the sessions projection and mirrors the
  // default-workspace boot path, hence `sessions` + `locale`. Without a
  // binding the Hub surfaces' fusion branch degrades to swallowed clicks —
  // never navigation away from the fused page (the seatClickDecision
  // contract).
  ctx.inject(['connection', 'uiWorkspace', 'workspaces', 'sessions', 'locale'], (raw) => {
    const services = raw as unknown as {
      connection: SwitchConnection
      uiWorkspace: SwitchUiWorkspace
      workspaces: SwitchWorkspaces
      sessions: SwitchSessions
      locale: SwitchLocale
    }
    bindSwitchAgent(services)
  })
}
