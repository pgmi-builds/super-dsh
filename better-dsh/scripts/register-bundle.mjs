// Separate-process entry for the SAME native package operations used by dsh plugin.
// No shell interpolation, package scripts, upstream edits, or companion registry lookup.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
let input = ''
for await (const bytes of process.stdin) input += bytes
const {profile,archive,expected} = JSON.parse(input)
const require = createRequire(profile.installAnchor)
const {runProfilePnpm} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
const {withFileLock} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
const abort = new AbortController()
process.once('SIGTERM', () => abort.abort())
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function contained(root, path) {
  if (typeof path !== 'string' || isAbsolute(path)) throw new Error('Pack delivery path must be relative')
  const base = await realpath(root), file = await realpath(resolve(base, path)), rel = relative(base, file)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Pack delivery path escapes its owner')
  return file
}
const skipped = disposition => ({ exitCode: 0, disposition })
// Complete each native acquisition/release before observing cancellation;
// exiting during its async lock-file write can strand incomplete lock metadata.
async function withCancellableProfileLock(operation) {
  const path = join(profile.dir, 'package.json'), deadline = Date.now() + 120000
  for (;;) {
    abort.signal.throwIfAborted()
    let acquired = false
    try {
      return await withFileLock(path, async () => {
        acquired = true
        abort.signal.throwIfAborted()
        return operation()
      }, { waitMs: Math.min(250, Math.max(0, deadline - Date.now())) })
    } catch (error) {
      abort.signal.throwIfAborted()
      if (acquired || Date.now() >= deadline
        || error.message !== `atomic-write: timed out waiting for the writer lock at ${path}.lock`) throw error
    }
  }
}
const result = await withCancellableProfileLock(async () => {
  abort.signal.throwIfAborted()
  const current = await json(join(profile.dir, 'package.json'))
  if (typeof expected.ownerSpec !== 'string' || current.dependencies?.[expected.owner] !== expected.ownerSpec) return skipped('owner-changed')
  const ownerDir = join(profile.dir, 'node_modules', expected.owner)
  let owner, descriptorPath, descriptor
  try {
    owner = await json(join(ownerDir, 'package.json'))
    if (owner.dependencies?.[expected.companion.name] !== expected.companion.version || owner.superd?.delivery === undefined) return skipped('owner-changed')
    descriptorPath = await contained(ownerDir, owner.superd.delivery)
    descriptor = await json(descriptorPath)
  } catch (error) {
    if (error.code === 'ENOENT') return skipped('owner-changed')
    throw error
  }
  const item = descriptor.companions?.find(item => item.name === expected.companion.name)
  if (item?.version !== expected.companion.version || item.sha256 !== expected.companion.sha256
    || hash(await readFile(await contained(dirname(descriptorPath), item.tarball))) !== expected.companion.sha256) return skipped('owner-changed')
  const prior = current.dependencies?.[item.name]
  if (prior !== expected.priorSpec) return skipped(prior === undefined && expected.priorSpec !== undefined ? 'companion-removed' : 'companion-changed')
  if (hash(await readFile(archive)) !== item.sha256) throw new Error('Cached companion SHA256 mismatch')
  abort.signal.throwIfAborted()
  // Same public operation and writer lock used by the native Plugin Manager;
  // intent is checked after acquisition, before a queued install can undo removal.
  const operation = await runProfilePnpm({profile:profile.name,dir:profile.dir,installAnchor:profile.installAnchor,cwd:profile.dir,home:profile.home}, ['add','file:'+archive,'--ignore-scripts'], {
    ...profile.packageManager, execution:'service', signal:abort.signal, outputBytes:16384,
    lookupTimeoutMs:120000, idleTimeoutMs:120000,
  })
  if (operation.exitCode === 0) {
    const installed = await json(join(profile.dir, 'node_modules', item.name, 'package.json'))
    const after = await json(join(profile.dir, 'package.json'))
    if (installed.name !== item.name || installed.version !== item.version || after.dependencies?.[item.name] !== 'file:' + archive) throw new Error('Native companion registration did not install the exact local artifact')
  }
  return { exitCode: operation.exitCode, logPath: operation.logPath, disposition: 'installed' }
})
process.stdout.write(JSON.stringify(result)+'\n')
