import { it, expect } from 'vitest'
import { mkdir, writeFile, readdir, symlink, access, readFile, stat } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, createConnection, type Socket } from 'node:net'
import { withSshFixture } from './ssh-fixture.ts'
import { sshArgv } from '../../src/remote/ssh-targets.ts'
import { withSshRelay, withNativeRsyncOwner, nativeRsyncPath, runCommand, type RelayOptions } from '../../src/remote/ssh-relay.ts'
import { recoveryHelperCommand, SSH_RECOVERY_HELPER } from '../../src/remote/ssh-lease.ts'
import { randomUUID } from 'node:crypto'
import { runRsync } from '../../src/remote/rsync.ts'
import { RemoteDriver } from '../../src/remote/driver.ts'

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function until(test: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!await test()) { if (Date.now() >= end) throw new Error('fixture condition timed out'); await wait() }
}
const configs = async () => (await readdir(tmpdir())).filter(name => name.startsWith('superd-rsync')).sort()
const processes = () => execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,args='], {encoding:'utf8'}).split('\n').map(line => {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m ? {pid:Number(m[1]),parent:Number(m[2]),group:Number(m[3]),args:m[4]!} : undefined
}).filter(p => p !== undefined)
const active = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function listening(port: number) { return new Promise<boolean>(resolve => { const s=createConnection({host:'127.0.0.1',port}); s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>{s.destroy();resolve(false)}) }) }
async function port() { const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const n=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return n }
async function ports() { const values=new Set<number>();while(values.size<3) values.add(await port());const [destination,origin,source]=[...values];return {destination:destination!,origin:origin!,source:source!} }
async function ownedClean(before: string[], p: NonNullable<RelayOptions['ports']>, captured: number[] = []) {
  expect(await configs()).toEqual(before)
  for(const n of Object.values(p)) expect(await listening(n)).toBe(false)
  for(const pid of captured) expect(active(pid)).toBe(false)
}

it('refuses the literal percent transfer/delete attempt before touching it or its expanded sibling',async()=>{
  await withSshFixture(async f=>{
    const src=join(f.directory,'src'),literal=join(f.directory,'%USER%'),sibling=join(f.directory,userInfo().username)
    await mkdir(src);await mkdir(literal);await mkdir(sibling);await writeFile(join(src,'marker'),'literal binary\0\xff');await writeFile(join(literal,'delete-me'),'remove');await writeFile(join(sibling,'keep'),'must remain')
    const before=await configs(),p=await ports(),options={ports:p,ssh:(c:Parameters<typeof sshArgv>[0],o:Parameters<typeof sshArgv>[1])=>f.isolate(sshArgv(c,o))}
    await expect(runRsync({src:src+'/',dst:literal,dryRun:false,delete:true},{path:src+'/',connection:f.jump},{path:literal,connection:f.destination},new AbortController().signal,options)).rejects.toThrow(/percent.*unsupported/)
    expect(await readdir(literal)).toEqual(['delete-me']);expect(await readFile(join(literal,'delete-me'),'utf8')).toBe('remove')
    expect(await readdir(sibling)).toEqual(['keep']);expect(await readFile(join(sibling,'keep'),'utf8')).toBe('must remain');await ownedClean(before,p)
    const spaced=join(f.directory,'grammar-space '),trimmed=spaced.trim();await mkdir(spaced);await mkdir(trimmed)
    await writeFile(join(spaced,'keep'),'literal space directory');await writeFile(join(trimmed,'keep'),'trimmed sibling')
    await expect(runRsync({src:src+'/',dst:spaced+'/',dryRun:false,delete:true},{path:src+'/',connection:f.jump},{path:spaced+'/',connection:f.destination},new AbortController().signal,options)).rejects.toThrow(/whitespace/)
    expect(await readdir(spaced)).toEqual(['keep']);expect(await readFile(join(spaced,'keep'),'utf8')).toBe('literal space directory')
    expect(await readdir(trimmed)).toEqual(['keep']);expect(await readFile(join(trimmed,'keep'),'utf8')).toBe('trimmed sibling');await ownedClean(before,p)
    for(const target of [literal+'\r',literal+'\n[escape]',literal+' ']) {
      await expect(withSshRelay(f.jump,f.destination,target,new AbortController().signal,async()=>{throw new Error('must not run')},options)).rejects.toThrow(/newline|whitespace/)
      await ownedClean(before,p)
    }
  })
},20000)

