// super-dsh pack orchestrator — THE build entry (docs/06 §三 discipline).
// Builds every component and produces the single delivery tarball:
//
//   node super-dsh/scripts/pack.mjs [--keep-going]
//
// The dev 4999 line and the npm release consume the SAME artifact from here;
// nothing else may hand-assemble super-dsh dists or tarballs.
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packPackage } from './pack-package.mjs'
import { buildBetterDash } from './build-better.mjs'
import { buildRemote } from './build-remote.mjs'
import { verifyPackagePair } from './verify-package-pair.mjs'
import { buildPiBundle, verifyPiBundle, PI_PACKAGE } from './build-pi.mjs'

const LINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = dirname(LINE)
const PACK_DIR = join(REPO, '.scratch/superd-pack')
mkdirSync(PACK_DIR, { recursive: true })
rmSync(join(PACK_DIR, 'pair.json'), { force: true })
const manifest = JSON.parse(readFileSync(join(LINE, 'package.json'), 'utf8'))
const betterDash = buildBetterDash(LINE, REPO, PACK_DIR, manifest)
// Regenerates super-dsh/remote — a PRIVATE hub-internal dependency since ADR
// 0016 (the hub exec/PTY/file lanes import its process primitives); it carries
// no composite row and no public export, and must exist before the hub's tsc
// build, which resolves its declarations.
await buildRemote()

const run = (cmd, cwd) => execSync(cmd, {
  cwd,
  stdio: 'inherit',
  // claude-agent-sdk + zod 4 types blow the default heap under tsc.
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() },
})

// Stale-output hygiene: the packed `files` list names whole `dist`/`lib`
// directories, so any file left behind by a renamed or deleted source (the
// 0.1.7-retired `agent-preset-projection`, the old `spike`/`app-home`/`labels`
// modules) would ship silently in the next release. Clean every generated
// directory first; `super-dsh/client/index.js` is deliberately tracked and is
// rewritten by build-superd-client.mjs below.
const AGENTS = ['agent-omp', 'agent-codex', 'agent-claude', 'agent-pi', 'agent-hermes', 'agent-agy',
  // The opt-in SDK half of the Antigravity split (world key `agy-sdk`). Built
  // and packed like every other adapter — its composite row is `disabled: true`.
  'agent-agy-sdk',
  // The opt-in SDK transport for OMP (world key `omp-sdk`, 2026-10-03 user
  // ruling): the SAME adapter logic as `agent-omp` with an injectable transport
  // that drives an in-process bun sidecar instead of one `omp --mode rpc`
  // child per session. Built and packed like every other adapter, but its
  // composite row is `disabled: true` AND it declares no dependency: the bun
  // runtime + `@oh-my-pi/pi-coding-agent` are fetched into the world home on
  // first real use (agent-omp-sdk/src/sdk-runtime.ts).
  'agent-omp-sdk',
  // The PRESERVED SDK line of Codex (world key `codex-sdk`, 2026-10-04 user
  // ruling): the app-server line is the PRIMARY path, so this one is kept as an
  // option rather than deleted. Its composite row is `disabled: true`, and it
  // declares no dependency at all — `@openai/codex-sdk` plus the codex binary
  // are fetched into the world home on first real use
  // (agent-codex-sdk/src/sdk-runtime.ts).
  'agent-codex-sdk']
const GENERATED = [
  join(LINE, 'superd-hub', 'dist'),
  join(LINE, 'superd-hub', 'lib'),
  ...AGENTS.map((pkg) => join(LINE, pkg, 'dist')),
  join(LINE, 'agent-omp', 'lib'),
]
for (const dir of GENERATED) rmSync(dir, { recursive: true, force: true })
console.log(`[pack] cleaned ${GENERATED.length} generated dir(s)`)

console.log('[pack] building superd-hub (tsc + client halves)')
run('npm run build', join(LINE, 'superd-hub'))
run('npm run build-client', join(LINE, 'superd-hub'))
run('node scripts/build-superd-client.mjs', join(LINE, 'superd-hub'))

for (const pkg of AGENTS) {
  console.log(`[pack] building ${pkg} (tsc)`)
  run('npm run build', join(LINE, pkg))
  const component = JSON.parse(readFileSync(join(LINE, pkg, 'package.json'), 'utf8'))
  if (component.scripts?.['build-client']) run('npm run build-client', join(LINE, pkg))
}

const { version } = manifest
buildPiBundle(LINE, REPO)
console.log(`[pack] npm pack super-dsh@${version}`)
packPackage(LINE, PACK_DIR)
console.log(`[pack] tarball: ${PACK_DIR}/super-dsh-${version}.tgz`)
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const superDash = { name: manifest.name, version, source: LINE, tarball: join(PACK_DIR, `super-dsh-${version}.tgz`) }
verifyPiBundle(superDash.tarball, manifest.dependencies[PI_PACKAGE])
const independentPackages = verifyPackagePair(superDash.tarball, betterDash.tarball)
console.log('[pack] verified independent synchronized packages; no Better dependency or payload in Super')
const pair = { independentPackages, builtAt: new Date().toISOString(), betterDash: { ...betterDash, sha256: sha256(betterDash.tarball) }, superDash: { ...superDash, sha256: sha256(superDash.tarball) } }
writeFileSync(join(PACK_DIR, 'pair.json'), JSON.stringify(pair, null, 2) + '\n')
for (const item of [pair.betterDash, pair.superDash]) console.log(`[pack] ${item.name}@${item.version}: ${item.sha256}`)
