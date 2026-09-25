/**
 * Client half entry: the app-level Super D surfaces.
 *
 * - `sidebar.footer.action` (`agent-runtime`) — the runtime seat: active
 *   agent + quick switch, just above Settings.
 * - `main` (key `hub`) + `sidebar.panellist` (id `hub`, below Plugins) — the
 *   Hub global panel: the sidebar row opens the hub home page (machines +
 *   agent adapters); the row's chevron expands the agent selector.
 *
 * The plugin shape mirrors the cordis client-plugin contract: an `inject`
 * declaration of required services plus an `apply(ctx)`.
 *
 * @module superd-hub/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { RuntimeSeat } from './RuntimeSeat.js'
import { HubPage } from './HubPage.js'
import { HubPanelIcon } from './HubPanelIcon.js'

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
    scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'agent-runtime',
      },
      RuntimeSeat,
    )), 'superd-hub: runtime footer action')
    scope.effect(() => scope.slots.inject('main', () => scope.slots.register(
      { name: 'main', key: 'hub' },
      HubPage,
    )), 'superd-hub: hub main panel')
    scope.effect(() => scope.slots.inject('sidebar.panellist', () => scope.slots.register(
      { name: 'sidebar.panellist', id: 'hub', order: 1, label: 'Hub' },
      HubPanelIcon,
    )), 'superd-hub: hub sidebar row')
  })
}
