import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const PORT = 4999
const BASE = `http://127.0.0.1:${PORT}`
const repoRoot = join(import.meta.dirname, '..')

describe('superd web smoke (P1 acceptance)', { timeout: 120_000, sequential: true }, () => {
  let child: ChildProcess | undefined
  let tokenUrl = ''

  it('boots on 4999 and prints the token URL line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'superd-smoke-'))
    child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', 'src/bin.ts', 'web', '--port', String(PORT), '--home', home],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => { stderr += chunk })
    tokenUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(
        () => reject(new Error(`no URL line within 60s\nstderr:\n${stderr}\nstdout:\n${buf}`)), 60_000)
      child!.stdout!.setEncoding('utf8')
      child!.stdout!.on('data', (chunk: string) => {
        buf += chunk
        const match = buf.match(/^superd: (https?:\/\/\S+)/m)
        if (match?.[1]) { clearTimeout(timer); resolve(match[1]) }
      })
      child!.on('exit', code => { clearTimeout(timer); reject(new Error(`exited early code=${code}\nstderr:\n${stderr}`)) })
    })
    expect(tokenUrl).toContain(`127.0.0.1:${PORT}/?token=`)
  })

  it('unauthenticated probe → 401 with the upstream dsh-auth fingerprint', async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('dsh web authentication required')
  })

  it('token URL mints a cookie; authenticated shell serves 200 with the neutral roster', async () => {
    const mint = await fetch(tokenUrl, { redirect: 'manual' })
    expect(mint.status).toBe(303)
    const setCookie = mint.headers.get('set-cookie')
    expect(setCookie).toMatch(/^dsh-auth-/)
    const cookie = setCookie!.split(';')[0]!

    const page = await fetch(`${BASE}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('__DSH_BOOT__')
    for (const id of ['modules', 'connection', 'api-remotes', 'ui-layout', 'ui-renderer', 'ui-sidebar', 'ui-settings']) {
      expect(html).toContain(id)
    }
  })

  afterAll(() => { child?.kill('SIGTERM') })
})
