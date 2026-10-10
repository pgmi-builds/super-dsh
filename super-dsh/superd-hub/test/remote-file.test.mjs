import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Observe only this fixture's actual worker/root; other files may transfer concurrently.
async function ownedWorker(path) {
 for(let attempt=0;attempt<200;attempt++){
  for(const candidate of await readdir('/proc'))if(/^\d+$/.test(candidate)){try{
   const argv=(await readFile(`/proc/${candidate}/cmdline`)).toString().split('\0')
   if(!argv.some(a=>a.includes('runFileWorker')))continue
   const value=argv.find(a=>a.startsWith('{'));if(!value)continue
   const request=JSON.parse(value);if(request.path!==path)continue
   const entries=await readdir(request.root)
   if(request.action==='import'&&!entries.includes('payload'))continue
   return {pid:Number(candidate),root:request.root}
  }catch{}}
  await new Promise(r=>setTimeout(r,10))
 }
 throw new Error(`fixture worker/root did not appear for ${path}`)
}

test('independent Hub binary WS lane transfers >single frame and authenticates before writes', async t => {
  const mod = await import('../dist/remote-file-rpc.js').catch(()=>({}))
  assert.equal(typeof mod.registerRemoteFileRpc,'function','binary receiving lane is present')
  const home=await mkdtemp(join(tmpdir(),'hub-file-'))
  const http=createServer();let handler
  const off=await mod.registerRemoteFileRpc({registerUpgrade: r=>{handler=r.handler;return ()=>{handler=undefined}}},{authorize:req=>req.headers.cookie==='paired=yes',requestRejection:req=>req.headers.origin==='https://blocked'?403:undefined})
  http.on('upgrade',(req,socket,head)=>handler?.(req,socket,head));await new Promise(r=>http.listen(0,'127.0.0.1',r))
  t.after(async()=>{await off();await new Promise(r=>http.close(r));await rm(home,{recursive:true,force:true})})
  const endpoint=mod.createRemoteFileEndpoint(()=>({origin:`http://127.0.0.1:${http.address().port}`,cookie:'paired=yes'}))
  const src=join(home,'source'),dst=join(home,'dest'),bytes=randomBytes(400_000),signal=new AbortController().signal
  bytes[0]=0;bytes[1]=255;await writeFile(src,bytes)
  await endpoint.importTree(dst,await endpoint.exportTree(src,signal),{mkdir:true,signal})
  assert.deepEqual(await readFile(dst),bytes)
  assert.deepEqual(await endpoint.digest(dst,signal),await endpoint.digest(src,signal))
  const denied=mod.createRemoteFileEndpoint(()=>({origin:`http://127.0.0.1:${http.address().port}`,cookie:'wrong'}))
  await assert.rejects(denied.digest(src,signal),/401|unauthorized|unavailable/i)
})