for(const fault of ['destination','source','clock-rollback'] as const) {
it(`holds cancellation settlement through an immediate silent ${fault} partition with remote close withheld`,async()=>{
  await withSshFixture(async f=>{
    const sockets=new Set<Socket>();let stalled=false
    const target=fault==='source'?f.jump:f.destination
    const proxy=createServer(client=>{const remote=createConnection({host:'127.0.0.1',port:target.port});sockets.add(client);sockets.add(remote)
      client.on('data',data=>{if(!stalled)remote.write(data)});remote.on('data',data=>{if(!stalled)client.write(data)})
      client.on('error',()=>{});client.on('close',()=>{sockets.delete(client)})
      remote.on('error',()=>{});remote.on('close',()=>{sockets.delete(remote)})
    });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as {port:number}).port
    const dst=join(f.directory,'dest');await mkdir(dst);const before=await configs(),p=await ports(),controller=new AbortController()
    let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),holding=new Promise<void>(r=>{release=r})
    const work=withSshRelay(f.jump,f.destination,dst,controller.signal,async()=>{ready();await holding},{ports:p,ssh:(c,o)=>f.isolate(sshArgv(c.port===target.port?{...c,port:proxyPort}:c,{...o,extraArgs:[...(o?.extraArgs??[]),...(c.port===target.port?['-o',`HostKeyAlias=[127.0.0.1]:${target.port}`]:[])],command:fault==='clock-rollback'?o?.command?.replace('control() {','control() {\\n  SECONDS=$((SECONDS - 86400))'):o?.command}))})
    let settled=false;void work.then(()=>{settled=true},()=>{settled=true});let captured:number[]=[]
    try {
      await Promise.race([started,work.then(()=>{throw new Error('relay ended before readiness')})]);const owned=(await configs()).filter(n=>!before.includes(n)&&n.startsWith('superd-rsync.'));expect(owned).toHaveLength(1)
      captured=processes().filter(p=>p.args.startsWith('rsync --daemon ')&&p.args.includes(owned[0]!)).map(p=>p.pid);expect(captured).toHaveLength(1)
      const transportPid=Number(/pid=(\d+)/.exec(execFileSync('ss',['-H','-ltnp',`sport = :${p.source}`],{encoding:'utf8'}))?.[1]);expect(transportPid).toBeGreaterThan(0)
      captured.push(transportPid,...processes().filter(p=>p.args.startsWith('python3 -u -c ')&&(/(?:lease-clock \{\}|controller \{"token":|register \{"directory":)/.test(p.args))).map(p=>p.pid))
      stalled=true;const abortAt=Date.now();controller.abort(new Error('immediate partition cancel'));release()
      await wait(300);expect(settled).toBe(false);expect(await configs()).toContain(owned[0])
      await expect(work).rejects.toThrow('immediate partition cancel');await ownedClean(before,p,captured)
      expect([...sockets].filter(s=>!s.destroyed).length).toBeGreaterThan(0) // downstream close was never propagated
      await writeFile(`../.scratch/task-1/task7-fix2-${fault}-partition-evidence.json`,JSON.stringify({settledAfterAbortMs:Date.now()-abortAt,capturedRemotePids:captured,ownedMetadataAtSettlement:await configs(),ownedListenersAtSettlement:await Promise.all(Object.values(p).map(listening)),capturedPidsAliveAtSettlement:captured.map(active),downstreamCloseWithheld:true},null,2)+'\n')
    } finally {
      controller.abort();release();for(const socket of sockets)socket.destroy();await work.catch(()=>{})
      // Teardown-only grace for the RED implementation; never settlement evidence.
      await until(async()=>JSON.stringify(await configs())===JSON.stringify(before),15000)
      await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},30000)
}

// Break caught: PREPARED anchors a lease that the delayed coprocess has not initialized.
it('does not admit after delayed initial lease clock startup and holds unprepared cancellation until actual cleanup observation',async()=>{
  await withSshFixture(async f=>{
    const sockets=new Set<Socket>(),queued:Buffer[]=[];let blocked=false,observe=false;let clientSocket:Socket|undefined
    const proxy=createServer(client=>{clientSocket=client;const remote=createConnection({host:'127.0.0.1',port:f.destination.port});sockets.add(client);sockets.add(remote)
      client.on('data',data=>{if(!blocked)remote.write(data)});remote.on('data',data=>{if(!blocked||observe)client.write(data);else queued.push(Buffer.from(data))})
      client.on('error',()=>{});client.on('close',()=>{sockets.delete(client)})
      remote.on('error',()=>{});remote.on('close',()=>{sockets.delete(remote)})
    });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as {port:number}).port
    const bin=join(f.directory,'python-bin'),markerFile=join(f.directory,'clock-start'),dst=join(f.directory,'dest');await mkdir(bin);await mkdir(dst)
    const {chmod}=await import('node:fs/promises')
    await writeFile(join(bin,'python3'),`#!/bin/bash
if [ "$4" = lease-clock ]; then printf '%s\\n' $$ > ${JSON.stringify(markerFile)}; sleep 6; fi
exec /usr/bin/python3 "$@"
`);await chmod(join(bin,'python3'),0o700)
    const before=await configs(),p=await ports(),controller=new AbortController(),ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c.port===f.destination.port?{...c,port:proxyPort}:c,{...o,extraArgs:[...(o?.extraArgs??[]),...(c.port===f.destination.port?['-o',`HostKeyAlias=[127.0.0.1]:${f.destination.port}`]:[])],command:c.port===f.destination.port&&o?.command?'PATH='+JSON.stringify(bin)+':"$PATH"; '+o.command:o?.command}))
    const work=withSshRelay(f.jump,f.destination,dst,controller.signal,async()=>{throw new Error('late sender admission')},{ports:p,ssh});void work.catch(()=>{})
    let settled=false,settledAt=0;void work.then(()=>{settled=true;settledAt=Date.now()},()=>{settled=true;settledAt=Date.now()});let captured:number[]=[]
    try {
      await until(async()=>{try{await access(markerFile);return true}catch{return false}})
      const wrapper=Number(await readFile(markerFile,'utf8'));await until(()=>processes().some(p=>p.parent===wrapper&&p.args==='sleep 6'))
      captured=[wrapper,processes().find(p=>p.pid===wrapper)!.parent,...processes().filter(p=>p.parent===wrapper).map(p=>p.pid)]
      await wait(200);blocked=true;const abortAt=Date.now();controller.abort(new Error('delayed clock cancellation'))
      await wait(12000)
      await writeFile('../.scratch/task-1/task7-fix3-initial-clock-12s-state.json',JSON.stringify({settled,settledAfterAbortMs:settledAt?settledAt-abortAt:null,ownedMetadataAt12s:await configs(),ownedListenersAt12s:await Promise.all(Object.values(p).map(listening)),capturedPidsAliveAt12s:captured.map(active)},null,2)+'\n')
      expect(settled).toBe(false);expect(await listening(p.destination)).toBe(false)
      expect((await configs()).filter(n=>!before.includes(n)&&n.startsWith('superd-rsync.'))).toEqual([])
      // Restore only receiving observation, never STOP/START or downstream close.
      observe=true;for(const data of queued)clientSocket!.write(data)
      await expect(work).rejects.toThrow('delayed clock cancellation');await ownedClean(before,p,captured)
      expect([...sockets].some(s=>!s.destroyed)).toBe(true)
      await writeFile('../.scratch/task-1/task7-fix3-delayed-initial-clock-evidence.json',JSON.stringify({settledAfterAbortMs:Date.now()-abortAt,restoredReceivingObservationAfterAbortMs:12000,noSenderAdmission:true,capturedRemotePids:captured,capturedPidsAliveAtSettlement:captured.map(active),ownedMetadataAtSettlement:await configs(),ownedListenersAtSettlement:await Promise.all(Object.values(p).map(listening)),downstreamCloseWithheld:true},null,2)+'\n')
    } finally {
      controller.abort();for(const socket of sockets)socket.destroy();await work.catch(()=>{})
      await until(async()=>JSON.stringify(await configs())===JSON.stringify(before),16000)
      await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},35000)

for(const failure of ['connection-refused','authentication-rejected','clock-eof'] as const) {
it(`settles positive pre-command ${failure} without admitting a delayed receiver`,async()=>{
  await withSshFixture(async f=>{
    const dst=join(f.directory,'startup-dest');await mkdir(dst);const before=await configs(),p=await ports(),refused=await port()
    const bin=join(f.directory,'eof-bin');await mkdir(bin);const {chmod}=await import('node:fs/promises')
    await writeFile(join(bin,'python3'),`#!/bin/bash
[ "$4" != lease-clock ] || exit 78
exec /usr/bin/python3 "$@"
`);await chmod(join(bin,'python3'),0o700)
    const ssh:typeof sshArgv=(c,o)=>{
      const receiver=c.port===f.destination.port&&o?.command?.startsWith('bash -c ')
      return f.isolate(sshArgv(receiver&&failure==='connection-refused'?{...c,port:refused}:receiver&&failure==='authentication-rejected'?{...c,key:f.jump.key}:c,{...o,command:receiver&&failure==='clock-eof'?'PATH='+JSON.stringify(bin)+':"$PATH"; '+o?.command:o?.command}))
    }
    await expect(withSshRelay(f.jump,f.destination,dst,new AbortController().signal,async()=>{throw new Error('receiver admitted')},{ports:p,ssh})).rejects.toThrow(failure==='connection-refused'?/Connection refused/:failure==='authentication-rejected'?/Permission denied/:/readiness|clock|unbound variable|Bad file descriptor/)
    await ownedClean(before,p)
    await writeFile(`../.scratch/task-1/task7-fix3-${failure}-evidence.json`,JSON.stringify({failure,ownedMetadataAtSettlement:await configs(),ownedListenersAtSettlement:await Promise.all(Object.values(p).map(listening))},null,2)+'\n')
  })
},20000)
}

it('settles a native source work-helper failure before proxy/business preparation',async()=>{
  await withSshFixture(async f=>{
    const dst=join(f.directory,'controller-startup-dest');await mkdir(dst)
    const bin=join(f.directory,'controller-eof-bin');await mkdir(bin);const {chmod}=await import('node:fs/promises')
    await writeFile(join(bin,'python3'),`#!/bin/bash
[ "$4" != native-command ] || exit 79
exec /usr/bin/python3 "$@"
`);await chmod(join(bin,'python3'),0o700)
    const before=await configs(),p=await ports(),controller=new AbortController()
    const ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,{...o,command:c.port===f.jump.port&&o?.command?'PATH='+JSON.stringify(bin)+':"$PATH"; '+o.command:o?.command}))
    let admitted=false,settled=false,caught:unknown
    const work=withSshRelay(f.jump,f.destination,dst,controller.signal,async()=>{admitted=true;throw new Error('controller admitted')},{ports:p,ssh})
    const inspected=work.then(()=>{settled=true;throw new Error('unexpected controller success')},async error=>{
      caught=error;settled=true
      // Inspect directly in the settlement reaction, not after the liveness deadline.
      await ownedClean(before,p)
      await writeFile('../.scratch/task-1/task7-fix3-controller-startup-evidence.json',JSON.stringify({error:String(caught),admitted,ownedMetadataAtSettlement:await configs(),ownedListenersAtSettlement:await Promise.all(Object.values(p).map(listening))},null,2)+'\n')
    });void inspected.catch(()=>{})
    try {
      await inspected;expect(settled).toBe(true);await expect(work).rejects.toThrow(/source proxy closed: exit 79/);expect(admitted).toBe(false)
    } finally {
      controller.abort();if(settled)await work.catch(()=>{})
      // RED teardown only: no abandoned receiver lifetime is claimed from this wait.
      await until(async()=>JSON.stringify(await configs())===JSON.stringify(before),16000)
    }
  })
},22000)

it('waits for actual connected native-owner cleanup when cancelled before clock preparation',async()=>{
  await withSshFixture(async f=>{
    const bin=join(f.directory,'native-clock-bin'),markerFile=join(f.directory,'native-clock-start');await mkdir(bin);const {chmod}=await import('node:fs/promises')
    await writeFile(join(bin,'python3'),`#!/bin/bash
if [ "$4" = lease-clock ]; then printf '%s\n' $$ > ${JSON.stringify(markerFile)}; sleep 6; fi
exec /usr/bin/python3 "$@"
`);await chmod(join(bin,'python3'),0o700)
    const before=await configs(),controller=new AbortController(),ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,{...o,command:'PATH='+JSON.stringify(bin)+':"$PATH"; '+o?.command}))
    let admitted=false;const work=withNativeRsyncOwner(f.destination,controller.signal,async()=>{admitted=true;throw new Error('native protocol admitted')},ssh);void work.catch(()=>{})
    let captured:number[]=[]
    try {
      await until(async()=>{try{await access(markerFile);return true}catch{return false}});const wrapper=Number(await readFile(markerFile,'utf8'))
      await until(()=>processes().some(p=>p.parent===wrapper&&p.args==='sleep 6'));captured=[wrapper,processes().find(p=>p.pid===wrapper)!.parent,...processes().filter(p=>p.parent===wrapper).map(p=>p.pid)]
      const began=Date.now(),checked=work.then(()=>{throw new Error('unexpected native success')},async error=>{
        expect(admitted).toBe(false);for(const pid of captured)expect(active(pid)).toBe(false);expect(await configs()).toEqual(before);return error
      });void checked.catch(()=>{})
      controller.abort(new Error('unprepared native cancel'))
      // Gate-owned STOP can now reap a delayed clock promptly; assert actual
      // cleanup in the settlement reaction, not a minimum elapsed duration.
      expect(String(await checked)).toContain('unprepared native cancel')
      await writeFile('../.scratch/task-1/task7-fix3-native-unprepared-evidence.json',JSON.stringify({settledAfterAbortMs:Date.now()-began,admitted,capturedRemotePids:captured,capturedPidsAliveAtSettlement:captured.map(active),ownedMetadataAtSettlement:await configs()},null,2)+'\n')
    } finally {controller.abort();await work.catch(()=>{})}
  })
},20000)

