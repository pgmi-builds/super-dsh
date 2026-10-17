// Live-install staleness heal (2026-10-18): the fusion row's ARMED state and
// its roster advertisement, plus the reload decision they feed.
//
// The bug this pins shut: the flag global and the transport script are baked
// into the SERVED index, so a page that booted before super-dsh was installed
// ran the hot-loaded client half with `fusionPage()` false forever — the Hub
// sidebar row rendered but the agent selector did not, and only a manual app
// restart healed it. The heal: the row publishes `fusionTransportArmed()`,
// the roster GET carries it additively as `hub.fusion`, and the client half
// (`fusionReloadDecision` + switch.ts `probeStaleFusionPage`) re-boots the
// page ONCE on an armed host. Own process (node --test isolates per file) so
// the module-level armed counter starts at zero here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply: applyFusion, fusionTransportArmed } = await import('../dist/fusion-transport.js')
const { handleAgentRuntime } = await import('../dist/rpc.js')
const { FUSION_RELOAD_MARKER, fusionReloadDecision } = await import('../dist/switch-core.js')

/** The emission harness: inject/ordered-listener/effect semantics of a cordis ctx. */
function harness() {
  const injectCbs = []
  const listeners = []
  const effectDisposers = []
  return {
    inject(_deps, cb) { injectCbs.push(cb) },
    on(_event, fn) {
      listeners.push(fn)
      return () => {
        const at = listeners.indexOf(fn)
        if (at !== -1) listeners.splice(at, 1)
      }
    },
    effect(fn, _label) { effectDisposers.push(fn()) },
    materialize() { for (const cb of [...injectCbs]) cb() },
    disposeEffects() { for (const dispose of [...effectDisposers]) dispose() },
    emit(table) { for (const fn of [...listeners]) fn(table) },
  }
}

test('the armed state is false before any mount and rides the listener lifetime', () => {
  assert.equal(fusionTransportArmed(), false, 'dormant until a fusion row mounts')
  const ctx = harness()
  applyFusion(ctx, { enabled: true })
  ctx.materialize()
  assert.equal(fusionTransportArmed(), true, 'armed exactly while the index-inject listener is live')
  // The armed listener still does its day job: script + flag global.
  const table = []
  ctx.emit(table)
  assert.equal(table.length, 2, 'the armed listener pushes the transport + flag rows')
  // Disposal (row disable/unload) resets the advertisement AND the injection.
  ctx.disposeEffects()
  assert.equal(fusionTransportArmed(), false, 'disposal un-arms — a disabled row must never advertise fusion')
  const after = []
  ctx.emit(after)
  assert.equal(after.length, 0, 'the disposed listener injects nothing')
  // Re-mount re-arms (HMR re-apply shape).
  const again = harness()
  applyFusion(again, { enabled: true })
  again.materialize()
  assert.equal(fusionTransportArmed(), true, 'a fresh mount re-arms')
  // Balance the module counter for the tests below: they own their mounts.
  again.disposeEffects()
  assert.equal(fusionTransportArmed(), false)
})

test('the roster GET advertises hub.fusion additively, riding the armed state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superd-armed-'))
  try {
    const source = { listRuntimes: () => ['native'] }
    // Armed (test 1 leaves its last mount live — module state is the point):
    // the field answers the LIVE armed state, additively.
    const ctx = harness()
    applyFusion(ctx, { enabled: true })
    ctx.materialize()
    const armed = await (await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source, { home })).json()
    assert.equal(armed.hub.fusion, true, 'armed row → hub.fusion true (the stale-page reload signal)')
    // Disposal un-advertises: a disabled row must never trigger the reload.
    ctx.disposeEffects()
    const dormant = await (await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source, { home })).json()
    assert.equal(dormant.hub.fusion, false, 'disposed row → hub.fusion false (the T-E shape stays degraded)')
    // Pre-existing hub fields ride unchanged (additive contract).
    assert.equal(dormant.hub.machineId, armed.hub.machineId)
    assert.equal(dormant.hub.version, armed.hub.version)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---- the pure decision the client half runs on the answer ------------------

test('fusionReloadDecision: armed pages and answered-off pages never reload', () => {
  assert.equal(fusionReloadDecision({ flagPresent: true, markerPresent: false, hubFusion: true }), 'armed')
  assert.equal(fusionReloadDecision({ flagPresent: true, markerPresent: true, hubFusion: true }), 'armed')
  // The T-E flag-off shape: the host ANSWERS false — degraded, never reloaded.
  assert.equal(fusionReloadDecision({ flagPresent: false, markerPresent: false, hubFusion: false }), 'row-off')
})

test('fusionReloadDecision: the stale pre-install page reloads exactly once per session', () => {
  // The fresh-install page: no flag, no marker, armed host → the one reload.
  assert.equal(fusionReloadDecision({ flagPresent: false, markerPresent: false, hubFusion: true }), 'reload')
  // The marker (set just before the reload) makes every later probe a no-op —
  // a host that reports fusion but never bakes the flag can never loop a tab.
  assert.equal(fusionReloadDecision({ flagPresent: false, markerPresent: true, hubFusion: true }), 'already-reloaded')
})

test('fusionReloadDecision: an unusable answer degrades to no action', () => {
  // Old host (pre-additive): the field is absent.
  assert.equal(fusionReloadDecision({ flagPresent: false, markerPresent: false, hubFusion: undefined }), 'host-silent')
  // Malformed values are not `true`, so they cannot trigger the reload.
  assert.equal(fusionReloadDecision({ flagPresent: false, markerPresent: false, hubFusion: 'yes' }), 'host-silent')
  assert.equal(fusionReloadDecision({ flagPresent: false, markerPresent: false, hubFusion: 1 }), 'host-silent')
})

test('the sessionStorage marker key is a single constant across the halves', () => {
  assert.equal(FUSION_RELOAD_MARKER, 'superd.fusion-armed.reload')
})