test('binary import cancellation, disconnect, malformed carrier and Origin denial clean receiving operations', async t=>{
  const mod=await import('../dist/remote-file-rpc.js'),{PassThrough,Readable}=await import('node:stream'),{createRequire}=await import('node:module')
  const {WebSocket}=createRequire(import.meta.url)('ws')
  const home=await mkdtemp(join(tmpdir(),'hub-file-negative-')),http=createServer();let handler
  const off=await mod.registerRemoteFileRpc({registerUpgrade:r=>{handler=r.handler;return()=>{handler=undefined}}},{authorize:req=>req.headers.cookie==='paired=yes',requestRejection:req=>req.headers.origin==='https://blocked'?403:undefined})
  http.on('upgrade',(req,socket,head)=>handler?.(req,socket,head));await new Promise(r=>http.listen(0,'127.0.0.1',r))
  t.after(async()=>{await off();await new Promise(r=>http.close(r));await rm(home,{recursive:true,force:true})})
  const origin=`http://127.0.0.1:${http.address().port}`,e=mod.createRemoteFileEndpoint(()=>({origin,cookie:'paired=yes'})),dst=join(home,'never-written')
  const ctrl=new AbortController(),source=new PassThrough()
  const copying=e.importTree(dst,source,{mkdir:true,signal:ctrl.signal}).then(()=>null,error=>error)
  source.write(Buffer.alloc(100))
  await new Promise(r=>setTimeout(r,25));ctrl.abort(new Error('test cancel'))
  assert.match(String(await copying),/cancel/i)
  await assert.rejects(readFile(dst))
  await assert.rejects(e.importTree(dst,Readable.from([Buffer.from('bad archive')]),{mkdir:true,signal:new AbortController().signal}),/archive|header|truncated/i)
  const connect=headers=>new WebSocket(origin.replace('http','ws')+mod.REMOTE_FILE_PATH,{headers})
  const denied=connect({Cookie:'paired=yes',Origin:'https://blocked'})
  await assert.rejects(new Promise((resolve,reject)=>{denied.on('open',resolve);denied.on('error',reject)}),/403/)
  const disconnected=connect({Cookie:'paired=yes'})
  const preparation=new Promise(resolve=>disconnected.once('message',data=>resolve(JSON.parse(String(data)))))
  await new Promise((resolve,reject)=>{disconnected.on('open',resolve);disconnected.on('error',reject)})
  const prepared=await preparation
  disconnected.send(JSON.stringify({op:'open',action:'import',path:dst,mkdir:true}));disconnected.send(JSON.stringify({op:'begin',token:prepared.lease.token}))
  await new Promise(resolve=>disconnected.once('message',resolve))
  disconnected.send(Buffer.alloc(400));disconnected.terminate()
  // Receiver disposer must await aborted archive staging; no detached operation is left.
  await off()
  await assert.rejects(readFile(dst))
})

test('old peer without binary lane fails explicitly without text fallback',async t=>{
  const {createRemoteFileEndpoint}=await import('../dist/remote-file-rpc.js')
  const http=createServer((_req,res)=>{res.writeHead(404);res.end()})
  await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>http.close(r)))
  const e=createRemoteFileEndpoint(()=>({origin:`http://127.0.0.1:${http.address().port}`,cookie:''}))
  await assert.rejects(e.digest('/unused',new AbortController().signal),/unsupported.*404|404/i)
})

test('stalled import is rejected within its deadline and releases receiving scratch', {timeout:12000},async t=>{
  const mod=await import('../dist/remote-file-rpc.js'),{PassThrough}=await import('node:stream'),{readdir}=await import('node:fs/promises')
  const home=await mkdtemp(join(tmpdir(),'hub-file-stall-')),http=createServer();let handler
  const off=await mod.registerRemoteFileRpc({registerUpgrade:r=>{handler=r.handler;return()=>{handler=undefined}}},{authorize:()=>true})
  http.on('upgrade',(req,socket,head)=>handler?.(req,socket,head));await new Promise(r=>http.listen(0,'127.0.0.1',r))
  t.after(async()=>{await off();await new Promise(r=>http.close(r));await rm(home,{recursive:true,force:true})})
  const e=mod.createRemoteFileEndpoint(()=>({origin:`http://127.0.0.1:${http.address().port}`,cookie:''})),source=new PassThrough(),start=Date.now()
  const path=join(home,'dest'),copy=e.importTree(path,source,{mkdir:true,signal:new AbortController().signal});void copy.catch(()=>{})
  const worker=await ownedWorker(path)
  await assert.rejects(copy,/timeout/i)
  assert.ok(Date.now()-start<mod.FILE_IDLE_MS+3000)
  assert.equal(source.destroyed,true)
  await assert.rejects(readdir(worker.root),/ENOENT/)
  assert.throws(()=>process.kill(worker.pid,0),/ESRCH/)
})

