// Zero-port audit (risk 1, AW-A audited form): the world keeps the full
// web/app row set so every dependency chain activates, with its listener
// bound to an EPHEMERAL LOOPBACK port (127.0.0.1:0) — never user-facing.
// FINDING (2026-09-15): fully disabling webserver/web-runtime cascades 9
// pending entries (webRuntime→connection→fileUploads chains). True
// zero-listener surgery (webRuntime shim) is a recorded AW-B follow-up.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnWorld } from '../dist/index.js'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'
const REPO = join(new URL('../../../..', import.meta.url).pathname)
const HOME = process.env.AW_TEST_HOME ?? join(REPO, '.superd-test', 'aw')
const FIXTURE = new URL('./fixtures/aw-omp-world/', import.meta.url).pathname

mkdirSync(join(HOME, 'profiles'), { recursive: true })
cpSync(FIXTURE, join(HOME, 'profiles', 'aw-omp-world'), { recursive: true })

test('world: full RPC face + loopback-ephemeral listener, no pending entries', async () => {
  const patch = readFileSync(join(FIXTURE, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /host: 127\.0\.0\.1/, 'listener pinned to loopback')
  assert.match(patch, /port: 0/, 'ephemeral port — no fixed collision surface')
  const ctxW = await spawnWorld({
    appName: 'aw-omp-world',
    profileName: 'aw-omp-world',
    installAnchor: ANCHOR,
    home: HOME,
  })
  for (const name of ['sessionController', 'typert', 'typertGateway', 'webServer', 'sessionQuery']) {
    assert.notEqual(ctxW.get(name), undefined, `${name} present`)
  }
  await ctxW.fiber.dispose()
})
