// super-dsh pack orchestrator — THE build entry (docs/06 §三 discipline).
// Builds every component and produces the single delivery tarball:
//
//   node super-dsh/scripts/pack.mjs [--keep-going]
//
// The dev 4999 line and the npm release consume the SAME artifact from here;
// nothing else may hand-assemble super-dsh dists or tarballs.
import { execSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = dirname(LINE)
const PACK_DIR = join(REPO, '.scratch/superd-pack')

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
const AGENTS = ['agent-omp', 'agent-codex', 'agent-claude', 'agent-pi', 'agent-hermes', 'agent-agy']
const GENERATED = [
  join(LINE, 'superd-hub', 'dist'),
  join(LINE, 'superd-hub', 'lib'),
  ...AGENTS.map((pkg) => join(LINE, pkg, 'dist')),
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
}

const { version } = JSON.parse(readFileSync(join(LINE, 'package.json'), 'utf8'))
console.log(`[pack] npm pack super-dsh@${version}`)
run(`mkdir -p ${PACK_DIR}`, REPO)
run(`npm pack --pack-destination ${PACK_DIR}`, LINE)
console.log(`[pack] tarball: ${PACK_DIR}/super-dsh-${version}.tgz`)