test('failed Hub admission closes a supplied real payload ReadStream before rejection and provider completion',async t=>{
 const {createRemoteFileEndpoint}=await import('../dist/remote-file-rpc.js'),{createReadStream}=await import('node:fs')
 const home=await mkdtemp(join(tmpdir(),'hub-file-admission-')),payload=join(home,'payload');await writeFile(payload,randomBytes(200000))
 let denial=404;const http=createServer((_req,res)=>{res.writeHead(denial);res.end()});await new Promise(r=>http.listen(0,'127.0.0.1',r))
 t.after(async()=>{await new Promise(r=>http.close(r));await rm(home,{recursive:true,force:true})})
 for(const connection of [()=>({origin:`http://127.0.0.1:${http.address().port}`,cookie:'wrong'}),()=>{denial=401;return {origin:`http://127.0.0.1:${http.address().port}`,cookie:'wrong'}},()=>{throw new Error('machine disabled')}]){
  const tracked=[],e=createRemoteFileEndpoint(connection,undefined,p=>tracked.push(p)),source=createReadStream(payload)
  await new Promise(r=>source.once('open',r))
  await assert.rejects(e.importTree('/unused',source,{mkdir:true,signal:new AbortController().signal}))
  await Promise.all(tracked)
  assert.equal(source.closed,true,'failed admission must await actual file descriptor closure')
 }
})

for(const fault of ['drop-controls','lost-renewal'])test(`partitioned task controls (${fault}) cannot settle provider ownership while the auto-pong upstream retains receiving scratch`, {timeout:18000},async t=>{
 const mod=await import('../dist/remote-file-rpc.js'),{PassThrough}=await import('node:stream'),{readdir}=await import('node:fs/promises'),{createRequire}=await import('node:module')
 const {WebSocket,WebSocketServer}=createRequire(import.meta.url)('ws')
 const home=await mkdtemp(join(tmpdir(),'hub-partition-')),receiver=createServer(),proxy=createServer();let handler,drop=false,pongs=0
 const off=await mod.registerRemoteFileRpc({registerUpgrade:r=>{handler=r.handler;return()=>{handler=undefined}}},{authorize:()=>true})
 receiver.on('upgrade',(req,sock,head)=>handler?.(req,sock,head));await new Promise(r=>receiver.listen(0,'127.0.0.1',r))
 let leaseDroppedResolve;const leaseDropped=new Promise(r=>{leaseDroppedResolve=r})
 const wss=new WebSocketServer({noServer:true}),peers=new Set()
 proxy.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,down=>{
  const up=new WebSocket(`ws://127.0.0.1:${receiver.address().port}${mod.REMOTE_FILE_PATH}`);peers.add(up);peers.add(down)
  const queued=[];up.on('open',()=>{for(const [b,binary]of queued)up.send(b,{binary})})
  down.on('message',(b,binary)=>{if(!drop){if(up.readyState===1)up.send(b,{binary});else queued.push([b,binary])}})
  up.on('message',(b,binary)=>{if(fault==='lost-renewal'&&!binary&&JSON.parse(String(b)).op==='lease'){drop=true;leaseDroppedResolve();return};if(!drop&&down.readyState===1)down.send(b,{binary})})
  down.on('error',()=>{});up.on('error',()=>{})
 }))
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
 t.after(async()=>{for(const s of peers)s.terminate();await off();wss.close();await Promise.all([new Promise(r=>receiver.close(r)),new Promise(r=>proxy.close(r))]);await rm(home,{recursive:true,force:true})})
 const {createHubRemoteTransport}=await import('../dist/remote-provider.js'),{upsertRemote}=await import('../dist/machines.js')
 upsertRemote(home,{id:'peer',name:'file-worker-peer',origin:`http://127.0.0.1:${proxy.address().port}`,cookie:'paired',enabled:true,addedAt:Date.now()})
 const provider=createHubRemoteTransport(home),source=new PassThrough(),e=provider.fileEndpoint('peer')
 t.after(()=>provider.dispose())
 const target=join(home,'target')
 if(fault==='lost-renewal'){const {open}=await import('node:fs/promises');const file=await open(target,'w');await file.truncate(256*1024*1024);await file.close()}
 const pending=(fault==='lost-renewal'?e.digest(target,new AbortController().signal):e.importTree(target,source,{mkdir:true,signal:new AbortController().signal})).catch(error=>error)
 if(fault==='drop-controls')source.write(Buffer.alloc(100))
 const {pid:workerPid,root:workerRoot}=await ownedWorker(target)
 process.kill(workerPid,'SIGSTOP') // Hold real filesystem/stream resources; TERM cannot finish this child.
 if(fault==='lost-renewal')await leaseDropped;else drop=true
 for(const s of peers)s.on('pong',()=>pongs++)
 const pinging=setInterval(()=>{for(const s of peers)if(s.readyState===1)s.ping()},200);t.after(()=>clearInterval(pinging))
 const disposing=provider.dispose()
 await pending;await disposing
 assert.ok(pongs>=2,'transport pong remains live while task renewal/cancel traffic is dropped')
 assert.throws(()=>process.kill(workerPid,0),/ESRCH/,'worker group has ended before provider disposal resolves')
 assert.ok([...peers].every(s=>s.readyState===3),'both proxy-facing sockets have actually closed before owner completion')
 await assert.rejects(readdir(workerRoot),/ENOENT/,'owned receive root is removed before provider disposal settles')
})

