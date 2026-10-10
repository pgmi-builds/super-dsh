import { describe, expect, it, vi } from 'vitest'
import { createConfigProjector, isNativeConfigSchema } from '@deepseek-ai/dsh-app-boot'
import { deferredTargetResolution, killReturnedShell, descendantIsLive, killFixtureDescendant } from './disposal-fixture.ts'
import { createRealRemoteHarness } from './real-harness.ts'

const run = { target: 'byop:t', spawn: 'bash', cmd: 'printf ready' }
describe('Agent-owned remote registration', () => {
  it('does not veto creation when another remote owns this Agent scope', async () => {
    const h = await createRealRemoteHarness()
    try {
      expect(h.host.tools.get('remote')).toBeUndefined()
      for (const id of ['collision', 'independent']) {
        const agent = await h.createAgent(id)
        expect(await h.invoke(agent, run)).toMatchObject({ text: 'ready' })
        expect(h.visibleTools(agent).filter(t => t.name === 'remote')).toHaveLength(1)
      }
    } finally { await h.dispose() }
  })
  it('does not backfill current Agents; new and cold-resumed Agents try the surviving row', async () => {
    const h = await createRealRemoteHarness()
    try {
      const current = await h.createAgent('current')
      await h.invoke(current, run)
      await h.rows[0]!.dispose()
      expect(h.host.tools.get('remote', current)).toBeUndefined()
      const fresh = await h.createAgent('fresh')
      expect(await h.invoke(fresh, run)).toMatchObject({ text: 'ready' })
      await h.disposeAgent(current)
      const resumed = await h.createAgent('current', 'resume')
      expect(await h.invoke(resumed, run)).toMatchObject({ text: 'ready' })
    } finally { await h.dispose() }
  })
  it('keeps each Agent shell state separate', async () => {
    const h = await createRealRemoteHarness()
    try {
      const a = await h.createAgent('a'), b = await h.createAgent('b')
      await h.invoke(a, { ...run, cmd: 'cd /tmp; printf a' })
      expect(await h.invoke(b, { ...run, cmd: 'pwd' })).not.toMatchObject({ cwd: '/tmp' })
      expect(await h.invoke(a, { target: 'byop:t', cmd: 'pwd' })).toMatchObject({ cwd: '/tmp' })
    } finally { await h.dispose() }
  })
  it('propagates unrelated registration errors', async () => {
    const h = await createRealRemoteHarness({ copies: 1 })
    try {
      const occupied = await h.createAgent('occupied')
      const register = vi.spyOn(h.host.tools, 'register').mockImplementation(() => { throw new TypeError('invalid output schema') })
      await expect(h.createAgent('invalid')).rejects.toThrow('invalid output schema')
      register.mockRestore()
      expect(await h.invoke(occupied, run)).toMatchObject({ text: 'ready' })
    } finally { vi.restoreAllMocks(); await h.dispose() }
  })
  it.each(['Agent', 'row'])('cannot resurrect a PTY after its %s owner unloads during target discovery', async owner => {
    const gate = deferredTargetResolution()
    const h = await createRealRemoteHarness({ copies: 1, driverOptions: gate.options })
    let result: { text: string } | undefined
    try {
      const agent = await h.createAgent('in-flight-discovery')
      const pending = h.invoke(agent, { target: 'delayed', mode: 'pty', cmd: 'printf %s "$$"' })
        .then(value => { result = value; return { value } }, error => ({ error }))
      await gate.entered
      if (owner === 'Agent') await h.disposeAgent(agent)
      else await h.rows[0]!.dispose()
      expect(h.host.tools.get('remote', agent)).toBeUndefined()
      gate.release()
      expect(await pending).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('E_REMOTE_DISPOSED') }) })
    } finally {
      gate.release()
      killReturnedShell(result?.text)
      await h.dispose()
    }
  })
  it('concurrent row and Agent unloads each wait for the shared shell cleanup', async () => {
    const h = await createRealRemoteHarness({ copies: 1 })
    try {
      const agent = await h.createAgent('concurrent-cleanup')
      const { text } = await h.invoke(agent, { ...run, cmd: 'printf %s "$$"' })
      const pid = Number(text)
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      const row = h.rows[0]!.dispose().then(() => alive())
      const agentExit = h.disposeAgent(agent).then(() => alive())
      expect(await Promise.all([row, agentExit])).toEqual([false, false])
    } finally { await h.dispose() }
  })
  it.each(['Agent', 'row'])('reaps redirected background descendants at %s owner cleanup completion', async owner => {
    // Plain bash gives a directly observable detached process group; the real
    // scoped registry/tool/driver dispatch and owner fibers are unchanged.
    const h = await createRealRemoteHarness({ copies: 1, driverOptions: { spawnArgvFor: () => ['bash'] } })
    let child: number | undefined
    try {
      const agent = await h.createAgent('background-owner-cleanup')
      const result = await h.invoke(agent, { ...run, cmd: 'sleep 30 </dev/null >/dev/null 2>&1 & printf %s "$!"' })
      child = Number(result.text)
      expect(descendantIsLive(child)).toBe(true)
      if (owner === 'Agent') await h.disposeAgent(agent)
      else await h.rows[0]!.dispose()
      expect(descendantIsLive(child)).toBe(false)
      expect(h.host.tools.get('remote', agent)).toBeUndefined()
    } finally { killFixtureDescendant(child); await h.dispose() }
  })
  it.each(['Agent', 'row'])('reaps a running PTY when its %s owner exits', async owner => {
    const h = await createRealRemoteHarness({ copies: 1 })
    try {
      const agent = await h.createAgent('cleanup')
      const result = await h.invoke(agent, { ...run, cmd: 'printf %s "$$"' })
      const pid = Number(result.text)
      expect(Number.isInteger(pid) && pid > 1).toBe(true)
      process.kill(pid, 0)
      if (owner === 'Agent') await h.disposeAgent(agent)
      else await h.rows[0]!.dispose()
      await expect.poll(() => { try { process.kill(pid, 0); return true } catch { return false } }).toBe(false)
      expect(h.host.tools.get('remote', agent)).toBeUndefined()
    } finally { await h.dispose() }
  })

})

