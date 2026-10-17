import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as api from '../super-dsh/superd-hub/dist/bundle-setup.js'

function fixture(t, outcomes = [], existing) {
  assert.equal(typeof api.BetterDashCompanion, 'function', 'native companion controller is available')
  const home = mkdtempSync(join(tmpdir(), 'superd-companions-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = { home, dir: join(home, 'profiles', 'test') }
  mkdirSync(profile.dir, { recursive: true })
  let current = existing, release
  const calls = [], manager = {
    async listBundles() { return current ? [{name:'better-dsh',...current}] : [] },
    async installBundle(spec) {
      calls.push(spec)
      const item = outcomes.shift() ?? { application:'applied' }
      if (item.gate) await new Promise(r => { release = r })
      if (item.throw) throw new Error(item.throw)
      if (['applied','restart-required'].includes(item.application)) current = {installed:true,enabled:true,version:item.version ?? '0.3.0-f'}
      return {changed:true,stage:'enable',target:'better-dsh',...item}
    },
  }
  const make = version => new api.BetterDashCompanion(profile, version ?? '0.3.0-f', () => manager)
  return {profile,calls,make,remove:()=>{current=undefined},release:()=>release?.(),manager,installExternally:()=>{current={installed:true,enabled:true,version:'0.3.0-f'}}}
}

test('first use installs the running Super exact version and leaves a durable intent', async t => {
 const f=fixture(t),c=f.make(); const status=await c.ensureAutomatic()
 assert.deepEqual(f.calls,['better-dsh@0.3.0-f']);assert.equal(status.installed,true);assert.equal(status.enabled,true)
 await f.make('0.4.0-a').ensureAutomatic();assert.equal(f.calls.length,1)
 assert.equal(JSON.parse(readFileSync(join(f.profile.home,'superd','companions',createHash('sha256').update(f.profile.dir).digest('hex')+'.json'),'utf8')).attempted,true)
})
test('native resolved failure falls back to latest and reports the installed version', async t=>{
 const f=fixture(t,[{application:'failed',error:{code:'operation-error',diagnostic:'exact missing'}},{application:'applied',version:'0.2.9'}]);const status=await f.make().ensureAutomatic()
 assert.deepEqual(f.calls,['better-dsh@0.3.0-f','better-dsh@latest']);assert.equal(status.version,'0.2.9');assert.equal(status.error,undefined)
})
test('all three native failures remain visible and retryable, with no restart loop',async t=>{
 const f=fixture(t,[{throw:'offline'},{application:'failed',error:{code:'operation-error',diagnostic:'latest offline'}},{application:'failed',error:{code:'operation-error',diagnostic:'bare offline'}}]);const c=f.make(),status=await c.ensureAutomatic()
 assert.equal(status.installed,false);assert.match(status.error,/offline/);assert.equal(status.installing,false)
 assert.deepEqual(f.calls,['better-dsh@0.3.0-f','better-dsh@latest','better-dsh'])
 assert.match(status.error,/latest offline/);assert.match(status.error,/bare offline/)
 await f.make('0.4.0-a').ensureAutomatic();assert.equal(f.calls.length,3)
 assert.equal((await c.installBetterDash()).installed,true);assert.equal(f.calls.length,4)
 assert.equal(f.calls[3],'better-dsh@0.3.0-f','explicit retry starts from installed Super exact version')
})
test('automatic and manual triggers share the active installation',async t=>{
 const f=fixture(t,[{application:'applied',gate:true}]),c=f.make(),first=c.ensureAutomatic()
 while(f.calls.length===0) await new Promise(r=>setImmediate(r))
 const second=c.installBetterDash();assert.equal((await c.getBetterDash()).installing,true);f.release();assert.deepEqual(await first,await second);assert.equal(f.calls.length,1)
})
test('existing disabled Better remains at its version without installation or enabling',async t=>{
 const f=fixture(t,[],{installed:true,enabled:false,version:'0.1.4'}),c=f.make()
 const status=await c.ensureAutomatic();assert.equal(status.enabled,false);assert.equal(status.version,'0.1.4');assert.equal(f.calls.length,0)
 assert.equal((await c.installBetterDash()).enabled,false);assert.equal(f.calls.length,0)
})
test('old receipt plus missing Better migrates without resurrecting removal on upgrade',async t=>{
 const f=fixture(t),dir=join(f.profile.home,'companion-registration');mkdirSync(dir)
 writeFileSync(join(dir,createHash('sha256').update(f.profile.dir).digest('hex')+'.json'),JSON.stringify({'super-dsh:better-dsh':'0.3.0-e'}))
 assert.equal((await f.make().ensureAutomatic()).installed,false);assert.equal(existsSync(dir),false,'empty legacy receipt directory is removed after safe migration');await f.make('0.4.0-a').ensureAutomatic();assert.equal(f.calls.length,0)
 assert.equal((await f.make().installBetterDash()).installed,true)
})
test('native uninstall remains authoritative across restart and Super version changes',async t=>{
 const f=fixture(t),c=f.make();await c.ensureAutomatic();f.remove();await c.observeNativeChange()
 await f.make('0.4.0-a').ensureAutomatic();assert.equal(f.calls.length,1)
 assert.equal((await f.make().installBetterDash()).installed,true);assert.equal(f.calls.length,2)
})
test('overridden native application is a failure even if a package appeared',async t=>{
 const f=fixture(t,[{application:'overridden',error:{code:'operation-error',diagnostic:'profile override'}},{application:'cancelled'},{application:'failed',error:{code:'operation-error',diagnostic:'bare refused'}}]);const status=await f.make().ensureAutomatic()
 assert.equal(status.installed,false);assert.match(status.error,/overridden/);assert.equal(f.calls.length,3)
})
test('unavailable manager leaves Super status usable with explicit retry error',async t=>{
 const f=fixture(t),c=new api.BetterDashCompanion(f.profile,'0.3.0-f',()=>undefined)
 const status=await c.ensureAutomatic();assert.equal(status.installed,false);assert.match(status.error,/Plugin Manager/)
})

test('migration only removes this profile receipt while other profiles still use legacy storage',async t=>{
 const f=fixture(t),dir=join(f.profile.home,'companion-registration');mkdirSync(dir)
 const receipt=join(dir,createHash('sha256').update(f.profile.dir).digest('hex')+'.json')
 writeFileSync(receipt,JSON.stringify({'super-dsh:better-dsh':'0.3.0-e'}));writeFileSync(join(dir,'other-profile.json'),'{}')
 await f.make().getBetterDash();assert.equal(existsSync(receipt),false);assert.equal(existsSync(join(dir,'other-profile.json')),true)
})

test('native restart-required notice is transient and disappears after controller restart',async t=>{
 const f=fixture(t,[{application:'restart-required'}]),c=f.make()
 const status=await c.ensureAutomatic();assert.equal(status.installed,true);assert.match(status.error,/restart/i)
 assert.equal((await f.make().getBetterDash()).error,undefined)
 assert.equal(JSON.parse(readFileSync(join(f.profile.home,'superd','companions',createHash('sha256').update(f.profile.dir).digest('hex')+'.json'),'utf8')).error,undefined)
})
test('a successful external native install clears the persisted failed attempt',async t=>{
 const f=fixture(t,[{application:'failed',error:{code:'operation-error',diagnostic:'exact offline'}},{application:'failed',error:{code:'operation-error',diagnostic:'latest offline'}},{application:'failed',error:{code:'operation-error',diagnostic:'bare offline'}}]),c=f.make()
 assert.match((await c.ensureAutomatic()).error,/offline/);f.installExternally()
 const status=await c.observeNativeChange();assert.equal(status.installed,true);assert.equal(status.error,undefined)
 const restarted=f.make();assert.equal((await restarted.getBetterDash()).error,undefined)
 assert.equal(f.calls.length,3,'successful native repair causes no companion reinstall')
})
test('a failed active operation reports its native error once; an observed install confirms done and clears it',async t=>{
 const f=fixture(t,[{application:'failed',gate:true,error:{code:'operation-error',diagnostic:'native enable refused'}},{application:'failed',error:{code:'operation-error',diagnostic:'latest refused'}},{application:'failed',error:{code:'operation-error',diagnostic:'bare refused'}}]),c=f.make(),pending=c.ensureAutomatic()
 while(f.calls.length===0) await new Promise(r=>setImmediate(r))
 f.installExternally();assert.equal((await c.getBetterDash()).installing,true);f.release()
 const outcome=await pending;assert.equal(outcome.installed,true);assert.match(outcome.error,/native enable refused/);assert.equal(outcome.installing,false)
 assert.equal((await c.getBetterDash()).error,undefined,'observed installed confirms done and clears the failed diagnosis (0.3.1 semantics)')
 assert.equal((await c.ensureAutomatic()).installed,true,'unrelated native changes cannot turn installed into applied')
 assert.equal((await f.make().getBetterDash()).error,undefined,'confirmed done survives restart')
 assert.equal(f.calls.length,3)
 f.remove();assert.equal((await c.ensureAutomatic()).installed,false);f.installExternally()
 assert.equal((await c.ensureAutomatic()).error,undefined,'native changed event path observes missing then installed recovery')
 assert.equal(f.calls.length,3,'event observation does not reinstall or replace Better')
})

test('exact and latest native failures fall back to bare package name and stop on its success',async t=>{
 const f=fixture(t,[{application:'failed',error:{code:'operation-error',diagnostic:'exact missing'}},{throw:'latest unavailable'},{application:'applied',version:'0.3.2'}]),c=f.make()
 const status=await c.ensureAutomatic()
 assert.deepEqual(f.calls,['better-dsh@0.3.0-f','better-dsh@latest','better-dsh'])
 assert.equal(status.installed,true);assert.equal(status.version,'0.3.2');assert.equal(status.error,undefined)
 await c.ensureAutomatic();assert.equal(f.calls.length,3,'bare success ends the operation and later automatic checks do not replace it')
})
