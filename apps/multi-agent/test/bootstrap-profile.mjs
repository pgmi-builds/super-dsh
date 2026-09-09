#!/usr/bin/env node
// Multi-Agent test-profile bootstrap: creates .superd-test/profiles/ma and
// installs the link: dep tree (pnpm hoisted linker + autoInstallPeers=false —
// nested @deepseek-ai copies break cordis scopeOf identity, omp-web precedent).
//
// Idempotent: package.json is rewritten against the manifest below (append a
// bundle here to update an existing profile in place); cordis.patch.yml is
// only written when absent.
//
// Usage: node apps/multi-agent/test/bootstrap-profile.mjs
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const home = join(repoRoot, '.superd-test')
const profile = join(home, 'profiles', 'ma')

mkdirSync(profile, { recursive: true })

// Desired profile manifest (single source of truth for this script).
const profileManifest = {
  name: 'dsh-profile-ma',
  private: true,
  dependencies: {
    // link: relative to the profile dir; @deepseek-ai/* bundles resolve from
    // the global dsh vendored tree (omp-web two-layer resolution precedent)
    '@pgmi-builds/dsh-multi-agent-registry': 'link:../../../apps/multi-agent/dsh-multi-agent-registry',
    '@pgmi-builds/agent-omp-sdk': 'link:../../../apps/multi-agent/agent-omp-sdk',
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@pgmi-builds/dsh-multi-agent-registry',
        '@pgmi-builds/agent-omp-sdk',
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

// Profile layer: dev/test port + LAN bind (AGENTS.md 三: user acceptance from
// LAN/external; loopback-only instances are invisible to the user). The
// runtime derives LAN trust from the 0.0.0.0 bind; external domains go
// through --trusted-host on the launch script, not here.
const patchPath = join(profile, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  writeFileSync(patchPath, `# Profile layer for ma (multi-agent): port + LAN bind.
- id: webserver
  config:
    # config is whole-value replacement: restate host alongside port
    host: 0.0.0.0
    port: 4999
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

// Rebuild package dists if missing (dist/ and lib/ are gitignored).
for (const pkg of ['dsh-multi-agent-registry', 'agent-omp-sdk']) {
  const distIndex = join(repoRoot, `apps/multi-agent/${pkg}/dist/index.js`)
  if (!existsSync(distIndex)) {
    console.log(`dist missing for ${pkg}, building…`)
    const r = spawnSync('npx', ['tsc', '-p', `apps/multi-agent/${pkg}`], { cwd: repoRoot, stdio: 'inherit' })
    if (r.status !== 0) { console.error('package build failed'); process.exit(1) }
  }
}
// Client half of agent-omp-sdk (lib/client — dsh.client compose target).
const clientIndex = join(repoRoot, 'apps/multi-agent/agent-omp-sdk/lib/client/index.js')
if (!existsSync(clientIndex)) {
  console.log('client bundle missing for agent-omp-sdk, building…')
  const r = spawnSync('npm', ['run', 'build-client'], { cwd: join(repoRoot, 'apps/multi-agent/agent-omp-sdk'), stdio: 'inherit' })
  if (r.status !== 0) { console.error('client build failed'); process.exit(1) }
}

console.log('installing profile deps with pnpm…')
const r = spawnSync('pnpm', ['install', '--store-dir', join(repoRoot, '.npm-cache/pnpm-store')], { cwd: profile, stdio: 'inherit' })
if (r.status !== 0) { console.error('pnpm install failed'); process.exit(1) }

console.log('\ndone. proof run:')
console.log(`DSH_HOME=${home} /home/u1/.local/bin/dsh --profile ma --dump-config`)
