import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildProbeCommand, formatStatus, formatTargets, parseProbeOutput } from '../../src/remote/preparation.ts'
import type { StatusLine } from '../../src/remote/preparation.ts'

const TARGET = {
  name: 'dev3',
  backend: 'ssh' as const,
  host: 'dev3.example.com',
  port: 22,
  user: 'u1',
  identityFile: '~/.ssh/id_ed25519',
}

// Task 6 degraded exec 会包 cd 守卫 + bash -lc + 尾哨兵；这里只管探针本体
const FULL_PROBE = [
  'user=u1',
  'host=dev3.example.com',
  'path-node=/opt/node/bin/node',
  'ver-node=v22.23.2',
  'path-pnpm=/usr/local/bin/pnpm',
  'ver-pnpm=9.12.0',
  'path-python=/usr/bin/python',
  'ver-python=Python 3.11.9',
  'path-pip=/usr/bin/pip',
  'ver-pip=pip 23.0.1 from /usr/lib/python3.11/site-packages/pip (python 3.11)',
  'path-git=/usr/bin/git',
  'ver-git=git version 2.43.0',
  'sudo=nopasswd',
  'bash=5.1.16(1)-release',
  '',
].join('\n')

describe('buildProbeCommand', () => {
  it('contains the required probe fragments', () => {
    const cmd = buildProbeCommand()
    expect(cmd).toContain('id -un')
    expect(cmd).toContain('hostname')
    expect(cmd).toContain('command -v')
    expect(cmd).toContain('node --version')
    expect(cmd).toContain('sudo -n true')
    expect(cmd).toContain('BASH_VERSION')
    // 六个工具都要被探测
    for (const tool of ['node', 'pnpm', 'python', 'python3', 'pip', 'git']) {
      expect(cmd).toContain(tool)
    }
  })

  it('is deterministic and parseable by parseProbeOutput (real bash round-trip)', () => {
    expect(buildProbeCommand()).toBe(buildProbeCommand())
    const raw = execFileSync('bash', ['-c', buildProbeCommand()], { encoding: 'utf8' })
    const facts = parseProbeOutput(raw)
    expect(facts.user).toBeTruthy()
    expect(facts.bashVersion).toMatch(/^\d+\./)
    expect(['nopasswd', 'password', 'no']).toContain(facts.sudo)
    expect(facts.tools.map((t) => t.name)).toContain('node')
    const node = facts.tools.find((t) => t.name === 'node')!
    expect(node.version).toMatch(/^v?\d+\./)
    expect(node.path).toBeTruthy()
  })
})

describe('parseProbeOutput', () => {
  it('parses full probe output into complete facts', () => {
    const facts = parseProbeOutput(FULL_PROBE)
    expect(facts.user).toBe('u1')
    expect(facts.host).toBe('dev3.example.com')
    expect(facts.bashVersion).toBe('5.1.16(1)-release')
    expect(facts.sudo).toBe('nopasswd')
    expect(facts.tools).toEqual([
      { name: 'node', path: '/opt/node/bin/node', version: 'v22.23.2' },
      { name: 'pnpm', path: '/usr/local/bin/pnpm', version: '9.12.0' },
      { name: 'python', path: '/usr/bin/python', version: '3.11.9' },
      { name: 'pip', path: '/usr/bin/pip', version: '23.0.1' },
      { name: 'git', path: '/usr/bin/git', version: '2.43.0' },
    ])
  })

  it('parses the sudo three states', () => {
    expect(parseProbeOutput('sudo=nopasswd\n').sudo).toBe('nopasswd')
    expect(parseProbeOutput('sudo=password\n').sudo).toBe('password')
    expect(parseProbeOutput('sudo=no\n').sudo).toBe('no')
  })

  it('handles partial output: missing lines → partial facts, never throws', () => {
    const facts = parseProbeOutput('user=u1\nver-node=v20.11.1\n')
    expect(facts.user).toBe('u1')
    expect(facts.host).toBeUndefined()
    expect(facts.bashVersion).toBeUndefined()
    expect(facts.sudo).toBe('no') // sudo 行缺席 → 最保守假设
    expect(facts.tools).toEqual([{ name: 'node', version: 'v20.11.1' }])
  })

  it('ignores motd noise, CRLF, and empty input', () => {
    const noisy = 'Welcome to Ubuntu 24.04\r\nuser=ops\r\nLast login: today\r\nsudo=password\r\n'
    expect(parseProbeOutput(noisy).user).toBe('ops')
    expect(parseProbeOutput(noisy).sudo).toBe('password')
    expect(parseProbeOutput('')).toEqual({ tools: [], sudo: 'no' })
    expect(parseProbeOutput('garbage line without equals\n= novalue\n').tools).toEqual([])
  })

  it('normalizes per-tool version strings', () => {
    const facts = parseProbeOutput([
      'ver-python=Python 3.12.4',
      'ver-pip=pip 24.0 from /x (python 3.12)',
      'ver-git=git version 2.45.1',
      'ver-python3=Python 3.12.4',
    ].join('\n'))
    const byName = Object.fromEntries(facts.tools.map((t) => [t.name, t.version]))
    expect(byName['python']).toBe('3.12.4')
    expect(byName['python3']).toBe('3.12.4')
    expect(byName['pip']).toBe('24.0')
    expect(byName['git']).toBe('2.45.1')
  })

  it('keeps canonical tool order and tolerates empty version values', () => {
    const facts = parseProbeOutput('path-git=/usr/bin/git\nver-node=\npath-node=/opt/node/bin/node\n')
    expect(facts.tools.map((t) => t.name)).toEqual(['node', 'git'])
    expect(facts.tools[0]).toEqual({ name: 'node', path: '/opt/node/bin/node' })
    expect(facts.tools[1]).toEqual({ name: 'git', path: '/usr/bin/git' })
  })
})

