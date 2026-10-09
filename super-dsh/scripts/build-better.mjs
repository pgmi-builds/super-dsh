// Build the independent same-repository tarball; development imports use this exact artifact.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, lstatSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { packPackage } from './pack-package.mjs'
import { assertReleaseVersions } from '../../scripts/release-version.mjs'

export function resolveBetterDashSource(repo) {
  const source = join(repo, 'better-dsh')
  if (!lstatSync(source).isDirectory()) throw new Error('Better Dash source must be a physical same-repository directory')
  return realpathSync(source)
}

export function buildBetterDash(line, repo, output, superManifest) {
  assertReleaseVersions(repo)
  const source = resolveBetterDashSource(repo)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (manifest.name !== 'better-dsh' || superManifest.dependencies?.['better-dsh'] !== manifest.version) {
    throw new Error(`Local better-dsh@${manifest.version} does not match the Super Dash exact dependency; update the pin deliberately`)
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[hook]) throw new Error(`Better Dash must not carry install hook ${hook}`)
  }
  for (const input of ['third_party/schemastery/lib/index.mjs', 'third_party/schemastery/lib/index.d.mts', 'third_party/schemastery/node_modules/@deepseek-ai/cosmokit/lib/index.js', 'third_party/schemastery/node_modules/@standard-schema/spec/dist/index.d.ts']) {
    if (!existsSync(join(source, input))) throw new Error(`Missing real Better Dash build input: ${input}`)
  }
  console.log(`[pack] building local better-dsh@${manifest.version} from ${source}`)
  rmSync(join(source, 'lib'), { recursive: true, force: true })
  execFileSync('npm', ['run', 'build'], { cwd: source, stdio: 'inherit' })
  for (const file of readdirSync(join(source, 'lib')).filter(file => file.endsWith('.js'))) {
    if (/from\s*["']#schemastery["']/.test(readFileSync(join(source, 'lib', file), 'utf8'))) throw new Error(`Unresolved private schema import in Better Dash: ${file}`)
  }
  const packed = packPackage(source, output)
  const tarball = join(output, packed.filename)
  const embedded = join(line, 'node_modules/better-dsh')
  rmSync(embedded, { recursive: true, force: true })
  mkdirSync(embedded, { recursive: true })
  execFileSync('tar', ['-xf', tarball, '-C', embedded, '--strip-components=1'])
  // Remove legacy staging; npm must resolve the exact ordinary dependency.
  rmSync(join(line, 'bundles'), { recursive: true, force: true })
  return { name: manifest.name, version: manifest.version, source, tarball }
}
