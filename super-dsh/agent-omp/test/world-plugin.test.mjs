// Task 6: activation = roster membership + zero-port world spawn + gateway
// target registration. Real dsh tree; anchor auto-derives to the repo build
// (SUPERD_DSH_ANCHOR overrides), skipping only when that tree is absent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Three levels up: test/ -> agent-omp -> super-dsh -> repo root.
const REPO = join(new URL('../../..', import.meta.url).pathname)
// Red line: pin the ambient DSH home to an ISOLATED test tree BEFORE anything
// resolves it (provision/join default to resolveDshHome() = ~/.dsh when the
// env is unset). This suite never touches a live line home (docs/07 §3.2;
// super-dsh/AGENTS: 绝不写进在役线 home).
// An ambient DSH_HOME inherited from a host dsh.service session points at the
// PROD home — treat that as unset. Explicit non-prod values are honored.
const __prodHomes = new Set([join(homedir(), '.dsh'), join(homedir(), '.superd')])
const HOME = !process.env.DSH_HOME || __prodHomes.has(process.env.DSH_HOME)
  ? join(REPO, '.tests', 'omp-world-test')
  : process.env.DSH_HOME
if (process.env.DSH_HOME !== HOME) {
  process.stderr.write(`[world-plugin] ignoring prod DSH_HOME=${process.env.DSH_HOME}; using ${HOME}\n`)
}
process.env.DSH_HOME = HOME
const OMP_HOME = join(HOME, 'agents', 'omp')
mkdirSync(OMP_HOME, { recursive: true })

// Repo-build anchor (same default as the hermes twin and
// superd-hub/test/world-mount.test.mjs): the world-plugin honors
// SUPERD_DSH_ANCHOR at module scope, so set it before importing
// dist/world-plugin.js.
const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? join(REPO, 'upstream/deepseek-harness/apps/cli/package.json')
process.env.SUPERD_DSH_ANCHOR = ANCHOR

// provision @pgmi-builds scope in the ISOLATED home's profile tree (0.1.7:
// nothing heals a profiles-level @deepseek-ai farm anymore — project the
// runtime resolution there ourselves). The world composition resolves the
// hub rows (`@pgmi-builds/superd-hub` + its `/world` entry) AND this adapter
// through SUPERD_BARE_BASE — link BOTH (an isolated home has nothing
// pre-linked; the old live-home default only needed the adapter).
const pm = join(HOME, 'profiles', 'node_modules', '@pgmi-builds')
mkdirSync(pm, { recursive: true })
for (const [name, target] of Object.entries({
  'superd-hub': join(REPO, 'super-dsh/superd-hub'),
  'agent-omp': join(REPO, 'super-dsh/agent-omp'),
})) {
  const dst = join(pm, name)
  rmSync(dst, { force: true })
  symlinkSync(target, dst)
}
const { createRuntimeResolution } = await import('@deepseek-ai/dsh-app-boot')
const __resolution = await createRuntimeResolution({ installAnchor: ANCHOR, home: HOME })
for (const entry of __resolution.entries) {
  const dest = join(HOME, 'profiles', 'node_modules', entry.name)
  if (existsSync(dest)) rmSync(dest, { force: true })
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(entry.packageDir, dest, 'dir')
}
process.env.SUPERD_BARE_BASE = join(HOME, 'profiles', 'node_modules') + '/'
process.env.OMP_HOME = OMP_HOME

test('agent-omp: activation = roster + world spawn + gateway target', { skip: !existsSync(ANCHOR) && `dsh install anchor not found: ${ANCHOR}` }, async () => {
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