describe('formatStatus', () => {
  const FACTS = {
    user: 'u1',
    host: 'dev3.example.com',
    rttMs: 38,
    tools: [
      { name: 'node', path: '/opt/node/bin/node', version: 'v22.23.2' },
      { name: 'pnpm', version: '9.12' },
      { name: 'python', version: '3.11' },
    ],
    bashVersion: '5.1.16(1)-release',
    sudo: 'nopasswd' as const,
  }

  it('renders the §3.3 block verbatim for the full happy path', () => {
    const out = formatStatus({
      target: { ...TARGET, defaultCwd: '/srv/app', env: { NODE_ENV: 'test' } },
      facts: FACTS,
      conn: { state: 'ready', sinceMs: 92_000 },
    })
    expect(out.split('\n')).toEqual([
      'target : dev3 → u1@dev3.example.com:22  (key ~/.ssh/id_ed25519, via ~/.ssh/config)',
      'conn   : alive 1m32s   rtt 38ms',
      'cwd    : /srv/app   (default, registry)',
      'env    : login-shell (bash -lc) + NODE_ENV=test',
      'tools  : node v22.23.2 (/opt/node/bin/node) · pnpm 9.12 · python 3.11',
      'sudo   : NOPASSWD ✓',
    ])
  })

  it('renders not-connected, session line, and session cwd taking precedence', () => {
    const out = formatStatus({
      target: TARGET,
      session: { mode: 'pty', cwd: '/tmp/work' },
    })
    expect(out.split('\n')).toEqual([
      'target : dev3 → u1@dev3.example.com:22  (key ~/.ssh/id_ed25519, via ~/.ssh/config)',
      'conn   : not connected',
      'cwd    : /tmp/work',
      'env    : login-shell (bash -lc)',
      'session : pty · cwd /tmp/work',
    ])
  })

  it('renders the closed connection state distinctly (still a not-connected conn line)', () => {
    const out = formatStatus({ target: TARGET, conn: { state: 'closed' } })
    expect(out).toContain('conn   : not connected (closed)')
  })

  it('renders degraded session mode and cwd fallback to registry default', () => {
    const out = formatStatus({
      target: { ...TARGET, defaultCwd: '/srv/app' },
      session: { mode: 'exec' },
    })
    expect(out).toContain('session : exec (degraded)')
    expect(out).toContain('cwd    : /srv/app   (default, registry)')
  })

  it('omits rtt when no facts accompany a ready connection', () => {
    const out = formatStatus({ target: TARGET, conn: { state: 'ready', sinceMs: 500 } })
    expect(out).toContain('conn   : alive <1s')
    expect(out).not.toContain('rtt')
  })

  it('renders sudo password-required / no sudo', () => {
    const base: StatusLine = { target: TARGET, facts: { tools: [], sudo: 'password' } }
    expect(formatStatus(base)).toContain('sudo   : password-required')
    expect(formatStatus({ target: TARGET, facts: { tools: [], sudo: 'no' } })).toContain('sudo   : no sudo')
  })

  it('renders (unset) cwd and empty tools list', () => {
    const out = formatStatus({ target: { ...TARGET, user: undefined, identityFile: undefined }, facts: { tools: [], sudo: 'no' } })
    expect(out).toContain('target : dev3 → dev3.example.com:22') // 无 user、无 key 括注
    expect(out).toContain('cwd    : (unset)')
    expect(out).toContain('tools  : (none found)')
  })

  it('renders multiple injected env vars', () => {
    const out = formatStatus({ target: { ...TARGET, env: { NODE_ENV: 'test', FOO: 'bar' } } })
    expect(out).toContain('env    : login-shell (bash -lc) + NODE_ENV=test + FOO=bar')
  })

  it('error replaces the facts block (dial failure)', () => {
    const out = formatStatus({
      target: TARGET,
      conn: { state: 'idle' },
      error: 'E_AUTH: authentication failed',
    })
    expect(out).toContain('target : dev3 → u1@dev3.example.com:22')
    expect(out).toContain('error : E_AUTH: authentication failed')
    expect(out).not.toContain('conn   :')
    expect(out).not.toContain('tools  :')
    expect(out).not.toContain('sudo   :')
    expect(out).not.toContain('cwd    :')
  })
})

describe('formatTargets', () => {
  it('lists one line per target with alive marker and default cwd annotation', () => {
    const out = formatTargets([
      { name: 'dev3', host: 'dev3.example.com', port: 22, user: 'u1', alive: true, defaultCwd: '/srv/app' },
      { name: 'mac', host: '192.0.2.7', port: 2201, alive: false },
    ])
    expect(out.split('\n')).toEqual([
      'dev3 : u1@dev3.example.com:22  ✓ alive  (default cwd /srv/app)',
      'mac  : 192.0.2.7:2201  · offline',
    ])
  })

  it('renders the empty registry', () => {
    expect(formatTargets([])).toBe('(no targets)')
  })
})
