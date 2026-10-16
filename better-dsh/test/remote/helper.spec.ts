import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelperRegistry, helperAssets, archTriple, type HelperAssets, type HelperExec } from '../../src/remote/helper.ts'
import { buildHelperProbeArgv, buildHelperUploadArgv, buildHelperOneShotArgv, buildHelperKillgroupArgv } from '../../src/remote/transports.ts'
import type { TargetPlan } from '../../src/remote/target.ts'

const VER = '9.9.9-t'
const TRIPLE = 'x86_64-unknown-linux-musl'
const SSH_PLAN = { kind: 'ssh', host: 'dev2' } as unknown as TargetPlan
const DOCKER_PLAN = { kind: 'docker', container: 'ctr1' } as unknown as TargetPlan

const PROBE_MISS = { exit: 90, stdout: 'SUPERD-PROBE Linux x86_64\n' }
const PROBE_HIT = (ver: string) => ({ exit: 0, stdout: `SUPERD-READY /root/.cache/superd/run/${TRIPLE}-${ver}/superd-run\nSUPERD-RUN proto=1 name=superd-run ver=${ver} target=${TRIPLE} os=linux pdeathsig=1 pid=1\n` })

async function makeAssets(): Promise<{ assets: HelperAssets; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'superd-helper-assets-'))
  await mkdir(join(dir, TRIPLE))
  await writeFile(join(dir, TRIPLE, 'superd-run'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  await writeFile(join(dir, 'MANIFEST.json'), JSON.stringify({ format: 1, name: 'superd-run', ver: VER, protocol: 1, targets: { [TRIPLE]: { file: 'superd-run', bytes: 4, sha256: 'deadbeef' } } }))
  return { assets: { dir, manifest: (await helperAssets(dir))!.manifest }, cleanup: async () => { await rm(dir, { recursive: true, force: true }) } }
}

it('archTriple maps shipped combos and refuses everything else', () => {
  const shipped = new Set([TRIPLE, 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin'])
  expect(archTriple('Linux', 'x86_64', shipped)).toBe(TRIPLE)
  expect(archTriple('Linux', 'aarch64', shipped)).toBe('aarch64-unknown-linux-musl')
  expect(archTriple('Darwin', 'arm64', shipped)).toBe('aarch64-apple-darwin')
  expect(archTriple('Darwin', 'x86_64', shipped)).toBeNull() // unshipped on purpose: no intel mac target
  expect(archTriple('Windows_NT', 'AMD64', shipped)).toBeNull() // helper-reachable windows is D5-pending
  expect(archTriple('Linux', 'riscv64', shipped)).toBeNull()
  expect(archTriple('Linux', 'x86_64', new Set())).toBeNull() // arch fine, target not shipped
})

it('helperAssets returns null for missing or malformed manifests', async () => {
  expect(helperAssets(join(tmpdir(), 'definitely-missing-superd'))).toBeNull()
  const dir = await mkdtemp(join(tmpdir(), 'superd-helper-bad-'))
  await writeFile(join(dir, 'MANIFEST.json'), 'not json')
  expect(helperAssets(dir)).toBeNull()
  await rm(dir, { recursive: true, force: true })
})

it('helper argv shapes: probe/upload single sh hop; run/killgroup one remote parse', () => {
  const assets = { dir: '/x', manifest: { format: 1 as const, name: 'superd-run', ver: VER, protocol: 1, targets: { [TRIPLE]: { file: 'superd-run', bytes: 4, sha256: 'x' } } } }
  const probe = buildHelperProbeArgv(SSH_PLAN, assets)
  expect(probe[0]).toBe('ssh')
  const script = probe.at(-1)!
  expect(script).toContain('SUPERD-READY')
  expect(script).toContain(`$HOME/.cache/superd/run/${TRIPLE}-${VER}`)
  expect(script).toContain('SUPERD-PROBE')
  expect(script.trimEnd().endsWith('exit 90')).toBe(true)

  const upload = buildHelperUploadArgv(SSH_PLAN, TRIPLE, 'superd-run', assets)
  const upScript = upload.at(-1)!
  expect(upScript).toContain('mkdir -p "$HOME/.cache/superd/run')
  expect(upScript).toContain('cat >')
  expect(upScript).toContain('chmod 0755')
  expect(upScript).toContain('mv -f')

  const dockerProbe = buildHelperProbeArgv(DOCKER_PLAN, assets)
  expect(dockerProbe).toContain('sh')
  expect(dockerProbe).toContain('-c')

  const run = buildHelperOneShotArgv(SSH_PLAN, '/root/.cache/superd/run/x/superd-run', { tag: 'ab12cd34', cmd: "echo 'hi' ; exit 7" })
  expect(run[0]).toBe('ssh')
  expect(run.at(-1)).toContain('exec ')
  expect(run.at(-1)).toContain('run --tag ')
  expect(run.at(-1)).toContain('-- bash -lc ')

  const dockerRun = buildHelperOneShotArgv(DOCKER_PLAN, '/root/.cache/superd/run/x/superd-run', { tag: 'ab12cd34', cmd: 'echo hi' })
  expect(dockerRun.slice(0, 5)).toEqual(['docker', 'exec', '-i', '--', 'ctr1'])
  // cmd rides as ONE argv token — no shell parse inside docker exec.
  expect(dockerRun.at(-1)).toBe('echo hi')
  expect(dockerRun).toContain('bash')

  const kg = buildHelperKillgroupArgv(DOCKER_PLAN, '/root/.cache/superd/run/x/superd-run', 'ab12cd34')
  expect(kg).toEqual(['docker', 'exec', '--', 'ctr1', '/root/.cache/superd/run/x/superd-run', 'killgroup', '--tag', 'ab12cd34'])
})

it('registry: miss → upload → verify hits; sticky ready with no extra probes', async () => {
  const { assets, cleanup } = await makeAssets()
  const calls: { argv: string[]; stdin?: Buffer }[] = []
  const exec: HelperExec = async (argv, options) => {
    calls.push({ argv, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) })
    if (options?.stdin !== undefined) return { exit: 0, stdout: '' }
    return calls.filter(c => c.stdin === undefined).length <= 1 ? PROBE_MISS : PROBE_HIT(VER)
  }
  const registry = new HelperRegistry(assets, exec, buildHelperProbeArgv, buildHelperUploadArgv)
  try {
    const info = await registry.ensure(SSH_PLAN)
    expect(info).toEqual({ binPath: `/root/.cache/superd/run/${TRIPLE}-${VER}/superd-run`, triple: TRIPLE, ver: VER, protocol: 1 })
    expect(calls.length).toBe(3) // probe, upload, verify
    expect(calls[1]!.stdin).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) // raw binary bytes on stdin
    const again = await registry.ensure(SSH_PLAN)
    expect(again).toEqual(info)
    expect(calls.length).toBe(3) // sticky: zero extra hops
  } finally { await cleanup() }
})

it('registry: upload failure parks sticky null and the shim stays the path', async () => {
  const { assets, cleanup } = await makeAssets()
  const calls: { argv: string[]; stdin?: Buffer }[] = []
  const exec: HelperExec = async (argv, options) => {
    calls.push({ argv })
    if (options?.stdin !== undefined) return { exit: 1, stdout: '' } // readonly home / noexec
    return PROBE_MISS
  }
  const registry = new HelperRegistry(assets, exec, buildHelperProbeArgv, buildHelperUploadArgv)
  try {
    expect(await registry.ensure(SSH_PLAN)).toBeNull()
    expect(calls.length).toBe(2)
    expect(await registry.ensure(SSH_PLAN)).toBeNull()
    expect(calls.length).toBe(2) // sticky absent: no retry storm
  } finally { await cleanup() }
})

it('registry: version-skewed cache banner is treated as a miss and re-uploaded', async () => {
  const { assets, cleanup } = await makeAssets()
  let probeCount = 0
  const exec: HelperExec = async (_argv, options) => {
    if (options?.stdin !== undefined) return { exit: 0, stdout: '' }
    probeCount += 1
    return probeCount === 1 ? PROBE_MISS : PROBE_HIT(VER + '-old')
  }
  const registry = new HelperRegistry(assets, exec, buildHelperProbeArgv, buildHelperUploadArgv)
  try {
    // verify probe reports a stale version → parseReady rejects → sticky null (honest shim),
    // never a silent run under an unpinned helper.
    expect(await registry.ensure(SSH_PLAN)).toBeNull()
    expect(probeCount).toBe(2)
  } finally { await cleanup() }
})

it('registry: garbage probe output parks null immediately', async () => {
  const { assets, cleanup } = await makeAssets()
  const calls: string[][] = []
  const exec: HelperExec = async (argv) => {
    calls.push(argv)
    return { exit: 1, stdout: 'some native error\n' }
  }
  const registry = new HelperRegistry(assets, exec, buildHelperProbeArgv, buildHelperUploadArgv)
  try {
    expect(await registry.ensure(DOCKER_PLAN)).toBeNull()
    expect(calls.length).toBe(1)
  } finally { await cleanup() }
})
