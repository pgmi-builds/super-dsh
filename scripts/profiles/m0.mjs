#!/usr/bin/env node
// M0/M1 test-profile bootstrap: creates .superd-test/profiles/m0 and installs the
// link: dep tree (no @deepseek-ai nesting: pnpm hoisted linker + autoInstallPeers=false,
// mirroring the omp-web profile precedent).
//
// package.json is written idempotently against the desired dependency/bundle
// set below: appending a bundle here updates an existing profile in place
// (no delete+recreate dance).
//
// Usage: node scripts/m0-profile.mjs
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(repoRoot, '.superd-test')
const profile = join(home, 'profiles', 'm0')

mkdirSync(profile, { recursive: true })

// Desired profile manifest (single source of truth for this script).
const profileManifest = {
  name: 'dsh-profile-m0',
  private: true,
  dependencies: {
    // link: relative to the profile dir; @deepseek-ai/* bundles resolve from
    // the global dsh vendored tree (omp-web two-layer resolution precedent)
    '@pgmi-builds/dsh-multi-agent-registry': 'link:../../../apps/multi-agent/dsh-multi-agent-registry',
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@pgmi-builds/dsh-multi-agent-registry',
      ],
    },
  },
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const pkgPath = join(profile, 'package.json')
const desiredPkg = JSON.stringify(profileManifest, null, 2) + '\n'
if (readIfExists(pkgPath) !== desiredPkg) {
  writeFileSync(pkgPath, desiredPkg)
  console.log('wrote', pkgPath)
}

const patchPath = join(profile, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  writeFileSync(patchPath, `# Profile layer for m0: dev/test port convention (AGENTS.md 三).
- id: webserver
  config:
    # config is whole-value replacement: restate host alongside port
    host: 127.0.0.1
    port: 4998 # ruling 2026-09-09: 4999 held by a foreign long-lived dsh instance; m0 dev/test moved to 4998
`)
  console.log('wrote', patchPath)
}

// pnpm workspace config: hoisted linker so the host-resolved @deepseek-ai peers
// stay unnested (nested copies break cordis scopeOf identity); no peer auto-install.
const wsPath = join(profile, 'pnpm-workspace.yaml')
if (!existsSync(wsPath)) {
  writeFileSync(wsPath, `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
storeDir: ../../.npm-cache/pnpm-store
`)
  console.log('wrote', wsPath)
}

// Rebuild package dists if missing (dist/ is gitignored in the packages).
for (const pkg of ['dsh-multi-agent-registry']) {
  const distIndex = join(repoRoot, `apps/multi-agent/${pkg}/dist/index.js`)
  if (!existsSync(distIndex)) {
    console.log(`dist missing for ${pkg}, building…`)
    const r = spawnSync('npx', ['tsc', '-p', `apps/multi-agent/${pkg}`], { cwd: repoRoot, stdio: 'inherit' })
    if (r.status !== 0) { console.error('package build failed'); process.exit(1) }
  }
}

console.log('installing profile deps with pnpm…')
const r = spawnSync('pnpm', ['install', '--store-dir', join(repoRoot, '.npm-cache/pnpm-store')], { cwd: profile, stdio: 'inherit' })
if (r.status !== 0) { console.error('pnpm install failed'); process.exit(1) }

console.log('\ndone. proof run:')
console.log(`DSH_HOME=${home} /home/u1/.local/bin/dsh --profile m0 --dump-config`)