// Break caught: a completed ambiguous SSH255 cannot deliver a later preparation/cleanup receipt.
it('recovers cleanup over a fresh channel after established startup exits 255 without any receipt',async()=>{
  await withSshFixture(async f=>{
    const {chmod}=await import('node:fs/promises'),bin=join(f.directory,'closed-startup-bin'),mark=join(f.directory,'closed-clock-start'),exitFile=join(f.directory,'initial-exit'),failedObserver=join(f.directory,'observer-failed');await mkdir(bin)
    await writeFile(join(bin,'python3'),`#!/bin/bash
if [ "$4" = lease-clock ]; then printf '%s\\n' $$ > ${JSON.stringify(mark)}; sleep 6; fi
if [ "$4" = recovery-observe ] && [ ! -e ${JSON.stringify(failedObserver)} ]; then /usr/bin/python3 "$@" & observer=$!; printf '%s\\n' "$observer" > ${JSON.stringify(failedObserver)}; sleep .2; kill -KILL "$observer"; wait "$observer" 2>/dev/null || :; exit 79; fi
exec /usr/bin/python3 "$@"
`);await chmod(join(bin,'python3'),0o700)
    const sockets=new Set<Socket>();let lastClient:Socket|undefined,oldClient:Socket|undefined,recovered=true
    const proxy=createServer(client=>{
      const remote=createConnection({host:'127.0.0.1',port:f.destination.port});sockets.add(client);sockets.add(remote);lastClient=client
      if(!recovered){client.destroy();remote.destroy();return}
      client.on('data',b=>{if(client!==oldClient)remote.write(b)});remote.on('data',b=>{if(client!==oldClient&&!client.destroyed)client.write(b)})
      client.on('error',()=>{});remote.on('error',()=>{});client.on('close',()=>{if(client!==oldClient)remote.destroy()});remote.on('close',()=>{if(client!==oldClient)client.destroy()})
    });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as {port:number}).port
    let wrapped=false,admitted=false,settled=false;const before=await configs(),ctrl=new AbortController()
    const ssh:typeof sshArgv=(c,o)=>{
      const argv=f.isolate(sshArgv({...c,port:proxyPort},{...o,extraArgs:[...(o?.extraArgs??[]),'-o',`HostKeyAlias=[127.0.0.1]:${f.destination.port}`],command:'PATH='+JSON.stringify(bin)+':"$PATH"; '+o?.command}))
      if(!wrapped&&o?.command?.includes('superd-rsync-native.XXXXXXXX')){wrapped=true;return ['bash','-c',`"$@"; status=$?; printf '%s\\n' "$status" > ${JSON.stringify(exitFile)}; exit "$status"`,'initial-ssh',...argv]}
      return argv
    }
    const work=withNativeRsyncOwner(f.destination,ctrl.signal,async()=>{admitted=true;throw new Error('business must not start')},ssh);void work.catch(()=>{})
    let captured:number[]=[]
    const observed=work.then(()=>{settled=true;throw new Error('unexpected success')},async error=>{
      settled=true;expect(admitted).toBe(false);expect(await configs()).toEqual(before);for(const pid of captured)expect(active(pid)).toBe(false)
      await writeFile('../.scratch/task-1/task7-fix4-closed-startup-evidence.json',JSON.stringify({error:String(error),initialExit:await readFile(exitFile,'utf8'),admitted,capturedPids:captured,alive:captured.map(active),metadata:await configs(),oldChannelClosed:oldClient?.destroyed},null,2)+'\n')
      return error
    });void observed.catch(()=>{})
    try{
      await until(async()=>{try{await access(mark);return true}catch{return false}});const clock=Number(await readFile(mark,'utf8'));await until(()=>processes().some(p=>p.parent===clock&&p.args==='sleep 6'))
      const ps=processes(),supervisor=ps.find(p=>p.pid===clock)!.parent,gate=ps.find(p=>p.pid===supervisor)!.parent;captured=[gate,supervisor,clock,...ps.filter(p=>p.parent===clock).map(p=>p.pid)]
      oldClient=lastClient!;recovered=false;oldClient.destroy()
      await until(async()=>{try{return (await readFile(exitFile,'utf8')).trim()==='255'}catch{return false}})
      ctrl.abort(new Error('closed startup cancelled'));await wait(300);expect(settled).toBe(false)
      recovered=true
      let deadline:ReturnType<typeof setTimeout>|undefined
      try{const error=await Promise.race([observed,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('closed-channel cleanup did not recover')),18000)})]);expect(String(error)).toMatch(/cancel|255/)}finally{clearTimeout(deadline)}
      expect(oldClient.destroyed).toBe(true);await access(failedObserver);expect(active(Number(await readFile(failedObserver,'utf8')))).toBe(false)
    }finally{
      ctrl.abort();for(const socket of sockets)socket.destroy();if(settled)await observed.catch(()=>{})
      // RED safety net only; never accepted as at-settlement cleanup proof.
      await until(async()=>JSON.stringify(await configs())===JSON.stringify(before),16000)
      await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},35000)

