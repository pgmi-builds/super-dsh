// P0 probe ② (fusion plan R4): does the sanctioned `connection/request`
// waterfall give a sibling plugin a per-request demux seat on ctx0's single
// /api route — and do the naive alternatives (duplicate registration) throw?
//
// Boot recipe (world-mount test pattern): bare boot() has NO resolution table
// (0.1.7), so we install PluginPackages with a createRuntimeResolution table
// for the probe profile, plus the profile's own node_modules farm link.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeResolution, loadProfile, PluginPackages, boot } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE = join(HERE, '../../..')  // super-dsh
const REPO_WT = dirname(LINE)
const REPO = dirname(REPO_WT)
const ANCHOR = join(REPO, 'upstream', 'deepseek-harness', 'apps', 'cli', 'package.json')
const FARM = join(LINE, 'node_modules', '@deepseek-ai')

function probeHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `superd-api-${tag}-`))
  const profile = join(home, 'profiles', 'p0')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(FARM, join(profile, 'node_modules', '@deepseek-ai'), 'dir')
  writeFileSync(join(profile, 'index.html'), '<!doctype html><title>p0</title>ok\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p0', private: true, dsh: { profile: { bundles: [] } } }) + '\n')
  writeFileSync(join(profile, 'cordis.yml'), [
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: client-connection',
    "  name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend-static',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: ${join(profile, 'index.html')}`,
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '',
  ].join('\n'))
  return { home, profile }
}

async function bootProbe(tag) {
  const { home, profile } = probeHome(tag)
  const loaded = loadProfile('dsh', 'p0', ANCHOR, home)
  const host = new Context()
  await host.plugin(PluginPackages, {
    resolution: await createRuntimeResolution({ installAnchor: ANCHOR, profile: loaded, home }),
  })
  const ctx = await boot('superd-api-probe', join(profile, 'cordis.yml'), [], () => { })
  return { home, host, ctx }
}

test('Q1 duplicate /api prefix registration throws', async () => {
  const seen = { duplicate: undefined }
  const { home, host, ctx } = await bootProbe('q1')
  try {
    try {
      ctx.webServer.register({ kind: 'prefix', path: '/api', handler: () => { } })
      seen.duplicate = 'accepted'
    } catch (e) {
      seen.duplicate = `threw: ${e.message}`
    }
    console.log('Q1:', seen.duplicate)
    assert.match(String(seen.duplicate), /threw:.*duplicate/)
  } finally {
    await ctx.fiber.dispose()
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('Q2+Q3 connection/request waterfall: observe query, veto+answer', async () => {
  const seen = { url: undefined, vetoed: false }
  const { home, host, ctx } = await bootProbe('q2')
  try {
    const port = ctx.webServer.port
    assert.ok(port > 0, `ephemeral port assigned (got ${port})`)
    ctx.on('connection/request', (req, res, next) => {
      seen.url = req.url
      const agent = new URL(req.url ?? '/', 'http://x').searchParams.get('agent')
      if (agent !== null && agent !== 'native') {
        seen.vetoed = true
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(`forwarded-to-world:${agent}`)
        return
      }
      return next()
    })
    // authenticate: mint the launch token via the connection service face
    const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
    const r0 = await fetch(authed, { redirect: 'manual' })
    const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0]
    console.log('Q0: auth r0 status', r0.status, 'loc', r0.headers.get('location'), 'cookie', (r0.headers.get('set-cookie') ?? 'NONE').slice(0, 40), 'body', (await r0.text()).slice(0, 60), 'url', authed.slice(0, 80))
    assert.ok(cookie.length > 0, `auth cookie minted (got ${JSON.stringify(cookie)})`)
    const r1 = await fetch(`http://127.0.0.1:${port}/api/some.endpoint?x=1`, { method: 'POST', body: '{}', headers: { cookie } })
    console.log('Q2: observer saw', seen.url, '| passthrough status', r1.status)
    assert.equal(seen.url, '/api/some.endpoint?x=1')
    assert.equal(seen.vetoed, false)
    const r2 = await fetch(`http://127.0.0.1:${port}/api/some.endpoint?agent=codex`, { method: 'POST', body: '{}', headers: { cookie } })
    const body = await r2.text()
    console.log('Q3: veto status', r2.status, 'body', body)
    assert.equal(r2.status, 200)
    assert.equal(body, 'forwarded-to-world:codex')
    assert.equal(seen.vetoed, true)
  } finally {
    await ctx.fiber.dispose()
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
