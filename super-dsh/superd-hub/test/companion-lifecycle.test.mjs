import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import setup from '../dist/bundle-setup.js'

async function mount(t, live) {
 const home=mkdtempSync(join(tmpdir(),'superd-ready-')),ctx=new Context(),transaction=new AsyncLocalStorage()
 t.after(async()=>{await ctx.fiber.dispose();rmSync(home,{recursive:true,force:true})})
 let ready,installed=false,calls=0
 ctx.provide('profileContext',{home,dir:join(home,'profiles','test')})
 ctx.provide('appReady',{onReady(listener){ready=listener;if(live)listener();return()=>{}}})
 ctx.provide('pluginManager',{
  async listBundles(){return installed?[{name:'better-dsh',installed:true,enabled:true,version:'0.3.0-f'}]:[]},
  async installBundle(){calls++;assert.equal(transaction.getStore(),undefined,'child native install cannot inherit parent HMR transaction');installed=true;ctx.emit('plugin-manager/changed',{reason:'install'});return {application:'applied'}}
 })
 const fiber=await transaction.run(live?true:undefined,()=>ctx.plugin(setup))
 assert.ok(fiber)
 return {ctx,ready:()=>ready(),calls:()=>calls,transaction,home,dir:join(home,'profiles','test')}
}
async function settled(f){for(let i=0;i<100;i++){if(f.calls()>0&&!(await f.ctx.superdCompanions.getBetterDash()).installing)return;await new Promise(r=>setTimeout(r,5))}assert.fail('companion installation did not settle')}

test('cold appReady starts native installation outside boot, exposing decorated unary methods',async t=>{
 const f=await mount(t,false);assert.equal(f.calls(),0);f.ready();await settled(f)
 assert.equal(f.calls(),1);assert.equal((await f.ctx.superdCompanions.getBetterDash()).installed,true)
 const markers=remoteMethods(f.ctx.superdCompanions);assert.deepEqual(markers.map(m=>m.method).sort(),['getBetterDash','installBetterDash'])
})
test('live mount waits for changed outside parent HMR and never awaits its profile lock',async t=>{
 const f=await mount(t,true);await new Promise(r=>setImmediate(r));assert.equal(f.calls(),0)
 f.ctx.emit('plugin-manager/changed',{reason:'install'})
 await settled(f);assert.equal(f.calls(),1)
})
test('interrupted first use re-arms the retry; the successful retry confirms the receipt',async t=>{
 const f=await mount(t,true)
 const {createHash}=await import('node:crypto'),{writeFileSync,mkdirSync,readFileSync}=await import('node:fs')
 const key=createHash('sha256').update(f.dir).digest('hex')+'.json'
 const receipt=join(f.home,'superd','companions',key)
 mkdirSync(join(f.home,'superd','companions'),{recursive:true})
 writeFileSync(receipt,JSON.stringify({attempted:true})) // killed mid-flight: no done, no error
 f.ctx.emit('plugin-manager/changed',{reason:'install'})
 await settled(f);assert.equal(f.calls(),1,'interrupted first use must retry installation')
 assert.equal(JSON.parse(readFileSync(receipt,'utf8')).done,true,'successful retry must confirm the receipt')
})
test('a confirmed first-use receipt stays suppressed forever',async t=>{
 const f=await mount(t,true);await new Promise(r=>setImmediate(r))
 const {createHash}=await import('node:crypto'),{writeFileSync,mkdirSync}=await import('node:fs')
 const key=createHash('sha256').update(f.dir).digest('hex')+'.json'
 const receipt=join(f.home,'superd','companions',key)
 mkdirSync(join(f.home,'superd','companions'),{recursive:true})
 writeFileSync(receipt,JSON.stringify({attempted:true,done:true}))
 for(const reason of ['install','uninstall','restart'])f.ctx.emit('plugin-manager/changed',{reason})
 await new Promise(r=>setTimeout(r,50))
 assert.equal(f.calls(),0,'confirmed first use must never install again')
})
