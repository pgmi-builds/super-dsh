import {it,expect} from 'vitest'
import {readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises'
import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes,createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {createServer,createConnection,type Socket} from 'node:net'
import {withSshFixture} from './ssh-fixture.ts'
import {cliFileEndpoint} from '../../src/remote/endpoints.ts'
import {localFileEndpoint} from '../../src/remote/archive.ts'
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const roots=async()=>(await readdir(tmpdir())).filter(n=>n.startsWith('superd-rsync')).sort()
async function importPid(path:string){for(const n of await readdir('/proc')){if(!/^\d+$/.test(n))continue;try{const args=(await readFile('/proc/'+n+'/cmdline','utf8')).split('\0');if(args.includes(path)&&args.includes('import')&&args.some(a=>a.includes('MAX_META=8388608')))return Number(n)}catch{}}return undefined}
it('does not settle binary SSH cancellation while a receiving import and temporary FD survive held work-channel EOF',async()=>{
 await withSshFixture(async f=>{
  const sockets=new Set<Socket>();let latest:{origin:Socket;peer:Socket}|undefined,held:typeof latest;let releaseTimer:ReturnType<typeof setTimeout>|undefined
  const proxy=createServer({allowHalfOpen:true},origin=>{const peer=createConnection({host:'127.0.0.1',port:f.destination.port,allowHalfOpen:true});latest={origin,peer};sockets.add(origin);sockets.add(peer);origin.pipe(peer,{end:false});peer.pipe(origin,{end:false});origin.on('end',()=>{if(held?.origin!==origin)peer.end()});peer.on('end',()=>origin.end());origin.on('error',()=>{if(held?.origin!==origin)peer.destroy()});peer.on('error',()=>origin.destroy());origin.on('close',()=>{if(held?.origin!==origin)peer.destroy()});peer.on('close',()=>origin.destroy())})
  await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const port=(proxy.address() as {port:number}).port
  await writeFile(join(f.directory,'known_hosts'),`[127.0.0.1]:${port} ${await readFile(join(f.directory,'destination/host.pub'),'utf8')}`,{flag:'a'})
  const bin=join(f.directory,'bin');await mkdir(bin);await writeFile(join(bin,'ssh'),`#!/bin/sh\nexec /usr/bin/ssh -F '${f.config}' "$@"\n`,{mode:0o700});const oldPath=process.env.PATH;process.env.PATH=bin+':'+oldPath
  const src=join(f.directory,'source'),dst=join(f.directory,'destination-file'),abort=new AbortController(),before=await roots();let pid:number|undefined
  const release=()=>{if(!held)return;const {origin,peer}=held;held=undefined;origin.pipe(peer,{end:false});origin.resume();if(origin.readableEnded||origin.destroyed)peer.end()}
  try{
   await writeFile(src,randomBytes(8*1024*1024));const raw=await localFileEndpoint().exportTree(src,abort.signal)
   const stream=Readable.from((async function*(){for await(const chunk of raw){yield chunk;await delay(25)}})())
   const endpoint=cliFileEndpoint({kind:'ssh',host:'127.0.0.1',connection:{...f.destination,port}})
   const operation=endpoint.importTree(dst,stream,{mkdir:true,signal:abort.signal});void operation.catch(()=>{})
   const until=Date.now()+12000;while(!(pid=await importPid(dst))){if(Date.now()>until)throw Error('no actual import admitted');await delay(10)}
   let fds:string[]=[];while(!fds.length){fds=(await readdir('/proc/'+pid+'/fd')).filter(fd=>{try{return readFileSync('/proc/'+pid+'/fdinfo/'+fd,'utf8').length>0&&fd==='3'}catch{return false}});if(Date.now()>until)throw Error('no receiving temporary FD');await delay(5)}
   held=latest!;held.origin.unpipe(held.peer);held.origin.pause();releaseTimer=setTimeout(release,3000)
   abort.abort(new Error('fixture copy cancellation'));await expect(operation).rejects.toThrow('fixture copy cancellation')
   const snapshot={pid,pidLive:existsSync('/proc/'+pid),tempFdLive:existsSync('/proc/'+pid+'/fd/3'),heldWorkChannel:!!held,metadata:await roots()}
   await writeFile('../.scratch/task-8/cli-copy-source-cancel-evidence.json',JSON.stringify(snapshot,null,2))
   expect(snapshot.pidLive,'actual receiver must be gone when cancellation settles').toBe(false);expect(snapshot.tempFdLive).toBe(false);expect(snapshot.metadata).toEqual(before);expect(existsSync(dst)).toBe(false)
  }finally{clearTimeout(releaseTimer);release();for(const s of sockets)s.destroy();await new Promise<void>(r=>proxy.close(()=>r()));process.env.PATH=oldPath;const end=Date.now()+5000;while(pid&&existsSync('/proc/'+pid)&&Date.now()<end)await delay(20)}
 })
},30000)


import {execFileSync} from 'node:child_process'
import {PassThrough} from 'node:stream'
for(const kind of ['docker','incus'] as const){
 const container=process.env[kind==='docker'?'REMOTE_TEST_DOCKER_CONTAINER':'REMOTE_TEST_INCUS_CONTAINER']
 it.skipIf(!container)(`real ${kind} binary import/export/digest fully drains and cancellation releases receiving helpers`,async()=>{
  const dir=join(tmpdir(),'cli-binary-'+crypto.randomUUID()),remoteDir='/tmp/task8-cli-binary-'+crypto.randomUUID(),abort=new AbortController()
  const command=(code:string,...args:string[])=>execFileSync(kind,kind==='docker'?['exec',container!,'python3','-c',code,...args]:['exec',container!,'--','python3','-c',code,...args],{encoding:'utf8'})
  const inspect=(path:string,op:string)=>JSON.parse(command(`import os,sys,json
pids=[]
for n in os.listdir('/proc'):
 if not n.isdigit() or int(n)==os.getpid():continue
 try:
  a=open('/proc/'+n+'/cmdline','rb').read().split(b'\\0')
  if sys.argv[1].encode() in a and sys.argv[2].encode() in a and any(b'MAX_META=8388608' in v for v in a):pids.append(int(n))
 except OSError:pass
print(json.dumps(pids))`,path,op)) as number[]
  const state=()=>JSON.parse(command(`import os,json
print(json.dumps(sorted(n for n in os.listdir('/tmp') if n.startswith('superd-rsync'))))`))
  const endpoint=cliFileEndpoint({kind,container:container!}),local=localFileEndpoint(),before=state()
  await mkdir(dir);const src=join(dir,'src'),dst=remoteDir+'/file',bytes=randomBytes(8*1024*1024);await writeFile(src,bytes)
  try{
   console.log(kind+' import start');await endpoint.importTree(dst,await local.exportTree(src,abort.signal),{mkdir:true,signal:abort.signal})
   console.log(kind+' import complete; digest start');expect(await endpoint.digest(dst,abort.signal)).toEqual(await local.digest(src,abort.signal))
   await local.importTree(join(dir,'back'),await endpoint.exportTree(dst,abort.signal),{mkdir:false,signal:abort.signal})
   const actual=await readFile(join(dir,'back'));expect(actual.length).toBe(bytes.length);expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));console.log(kind+' normal binary roundtrip complete');expect(state()).toEqual(before)
   const cancel=new AbortController(),source=new PassThrough(),pending=endpoint.importTree(remoteDir+'/cancelled',source,{mkdir:true,signal:cancel.signal});void pending.catch(()=>{})
   let pids:number[]=[];const end=Date.now()+12000;while(!(pids=inspect(remoteDir+'/cancelled','import')).length){if(Date.now()>end)throw Error('container import not admitted');await delay(10)}
   source.write(Buffer.alloc(100));cancel.abort(new Error('fixture import cancelled'));await expect(pending).rejects.toThrow('fixture import cancelled')
   expect(inspect(remoteDir+'/cancelled','import')).toEqual([]);expect(JSON.parse(command('import os,sys,json;print(json.dumps([os.path.exists("/proc/"+p) for p in sys.argv[1:]]))',...pids.map(String)))).toEqual(pids.map(()=>false));expect(state()).toEqual(before)
   const exportCancel=new AbortController(),output=await endpoint.exportTree(dst,exportCancel.signal)
   let exportPids:number[]=[];while(!(exportPids=inspect(dst,'export')).length){if(Date.now()>end)throw Error('container export not admitted');await delay(10)}
   exportCancel.abort(new Error('fixture export cancelled'));await expect((async()=>{for await(const _ of output){}})()).rejects.toThrow('fixture export cancelled')
   expect(inspect(dst,'export')).toEqual([]);expect(state()).toEqual(before)
   await writeFile('../.scratch/task-8/cli-copy-'+kind+'-source-evidence.json',JSON.stringify({container,bytes:bytes.length,importPids:pids,exportPids,receiversAbsent:true,metadataRestored:true,allBinaryBytesEqual:true},null,2))
  }finally{abort.abort();command('import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)',remoteDir);await rm(dir,{recursive:true,force:true})}
 },45000)
}
