// Task 6: activation = roster membership + zero-touch world spawn + gateway
// target registration. Real dsh tree; requires SUPERD_DSH_ANCHOR.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Red line: pin the ambient DSH home to the test tree BEFORE anything
// resolves it (provision/join default to resolveDshHome() = ~/.dsh when the
// env is unset — the 0.1.6-era tests silently provisioned into the prod home
// farm; never again).
const ANCHOR = process.env.SUPERD_DSH_ANCHOR
// An ambient DSH_HOME inherited from a host dsh.service session points at the
// PROD home — treat that as unset (this suite runs from agent shells inside
// dsh.service). Explicit non-prod values are honored.
const __prodHomes = new Set(['/home/u1/.dsh', '/home/u1/.superd'])
const HOME = !process.env.DSH_HOME || __prodHomes.has(process.env.DSH_HOME)
  ? '/home/u1/workspaces/superd/.tests/superd'
  : process.env.DSH_HOME
if (process.env.DSH_HOME !== HOME) {
  process.stderr.write(`[world-plugin] ignoring prod DSH_HOME=${process.env.DSH_HOME}; using ${HOME}\n`)
}
process.env.DSH_HOME = HOME
const OMP_HOME = join(HOME, 'agents', 'omp')

// provision @pgmi-builds scope in the profile tree (0.1.7: nothing heals a
// profiles-level @deepseek-ai farm anymore — healProfilesModuleFallback is
// gone — so project the runtime resolution there ourselves).
const REPO = '/home/u1/workspaces/superd'
const ANCHOR_PATH = ANCHOR ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
const pm = join(HOME, 'profiles', 'node_modules', '@pgmi-builds')
mkdirSync(pm, { recursive: true })
const dst = join(pm, 'agent-adapter-omp')
rmSync(dst, { force: true })
symlinkSync(join(REPO, 'super-dsh/agent-omp'), dst)
const { createRuntimeResolution } = await import('@deepseek-ai/dsh-app-boot')
const __resolution = await createRuntimeResolution({ installAnchor: ANCHOR_PATH, home: HOME })
for (const entry of __resolution.entries) {
  const dest = join(HOME, 'profiles', 'node_modules', entry.name)
  if (existsSync(dest)) rmSync(dest, { force: true })
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(entry.packageDir, dest, 'dir')
}
process.env.SUPERD_BARE_BASE = join(HOME, 'profiles', 'node_modules') + '/'
process.env.OMP_HOME = OMP_HOME
mkdirSync(OMP_HOME, { recursive: true })

test('agent-omp: activation = roster + world spawn + gateway target', { skip: !ANCHOR && 'SUPERD_DSH_ANCHOR not set' }, async () => {
  const { name, apply } = await import('../dist/world-plugin.js')
  assert.equal(name, 'agent-omp')
  const routing = await import('@pgmi-builds/superd-hub')
  const provided = {}
  // The plugin awaits `ctx.inject(['webServer', 'connection'], ...)` for the
  // ctx0 listening stack; the test plays the host: a structural fake webServer
  // (same shape as superd-hub/test/world-mount.test.mjs) + connection fences.
  function fakeReal() {
    return {
      routes: new Map(), upgrades: new Map(), fallback: undefined,
      register(route) { const id = `${route.kind}:${route.path}`; this.routes.set(id, route); return () => this.routes.delete(id) },
      registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path) },
      registerFallback(handler) { this.fallback = handler; return () => { this.fallback = undefined } },
    }
  }
  const fakeHost = {
    webServer: fakeReal(),
    connection: { authorizeIndex: () => true, requestRejection: () => undefined },
  }
  apply({
    provide: (k, v) => { provided[k] = v },
    inject: (_services, cb) => { cb(fakeHost) },
    effect: () => {},
  })
  // readiness flips only when the world's gateway is live — await it first
  const ctxW = await provided['superd.world.omp']
  try {
    assert.deepEqual(routing.listAgents(), [{ key: 'omp', label: 'OMP', ready: true }])
    assert.ok(existsSync(OMP_HOME), 'nested home created')
    assert.notEqual(ctxW.get('typertGateway'), undefined, 'world gateway live')
    assert.notEqual(ctxW.get('sessionController'), undefined, 'world RPC face live')
    assert.notEqual(routing.getTarget('omp')?.gateway, undefined, 'target registered')
  } finally {
    await ctxW.fiber.dispose()
    // spawned server/child handles must not hold the test runner open
    setTimeout(() => process.exit(0), 250).unref()
  }
})
