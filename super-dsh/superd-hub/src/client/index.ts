/**
 * Client half entry: the app-level Super D surfaces.
 *
 * - `main` (key `hub`) + `sidebar.panellist` (id `hub`, below Plugins) — the
 *   Hub global panel: the sidebar row opens the hub home page (machines +
 *   agent adapters); the row's right-edge selector expands the agent menu. The
 *   row's label is the constant `Hub` registered here; the ACTIVE agent rides
 *   the selector's own runtime mark (HubPanelIcon), so no label push is needed
 *   and the entry never re-registers. The Hub
 *   UI is the SOLE agent-switch surface (T-B, user ruling: the sidebar-bottom
 *   RuntimeSeat is retired): both the HubPage rows and the selector menu
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
import {
  bindSwitchAgent,
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
    scope.effect(() => scope.slots.inject('sidebar.panellist', () => scope.slots.register(
      // The row label is the constant `Hub` (native-workspace-look round 2):
      // the active agent moved ONTO the row's right-edge selector, which
      // carries its runtime mark beside the chevron (HubPanelIcon). A label
      // that never changes needs no re-registration push, so the entry is
      // registered once — no `syncPanels` projection churn on agent switches.
      { name: 'sidebar.panellist', id: 'hub', order: 1, label: 'Hub' },
      HubPanelIcon,
    )), 'superd-hub: hub sidebar row')
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
