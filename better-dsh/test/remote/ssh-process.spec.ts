import { it, expect } from 'vitest'
import { readFile, writeFile, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { withSshFixture } from './ssh-fixture.ts'
import { sshArgv } from '../../src/remote/ssh-targets.ts'
import { startOwnedSshProcess } from '../../src/remote/ssh-process.ts'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { shQuote } from '../../src/remote/transports.ts'
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(f:()=>boolean|Promise<boolean>){const end=Date.now()+15000;while(!await f()){if(Date.now()>end)throw Error('fixture deadline');await wait(20)}}
function live(pid:number){try{process.kill(pid,0);return true}catch{return false}}
async function pidsAt(path:string){try{return(await readFile(path,'utf8')).trim().split(/\s+/).map(Number)}catch{return[]}}
const command=(file:string)=>`bash -c ${shQuote('echo $$ > '+shQuote(file)+'; sleep 600 & echo $! >> '+shQuote(file)+'; printf ready; wait')}`
it('cancellation drains real terminal output when work channel trails control ACK',async()=>{
 await withSshFixture(async f=>{
  const proxy=join(f.directory,'delayed-work.mjs')
  await writeFile(proxy,`import {spawn} from 'node:child_process';const c=spawn('/usr/bin/ssh',process.argv.slice(2),{stdio:['pipe','pipe','pipe']});process.stdin.pipe(c.stdin);c.stdin.on('error',()=>{});let out=[],err=[];c.stdout.on('data',b=>out.push(b));c.stderr.on('data',b=>err.push(b));c.on('close',code=>setTimeout(()=>{process.stdout.write(Buffer.concat(out));process.stderr.write(Buffer.concat(err));process.exitCode=code},700));`)
  const file=join(f.directory,'ready')
  const ssh:typeof sshArgv=(c,o)=>{const argv=f.isolate(sshArgv(c,o));return o?.command?.includes(" 'native-command' ")?[process.execPath,proxy,...argv.slice(1)]:argv}
  const p=await startOwnedSshProcess(f.destination,`trap 'trap - TERM HUP INT; printf terminal-out; printf terminal-err >&2; exit 0' TERM; echo $$ > ${shQuote(file)}; while :; do sleep .05; done`,{signal:new AbortController().signal,ssh})
  try{
   await until(async()=>{try{await access(file);return true}catch{return false}})
   p.cancel();expect((await p.done).cancelled).toBe(true)
   expect(p.read('stdout',0).text).toBe('terminal-out');expect(p.read('stderr',0).text).toContain('terminal-err')
   expect(p.read('stdout',p.read('stdout',0).nextOffset).text).toBe('')
  }finally{p.cancel();await p.done}
 })
},30000)
it('foreground script and large literal stdin preserve separate streams without control pollution',async()=>{
 await withSshFixture(async f=>{
  const d=new RemoteDriver({rsyncSshArgv:(c,o)=>f.isolate(sshArgv(c,o))})
  try{
   const stdin='START\nKEEP\nSTOP\n😀 literal $()\u0000\n'.repeat(20000)
   const r=await d.call({target:'byossh:owned',ssh:f.destination,cmd:"python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()); print(\"separate\",file=sys.stderr)'",stdin})
   expect(r.exit).toBe(0);expect(r.stdout).toBe(createHash('sha256').update(stdin).digest('hex')+'\n');expect(r.stderr).toBe('separate\n')
   const script=join(f.directory,'literal.sh');await writeFile(script,'printf "script-out😀"\nprintf "script-err" >&2\n')
   const s=await d.call({target:'byossh:owned',script});expect(s.exit).toBe(0);expect(s.stdout).toBe('script-out😀');expect(s.stderr).toBe('script-err')
  }finally{await d.dispose()}
 })
},30000)
for(const mode of ['timeout','dispose'] as const)it(`${mode} waits for real children to be absent`,async()=>{
 await withSshFixture(async f=>{
  let owner=''; const d=new RemoteDriver({rsyncSshArgv:(c,o)=>{if(o?.command?.includes(" 'native-command' ")) owner=/"directory":"([^"]+)"/.exec(o.command)![1]!;return f.isolate(sshArgv(c,o))}}),file=join(f.directory,'pids');let pids:number[]=[]
  try{
   const work=d.call({target:'byossh:owned',ssh:f.destination,cmd:command(file),timeout:mode==='timeout'?1:30})
   await until(async()=>{pids=await pidsAt(file);return pids.length===2});const helpers=(await readdir(owner)).filter(n=>n.startsWith('server.')).map(n=>Number(n.slice(7)));expect(helpers.length).toBe(1);if(mode==='dispose')await d.dispose()
   const r=await work;if(mode==='timeout')expect(r.timedOut).toBe(true);expect(pids.filter(live)).toEqual([]);expect(helpers.filter(live)).toEqual([]);await expect(access(owner)).rejects.toThrow()
  }finally{for(const pid of pids)try{process.kill(pid,'SIGKILL')}catch{}await d.dispose()}
 })
},30000)
it('pre-admission abort executes no SSH and disposed drivers admit no work',async()=>{
 const abort=new AbortController();abort.abort();let calls=0
 await expect(startOwnedSshProcess({host:'not-used'},'true',{signal:abort.signal,ssh:()=>{calls++;throw Error('must not execute')}})).rejects.toThrow();expect(calls).toBe(0)
 const d=new RemoteDriver();await d.dispose();await expect(d.start({target:'ssh:not-used',cmd:'true'},new AbortController().signal)).rejects.toThrow(/E_REMOTE_DISPOSED/)
})

it('cancellation fences a finitely delayed work exec before it can start user code',async()=>{
 await withSshFixture(async f=>{
  const proxy=join(f.directory,'late-work.mjs'),file=join(f.directory,'must-not-exist')
  await writeFile(proxy,`import {spawn} from 'node:child_process';setTimeout(()=>{const c=spawn('/usr/bin/ssh',process.argv.slice(2),{stdio:'inherit'});c.on('close',code=>{process.exitCode=code})},500)`)
  let owner=''
  const ssh:typeof sshArgv=(c,o)=>{const argv=f.isolate(sshArgv(c,o));if(!o?.command?.includes(" 'native-command' "))return argv;owner=/"directory":"([^"]+)"/.exec(o.command)![1]!;return [process.execPath,proxy,...argv.slice(1)]}
  const p=await startOwnedSshProcess(f.destination,`echo BAD > ${shQuote(file)}`,{signal:new AbortController().signal,ssh})
  p.cancel();await p.done
  await expect(access(file)).rejects.toThrow();await expect(access(owner)).rejects.toThrow()
 })
},30000)

it('a second receiving TERM during cleanup cannot abandon owned metadata',async()=>{
 await withSshFixture(async f=>{
  const {withNativeSshOwner}=await import('../../src/remote/ssh-relay.ts'),marker=join(f.directory,'cleanup-pid');let owner=''
  const ssh:typeof sshArgv=(c,o)=>f.isolate(sshArgv(c,{...o,command:o?.command?.replace('helpers=()',()=>JSON.stringify(`echo $$ > ${marker}; sleep .4; helpers=()`).slice(1,-1))}))
  const work=withNativeSshOwner(f.destination,new AbortController().signal,async directory=>{owner=directory;return 0},ssh)
  try{
   await until(async()=>{try{await access(marker);return true}catch{return false}})
   const pid=Number(await readFile(marker,'utf8'));process.kill(pid,'SIGTERM')
   await work;expect(live(pid)).toBe(false);await expect(access(owner)).rejects.toThrow()
  }finally{await work.catch(()=>{});if(owner){const {rm}=await import('node:fs/promises');await rm(owner,{recursive:true,force:true})}}
 })
},20000)
