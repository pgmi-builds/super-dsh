import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {packPackage} from '../super-dsh/scripts/pack-package.mjs'
const anchor=resolve('upstream/deepseek-harness/apps/cli/package.json'),require=createRequire(anchor)
const {withFileLock}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
const {runProfilePnpm}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
const json=(path,data)=>writeFileSync(path,JSON.stringify(data,null,2)+'\n'),read=path=>JSON.parse(readFileSync(path,'utf8'))
test('one install fetches exact companion; native offline promotion retains independent lifecycle',async t=>{
 const api=await import('../super-dsh/superd-hub/dist/bundle-setup.js');assert.equal(typeof api.reconcileRegistryCompanions,'function')
 const root=mkdtempSync(join(tmpdir(),'superd-registry-')),versions={},requests=[]
 const server=createServer((req,res)=>{
  requests.push(req.url)
  if(req.url==='/better-dsh'){const m={name:'better-dsh','dist-tags':{latest:Object.keys(versions).at(-1)},versions:{}};for(const [v,item] of Object.entries(versions))m.versions[v]={...item.manifest,dist:{tarball:`http://127.0.0.1:${server.address().port}/better-${v}.tgz`,integrity:'sha512-'+createHash('sha512').update(item.bytes).digest('base64')}};res.setHeader('content-type','application/json');res.end(JSON.stringify(m));return}
  const item=Object.entries(versions).find(([v])=>req.url===`/better-${v}.tgz`)?.[1];if(item){res.end(item.bytes);return}res.statusCode=404;res.end('{}')
 });await new Promise(r=>server.listen(0,'127.0.0.1',r))
 try{
  const home=join(root,'home'),dir=join(home,'profiles','registry-test'),better=join(root,'better'),superSource=join(root,'super'),out=join(root,'out');mkdirSync(dir,{recursive:true});mkdirSync(better);mkdirSync(superSource)
  json(join(dir,'package.json'),{name:'registry-fixture',private:true,dependencies:{},dsh:{profile:{bundles:[]}}});writeFileSync(join(dir,'pnpm-workspace.yaml'),'packages: [.]\nnodeLinker: hoisted\nautoInstallPeers: false\n');writeFileSync(join(dir,'.npmrc'),`registry=http://127.0.0.1:${server.address().port}/\nstore-dir=${join(root,'store')}\n`)
  const profile={home,dir,name:'registry-test',installAnchor:anchor,cwd:dir,patchPath:join(dir,'cordis.patch.yml'),startedBundles:[],overlays:[]}
  const mutate=args=>withFileLock(join(dir,'package.json'),()=>runProfilePnpm({profile:profile.name,dir,home,installAnchor:anchor,cwd:dir},args,{execution:'service',outputBytes:16384,lookupTimeoutMs:3000}))
  const key=randomUUID(),artifact=n=>{
   const version=`0.0.${n}-${key}`,m={name:'better-dsh',version,files:['cordis.patch.yml'],exports:{'./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}};json(join(better,'package.json'),m);writeFileSync(join(better,'cordis.patch.yml'),'[]\n');const b=packPackage(better,out);versions[version]={manifest:m,bytes:readFileSync(join(out,b.filename))}
   json(join(superSource,'package.json'),{name:'super-dsh',version,files:['cordis.patch.yml'],dependencies:{'better-dsh':version},dsh:{bundle:{patch:'./cordis.patch.yml'}}});writeFileSync(join(superSource,'cordis.patch.yml'),'[]\n');return {version,tarball:join(out,packPackage(superSource,out).filename)}
  }
  const first=artifact(1);let result=await mutate(['add','file:'+first.tarball,'--ignore-scripts']);assert.equal(result.exitCode,0,result.output)
  assert.equal(read(join(dir,'node_modules/better-dsh/package.json')).version,first.version,'the single user install already downloaded exact Better');assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined,'fixture must not pre-promote Better')
  let seen=requests.length;assert.deepEqual(await api.reconcileRegistryCompanions(profile),{installed:['better-dsh@'+first.version],restartRequired:true});assert.equal(requests.length,seen,'native offline promotion must not make any registry request');assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],first.version);assert.deepEqual(read(join(dir,'package.json')).dsh.profile.bundles,['super-dsh','better-dsh']);assert.equal(existsSync(join(home,'bundle-artifacts')),false)
  assert.deepEqual(await api.reconcileRegistryCompanions(profile),{installed:[],restartRequired:false})
  const receipt=join(home,'companion-registration',createHash('sha256').update(dir).digest('hex')+'.json');rmSync(receipt);await api.reconcileRegistryCompanions(profile);assert.equal(read(receipt)['super-dsh:better-dsh'],first.version)
  const disabled=read(join(dir,'package.json'));disabled.dsh.profile.bundles=['super-dsh'];json(join(dir,'package.json'),disabled)
  const second=artifact(2);result=await mutate(['add','file:'+second.tarball,'--ignore-scripts']);assert.equal(result.exitCode,0,result.output);seen=requests.length;await api.reconcileRegistryCompanions(profile);assert.equal(requests.length,seen);assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],second.version);assert.deepEqual(read(join(dir,'package.json')).dsh.profile.bundles,['super-dsh'],'upgrade preserves Better disablement')
  result=await mutate(['remove','better-dsh','--ignore-scripts']);assert.equal(result.exitCode,0,result.output);await api.reconcileRegistryCompanions(profile);assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined,'same-version explicit uninstall remains removed')
  await t.test('queued registration cannot undo native uninstall',async()=>{
   const next=artifact(3);result=await mutate(['add','file:'+next.tarball,'--ignore-scripts']);assert.equal(result.exitCode,0,result.output)
   // Retain a direct dependency so an uninstall while registration queues is observable.
   const m=read(join(dir,'package.json'));m.dependencies['better-dsh']=second.version;json(join(dir,'package.json'),m)
   let pending
   await withFileLock(join(dir,'package.json'),async()=>{pending=api.reconcileRegistryCompanions(profile);await waitChild();const removed=await runProfilePnpm({profile:profile.name,dir,home,installAnchor:anchor,cwd:dir},['remove','better-dsh','--ignore-scripts'],{execution:'service',outputBytes:16384});assert.equal(removed.exitCode,0,removed.output)},{waitMs:10000});assert.deepEqual(await pending,{installed:[],restartRequired:false});await api.reconcileRegistryCompanions(profile);assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined)
  })
  await t.test('bundle disposal cancels registration waiting on the native lock',async()=>{
   const next=artifact(4);result=await mutate(['add','file:'+next.tarball,'--ignore-scripts']);assert.equal(result.exitCode,0,result.output)
   const abort=new AbortController();await withFileLock(join(dir,'package.json'),async()=>{const pending=api.reconcileRegistryCompanions(profile,abort.signal);const rejected=assert.rejects(pending,/bundle unloaded/);await waitChild();abort.abort(new Error('bundle unloaded'));await rejected},{waitMs:10000});assert.equal(read(join(dir,'package.json')).dependencies['better-dsh'],undefined)
  })
  await t.test('plain npm installation registers from its own cache without pnpm or registry requests',async()=>{
   const npmDir=join(home,'profiles','npm-test');mkdirSync(npmDir,{recursive:true});json(join(npmDir,'package.json'),{name:'npm-consumer',private:true,dependencies:{},dsh:{profile:{bundles:['super-dsh']}}});writeFileSync(join(npmDir,'.npmrc'),`registry=http://127.0.0.1:${server.address().port}/\ncache=${join(root,'npm-cache')}\n`)
   const next=artifact(6);await npmInstall(npmDir,next.tarball)
   assert.equal(read(join(npmDir,'node_modules/better-dsh/package.json')).version,next.version)
   const npmProfile={...profile,dir:npmDir,name:'npm-test'};const count=requests.length
   await api.reconcileRegistryCompanions(npmProfile)
   assert.equal(requests.length,count,'plain npm registration must not access registry')
   assert.equal(read(join(npmDir,'package.json')).dependencies['better-dsh'],next.version)
   assert.equal(read(join(npmDir,'package-lock.json')).packages[''].dependencies['better-dsh'],next.version)
   await npmCommand(npmDir,['ci','--offline','--ignore-scripts','--no-audit','--no-fund'])
   const upgrade=artifact(7);await npmInstall(npmDir,upgrade.tarball);const countAfter=requests.length;await api.reconcileRegistryCompanions(npmProfile)
   assert.equal(requests.length,countAfter,'npm upgrade promotion must stay offline')
   assert.equal(read(join(npmDir,'node_modules/better-dsh/package.json')).version,upgrade.version)
  })
  result=await mutate(['remove','super-dsh','--ignore-scripts']);assert.equal(result.exitCode,0,result.output)
  // Native install paths reject a missing registry version, rather than silently consuming latest.
  const bad=JSON.parse(readFileSync(join(superSource,'package.json')));bad.version=`0.0.5-${key}`;bad.dependencies['better-dsh']=bad.version;json(join(superSource,'package.json'),bad);const archive=join(out,packPackage(superSource,out).filename);result=await mutate(['add','file:'+archive,'--ignore-scripts','--config.fetch-retries=0']);assert.notEqual(result.exitCode,0)
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
})
async function waitChild(){const deadline=Date.now()+10000;for(;;){const children=readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean);if(children.some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('register-companion.mjs')}catch{return false}}))return;assert.ok(Date.now()<deadline,'registration child must start before lock mutation/cancellation');await new Promise(r=>setTimeout(r,20))}}

async function npmInstall(dir,tarball){return npmCommand(dir,['install',tarball,'--ignore-scripts','--no-audit','--no-fund'])}
async function npmCommand(dir,args){await new Promise((resolve,reject)=>{const child=spawn('npm',args,{cwd:dir});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(output)))})}