// The token fence must cover exec delivery before and after the cutoff, even when
// no original command was ever dispatched. These are real remote helper processes.
it.each(['before-cutoff','after-cutoff','never-dispatched'] as const)('fences %s startup without recreating owned state or admitting work',async timing=>{
  await withSshFixture(async f=>{
    const signal=new AbortController().signal,ssh=(command:string)=>f.isolate(sshArgv(f.destination,{command})),token=randomUUID(),before=await configs()
    const clock=await runCommand(ssh(recoveryHelperCommand('recovery-clock')),signal);expect(clock.exit).toBe(0)
    const {tick,base}=JSON.parse(clock.stdout),root=join(base,'superd-rsync-recovery.'+token),args={root,since:tick,cutoff:tick+8000,token}
    const business=join(f.directory,'must-not-start'),entry=join(f.directory,'late-entry-pid')
    const observer=runCommand(ssh(recoveryHelperCommand('recovery-observe',args)),signal)
    await until(async()=>{try{await access(join(root,'cancel'));return true}catch{return false}})
    let original:ReturnType<typeof runCommand>|undefined
    if(timing!=='never-dispatched') original=runCommand(ssh(`sleep ${timing==='before-cutoff'?1:8.5}; printf '%s\\n' $$ > ${JSON.stringify(entry)}; `+recoveryHelperCommand('recovery-run',{...args,command:'touch '+JSON.stringify(business)})),signal)
    if(timing==='before-cutoff'){
      const rejectedPromptly=await Promise.race([original!.then(()=>true),wait(3000).then(()=>false)])
      if(!rejectedPromptly)await observer // failed-check cleanup, not settlement proof
      expect(rejectedPromptly).toBe(true)
    }
    const result=await observer;expect(result.exit).toBe(0);expect(result.stdout.trim()).toBe('__SUPERD_RSYNC_'+token+'_CLEANED__')
    if(timing==='before-cutoff')expect(active(Number(await readFile(entry,'utf8')))).toBe(false)
    expect(await configs()).toEqual(before);await expect(access(business)).rejects.toThrow()
    if(original){expect((await original).exit).toBe(125);expect(active(Number(await readFile(entry,'utf8')))).toBe(false)}
    expect(await configs()).toEqual(before);await expect(access(business)).rejects.toThrow()
    await writeFile('../.scratch/task-1/task7-fix4-'+timing+'-evidence.json',JSON.stringify({timing,cleanupAcknowledged:true,metadataAtSettlement:before,metadataAfterLateDelivery:await configs(),businessAdmitted:false,lateOriginalExit:original?125:null},null,2)+'\n')
  })
},20000)

// An unread original SSH channel must not hold the gate lock while TERM cleanup
// writes terminal output. This exercises real pipe/window backpressure, not text mocks.
it('recovers an owned gate despite backpressured original output and terminal cleanup output',async()=>{
  await withSshFixture(async f=>{
    const {spawn}=await import('node:child_process'),{shQuote}=await import('../../src/remote/transports.ts'),signal=new AbortController().signal,ssh=(command:string)=>f.isolate(sshArgv(f.destination,{command})),before=await configs(),token=randomUUID()
    const clock=JSON.parse((await runCommand(ssh(recoveryHelperCommand('recovery-clock')),signal)).stdout),root=join(clock.base,'superd-rsync-recovery.'+token),args={root,since:clock.tick,cutoff:clock.tick+8000,token}
    const pidFile=join(f.directory,'blocked-owner-pid'),clean=join(f.directory,'blocked-owner-clean')
    const script=`trap 'for ((i=0;i<128;i++)); do printf "%65536s" x >&2; done; touch ${JSON.stringify(clean)}; exit 125' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do printf "%65536s" x; done`
    const argv=ssh(recoveryHelperCommand('recovery-run',{...args,command:'bash -c '+shQuote(script)})),child=spawn(argv[0]!,argv.slice(1),{stdio:['pipe','pipe','pipe']})
    const done=new Promise<void>(resolve=>child.once('close',()=>resolve()));let observer:ReturnType<typeof runCommand>|undefined,timer:ReturnType<typeof setTimeout>|undefined
    try{
      await until(async()=>{try{await access(pidFile);return true}catch{return false}});const pid=Number(await readFile(pidFile,'utf8')),gate=processes().find(p=>p.pid===pid)!.parent
      await wait(500);expect(active(pid)).toBe(true)
      observer=runCommand(ssh(recoveryHelperCommand('recovery-observe',args)),signal)
      const result=await Promise.race([observer,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('backpressured gate cleanup did not recover')),12000)})])
      expect(result.exit).toBe(0);await access(clean);expect(active(pid)).toBe(false);expect(active(gate)).toBe(false);expect(await configs()).toEqual(before)
      await writeFile('../.scratch/task-1/task7-fix4-backpressure-evidence.json',JSON.stringify({capturedPids:[gate,pid],alive:[active(gate),active(pid)],metadata:await configs(),terminalCleanupCompleted:true,originalOutputUnreadUntilAfterSettlement:true},null,2)+'\n')
    }finally{clearTimeout(timer);child.stdout.resume();child.stderr.resume();await observer;await done}
  })
},25000)