test('a live renewable lease permits a real digest held beyond six seconds and preserves its final metadata', {timeout:18000},async t=>{
 const mod=await import('../dist/remote-file-rpc.js'),{open,readdir,readlink}=await import('node:fs/promises')
 const home=await mkdtemp(join(tmpdir(),'hub-long-digest-')),path=join(home,'large'),file=await open(path,'w');await file.truncate(256*1024*1024);await file.close()
 const {localFileEndpoint}=await import('../../remote/plugin.js'),expected=await localFileEndpoint().digest(path,new AbortController().signal)
 const http=createServer();let handler,pid
 const off=await mod.registerRemoteFileRpc({registerUpgrade:r=>{handler=r.handler;return()=>{handler=undefined}}},{authorize:()=>true})
 http.on('upgrade',(req,sock,head)=>handler?.(req,sock,head));await new Promise(r=>http.listen(0,'127.0.0.1',r))
 const ctrl=new AbortController();t.after(async()=>{ctrl.abort();if(pid)try{process.kill(pid,'SIGCONT')}catch{};await off();await new Promise(r=>http.close(r));await rm(home,{recursive:true,force:true})})
 const e=mod.createRemoteFileEndpoint(()=>({origin:`http://127.0.0.1:${http.address().port}`,cookie:''})),pending=e.digest(path,ctrl.signal)
 void pending.catch(()=>{})
 for(let i=0;i<100&&!pid;i++){
  for(const candidate of await readdir('/proc'))if(/^\d+$/.test(candidate)){try{
   const argv=(await readFile(`/proc/${candidate}/cmdline`)).toString().split('\0')
   if(!argv.some(a=>a.includes('runFileWorker'))||!argv.some(a=>a.startsWith('{')&&a.includes(path)))continue
   for(const fd of await readdir(`/proc/${candidate}/fd`))if(await readlink(`/proc/${candidate}/fd/${fd}`)===path){pid=Number(candidate);process.kill(pid,'SIGSTOP');break}
  }catch{}}
  if(!pid)await new Promise(r=>setTimeout(r,5))
 }
 assert.ok(pid,'hold actual receiver while its source file descriptor is open')
 await new Promise(r=>setTimeout(r,7200));process.kill(pid,'SIGCONT')
 assert.deepEqual(await pending,expected)
 assert.throws(()=>process.kill(pid,0),/ESRCH/)
})

