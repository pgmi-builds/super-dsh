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
  fusionPage,
  probeStaleFusionPage,
  type SwitchConnection,
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
 * Live-install staleness: the fusion flag is baked into the SERVED index, so
 * a page that booted before super-dsh was installed carries no flag even
 * though this very apply is the hot-loaded client half — the Hub row would
 * render with every switch affordance hidden until a manual restart. When
 * the flag is absent the entry probes the roster's `hub.fusion` once and
 * re-boots the page on an armed host (switch.ts `probeStaleFusionPage`; the
 * sessionStorage marker bounds it to one reload per tab session). A flag-off
 * deployment answers `false` and keeps the T-E inert shape with no reload.
 */
export function apply(ctx: ClientContext): void {
  // The stale-page probe rides EVERY application (fresh boot included): on an
  // armed page it is one guarded no-op; on a flag-off page one cheap
  // control-plane GET that answers `false`. It must not wait for the slots —
  // a composition without a sidebar still needs the heal.
  if (!fusionPage()) probeStaleFusionPage()
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
  // (structural faces; the stock client tree always has all four — upstream's
  // ui-workspace injects the same set itself). T-F: the landing resolves
  // against the sessions projection and mirrors the default-workspace boot
  // path, hence `sessions`. Without a binding the Hub surfaces' fusion branch
  // degrades to swallowed clicks — never navigation away from the fused page
  // (the seatClickDecision contract).
  ctx.inject(['connection', 'uiWorkspace', 'workspaces', 'sessions'], (raw) => {
    const services = raw as unknown as {
      connection: SwitchConnection
      uiWorkspace: SwitchUiWorkspace
      workspaces: SwitchWorkspaces
      sessions: SwitchSessions
    }
    bindSwitchAgent(services)
  })
}
