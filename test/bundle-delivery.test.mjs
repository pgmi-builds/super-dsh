import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {packPackage} from '../super-dsh/scripts/pack-package.mjs'
const anchor=resolve('upstream/deepseek-harness/apps/cli/package.json')
const require=createRequire(anchor)
const {withFileLock}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
const {runProfilePnpm}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
const json=(path,data)=>writeFileSync(path,JSON.stringify(data,null,2)+'\n')
const read=path=>JSON.parse(readFileSync(path,'utf8'))
test('native CLI registers the embedded companion independently and retains disabled/removal choices',async t=>{
 const api=await import('../better-dsh/lib/bundle-delivery.js').catch(()=>({}));assert.equal(typeof api.reconcileBundledDelivery,'function','production delivery coordinator is available')
 const root=mkdtempSync(join(tmpdir(),'superd-independent-'))
 try{
  const home=join(root,'home'),dir=join(home,'profiles','delivery-test'),owner=join(dir,'node_modules','super-dsh'),better=join(root,'better'),out=join(root,'out')
  mkdirSync(join(owner,'bundles'),{recursive:true});mkdirSync(better)
  writeFileSync(join(dir,'pnpm-workspace.yaml'),'packages: [.]\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const profile={home,dir,name:'delivery-test',installAnchor:anchor,cwd:dir,patchPath:join(dir,'cordis.patch.yml'),startedBundles:['super-dsh'],overlays:[]}
  json(join(dir,'package.json'),{name:'delivery-fixture',private:true,dependencies:{'super-dsh':'file:'+owner},dsh:{profile:{bundles:['super-dsh']}}})
  const artifact=version=>{
   json(join(better,'package.json'),{name:'better-dsh',version,files:['cordis.patch.yml'],dsh:{bundle:{patch:'./cordis.patch.yml'}}});writeFileSync(join(better,'cordis.patch.yml'),'[]\n')
   const packed=packPackage(better,out),bytes=readFileSync(join(out,packed.filename)),sha256=createHash('sha256').update(bytes).digest('hex')
   copyFileSync(join(out,packed.filename),join(owner,'bundles/better-dsh.tgz'))
   json(join(owner,'bundles/manifest.json'),{companions:[{name:'better-dsh',version,tarball:'./better-dsh.tgz',sha256}]})
   json(join(owner,'package.json'),{name:'super-dsh',version,dependencies:{'better-dsh':version},superd:{delivery:'./bundles/manifest.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}});writeFileSync(join(owner,'cordis.patch.yml'),'[]\n')
  }
  artifact('0.3.0-d')
  const source=join(root,'super-source');mkdirSync(join(source,'bundles'),{recursive:true});
  const syncOwner=()=>{
   for(const file of ['package.json','cordis.patch.yml','bundles/manifest.json','bundles/better-dsh.tgz'])copyFileSync(join(owner,file),join(source,file))
   const m=read(join(source,'package.json'));m.bundledDependencies=['better-dsh'];m.files=['bundles','cordis.patch.yml'];json(join(source,'package.json'),m)
   const nested=join(source,'node_modules/better-dsh');rmSync(nested,{recursive:true,force:true});mkdirSync(nested,{recursive:true});execFileSync('tar',['-xf',join(source,'bundles/better-dsh.tgz'),'-C',nested,'--strip-components=1'])
   const packed=packPackage(source,out);const profileManifest=read(join(dir,'package.json'));profileManifest.dependencies['super-dsh']='file:'+join(out,packed.filename);json(join(dir,'package.json'),profileManifest)
  }
  syncOwner()
  await api.reconcileBundledDelivery(profile)
  const first=read(join(dir,'package.json'));assert.deepEqual(first.dsh.profile.bundles,['super-dsh','better-dsh']);assert.match(first.dependencies['better-dsh'],/^file:/);const cached=first.dependencies['better-dsh'].slice(5);assert.ok(existsSync(cached));assert.equal(read(join(dir,'node_modules/better-dsh/package.json')).version,'0.3.0-d')
  const before=readFileSync(join(dir,'package.json'),'utf8');await api.reconcileBundledDelivery(profile);assert.equal(readFileSync(join(dir,'package.json'),'utf8'),before)
  const receipt=join(home,'bundle-artifacts',createHash('sha256').update(dir).digest('hex')+'.json')
  await t.test('an exact installed no-op repairs a lost receipt before a later uninstall',async()=>{
   rmSync(receipt)
   await api.reconcileBundledDelivery(profile)
   assert.ok(existsSync(receipt),'restart after installation must recover the successful receipt')
   assert.equal(read(receipt)['super-dsh:better-dsh'],read(join(owner,'bundles/manifest.json')).companions[0].sha256)
   const mutate=args=>withFileLock(join(dir,'package.json'),()=>runProfilePnpm({profile:profile.name,dir,installAnchor:anchor,cwd:dir,home},args,{execution:'service',outputBytes:16384}))
   const removed=await mutate(['remove','better-dsh','--ignore-scripts']);assert.equal(removed.exitCode,0,removed.output)
   await api.reconcileBundledDelivery(profile)
   assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined,'a recovered receipt must honor the subsequent native uninstall')
   const restored=await mutate(['add','file:'+cached,'--ignore-scripts']);assert.equal(restored.exitCode,0,restored.output)
  })
  first.dsh.profile.bundles=['super-dsh'];json(join(dir,'package.json'),first)
  artifact('0.3.0-e');syncOwner();await api.reconcileBundledDelivery(profile)
  const updated=read(join(dir,'package.json'));assert.deepEqual(updated.dsh.profile.bundles,['super-dsh']);assert.equal(read(join(dir,'node_modules/better-dsh/package.json')).version,'0.3.0-e');assert.ok(existsSync(cached),'prior file specs remain reinstallable')
  await t.test('native uninstall under the profile lock wins over a queued companion update',async()=>{
   artifact('0.3.0-f');syncOwner()
   const digest=read(join(owner,'bundles/manifest.json')).companions[0].sha256
   const archive=join(home,'bundle-artifacts','better-dsh-'+digest+'.tgz')
   let pending
   await withFileLock(join(dir,'package.json'),async()=>{
    pending=api.reconcileBundledDelivery(profile)
    const deadline=Date.now()+10000
    for(;;){
     const children=readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean)
     const started=children.some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('register-bundle.mjs')}catch{return false}})
     if(existsSync(archive)&&started)break
     assert.ok(Date.now()<deadline,'coordinator must cache the artifact and start its native child while the lock is held')
     await new Promise(resolve=>setTimeout(resolve,20))
    }
    const result=await runProfilePnpm({profile:profile.name,dir,installAnchor:anchor,cwd:dir,home},['remove','better-dsh','--ignore-scripts'],{execution:'service',outputBytes:16384})
    assert.equal(result.exitCode,0,result.output)
   },{waitMs:10000})
   assert.deepEqual(await pending,{installed:[],restartRequired:false},'skipped delivery must not report installation')
   assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined,'queued delivery must not undo the native uninstall')
   assert.deepEqual(read(join(dir,'package.json')).dsh.profile.bundles,['super-dsh'])
   await api.reconcileBundledDelivery(profile)
   assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined,'the removed artifact must stay removed on the next synchronization')
  })
  const removed=read(join(dir,'package.json'));delete removed.dependencies['better-dsh'];json(join(dir,'package.json'),removed);rmSync(join(dir,'node_modules/better-dsh'),{recursive:true,force:true});await api.reconcileBundledDelivery(profile);assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined,'same artifact does not fight explicit uninstall')
  await t.test('unloading while the native writer lock is held cancels its child without awaiting that lock',async()=>{
   artifact('0.3.0-g');syncOwner()
   const abort=new AbortController()
   await withFileLock(join(dir,'package.json'),async()=>{
    const pending=api.reconcileBundledDelivery(profile,abort.signal)
    const observed=pending.then(()=>{throw new Error('cancelled delivery unexpectedly completed')},error=>error)
    const deadline=Date.now()+10000
    for(;;){
     const children=readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean)
     if(children.some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('register-bundle.mjs')}catch{return false}}))break
     assert.ok(Date.now()<deadline,'native child starts before cancellation')
     await new Promise(resolve=>setTimeout(resolve,20))
    }
    abort.abort(new Error('bundle unloaded'))
    let timeout
    try{const error=await Promise.race([observed,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('cancelled child retained native lock waiter')),1500)})]);assert.match(error.message,/bundle unloaded/)}finally{clearTimeout(timeout)}
    assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined)
   },{waitMs:10000})
  })
  artifact('0.3.0-h');writeFileSync(join(owner,'bundles/better-dsh.tgz'),'tampered');await assert.rejects(api.reconcileBundledDelivery(profile),/digest|SHA256/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
