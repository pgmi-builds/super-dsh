/** Native slot election and real React effects follow the independent Host owner. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createElement, act } from 'react'
import { JSDOM } from '../../upstream/deepseek-harness/node_modules/jsdom/lib/api.js'
import { createRoot } from '../../upstream/deepseek-harness/node_modules/.pnpm/node_modules/react-dom/client.js'
import { SlotRegistry } from '../../upstream/deepseek-harness/packages/client/ui-renderer/src/client/registry.ts'
import { TestRemote } from '../../upstream/deepseek-harness/packages/test-support/client-runtime/src/remote.ts'
import { ConfigForms } from '../../upstream/deepseek-harness/packages/client/ui-settings/src/client/config-form.ts'
import { SettingsDescribeMirror } from '../../upstream/deepseek-harness/packages/client/ui-settings/src/client/settings-mirror.ts'
import { SettingsSchemaService } from '../../upstream/deepseek-harness/packages/client/ui-settings/src/client/schema.ts'
import * as client from '../src/failover/client/index.ts'

// Match the real renderer's React singleton; Better's build dependency has a separate copy.
vi.mock('react', () => import('../../upstream/deepseek-harness/node_modules/.pnpm/node_modules/react/index.js'))
vi.mock('../src/mobile/client/index.ts', () => ({ setupMobileLayout: () => {} }))

const nativeWelcome = () => createElement('p', null, 'Native preview notice')
const credentials = () => createElement('p', null, 'Native credentials')

async function bench(initial: string[]) {
  let namespaces = initial
  const describeCall = async () => ({ ok: true as const, value: {
    writable: true, hasDocument: true,
    namespaces: namespaces.map(ns => ({ ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0 })),
  } })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    'settings.general.item': { kind: 'list', scope: 'root' },
    'settings.onboarding': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  ctx.slots.register({ name: 'settings.onboarding', id: 'welcome-notice', order: -100 } as never, nativeWelcome)
  ctx.slots.register({ name: 'settings.onboarding', id: 'deepseek-official', order: 0 } as never, credentials)
  new TestRemote(ctx, { settings: { describe: describeCall }, session: {} })
  const mirror = new SettingsDescribeMirror({ remote: { settings: { describe: describeCall } } } as never)
  await ctx.plugin(ConfigForms, { mirror, schema: new SettingsSchemaService(ctx), persistence: 'host' }).await()
  ctx.provide('locale', { register: () => () => {} } as never)
  const fiber = ctx.plugin(client)
  await fiber.await()
  await mirror.ensure()
  return { ctx, fiber, cleanup: () => ctx.fiber.dispose(), set: async (next: string[]) => { namespaces = next; await mirror.load() } }
}

function welcome(b: Awaited<ReturnType<typeof bench>>) {
  return b.ctx.slots.entriesOfSlot('settings.onboarding').find(row => row.options.id === 'welcome-notice')!
}

describe('Better welcome skip uses the native onboarding owner', () => {
  it('shadows only welcome while served and restores native fallback on component or package disposal', async () => {
    const b = await bench([])
    try {
      expect(welcome(b).component).toBe(nativeWelcome)
      await b.set(['dashr-welcome-notice'])
      expect(welcome(b).component).not.toBe(nativeWelcome)
      expect(b.ctx.slots.entriesOfSlot('settings.onboarding').find(row => row.options.id === 'deepseek-official')?.component).toBe(credentials)
      await b.set([])
      expect(welcome(b).component).toBe(nativeWelcome)
      await b.set(['dashr-welcome-notice'])
      await b.fiber.dispose()
      expect(welcome(b).component).toBe(nativeWelcome)
      await b.set([])
      await b.set(['dashr-welcome-notice'])
      expect(welcome(b).component).toBe(nativeWelcome)
    } finally { await b.cleanup() }
  })

  it('completes first visit, new chat and explicit reopening once per mount without rendering a notice', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>')
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const b = await bench(['dashr-welcome-notice'])
    try {
      const component = welcome(b).component as (props: { complete(): void }) => null
      let completions = 0
      const complete = () => { completions++ }
      for (const reason of ['first visit', 'new chat', 'explicit reopening']) {
        const target = document.getElementById('mount')!
        const root = createRoot(target)
        await act(async () => { root.render(createElement(component, { complete })) })
        expect(completions, reason).toBe(['first visit', 'new chat', 'explicit reopening'].indexOf(reason) + 1)
        expect(target.innerHTML).toBe('')
        await act(async () => { root.render(createElement(component, { complete: () => { completions++ } })) })
        expect(completions, 'owner callback changes do not re-complete the same mount').toBe(['first visit', 'new chat', 'explicit reopening'].indexOf(reason) + 1)
        await act(async () => { root.unmount() })
      }
    } finally { await b.cleanup(); dom.window.close(); vi.unstubAllGlobals() }
  })
})
