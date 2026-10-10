import {it,expect} from 'vitest'
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes,createHash} from 'node:crypto'
import {withSshFixture} from './ssh-fixture.ts'
import {sshArgv} from '../../src/remote/ssh-targets.ts'
import {runRsync} from '../../src/remote/rsync.ts'
it('uses an owned source listener when native sshd forbids remote forwarding, preserving native binary delta',async()=>{
 await withSshFixture(async f=>{
  const src=join(f.directory,'src'),dst=join(f.directory,'dst'),bytes=randomBytes(2*1024*1024)
  await mkdir(src);await mkdir(dst);await writeFile(join(src,'payload'),bytes)
  const before=(await readdir(tmpdir())).filter(n=>n.startsWith('superd-rsync')).sort()
  const starts:{endpoint:string;kind:string}[]=[]
  const options={ssh:(c:Parameters<typeof sshArgv>[0],o:Parameters<typeof sshArgv>[1])=>{const command=o?.command??'';starts.push({endpoint:c.port===f.jump.port?'source':'destination',kind:command.includes('SOURCE_PROXY_READY')?'proxy-work':command.includes("'recovery-clock'")?'clock':command.includes('command -v rsync')?'prerequisite':'owned-channel'});return f.isolate(sshArgv(c,o))}}
  const args={src:src+'/',dst,dryRun:false},from={path:src+'/',connection:f.jump},to={path:dst,connection:f.destination}
  const first=await runRsync(args,from,to,new AbortController().signal,options)
  const firstStartups=starts.slice()
  expect(first.exit).toBe(0);expect(await readFile(join(dst,'payload'))).toEqual(bytes)
  bytes[100000]=bytes[100000]!^1;await writeFile(join(src,'payload'),bytes)
  const next=await runRsync(args,from,to,new AbortController().signal,options)
  expect(next.exit).toBe(0);expect(next.literalBytes).toBeLessThan(bytes.length);expect(next.matchedBytes).toBeGreaterThan(0)
  expect(createHash('sha256').update(await readFile(join(dst,'payload'))).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect((await readdir(tmpdir())).filter(n=>n.startsWith('superd-rsync')).sort()).toEqual(before)
  await writeFile('../.scratch/task-8/source-proxy-native-delta-evidence.json',JSON.stringify({firstStartups,secondStartups:starts.slice(firstStartups.length),first:{exit:first.exit,literal:first.literalBytes,matched:first.matchedBytes},second:{exit:next.exit,literal:next.literalBytes,matched:next.matchedBytes},independentSha:createHash('sha256').update(bytes).digest('hex'),ownedMetadataAbsent:true},null,2))
 },{forwarding:{jump:'no'}})
},30000)

import {createServer,createConnection,type Socket} from 'node:net'
import {execFileSync} from 'node:child_process'
import {withSshRelay,type RelayOptions} from '../../src/remote/ssh-relay.ts'
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(test:()=>Promise<boolean>|boolean,ms=8000){const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw Error('fixture deadline');await delay(20)}}
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p}
async function chosenPorts(){const all=new Set<number>();while(all.size<3)all.add(await port());const [destination,origin,source]=[...all];return{destination:destination!,origin:origin!,source:source!}}
const roots=async()=>(await readdir(tmpdir())).filter(n=>n.startsWith('superd-rsync')).sort()
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
async function listening(port:number){return new Promise<boolean>(r=>{const s=createConnection({host:'127.0.0.1',port});s.on('error',()=>r(false));s.on('connect',()=>{s.destroy();r(true)})})}
function ownerPids(ports:NonNullable<RelayOptions['ports']>){
 const result=new Set<number>()
 for(const p of [ports.source,ports.destination]){
  const text=execFileSync('ss',['-H','-ltnp',`sport = :${p}`],{encoding:'utf8'}),pid=Number(/pid=(\d+)/.exec(text)?.[1]);expect(pid).toBeGreaterThan(0);result.add(pid)
  const parent=Number(execFileSync('ps',['-o','ppid=','-p',String(pid)],{encoding:'utf8'}).trim());result.add(parent)
 }
 return [...result]
}
for(const fault of ['silent-backpressure','closed-data-channel'] as const)it(`${fault} releases actual source listener/helper/group and all owned state before settlement`,async()=>{
 await withSshFixture(async f=>{
  const src=join(f.directory,'src'),dst=join(f.directory,'dst'),marker=join(f.directory,'blocked'),wrapper=join(f.directory,'data-wrapper.mjs')
  await mkdir(src);await mkdir(dst);await writeFile(join(src,'payload'),randomBytes(16*1024*1024))
  await writeFile(wrapper,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn('/usr/bin/ssh',process.argv.slice(2),{stdio:['pipe','pipe','pipe']});process.stdin.pipe(c.stdin);c.stdin.on('error',()=>{});c.stderr.pipe(process.stderr);let total=0,triggered=false;c.stdout.on('data',b=>{process.stdout.write(b);total+=b.length;if(!triggered&&total>524288){triggered=true;writeFileSync(${JSON.stringify(marker)},String(total));${fault==='silent-backpressure'?"c.stdout.pause()":"c.kill('SIGKILL')"}}});c.on('close',code=>process.exitCode=code??255);`)
  let stalled=false;const sockets=new Set<Socket>()
  const tcp=createServer(client=>{const remote=createConnection({host:'127.0.0.1',port:f.jump.port});sockets.add(client);sockets.add(remote)
   client.on('data',b=>{if(!stalled)remote.write(b)});remote.on('data',b=>{if(!stalled)client.write(b)})
   client.on('error',()=>{});remote.on('error',()=>{});client.on('close',()=>sockets.delete(client));remote.on('close',()=>sockets.delete(remote))
  });await new Promise<void>(r=>tcp.listen(0,'127.0.0.1',r));const tcpPort=(tcp.address() as {port:number}).port
  const before=await roots(),ports=await chosenPorts(),abort=new AbortController();let captured:number[]=[],owned:string[]=[]
  const ssh:typeof sshArgv=(c,o)=>{
   const source=c.port===f.jump.port,argv=f.isolate(sshArgv(source?{...c,port:tcpPort}:c,{...o,extraArgs:[...(o?.extraArgs??[]),...(source?['-o',`HostKeyAlias=[127.0.0.1]:${f.jump.port}`]:[])]}))
   return source&&o?.command?.includes('SOURCE_PROXY_READY')?[process.execPath,wrapper,...argv.slice(1)]:argv
  }
  const work=withSshRelay(f.jump,f.destination,dst,abort.signal,async relay=>{
   captured=ownerPids(ports);owned=(await roots()).filter(n=>!before.includes(n))
   return relay.run(['rsync','-r','--no-compress','--timeout=10','--',src+'/',relay.url])
  },{ports,ssh});void work.catch(()=>{})
  try{
   await until(async()=>{try{return Number(await readFile(marker,'utf8'))>524288}catch{return false}})
   const started=Date.now()
   if(fault==='silent-backpressure'){stalled=true;abort.abort(new Error('source proxy partition cancel'))}
   await expect(work).rejects.toThrow(fault==='silent-backpressure'?/partition cancel/:/source proxy (?:closed|frame)/)
   const inventory={fault,elapsedMs:Date.now()-started,captured,alive:captured.filter(alive),owned,retained:(await roots()).filter(n=>owned.includes(n)),listeners:await Promise.all(Object.values(ports).map(listening))}
   await writeFile('../.scratch/task-8/source-proxy-'+fault+'-evidence.json',JSON.stringify(inventory,null,2))
   expect(inventory.alive).toEqual([]);expect(inventory.retained).toEqual([]);expect(inventory.listeners).toEqual([false,false,false])
  }finally{abort.abort();for(const s of sockets)s.destroy();await work.catch(()=>{});await new Promise<void>(r=>tcp.close(()=>r()))}
 })
},30000)

it('fences finitely delayed source work entry without recreating a listener or owner after disposal',async()=>{
 await withSshFixture(async f=>{
  const dst=join(f.directory,'dst'),marker=join(f.directory,'entry');await mkdir(dst)
  const before=await roots(),ports=await chosenPorts(),abort=new AbortController();let admitted=false,owner=''
  const ssh:typeof sshArgv=(c,o)=>{
   if(o?.command?.includes('SOURCE_PROXY_READY')){
    owner=/"directory":"([^"]+)"/.exec(o.command)![1]!
    o={...o,command:`echo $$ > ${marker}; sleep .5; `+o.command}
   }
   return f.isolate(sshArgv(c,o))
  }
  const work=withSshRelay(f.jump,f.destination,dst,abort.signal,async()=>{admitted=true},{ports,ssh});void work.catch(()=>{})
  try{
   await until(async()=>{try{await readFile(marker);return true}catch{return false}})
   abort.abort(new Error('delayed source admission cancelled'));await expect(work).rejects.toThrow(/delayed source admission/)
   const after=await roots();expect(after).toEqual(before);expect(admitted).toBe(false);expect(await listening(ports.source)).toBe(false)
   await delay(800);expect(await roots()).toEqual(before);expect(await listening(ports.source)).toBe(false)
   await writeFile('../.scratch/task-8/source-proxy-delayed-entry-evidence.json',JSON.stringify({admitted,owner,ownerAbsent:!after.includes(owner.split('/').at(-1)!),listenersAtSettlement:false,noRecreationAfter800ms:true},null,2))
  }finally{abort.abort();await work.catch(()=>{})}
 })
},20000)

it.skipIf(!process.env.REMOTE_TEST_DEFAULT_SSH_SOURCE)('transfers from the real default SSH source without inspecting privileged sshd descriptors',async()=>{
 await withSshFixture(async f=>{
  const host=process.env.REMOTE_TEST_DEFAULT_SSH_SOURCE!,path=process.env.REMOTE_TEST_DEFAULT_SSH_PATH!,dst=join(f.directory,'physical-destination'),owned=new Set<string>();await mkdir(dst)
  const ssh:typeof sshArgv=(c,o)=>{
   if(c.host!==host)return f.isolate(sshArgv(c,o))
   for(const m of (o?.command??'').matchAll(/"(?:root|directory)":"([^"\n]+)"/g))if(m[1]!.startsWith('/tmp/superd-rsync'))owned.add(m[1]!)
   const argv=sshArgv(c,o);return [process.env.REMOTE_TEST_SSH_BIN??argv[0]!,...argv.slice(1)]
  }
  const result=await runRsync({src:path+'/',dst,dryRun:false},{path:path+'/',connection:{host}},{path:dst,connection:f.destination},new AbortController().signal,{ssh})
  expect(result.exit).toBe(0)
  const {runCommand}=await import('../../src/remote/ssh-relay.ts'),{shQuote}=await import('../../src/remote/transports.ts')
  // Independent source-side digest: acceptance phases deliberately mutate this fixture,
  // so transfer integrity means destination == current source, not a frozen phase hash.
  const sourceHash=await runCommand(ssh({host},{command:'python3 -c '+shQuote('import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())')+' '+shQuote(path+'/binary.dat')}),new AbortController().signal)
  expect(sourceHash.exit).toBe(0);expect(sourceHash.stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
  const hash=createHash('sha256').update(await readFile(join(dst,'binary.dat'))).digest('hex')
  expect(hash).toBe(sourceHash.stdout.trim())
  const observation=await runCommand(ssh({host},{command:'python3 -c '+shQuote('import os,json; print(json.dumps([p for p in '+JSON.stringify([...owned])+' if os.path.exists(p)]))')}),new AbortController().signal)
  expect(observation.exit).toBe(0);expect(JSON.parse(observation.stdout)).toEqual([])
  await writeFile('../.scratch/task-8/source-proxy-default-dev3-source-green.json',JSON.stringify({source:host,exit:result.exit,literal:result.literalBytes,matched:result.matchedBytes,independentFileSha:hash,sourceObservedSha:sourceHash.stdout.trim(),ownedSourceRoots:[...owned],retained:JSON.parse(observation.stdout)},null,2))
 })
},60000)