// Prepared ownership includes the output gate, not just the inner lease owner.
// Pause the actual TCP reader, withhold STOP/KEEP and downstream close, then assert
// every known receiver PID and private record is absent in the settlement reaction.
it('settles prepared silent-partition cancellation only after its backpressured gate is cleaned',async()=>{
  await withSshFixture(async f=>{
    const {chmod}=await import('node:fs/promises'),trigger=join(f.directory,'flood-start'),writerPid=join(f.directory,'flood-pid'),writer=join(f.directory,'flood-writer')
    await writeFile(writer,`#!/bin/bash\necho $$ > ${writerPid}\nexec /usr/bin/python3 -c 'import os; os.write(1,b"x"*33554432)'\n`);await chmod(writer,0o700)
    const sockets=new Set<Socket>(),remotes=new Set<Socket>();let stalled=false
    const proxy=createServer(client=>{const remote=createConnection({host:'127.0.0.1',port:f.destination.port});sockets.add(client);sockets.add(remote);remotes.add(remote)
      client.on('data',data=>{if(!stalled)remote.write(data)});remote.on('data',data=>{if(!stalled)client.write(data)})
      client.on('error',()=>{});remote.on('error',()=>{})
      client.on('close',()=>{if(!stalled)remote.destroy()});remote.on('close',()=>{if(!stalled)client.destroy()})
    });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as {port:number}).port
    const injection=`control() {\n  if [ -f ${trigger} ] && [ -z "$pid" ]; then ${writer} & pid=$!; fi`
    const ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv({...c,port:proxyPort},{...o,extraArgs:[...(o?.extraArgs??[]),'-o',`HostKeyAlias=[127.0.0.1]:${f.destination.port}`],command:o?.command?.replace('control() {',JSON.stringify(injection).slice(1,-1))}))
    const before=await configs(),ctrl=new AbortController();let ready!:()=>void,release!:()=>void,owner=''
    const started=new Promise<void>(r=>{ready=r}),holding=new Promise<void>(r=>{release=r})
    const work=withNativeRsyncOwner(f.destination,ctrl.signal,async directory=>{owner=directory;ready();await holding;return 0},ssh);void work.catch(()=>{})
    let captured:number[]=[],gateArgs:Record<string,unknown>|undefined,abortedAt=0
    const observed=work.then(()=>{throw new Error('cancelled operation succeeded')},async error=>{
      const metadata=await configs(),alive=captured.map(active),ownerExists=await access(owner).then(()=>true,()=>false)
      await writeFile('../.scratch/task-1/task7-fix5-prepared-partition-evidence.json',JSON.stringify({settledAfterAbortMs:Date.now()-abortedAt,capturedPids:captured,alive,metadata,ownerExists,downstreamOutputPaused:true,stopAndRenewWithheld:true},null,2)+'\n')
      expect(metadata).toEqual(before);expect(ownerExists).toBe(false);expect(alive).toEqual(captured.map(()=>false));return error
    });void observed.catch(()=>{})
    try{
      await Promise.race([started,work.then(()=>{throw new Error('no owner preparation')})]);stalled=true;for(const socket of remotes)socket.pause();await writeFile(trigger,'start')
      await until(async()=>{try{await access(writerPid);return true}catch{return false}})
      const pid=Number(await readFile(writerPid,'utf8')),ps=processes(),supervisor=ps.find(p=>p.pid===pid)!.parent,gate=ps.find(p=>p.pid===supervisor)!.parent
      captured=[gate,supervisor,pid,...ps.filter(p=>p.parent===supervisor&&p.pid!==pid).map(p=>p.pid)]
      const argv=(await readFile(`/proc/${gate}/cmdline`)).toString().split('\0');gateArgs=JSON.parse(argv[argv.indexOf('recovery-run')+1]!)
      await wait(300);abortedAt=Date.now();ctrl.abort(new Error('prepared backlog cancellation'));release()
      expect(String(await observed)).toContain('prepared backlog cancellation')
    }finally{
      ctrl.abort();release();await work.catch(()=>{})
      // Teardown-only recovery for RED; not part of the assertion/settlement barrier.
      if(gateArgs&&captured.some(active))await runCommand(f.isolate(sshArgv(f.destination,{command:recoveryHelperCommand('recovery-observe',gateArgs)})),new AbortController().signal)
      for(const socket of sockets)socket.destroy();await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},25000)

// Successful delivery must keep every byte (including NUL/non-UTF8), despite
// bounded queues and a temporarily paused normal consumer.
it('preserves normal binary stdout and stderr through the prepared output gate',async()=>{
  await withSshFixture(async f=>{
    const {spawn}=await import('node:child_process'),{shQuote}=await import('../../src/remote/transports.ts'),{createHash}=await import('node:crypto'),signal=new AbortController().signal
    const ssh=(command:string)=>f.isolate(sshArgv(f.destination,{command})),token=randomUUID(),before=await configs(),clock=JSON.parse((await runCommand(ssh(recoveryHelperCommand('recovery-clock')),signal)).stdout)
    const root=join(clock.base,'superd-rsync-recovery.'+token),args={root,since:clock.tick,cutoff:clock.tick+8000,token},pidFile=join(f.directory,'binary-owner-pid')
    const prepared=Buffer.from('__SUPERD_RSYNC_'+token+'_PREPARED__\n'),cleaned=Buffer.from('__SUPERD_RSYNC_'+token+'_CLEANED__\n')
    const expectedOut=Buffer.alloc(4*1024*1024),expectedErr=Buffer.alloc(1024*1024);for(let i=0;i<expectedOut.length;i++)expectedOut[i]=i%256;for(let i=0;i<expectedErr.length;i++)expectedErr[i]=255-i%256
    const script=`echo $$ > ${pidFile}; printf '%s\\n' ${shQuote(prepared.toString().trim())} >&2; read -r start; [ "$start" = START ] || exit 125; python3 -c 'import os; os.write(1,bytes(range(256))*16384); os.write(2,bytes(reversed(range(256)))*4096)'; printf '%s\\n' ${shQuote(cleaned.toString().trim())} >&2`
    const argv=ssh(recoveryHelperCommand('recovery-run',{...args,command:'bash -c '+shQuote(script)})),child=spawn(argv[0]!,argv.slice(1),{stdio:['pipe','pipe','pipe']}),stdout:Buffer[]=[],stderr:Buffer[]=[]
    let ready!:()=>void,paused=false;const started=new Promise<void>(r=>{ready=r}),done=new Promise<number|null>(r=>child.once('close',code=>r(code)))
    child.stdout.on('data',b=>{stdout.push(Buffer.from(b));if(!paused){paused=true;child.stdout.pause();setTimeout(()=>child.stdout.resume(),250)}})
    child.stderr.on('data',b=>{stderr.push(Buffer.from(b));if(Buffer.concat(stderr).includes(prepared))ready()})
    let keep:ReturnType<typeof setInterval>|undefined
    try{
      await started;const pid=Number(await readFile(pidFile,'utf8')),gate=processes().find(p=>p.pid===pid)!.parent;child.stdin.write('START\n');keep=setInterval(()=>child.stdin.write('KEEP\n'),2000)
      expect(await done).toBe(0);clearInterval(keep)
      const out=Buffer.concat(stdout),err=Buffer.concat(stderr);expect(err.subarray(0,prepared.length).equals(prepared)).toBe(true);expect(err.subarray(-cleaned.length).equals(cleaned)).toBe(true)
      const payloadErr=err.subarray(prepared.length,-cleaned.length),hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex')
      expect(out.length).toBe(expectedOut.length);expect(payloadErr.length).toBe(expectedErr.length);expect(hash(out)).toBe(hash(expectedOut));expect(hash(payloadErr)).toBe(hash(expectedErr));expect(await configs()).toEqual(before);expect([gate,pid].map(active)).toEqual([false,false])
      await writeFile('../.scratch/task-1/task7-fix5-normal-binary-evidence.json',JSON.stringify({stdoutBytes:out.length,stderrBytes:payloadErr.length,stdoutSha256:hash(out),stderrSha256:hash(payloadErr),expectedStdoutSha256:hash(expectedOut),expectedStderrSha256:hash(expectedErr),exit:0,capturedPids:[gate,pid],alive:[gate,pid].map(active),metadata:await configs(),pausedReaderMs:250},null,2)+'\n')
    }finally{clearInterval(keep);child.stdin.end('STOP\n');child.stdout.resume();child.stderr.resume();await done}
  })
},15000)

// Even an inner exit0 cannot turn discarded queued output into outer success.
it('withholds inner cleanup ACK and fails an expired prepared gate with unread successful-child output',async()=>{
  await withSshFixture(async f=>{
    const {spawn}=await import('node:child_process'),{shQuote}=await import('../../src/remote/transports.ts'),signal=new AbortController().signal,token=randomUUID(),before=await configs()
    const clock=JSON.parse((await runCommand(['python3','-u','-c',SSH_RECOVERY_HELPER,'recovery-clock','{}'],signal)).stdout),root=join(clock.base,'superd-rsync-recovery.'+token),clean=join(f.directory,'successful-child-clean'),pids=join(f.directory,'successful-child-pids')
    const prepared='__SUPERD_RSYNC_'+token+'_PREPARED__\n',cleaned='__SUPERD_RSYNC_'+token+'_CLEANED__\n'
    const script=`printf '%s\\n' ${shQuote(prepared.trim())} >&2; read -r start; [ "$start" = START ] || exit 125; python3 -c 'import os; os.write(1,b"x"*33554432)' & writer=$!; echo "$$ $writer" > ${pids}; sleep .3; kill -TERM "$writer"; wait "$writer" 2>/dev/null || :; touch ${clean}; printf '%s\\n' ${shQuote(cleaned.trim())} >&2; exit 0`
    const child=spawn('python3',['-u','-c',SSH_RECOVERY_HELPER,'recovery-run',JSON.stringify({root,since:clock.tick,cutoff:clock.tick+8000,token,command:'bash -c '+shQuote(script)})],{stdio:['pipe','pipe','pipe']})
    let stderr='',ready!:()=>void;const started=new Promise<void>(r=>{ready=r}),exited=new Promise<number|null>(r=>child.once('exit',code=>r(code))),closed=new Promise<void>(r=>child.once('close',()=>r()))
    child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{stderr+=text;if(stderr.includes(prepared))ready()})
    try{
      await started;child.stdin.write('START\n');await until(async()=>{try{await access(clean);return true}catch{return false}});await wait(100)
      expect(active(child.pid!)).toBe(true);expect(stderr).not.toContain(cleaned)
      const captured=[child.pid!,...(await readFile(pids,'utf8')).trim().split(' ').map(Number)],exit=await exited
      expect(exit).toBe(125);expect(captured.map(active)).toEqual(captured.map(()=>false));expect(await configs()).toEqual(before)
      await writeFile('../.scratch/task-1/task7-fix5-expired-success-evidence.json',JSON.stringify({innerExit:0,innerCleanupCompleted:true,gateExit:exit,earlyInnerAckForwarded:false,stdoutUnreadThroughGateExit:true,capturedPids:captured,alive:captured.map(active),metadata:await configs()},null,2)+'\n')
    }finally{child.stdin.end('STOP\n');child.stdout.resume();await closed}
  })
},15000)

// Break caught: archive silently changes source symlink values or widens destination module.
it('refuses relay symlinks (including newline filenames) and files/new destinations before data writes', async()=>{
  await withSshFixture(async f=>{
    const src=join(f.directory,'src'),dst=join(f.directory,'dst');await mkdir(src);await mkdir(dst)
    await writeFile(join(src,'data'),'source');await writeFile(join(dst,'extra'),'preserved');await symlink('data',join(src,'link\nwith\nnewlines'))
    const before=await configs(),p=await ports(),options={ssh:(c:Parameters<typeof sshArgv>[0],o:Parameters<typeof sshArgv>[1])=>f.isolate(sshArgv(c,o)),ports:p}
    const request={src:src+'/',dst,dryRun:false,delete:true}
    await expect(runRsync(request,{path:src+'/',connection:f.jump},{path:dst,connection:f.destination},new AbortController().signal,options)).rejects.toThrow(/symlink.*unsupported/i)
    expect(await readdir(dst)).toEqual(['extra']);expect(await readFile(join(dst,'extra'),'utf8')).toBe('preserved');await ownedClean(before,p)
    for(const target of [join(f.directory,'new-path'),join(dst,'extra'),dst+'\n[escape]']) {
      await expect(withSshRelay(f.jump,f.destination,target,new AbortController().signal,async()=>{throw new Error('must not run')},options)).rejects.toThrow(/existing|newline/)
      await ownedClean(before,p)
    }
    await expect(access(join(f.directory,'new-path'))).rejects.toThrow()
  })
},20000)