// Independent built module copies, not two imports sharing Better's driver module.
describe('independent delivery entries', () => {
  it('preserves the native loader validator and inspectable Config metadata in both copies', async () => {
    const Better = (await import('../../lib/remote/plugin.js')).default
    const Super = (await import('../../../super-dsh/remote/plugin.js')).default
    const project = await createConfigProjector()
    for (const { Config } of [Better, Super]) {
      expect(isNativeConfigSchema(Config)).toBe(true)
      expect(Config['~standard'].validate(undefined)).toMatchObject({ value: { execTimeoutSec: 120, idleTtlSec: 600, maxOutputChars: 30_000 } })
      expect(Config['~standard'].validate({ execTimeoutSec: 0 })).toHaveProperty('issues')
      const result = project(Config, 'remote')
      expect(result).toMatchObject({ acceptsMissing: true, limitations: [], schema: { default: { execTimeoutSec: 120, idleTtlSec: 600, maxOutputChars: 30_000 } } })
      expect(Config.dict?.execTimeoutSec?.meta).toMatchObject({ min: 1, default: 120 })
    }
  })
  it.each(['Better first', 'Super first'])('%s supports either owner being disabled without backfill', async order => {
    const Better = (await import('../../lib/remote/plugin.js')).default
    const Super = (await import('../../../super-dsh/remote/plugin.js')).default
    const plugins = order === 'Better first' ? [Better, Super] : [Super, Better]
    const h = await createRealRemoteHarness({ plugins })
    try {
      const first = await h.createAgent('delivery')
      expect(await h.invoke(first, run)).toMatchObject({ text: 'ready' })
      expect(h.visibleTools(first).filter(t => t.name === 'remote')).toHaveLength(1)
      await h.rows[0]!.dispose()
      expect(h.host.tools.get('remote', first)).toBeUndefined()
      expect(await h.invoke(await h.createAgent('after-disable'), run)).toMatchObject({ text: 'ready' })
      const reenabled = await h.ctx.plugin(plugins[0]!, plugins[0]!.Config(undefined) as never)
      try {
        expect(h.host.tools.get('remote', first)).toBeUndefined()
        const next = await h.createAgent('after-enable')
        expect(await h.invoke(next, run)).toMatchObject({ text: 'ready' })
        expect(h.visibleTools(next).filter(t => t.name === 'remote')).toHaveLength(1)
      } finally { await reenabled.dispose() }
    } finally { await h.dispose() }
  })
})