for(const action of ['dispose','cancel'])test(`backpressured receiver (${action}) unwinds real pending sends before its cleanup bound`,{timeout:12000},async t=>{
 const mod=await import('../dist/remote-file-rpc.js'),{open,readdir}=await import('node:fs/promises'),{createRequire}=await import('node:module')
 const {WebSocket}=createRequire(import.meta.url)('ws'),home=await mkdtemp(join(tmpdir(),'hub-file-backpressure-')),path=join(home,'payload')
 const file=await open(path,'w');await file.truncate(32*1024*1024);await file.close()
 const http=createServer();let handler,acks,waitTimer,receiverSocket,receiverClosed=false,workerPid,root
 let closedResolve;const receiverClose=new Promise(r=>{closedResolve=r})
 const off=await mod.registerRemoteFileRpc({registerUpgrade:r=>{handler=r.handler;return()=>{handler=undefined}}},{authorize:()=>true})
 http.on('upgrade',(req,socket,head)=>{receiverSocket=socket;socket.once('close',()=>{receiverClosed=true;closedResolve()});handler?.(req,socket,head)})
 await new Promise(r=>http.listen(0,'127.0.0.1',r))
 const peer=new WebSocket(`ws://127.0.0.1:${http.address().port}${mod.REMOTE_FILE_PATH}`);peer.on('error',()=>{})
 let pausedResolve,pausedOnce=false;const paused=new Promise(r=>{pausedResolve=r})
 peer.on('message',(b,binary)=>{
  if(binary){if(!pausedOnce){pausedOnce=true;peer._socket.pause();acks=setInterval(()=>{if(peer.readyState===1)peer.send(JSON.stringify({op:'ack'}))},1);pausedResolve()}return}
  const m=JSON.parse(String(b));if(m.op==='prepared'){peer.send(JSON.stringify({op:'open',action:'export',path}));peer.send(JSON.stringify({op:'begin',token:m.lease.token}))}
 })
 t.after(async()=>{clearInterval(acks);clearTimeout(waitTimer);peer.terminate();await off();await new Promise(r=>http.close(r));await rm(home,{recursive:true,force:true})})
 await Promise.race([paused,new Promise((_,reject)=>{waitTimer=setTimeout(()=>reject(new Error('no first binary frame')),4000)})]);clearTimeout(waitTimer)
 await new Promise(r=>setTimeout(r,1500));clearInterval(acks)
 for(const candidate of await readdir('/proc'))if(/^\d+$/.test(candidate)){try{
  const argv=(await readFile(`/proc/${candidate}/cmdline`)).toString().split('\0'),request=argv.find(a=>a.startsWith('{')&&a.includes(path))
  if(request&&argv.some(a=>a.includes('runFileWorker'))){workerPid=Number(candidate);root=JSON.parse(request).root}
 }catch{}}
 assert.ok(workerPid,'real worker remains blocked behind the paused TCP reader');assert.ok(root);await readdir(root)
 const started=performance.now()
 let cleanup
 if(action==='dispose')cleanup=off();else{peer.send(JSON.stringify({op:'cancel'}));cleanup=receiverClose.then(()=>off())}
 const withinBound=await Promise.race([cleanup.then(()=>true),new Promise(r=>{waitTimer=setTimeout(()=>r(false),mod.FILE_CLEANUP_MS)})]);clearTimeout(waitTimer)
 assert.equal(withinBound,true,`receiver cleanup exceeded advertised ${mod.FILE_CLEANUP_MS}ms bound while TCP reads were paused`)
 assert.ok(performance.now()-started<mod.FILE_CLEANUP_MS)
 assert.throws(()=>process.kill(workerPid,0),/ESRCH/)
 await assert.rejects(readdir(root),/ENOENT/)
 assert.equal(receiverSocket.destroyed,true);assert.equal(receiverClosed,true,'actual receiver socket close precedes cleanup settlement')
 await off()
})