// Break caught: native local-leg sender survives Agent/plugin owner cancellation.
it('disposes a driver during native SSH-local transfer and reaps its real remote protocol descendants',async()=>{
  await withSshFixture(async f=>{
    const bin=join(f.directory,'bin'),src=join(f.directory,'src'),dst=join(f.directory,'dst');await mkdir(bin);await mkdir(src);await mkdir(dst)
    const {chmod}=await import('node:fs/promises')
    const marker=join(f.directory,'server-pid')
    await writeFile(join(bin,'rsync'),`#!/bin/bash\nprintf '%s\\n' $$ > ${JSON.stringify(marker)}\nexec /usr/bin/rsync --bwlimit=64 "$@"\n`);await chmod(join(bin,'rsync'),0o700)
    await writeFile(join(src,'binary'),Buffer.alloc(1024*1024,99))
    const ssh:typeof sshArgv=(c,o)=>{const argv=f.isolate(sshArgv(c,o));if(!o?.command)argv.push('PATH='+JSON.stringify(bin)+':"$PATH"');return argv}
    const d=new RemoteDriver({rsyncSshArgv:ssh});d.registerSsh('byossh:remote',f.destination)
    const work=d.rsync({src:`byossh:remote:${src}/`,dst,dryRun:false},new AbortController().signal);let outcome='pending';void work.then(r=>{outcome=JSON.stringify(r)},e=>{outcome=String(e)})
    try {
      let group:number|undefined
      try {await until(async()=>{try{const pid=Number(await readFile(marker,'utf8'));group=processes().find(p=>p.pid===pid&&p.args.startsWith('/usr/bin/rsync --bwlimit=64 --server '))?.group;return group!==undefined}catch{return false}})} catch(error) {throw new Error(`${error}; native work=${outcome}; marker=${await readFile(marker,'utf8').catch(()=> 'absent')}`)}
      const captured=processes().filter(p=>p.group===group).map(p=>p.pid);expect(captured.length).toBeGreaterThanOrEqual(1)
      await d.dispose();await expect(work).rejects.toThrow('remote owner disposed')
      for(const pid of captured)expect(active(pid)).toBe(false)
      expect((await readdir(tmpdir())).filter(n=>n.startsWith('superd-rsync-native.'))).toEqual([])
    } finally {await d.dispose();await work.catch(()=>{})}
  })
},20000)

// Break caught: a lost control channel or late KEEP refreshes an unknown remote lease,
// and native protocol helpers outlive Agent disposal while SSH close is unobservable.
it('accounts a delayed native renewal and holds driver disposal through withheld remote close',async()=>{
  await withSshFixture(async f=>{
    const sockets=new Set<Socket>(),pending:Buffer[]=[];let stalled=false,collect=true
    const downstream=new Map<Socket,Buffer[]>()
    const proxy=createServer(client=>{const remote=createConnection({host:'127.0.0.1',port:f.destination.port}),queued:Buffer[]=[];sockets.add(client);sockets.add(remote);downstream.set(remote,queued)
      remote.on('data',data=>{if(!stalled)client.write(data)})
      client.on('error',()=>{});client.on('close',()=>{sockets.delete(client)})
      remote.on('error',()=>{});remote.on('close',()=>{sockets.delete(remote);downstream.delete(remote)})
      // Each buffered packet belongs to this connection, not a guessed SSH packet type.
      client.on('data',data=>{
        if(!stalled)remote.write(data)
        else if(collect){const copy=Buffer.from(data);pending.push(copy);queued.push(copy)}
      })
    });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as {port:number}).port
    const bin=join(f.directory,'bin'),src=join(f.directory,'src'),dst=join(f.directory,'dst'),pidFile=join(f.directory,'native-pid');await mkdir(bin);await mkdir(src);await mkdir(dst)
    const {chmod}=await import('node:fs/promises')
    await writeFile(join(bin,'rsync'),`#!/bin/bash\nprintf '%s\\n' $$ > ${JSON.stringify(pidFile)}\nexec /usr/bin/rsync --bwlimit=64 "$@"\n`);await chmod(join(bin,'rsync'),0o700)
    await writeFile(join(src,'binary'),Buffer.alloc(1024*1024,77))
    const ssh:typeof sshArgv=(c,o)=>{
      const argv=f.isolate(sshArgv({...c,port:proxyPort},{...o,extraArgs:[...(o?.extraArgs??[]),'-o',`HostKeyAlias=[127.0.0.1]:${f.destination.port}`]}))
      if(!o?.command)argv.push('PATH='+JSON.stringify(bin)+':"$PATH"')
      return argv
    }
    const before=await configs(),d=new RemoteDriver({rsyncSshArgv:ssh});d.registerSsh('byossh:remote',f.destination)
    const work=d.rsync({src:`byossh:remote:${src}/`,dst,dryRun:false},new AbortController().signal);void work.catch(()=>{})
    let disposal:Promise<void>|undefined,captured:number[]=[]
    try {
      await until(async()=>{try{await access(pidFile);return true}catch{return false}})
      const owned=(await configs()).filter(n=>!before.includes(n)&&n.startsWith('superd-rsync-native.'));expect(owned).toHaveLength(1)
      const owner=join(tmpdir(),owned[0]!),record=(await readdir(owner)).find(n=>n.startsWith('server.'))!
      const [helper,group,clock]=(await readFile(join(owner,record),'utf8')).trim().split(' ').map(Number)
      await until(()=>processes().some(p=>p.group===group&&p.args.startsWith('/usr/bin/rsync --bwlimit=64 --server ')))
      captured=[helper!,clock!,...processes().filter(p=>p.group===group).map(p=>p.pid)]
      const initialCount=Number((await readFile(join(owner,'lease'),'utf8')).trim().split(' ')[1])
      expect((await stat(owner)).mode&0o777).toBe(0o700);expect((await stat(join(owner,'lease'))).mode&0o777).toBe(0o600)
      stalled=true;await wait(2300);expect(pending.length).toBeGreaterThan(0);collect=false
      const abortAt=Date.now();disposal=d.dispose();let settled=false;void disposal.then(()=>{settled=true})
      await wait(300);expect(settled).toBe(false);expect(await configs()).toContain(owned[0])
      await wait(1200)
      // Deliver only bytes buffered BEFORE abort; STOP/close and later data stay lost.
      for(const [remote,queued] of downstream)for(const packet of queued)remote.write(packet)
      await until(async()=>Number((await readFile(join(owner,'lease'),'utf8')).trim().split(' ')[1])>initialCount,2000)
      const appliedCount=Number((await readFile(join(owner,'lease'),'utf8')).trim().split(' ')[1])
      await disposal;await expect(work).rejects.toThrow('remote owner disposed')
      expect(await configs()).toEqual(before);for(const pid of captured)expect(active(pid)).toBe(false)
      expect([...downstream.keys()].some(socket=>!socket.destroyed)).toBe(true)
      await writeFile('../.scratch/task-1/task7-fix2-native-partition-evidence.json',JSON.stringify({settledAfterAbortMs:Date.now()-abortAt,bufferedPacketsBeforeAbort:pending.length,deliveredAfterAbortMs:1500,initialRenewalCount:initialCount,appliedRenewalCount:appliedCount,capturedRemotePids:captured,capturedPidsAliveAtSettlement:captured.map(active),ownedMetadataAtSettlement:await configs(),downstreamCloseWithheld:true},null,2)+'\n')
    } finally {
      for(const socket of sockets)socket.destroy();await d.dispose();await work.catch(()=>{});await disposal
      await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},35000)

it('closes native remote admission at ownership settlement without reviving metadata or children',async()=>{
  await withSshFixture(async f=>{
    const before=await configs(),signal=new AbortController().signal,ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,o))
    let directory=''
    await withNativeRsyncOwner(f.destination,signal,async path=>{directory=path},ssh)
    expect(await configs()).toEqual(before)
    const result=await runCommand(ssh(f.destination,{command:nativeRsyncPath(directory)+' --version'}),signal)
    expect(result.exit).toBe(125);expect(result.stdout).not.toContain('rsync  version');expect(await configs()).toEqual(before)
    await expect(access(directory)).rejects.toThrow()
  })
},15000)

