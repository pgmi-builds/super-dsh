/** Package client remains mounted while individual Host settings owners toggle. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '../../upstream/deepseek-harness/packages/test-support/client-runtime/src/remote.ts'
import { ConfigForms } from '../../upstream/deepseek-harness/packages/client/ui-settings/src/client/config-form.ts'
import { SettingsDescribeMirror } from '../../upstream/deepseek-harness/packages/client/ui-settings/src/client/settings-mirror.ts'
import { SettingsSchemaService } from '../../upstream/deepseek-harness/packages/client/ui-settings/src/client/schema.ts'
import * as client from '../src/failover/client/index.ts'

// Mobile gestures need a DOM and are unrelated to settings owner lifecycle.
vi.mock('../src/mobile/client/index.ts', () => ({ setupMobileLayout: () => {} }))

async function bench(initial: string[]) {
  let namespaces = initial
  const describeCall = async () => ({ ok: true as const, value: {
    writable: true, hasDocument: true,
    namespaces: namespaces.map(ns => ({ ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0 })),
  } })
  const ctx = new Context()
  new TestRemote(ctx, { settings: { describe: describeCall }, session: {} })
  const mirror = new SettingsDescribeMirror({ remote: { settings: { describe: describeCall } } } as never)
  const provider = ctx.plugin(ConfigForms, { mirror, schema: new SettingsSchemaService(ctx), persistence: 'host' })
  await provider.await()
  const rows = new Set<string>()
  ctx.provide('locale', { register: () => () => {} } as never)
  // The slot fixture executes the real package's contribution and its disposers.
  ctx.provide('slots', {
    register: (entry: { id: string }) => { rows.add(entry.id); return () => { rows.delete(entry.id) } },
    inject: (_name: string, factory: () => Generator<() => void>) => {
      const disposers = [...factory()]
      return () => { for (const off of disposers) off() }
    },
  } as never)
  const fiber = ctx.plugin(client)
  await fiber.await()
  await mirror.ensure()
  return { ctx, fiber, rows, cleanup: async () => { await fiber.dispose(); await provider.dispose() }, set: async (next: string[]) => { namespaces = next; await mirror.load() } }
}

describe('Better General rows follow their Host owners', () => {
  it('never offers failover when its Host component is initially disabled', async () => {
    const b = await bench(['dashr-compaction-tuning'])
    try {
      expect(b.rows.has('compaction-tuning')).toBe(true)
      expect(b.rows.has('failover')).toBe(false)
    } finally { await b.cleanup() }
  })

  it('adds, withdraws and restores each row independently without reloading the package client', async () => {
    const b = await bench(['dashr-failover', 'dashr-compaction-tuning'])
    try {
      expect([...b.rows].sort()).toEqual(['compaction-tuning', 'failover'])
      await b.set(['dashr-compaction-tuning'])
      expect([...b.rows]).toEqual(['compaction-tuning'])
      await b.set(['dashr-failover'])
      expect([...b.rows]).toEqual(['failover'])
      await b.set(['dashr-failover', 'dashr-compaction-tuning'])
      expect([...b.rows].sort()).toEqual(['compaction-tuning', 'failover'])
      await b.fiber.dispose()
      expect(b.rows.size).toBe(0)
      await b.set(['dashr-failover'])
      expect(b.rows.size).toBe(0)
    } finally { await b.cleanup() }
  })
})
