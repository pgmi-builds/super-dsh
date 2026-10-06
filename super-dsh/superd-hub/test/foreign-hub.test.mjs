import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const module = await import('../dist/foreign-hub.js').catch(() => ({}))

function setup(t) {
  assert.equal(typeof module.registerForeignHubHost, 'function', 'Hub must expose a session-bound host')
  const home = mkdtempSync(join(tmpdir(), 'foreign-hub-'))
  const calls = []
  const deps = {
    service: {
      async send(args, initiator) { calls.push({ args, initiator }); return { outcome: 'delivered', conversationId: 'c12345', messageId: 'm1', sessionId: 'peer' } },
      read(sessionId) { calls.push({ readSession: sessionId }); return [] }, listConversations() { return [] },
    },
    delivery: { agents: { get() {} }, buffer() {} },
    roster: () => ({ self: { id: 'm123', label: 'local' }, remotes: [], agents: [] }),
    exec: { selfM4: () => 'm123' },
  }
  const close = module.registerForeignHubHost(home, deps)
  t.after(async () => { await close(); rmSync(home, { recursive: true, force: true }) })
  return { home, calls, close }
}

test('foreign calls bind the runtime and session instead of trusting caller arguments', async t => {
  const { home, calls } = setup(t)
  const pi = module.bindForeignHub('pi', 'session-pi', join(home, 'agents/pi'), () => ({ status: 'idle' }))
  const omp = module.bindForeignHub('omp', 'session-omp', join(home, 'agents/omp'), () => ({ status: 'idle' }))
  t.after(() => { pi.dispose(); omp.dispose() })
  await pi.execute({ action: 'send', agent: 'm123-a12345', message: 'one' })
  await omp.execute({ action: 'send', agent: 'm123-a12345', message: 'two' })
  assert.deepEqual(calls.map(x => x.initiator.sessionId), ['session-pi', 'session-omp'])
  assert.notEqual(calls[0].initiator.agent, calls[1].initiator.agent)
  await pi.execute({ action: 'read', sessionId: 'session-omp' })
  assert.equal(calls.at(-1).readSession, 'session-pi', 'extra model arguments must never change the bound caller')
  await assert.rejects(pi.execute({ action: 'unrecognized' }), /action|enum|invalid/i)
})

test('extension wrapper is lazy, privately stored, and capability expires on dispose', async t => {
  const { home } = setup(t)
  const world = join(home, 'agents/omp')
  const binding = module.bindForeignHub('omp', 'session-omp', world, () => undefined)
  assert.equal(existsSync(world), false)
  const path = await binding.extensionPath()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const registered = []
  const extension = await import(new URL(`file://${path}`))
  extension.default({ registerTool: tool => registered.push(tool) })
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'superd-hub')
  assert.match(tool.description, /NEVER poll/)
  const result = await tool.execute('call-1', { action: 'agents' }, undefined)
  assert.equal(JSON.parse(result.content[0].text).action, 'agents')
  binding.dispose()
  assert.equal(existsSync(path), false)
  await assert.rejects(tool.execute('call-2', {}, undefined), /expired|unauthorized|binding|closed/i)
})

test('standalone adapters without a Hub do not create a plugin or listener', async () => {
  assert.equal(typeof module.bindForeignHub, 'function')
  const binding = module.bindForeignHub('pi', 'standalone', '/unowned/world', () => undefined)
  assert.equal(binding.definition(), undefined)
  assert.equal(await binding.extensionPath(), undefined)
  binding.dispose()
})

test('unbound HTTP callers cannot impersonate a live session', async t => {
  const { home, calls } = setup(t)
  const binding = module.bindForeignHub('pi', 'bound', join(home, 'agents/pi'), () => undefined)
  t.after(() => binding.dispose())
  const path = await binding.extensionPath()
  const text = readFileSync(path, 'utf8')
  const url = text.match(/"url":"([^"]+)"/)[1]
  const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: JSON.stringify({ action: 'send', message: 'bad' }) })
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
})

test('live delivery handle is visible before any tool materialization or draft IO', t => {
  const { home } = setup(t)
  const agent = { status: 'idle' }
  const world = join(home, 'agents/codex')
  const binding = module.bindForeignHub('codex', 'resumed', world, () => agent)
  assert.equal(module.foreignAgentHandle(home, 'resumed'), agent)
  assert.equal(existsSync(world), false)
  binding.dispose()
  assert.equal(module.foreignAgentHandle(home, 'resumed'), undefined)
})


test('host shutdown gives the model an explicit restart-and-resume recovery path', async t => {
  const { home, close } = setup(t)
  const binding = module.bindForeignHub('pi', 'restart-boundary', join(home, 'agents/pi'), () => undefined)
  t.after(() => binding.dispose())
  const path = await binding.extensionPath()
  let tool
  ;(await import(new URL(`file://${path}`))).default({ registerTool: value => { tool = value } })
  await close()
  await assert.rejects(tool.execute('after-shutdown', { action: 'agents' }), /Restart Super D, then resume/)
})