it('refuses a missing native control prerequisite before ownership metadata or transfer admission',async()=>{
  await withSshFixture(async f=>{
    const before=await configs(),bin=join(f.directory,'only-control-tools');await mkdir(bin)
    for(const name of ['bash','python3','mktemp','rm','sleep'])await symlink(execFileSync('which',[name],{encoding:'utf8'}).trim(),join(bin,name))
    const ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,{...o,command:'PATH='+JSON.stringify(bin)+'; '+o?.command}))
    await expect(withNativeRsyncOwner(f.destination,new AbortController().signal,async()=>{throw new Error('transfer admitted')},ssh)).rejects.toThrow(/native receiving control requires mv/)
    expect(await configs()).toEqual(before)
  })
},15000)

it('uses owned source proxy without obsolete source pidfd APIs and keeps ordinary native legs',async()=>{
  await withSshFixture(async f=>{
    const src=join(f.directory,'cap-source'),dst=join(f.directory,'cap-destination'),file=join(f.directory,'native-copy');await mkdir(src);await mkdir(dst);await writeFile(join(src,'file'),'capability scoped')
    const before=await configs(),p=await ports(),ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,{...o,command:o?.command?.replaceAll('os.pidfd_open','os.fixture_missing_pidfd_open')}))
    expect((await runRsync({src:src+'/',dst,dryRun:false},{path:src+'/',connection:f.jump},{path:dst,connection:f.destination},new AbortController().signal,{ssh,ports:p})).exit).toBe(0)
    expect(await readFile(join(dst,'file'),'utf8')).toBe('capability scoped');await ownedClean(before,p)
    const result=await runRsync({src:join(src,'file'),dst:file,dryRun:false},{path:join(src,'file'),connection:f.jump},{path:file},new AbortController().signal,{ssh})
    expect(result.exit).toBe(0);expect(await readFile(file,'utf8')).toBe('capability scoped');expect(await configs()).toEqual(before)
  })
},20000)

it('uses canonical actual IPv6 source SSH identity for a two-remote relay',async()=>{
  await withSshFixture(async f=>{
    const source={...f.jump,host:'::1'},signal=new AbortController().signal,ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,o))
    const connection=await runCommand(ssh(source,{command:'printf \'%s\' "$SSH_CONNECTION"'}),signal)
    expect(connection.exit).toBe(0);expect(connection.stdout).toMatch(/^::1 \d+ ::1 \d+$/)
    const src=join(f.directory,'ipv6-source'),dst=join(f.directory,'ipv6-destination');await mkdir(src);await mkdir(dst)
    await writeFile(join(src,'binary'),Buffer.from([0,255,128,13,10]));const before=await configs(),p=await ports()
    const result=await runRsync({src:src+'/',dst,dryRun:false},{path:src+'/',connection:source},{path:dst,connection:f.destination},signal,{ssh,ports:p})
    expect(result.exit).toBe(0);expect(await readFile(join(dst,'binary'))).toEqual(await readFile(join(src,'binary')));await ownedClean(before,p)
    await writeFile('../.scratch/task-1/task7-fix2-ipv6-source-evidence.json',JSON.stringify({sshConnection:connection.stdout,exit:result.exit,ownedMetadataAtSettlement:await configs(),ownedListenersAtSettlement:await Promise.all(Object.values(p).map(listening))},null,2)+'\n')
  },{ipv6:true})
},20000)

it('keeps agents and both identities on the origin despite native ForwardAgent=yes config and ProxyJump',async()=>{
  await withSshFixture(async f=>{
    const socket=join(f.directory,'agent.sock'),agent=execFileSync('ssh-agent',['-a',socket,'-s'],{encoding:'utf8'})
    const pid=Number(/SSH_AGENT_PID=(\d+)/.exec(agent)![1])
    try {
      execFileSync('ssh-add',[f.jump.key,f.destination.key],{env:{...process.env,SSH_AUTH_SOCK:socket},stdio:'ignore'})
      await writeFile(f.config,(await readFile(f.config,'utf8')).replace('IdentityAgent none',`IdentityAgent ${socket}`).replace('ForwardAgent no','ForwardAgent yes'))
      const baseline=await runCommand(f.isolate(sshArgv(f.destination,{command:'test -n "${SSH_AUTH_SOCK:-}"'})),new AbortController().signal)
      expect(baseline.exit).toBe(0)
      const src=join(f.directory,'src'),dst=join(f.directory,'dst');await mkdir(src);await mkdir(dst);await writeFile(join(src,'binary'),'native\0payload')
      const before=await configs(),p=await ports(),destination={...f.destination,host:'fixture-native',proxyJump:'fixture-jump'}
      let remoteCommands=0
      const ssh:typeof sshArgv=(c,o)=>{
        expect(c).toEqual(c.host==='fixture-native'?destination:f.jump)
        expect(o?.command ?? '').not.toContain(f.jump.key);expect(o?.command ?? '').not.toContain(f.destination.key)
        if(o?.command) remoteCommands++
        return f.isolate(sshArgv(c,o?.command?{...o,command:'test -z "${SSH_AUTH_SOCK:-}" || exit 99; '+o.command}:o))
      }
      const result=await runRsync({src:src+'/',dst,dryRun:false},{path:src+'/',connection:f.jump},{path:dst,connection:destination},new AbortController().signal,{ports:p,ssh})
      expect(result.exit).toBe(0);expect(remoteCommands).toBeGreaterThanOrEqual(6)
      expect(await readFile(join(dst,'binary'),'utf8')).toBe('native\0payload');await ownedClean(before,p)
      expect(await readdir(dst)).toEqual(['binary'])
    } finally {try{process.kill(pid,'SIGTERM')}catch{};await until(()=>!active(pid))}
  },{agentForwarding:true})
},20000)

it('retains the native source rsync failure and requires native rsync instead of falling back',async()=>{
  await withSshFixture(async f=>{
    const dst=join(f.directory,'dst');await mkdir(dst);const before=await configs(),p=await ports(),ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,o))
    const missing=join(f.directory,'missing')
    const result=await runRsync({src:missing,dst,dryRun:false},{path:missing,connection:f.jump},{path:dst,connection:f.destination},new AbortController().signal,{ports:p,ssh})
    expect(result.exit).toBe(23);expect(result.stderr).toContain('No such file');await ownedClean(before,p)
    const noRsync:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,o?.command?.includes('command -v rsync')?{...o,command:'PATH=/nonexistent; '+o.command}:o))
    await expect(withSshRelay(f.jump,f.destination,dst,new AbortController().signal,async()=>{throw new Error('fallback ran')},{ports:p,ssh:noRsync})).rejects.toThrow(/native rsync.*no copy fallback/)
    await ownedClean(before,p)
  })
},20000)

for (const endpoint of ['destination'] as const) {
  // Break caught: ExitOnForwardFailure alone cannot detect destination channel refusal.
  it(`fails the complete protocol route when ${endpoint} forwarding is denied, then removes owned resources`,async()=>{
    await withSshFixture(async f=>{
      const dst=join(f.directory,'dest');await mkdir(dst);const before=await configs(),p=await ports()
      let ran=false
      await expect(withSshRelay(f.jump,f.destination,dst,new AbortController().signal,async()=>{ran=true}, {ports:p,ssh:(c,o)=>f.isolate(sshArgv(c,o))})).rejects.toThrow(/forward|prohibited|readiness|source proxy/i)
      expect(ran).toBe(false);await ownedClean(before,p)
    },{forwarding:{[endpoint]:'no'}})
  },20000)
}

for (const leg of ['destination','origin','source'] as const) {
  it(`fails on ${leg} port collision without closing the pre-existing listener`,async()=>{
    await withSshFixture(async f=>{
      const dst=join(f.directory,'dest');await mkdir(dst);const before=await configs(),p=await ports();p[leg]=f.destination.port
      let ran=false
      await expect(withSshRelay(f.jump,f.destination,dst,new AbortController().signal,async()=>{ran=true}, {ports:p,ssh:(c,o)=>f.isolate(sshArgv(c,o))})).rejects.toThrow(/readiness|forward|bind|listen/i)
      expect(ran).toBe(false);expect(await configs()).toEqual(before)
      for(const [name,n] of Object.entries(p)) expect(await listening(n)).toBe(name===leg)
    })
  },20000)
}

