// Frozen, physical Pi SDK delivery. Upstream files and hooks stay verbatim;
// pnpm consumes them as an already bundled tree rather than installing them.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PI_PACKAGE = '@earendil-works/pi-coding-agent'
const json = path => JSON.parse(readFileSync(path, 'utf8'))

export function embedPiDependencyTree(line, tree) {
  const wanted = json(join(line, 'package.json')).dependencies?.[PI_PACKAGE]
  const modules = resolve(tree, 'node_modules'), sdk = join(modules, PI_PACKAGE)
  const manifest = json(join(sdk, 'package.json'))
  if (manifest.name !== PI_PACKAGE || manifest.version !== wanted) throw new Error('Pi SDK version does not match the pack exact pin')
  if (existsSync(join(modules, '@deepseek-ai'))) throw new Error('Pi SDK tree must not carry duplicate harness modules')
  const destination = join(line, 'node_modules', PI_PACKAGE)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(sdk, destination, { recursive: true, dereference: true })
  // npm ci hoists Pi's transitive packages beside the SDK. Nest that closure
  // under the SDK so it cannot rely on the development workspace's modules.
  cpSync(modules, join(destination, 'node_modules'), {
    recursive: true, dereference: true,
    filter: path => path !== sdk && path !== join(modules, '.bin') && path !== join(modules, '.package-lock.json'),
  })
  return manifest.version
}

export function buildPiBundle(line, repo) {
  const source = join(line, 'agent-pi/runtime'), tree = join(repo, '.scratch/pi-sdk-bundle')
  const wanted = json(join(line, 'package.json')).dependencies?.[PI_PACKAGE]
  if (json(join(source, 'package.json')).dependencies?.[PI_PACKAGE] !== wanted
    || json(join(line, 'agent-pi/package.json')).dependencies?.[PI_PACKAGE] !== wanted) {
    throw new Error('Pi SDK build, adapter and pack exact pins must agree')
  }
  mkdirSync(tree, { recursive: true })
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(source, name), join(tree, name))
  console.log(`[pack] preparing frozen Pi SDK ${wanted}, installation scripts disabled`)
  execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], { cwd: tree, stdio: 'inherit' })
  return embedPiDependencyTree(line, tree)
}

export function verifyPiBundle(tarball, version) {
  const root = 'package/node_modules/' + PI_PACKAGE
  const sdk = JSON.parse(execFileSync('tar', ['-xOf', tarball, root + '/package.json'], { encoding: 'utf8' }))
  if (sdk.name !== PI_PACKAGE || sdk.version !== version) throw new Error('Packed Pi SDK identity differs from the exact pin')
  // The original hooks and their prebuilt runtimes must be physical files in
  // the archive, not packages fetched and approved on the consumer machine.
  for (const path of ['dist/index.js', 'node_modules/@google/genai/dist/node/index.mjs',
    'node_modules/@google/genai/package.json', 'node_modules/protobufjs/index.js',
    'node_modules/protobufjs/scripts/postinstall.js']) {
    execFileSync('tar', ['-xOf', tarball, root + '/' + path], { stdio: 'ignore' })
  }
}
