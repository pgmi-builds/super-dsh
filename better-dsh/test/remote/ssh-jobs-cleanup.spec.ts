import {it,expect} from 'vitest'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {JobId} from '@deepseek-ai/dsh-jobs'
import {withSshFixture} from './ssh-fixture.ts'
import {createRealRemoteHarness} from './real-harness.ts'
import {shQuote} from '../../src/remote/transports.ts'
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(f:()=>boolean|Promise<boolean>,ms=15000){const end=Date.now()+ms;while(!await f()){if(Date.now()>end)throw Error('fixture deadline');await wait(20)}}
function live(pid:number){try{process.kill(pid,0);return true}catch{return false}}
it('official SSH job kill settles the job immediately; remote teardown is best-effort (no owner protocol)',async()=>{
 await withSshFixture(async f=>{
  const bin=join(f.directory,'bin');await mkdir(bin);await writeFile(join(bin,'ssh'),'#!/bin/sh\nexec /usr/bin/ssh -F '+shQuote(f.config)+' "$@"\n',{mode:0o700})
  const previous=process.env.PATH;process.env.PATH=bin+':'+previous
  const h=await createRealRemoteHarness({copies:1});const jobs=await h.ctx.plugin(LocalJobs,{pumpPollMs:10});const controller=await h.ctx.plugin(ToolJobs,{completionDelivery:'quiet'});let pids:number[]=[]
  try{
   const a=await h.createAgent('real-ssh-kill'), file=join(f.directory,'pids')
   const value=await h.invoke(a,{target:'ssh:owned',ssh:f.destination,cmd:`bash -c ${shQuote('echo $$ > '+shQuote(file)+'; sleep 600 & echo $! >> '+shQuote(file)+'; printf first; sleep .2; printf second; wait')}`,run_in_background:true}) as unknown as {jobId:string}
   const id=JobId(value.jobId),registry=a.ctx.get('jobs')!
   await until(async()=>{try{pids=(await readFile(file,'utf8')).trim().split(/\s+/).map(Number);return pids.length===2}catch{return false}})
   await until(()=>registry.readAt(id,0,a.id).chunks.map(c=>c.text).join('').includes('first'))
   expect(registry.get(id,a.id).status).toBe('running');expect(pids.every(live)).toBe(true)
   const first=registry.read(id,a.id).chunks.map(c=>c.text).join('');expect(first).toContain('first')
   await until(()=>registry.readAt(id,0,a.id).chunks.map(c=>c.text).join('').includes('second'))
   expect(registry.read(id,a.id).chunks.map(c=>c.text).join('')).not.toContain('first')
   await a.ctx.tools.execute({name:'job_kill',arguments:{job_id:id},agent:a,signal:new AbortController().signal,callId:'owned-ssh-kill' as never})
   await until(()=>registry.get(id,a.id).status==='killed')
   // Pure-CLI lane: the kill stops the local transport at once. Remote group
   // teardown rides on the wrapper's TERM/HUP trap when sshd delivers it —
   // no owner/lease protocol guarantees it, so nothing further is asserted here.
  }finally{for(const pid of pids)try{process.kill(pid,'SIGKILL')}catch{}await h.dispose();await controller.dispose();await jobs.dispose();process.env.PATH=previous}
 })
},30000)