for (const failure of ['abort','daemon-death','clock-death'] as const) {
  // Native throttling is a fixture-only sender option, not a model-facing feature.
  it(`cleans captured native sender/receiver groups after ${failure} during a real transfer`,async()=>{
    await withSshFixture(async f=>{
      const src=join(f.directory,'src'),dst=join(f.directory,'dst');await mkdir(src);await mkdir(dst);await writeFile(join(src,'binary'),Buffer.alloc(1024*1024,123))
      const before=await configs(),p=await ports(),controller=new AbortController(),captured:number[]=[]
      const work=withSshRelay(f.jump,f.destination,dst,controller.signal,async r=>{
        const running=r.run(['rsync','-a','--no-compress','--timeout=10','--bwlimit=64','--',src+'/',r.url]);void running.catch(()=>{})
        await until(()=>processes().some(x=>x.args.startsWith('rsync -a ')&&x.args.includes(src)))
        let daemon:ReturnType<typeof processes>[number]|undefined
        await until(()=>{daemon=processes().find(x=>x.args.startsWith('rsync --daemon ')&&!before.some(n=>x.args.includes(n)));return !!daemon})
        await until(()=>processes().some(x=>x.parent===daemon!.pid))
        const list=processes(),sender=list.find(x=>x.args.startsWith('rsync -a ')&&x.args.includes(src))!
        captured.push(...list.filter(x=>x.group===sender.group||x.group===daemon!.group).map(x=>x.pid))
        expect(captured.length).toBeGreaterThanOrEqual(3)
        if(failure==='abort') controller.abort(new Error('fixture transfer cancelled'))
        else if(failure==='daemon-death')process.kill(daemon!.pid,'SIGKILL')
        else {
          const clock=list.find(p=>p.parent===daemon!.parent&&p.args.startsWith('python3 -u -c ')&&p.args.endsWith('lease-clock {}'));expect(clock).toBeDefined()
          captured.push(clock!.pid);process.kill(clock!.pid,'SIGKILL')
        }
        return await running
      },{ports:p,ssh:(c,o)=>f.isolate(sshArgv(c,o))})
      if(failure==='abort') await expect(work).rejects.toThrow('fixture transfer cancelled')
      else {
        // The owned binary proxy can observe the broken daemon stream before
        // the native sender reports its nonzero exit. Both must retain cleanup.
        const outcome=await work.then(result=>({result}),error=>({error}))
        if('error' in outcome)expect(String(outcome.error)).toMatch(/source proxy destination socket: write EPIPE/)
        else {expect(outcome.result.exit).not.toBe(0);expect(outcome.result.stderr).toMatch(/rsync|closed|error|terminated/)}
      }
      await ownedClean(before,p,captured)
    })
  },30000)
}

// A silent TCP partition leaves sshd/session alive: remote stdin lease must expire independently.
it('expires the destination native daemon lease on a silent network partition before origin cancellation',async()=>{
  await withSshFixture(async f=>{
    const sockets=new Set<Socket>();let stalled=false
    const proxy=createServer(client=>{const remote=createConnection({host:'127.0.0.1',port:f.destination.port});sockets.add(client);sockets.add(remote)
      client.on('data',data=>{if(!stalled)remote.write(data)});remote.on('data',data=>{if(!stalled)client.write(data)})
      for(const [a,b] of [[client,remote],[remote,client]]) {a!.on('error',()=>b!.destroy());a!.on('close',()=>{sockets.delete(a!);b!.destroy()})}
    })
    await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as {port:number}).port
    const dst=join(f.directory,'dest');await mkdir(dst);const before=await configs(),p=await ports(),controller=new AbortController()
    let release!:()=>void,ready!:()=>void;const holding=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{ready=r})
    const work=withSshRelay(f.jump,f.destination,dst,controller.signal,async()=>{ready();await holding},{ports:p,ssh:(c,o)=>f.isolate(sshArgv(c.port===f.destination.port?{...c,port:proxyPort}:c,c.port===f.destination.port?{...o,extraArgs:[...(o?.extraArgs??[]),'-o',`HostKeyAlias=[127.0.0.1]:${f.destination.port}`]}:o))})
    void work.catch(()=>{})
    try {
      await started
      const owned=(await configs()).filter(n=>!before.includes(n)&&n.startsWith('superd-rsync.'));expect(owned).toHaveLength(1)
      expect((await stat(join(tmpdir(),owned[0]!))).mode&0o777).toBe(0o700)
      expect((await stat(join(tmpdir(),owned[0]!,'rsyncd.conf'))).mode&0o777).toBe(0o600)
      const daemon=processes().find(x=>x.args.startsWith('rsync --daemon ')&&x.args.includes(owned[0]!))!;expect(daemon).toBeDefined()
      stalled=true;const began=Date.now();await until(async()=>!(await configs()).includes(owned[0]!),11000)
      expect(Date.now()-began).toBeLessThan(11000);await until(()=>!active(daemon.pid))
      controller.abort(new Error('partition fixture finish'));release();await work.catch(()=>{})
      await ownedClean(before,p,[daemon.pid])
    } finally {
      controller.abort();release();await work.catch(()=>{});for(const socket of sockets)socket.destroy();await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},30000)

it('leases source tree inspection too: a partition cannot strand its actual find descendants',async()=>{
  await withSshFixture(async f=>{
    const bin=join(f.directory,'bin'),src=join(f.directory,'src'),dst=join(f.directory,'dst'),marker=join(f.directory,'find-pid');await mkdir(bin);await mkdir(src);await mkdir(dst)
    const {chmod}=await import('node:fs/promises')
    await writeFile(join(bin,'find'),`#!/bin/bash\nprintf '%s\\n' $$ > ${JSON.stringify(marker)}\nsleep 30\nexec /usr/bin/find "$@"\n`);await chmod(join(bin,'find'),0o700)
    const sockets=new Set<Socket>();let stalled=false
    const proxy=createServer(client=>{const remote=createConnection({host:'127.0.0.1',port:f.jump.port});sockets.add(client);sockets.add(remote)
      client.on('data',data=>{if(!stalled)remote.write(data)});remote.on('data',data=>{if(!stalled)client.write(data)})
      for(const [a,b] of [[client,remote],[remote,client]]){a!.on('error',()=>b!.destroy());a!.on('close',()=>{sockets.delete(a!);b!.destroy()})}
    });await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const n=(proxy.address() as {port:number}).port
    const controller=new AbortController();let group:number|undefined,captured:number[]=[]
    const ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c.port===f.jump.port?{...c,port:n}:c,{...o,extraArgs:[...(o?.extraArgs??[]),'-o',`HostKeyAlias=[127.0.0.1]:${f.jump.port}`],command:'PATH='+JSON.stringify(bin)+':"$PATH"; '+o?.command}))
    const work=runRsync({src:src+'/',dst,dryRun:false},{path:src+'/',connection:f.jump},{path:dst,connection:f.destination},controller.signal,{ssh});void work.catch(()=>{})
    try {
      await until(async()=>{try{await access(marker);return true}catch{return false}})
      const pid=Number(await readFile(marker,'utf8'));group=processes().find(p=>p.pid===pid)!.group
      await until(()=>processes().some(p=>p.parent===pid));captured=processes().filter(p=>p.group===group).map(p=>p.pid)
      expect(captured.length).toBeGreaterThanOrEqual(2);stalled=true
      await until(()=>captured.every(pid=>!active(pid)),11000)
    } finally {
      controller.abort();for(const socket of sockets)socket.destroy();await work.catch(()=>{})
      // RED safety net is strictly the captured fixture group, never unrelated SSH.
      if(group&&captured.some(active)){try{process.kill(-group,'SIGTERM')}catch{};await wait(150);try{process.kill(-group,'SIGKILL')}catch{}}
      await new Promise<void>(r=>proxy.close(()=>r()))
    }
  })
},30000)
