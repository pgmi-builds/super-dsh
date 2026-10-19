import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { buildOneShotArgv, shQuote } from '../../src/remote/transports.ts'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
// Explicit task-owned fixtures only; never mutate unrelated containers.
for(const kind of ['docker','incus'] as const){
 const container=process.env[`REMOTE_TEST_${kind.toUpperCase()}_CONTAINER`]
 describe.skipIf(!container)(`${kind} receiving ownership`,()=>{
  const run=(cmd:string)=>{const [exe,...args]=buildOneShotArgv({kind,container:container!},cmd);return execFileSync(exe!,args,{encoding:'utf8'})}
  for(const mode of ['cancel','timeout','dispose'] as const)it(`${mode} settles only after known work group and helper cleanup`,async()=>{
   const root=run('mktemp -d /tmp/task8-container-test.XXXXXXXX').trim(),d=new RemoteDriver();let pids:number[]=[]
   try{
    const cmd=`bash -c ${shQuote(`echo $$ > ${root}/pids; sleep 600 & echo $! >> ${root}/pids; printf ready; wait`)}`
    const p=await d.start({target:kind+':'+container,cmd,mode:'oneshot',...(mode==='timeout'?{timeout:2}:{})},new AbortController().signal)
    const end=Date.now()+5000
    while(!p.read('stdout',0).text.includes('ready')){if(Date.now()>end)throw Error('readiness timeout');await sleep(20)}
    pids=run(`cat ${root}/pids`).trim().split(/\s+/).map(Number)
    const helper=Number(run(`awk '{print $4}' /proc/${pids[0]}/stat`).trim());const known=[...pids,helper]
    const owners=run(`python3 -c ${shQuote(`import glob,os,json; print(json.dumps([os.path.dirname(p) for p in glob.glob('/tmp/superd-rsync-native.*/server.${helper}')]))`)}`).trim()
    const gates=JSON.parse(run(`python3 -c ${shQuote("import glob,json; print(json.dumps(glob.glob('/tmp/superd-rsync-recovery.*')))")}`)) as string[]
    if(mode==='cancel')p.cancel();if(mode==='dispose')await d.dispose()
    const result=await p.done;if(mode==='timeout')expect(result.timedOut).toBe(true)
    const inventory=JSON.parse(run(`python3 -c ${shQuote(`import os,json; print(json.dumps({'live':[p for p in ${JSON.stringify(known)} if os.path.exists('/proc/'+str(p))], 'owners':[p for p in ${JSON.stringify(JSON.parse(owners).concat(gates))} if os.path.exists(p)]}))`)}`))
    console.log(JSON.stringify({kind,mode,known,owners:JSON.parse(owners),gates,atSettlement:inventory}))
    expect(inventory).toEqual({live:[],owners:[]})
   }finally{
    for(const pid of [...pids].reverse())try{run(`kill -TERM ${pid} 2>/dev/null || :`)}catch{}
    await d.dispose();run(`rm -rf -- ${shQuote(root)}`)
   }
  },30000)
  it('preserves literal stdin, scripts, terminal output and byte cursors',async()=>{
   const d=new RemoteDriver(),dir=await mkdtemp(join(tmpdir(),'container-process-script-')),input='START\nKEEP\nSTOP\n😀\u0000'.repeat(30000)
   try{
    const r=await d.call({target:kind+':'+container,stdin:input,cmd:`python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()); print("stderr-only",file=sys.stderr)'`})
    expect(r.exit).toBe(0);expect(r.stdout).toBe(createHash('sha256').update(input).digest('hex')+'\n');expect(r.stderr).toBe('stderr-only\n')
    const script=join(dir,'literal.sh');await writeFile(script,'printf "script-out😀"\nprintf "script-err" >&2\n')
    const r2=await d.call({target:kind+':'+container,scriptPath: script});expect(r2.exit).toBe(0);expect(r2.stdout).toBe('script-out😀');expect(r2.stderr).toBe('script-err')
    const p=await d.start({target:kind+':'+container,mode:'oneshot',cmd:"trap 'trap \"\" TERM; printf terminal-out; printf terminal-err >&2; exit 0' TERM; printf ready; while :; do sleep .05; done"},new AbortController().signal)
    const end=Date.now()+5000
    while(!p.read('stdout',0).text.includes('ready')){if(Date.now()>end)throw Error('ready timeout');await sleep(20)}
    const first=p.read('stdout',0);p.cancel();await p.done
    expect(p.read('stdout',first.nextOffset).text).toBe('terminal-out');expect(p.read('stderr',0).text).toContain('terminal-err')
    expect(p.read('stdout',p.read('stdout',0).nextOffset).text).toBe('')
   }finally{await d.dispose();await rm(dir,{recursive:true,force:true})}
  },30000)
 })
}
