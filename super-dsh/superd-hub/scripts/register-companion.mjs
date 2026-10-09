// Separate-process entry for the SAME native package operations used by dsh plugin.
// No shell interpolation, package scripts, upstream edits, or online companion lookup.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
let input = ''
for await (const bytes of process.stdin) input += bytes
const {profile,expected} = JSON.parse(input)
const require = createRequire(profile.installAnchor)
const {runProfilePnpm,saveManifest} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
const {withFileLock,writeFileAtomic} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
const abort = new AbortController()
process.once('SIGTERM', () => abort.abort())
const json = async path => JSON.parse(await readFile(path, 'utf8'))
async function optionalJson(path) { try { return await json(path) } catch(error) { if(error.code === 'ENOENT') return undefined; throw error } }
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
  let owner
  try { owner = await json(join(ownerDir, 'package.json')) }
  catch (error) { if (error.code === 'ENOENT') return skipped('owner-changed'); throw error }
  const item=expected.companion
  if(owner.name !== 'super-dsh' || owner.version !== item.version || owner.dependencies?.[item.name] !== item.version) return skipped('owner-changed')
  // Resolve from the owner: a retained older direct Better may coexist with the new transitive version.
  const ownerRequire=createRequire(join(ownerDir,'package.json'))
  const downloaded=await json(ownerRequire.resolve(item.name+'/package.json'))
  if(downloaded.name !== item.name || downloaded.version !== item.version) throw new Error('The user installation did not fetch the exact companion dependency')
  const prior = current.dependencies?.[item.name]
  if (prior !== expected.priorSpec) return skipped(prior === undefined && expected.priorSpec !== undefined ? 'companion-removed' : 'companion-changed')
  abort.signal.throwIfAborted()
  // A plain npm consumer already has the exact transitive files but not a pnpm
  // store. Fresh hoisted registration changes metadata only, preserving npm ci.
  const npmLockPath=join(profile.dir,'package-lock.json')
  const npmLock=await optionalJson(npmLockPath)
  const staged=structuredClone(current)
  staged.dependencies={...staged.dependencies,[item.name]:item.version}
  const selectNew=manifest=>{
    if(prior !== undefined)return
    const bundles=manifest.dsh?.profile?.bundles??[]
    manifest.dsh={...manifest.dsh,profile:{...manifest.dsh?.profile,bundles:[...bundles,...bundles.includes(item.name)?[]:[item.name]]}}
  }
  const installedBefore=await optionalJson(join(profile.dir,'node_modules',item.name,'package.json'))
  if(npmLock?.packages?.[''] && installedBefore?.version === item.version) {
    const beforeLock=await readFile(npmLockPath,'utf8')
    npmLock.packages[''].dependencies={...npmLock.packages[''].dependencies,[item.name]:item.version}
    try {
      selectNew(staged)
      await writeFileAtomic(npmLockPath,JSON.stringify(npmLock,null,2)+'\n',{mode:0o600})
      await saveManifest(profile.dir,staged)
    } catch(error) { await writeFileAtomic(npmLockPath,beforeLock,{mode:0o600});await saveManifest(profile.dir,current);throw error }
    return {exitCode:0,disposition:'installed'}
  }
  // No named spec: native add --offline still does online pnpm view preflight.
  // Stage the exact dependency under the same lock, then re-layout cached files
  // with the package manager that actually produced the consumer's lockfile.
  await saveManifest(profile.dir,staged)
  let operation
  try {
    operation=await runProfilePnpm({profile:profile.name,dir:profile.dir,installAnchor:profile.installAnchor,cwd:profile.dir,home:profile.home},
      npmLock ? ['install','--offline','--ignore-scripts','--no-audit','--no-fund'] : ['install','--offline','--ignore-scripts','--no-frozen-lockfile'], {
      ...profile.packageManager, ...npmLock?{command:'npm',args:[]}: {},
      execution:'service', signal:abort.signal, outputBytes:16384,
      lookupTimeoutMs:120000, idleTimeoutMs:120000,
    })
    if(operation.exitCode !== 0) { await saveManifest(profile.dir,current) }
    else {
      const installed=await json(join(profile.dir,'node_modules',item.name,'package.json'))
      const after=await json(join(profile.dir,'package.json'))
      if(installed.name !== item.name || installed.version !== item.version || after.dependencies?.[item.name] !== item.version) throw new Error('Native companion registration did not resolve the exact cached registry version')
      selectNew(after)
      await saveManifest(profile.dir,after)
    }
  } catch(error) { await saveManifest(profile.dir,current);throw error }
  return { exitCode: operation.exitCode, logPath: operation.logPath, disposition: 'installed' }
})
process.stdout.write(JSON.stringify(result)+'\n')
