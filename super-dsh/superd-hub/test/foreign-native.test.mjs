import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec = promisify(execFile)
const module = await import('../dist/foreign-native.js').catch(()=>({}))
const hub = await import('../dist/foreign-hub.js')

test('Hermes native plugin registers only one tool; bound HTTP works and native caller has no mailbox',async t=>{
 const home=mkdtempSync(join(tmpdir(),'hermes-native-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const close=hub.registerForeignHubHost(home,{service:{},delivery:{},roster:()=>({self:{id:'test',label:'local'},remotes:[],agents:[]}),exec:{selfM4:()=> 'test'}});t.after(close)
 const binding=hub.bindForeignHub('hermes','test-session',join(home,'agents/hermes'),()=>undefined);t.after(()=>binding.dispose())
 const enabled=[]
 assert.equal(typeof module.prepareHermesNativePlugin,'function')
 const connection=await module.prepareHermesNativePlugin(binding,join(home,'native'),async key=>enabled.push(key))
 assert.deepEqual(enabled,['superd-hub'])
 const dir=join(home,'native/plugins/superd-hub')
 const publicConfig=readFileSync(join(dir,'connection.json'),'utf8')
 assert.equal(publicConfig.includes(JSON.parse(connection).token),false)
 const script=`import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('plugin',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Context:
 def register_tool(self,**kw): self.tool=kw
c=Context();m.register(c)
assert c.tool['name']=='superd-hub'
assert c.tool['schema']['parameters']['properties']['action']
print(c.tool['handler']({'action':'agents'}))
`
 const bound=await exec('python3',['-c',script,join(dir,'__init__.py')],{env:{...process.env,SUPERD_HUB_SESSION:connection}})
 assert.equal(JSON.parse(bound.stdout).action,'agents')
 const env={...process.env};delete env.SUPERD_HUB_SESSION
 const native=await exec('python3',['-c',script,join(dir,'__init__.py')],{env})
 assert.match(native.stdout,/E_HUB_ADDRESS_REQUIRED/)
 const src=readFileSync(join(dir,'__init__.py'),'utf8')
 assert.doesNotMatch(src,/register_hook|prefetch|system_prompt|sync_turn/)
})

test('native plugin installer refuses unrelated content and does not change sibling plugins',async t=>{
 const home=mkdtempSync(join(tmpdir(),'hermes-ownership-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const path=join(home,'plugins/superd-hub');mkdirSync(path,{recursive:true});writeFileSync(join(path,'__init__.py'),'user owned')
 const sibling=join(home,'plugins/other');mkdirSync(sibling);writeFileSync(join(sibling,'plugin.yaml'),'user plugin')
 const binding={transport:async()=>({url:'http://127.0.0.1:12345/tool',token:'secret',definition:{name:'superd-hub',description:'Hub',inputSchema:{}}})}
 await assert.rejects(module.prepareHermesNativePlugin(binding,home,async()=>{}),/owned|ownership|overwrite/)
 assert.equal(readFileSync(join(path,'__init__.py'),'utf8'),'user owned')
 assert.equal(readFileSync(join(sibling,'plugin.yaml'),'utf8'),'user plugin')
})

test('standalone missing Hub never installs a native plugin',async()=>{
 assert.equal(await module.prepareHermesNativePlugin({transport:async()=>undefined},'/must-not-be-written',async()=>assert.fail()),undefined)
})

test('concurrent sessions retain independent capabilities while sharing one native plugin',async t=>{
 const home=mkdtempSync(join(tmpdir(),'hermes-parallel-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const config=token=>({transport:async()=>({url:'http://127.0.0.1:12345/tool',token,definition:{name:'superd-hub',description:'same tool',inputSchema:{}}})})
 const tokens=await Promise.all(['one','two','three'].map(token=>module.prepareHermesNativePlugin(config(token),home,async()=>{})))
 assert.deepEqual(tokens.map(x=>JSON.parse(x).token),['one','two','three'])
 const publicConfig=JSON.parse(readFileSync(join(home,'plugins/superd-hub/connection.json'),'utf8'))
 assert.equal(publicConfig.token,undefined)
 assert.equal(publicConfig.definition.name,'superd-hub')
})

test('plugin config stays parseable during native startup and parallel session preparation',async t=>{
 const {spawn}=await import('node:child_process')
 const home=mkdtempSync(join(tmpdir(),'hermes-readers-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const binding={transport:async()=>({url:'http://127.0.0.1:12345/tool',token:'capability',definition:{name:'superd-hub',description:'Hub '.repeat(4000),inputSchema:{}}})}
 await module.prepareHermesNativePlugin(binding,home,async()=>{})
 const path=join(home,'plugins/superd-hub/connection.json'),flag=join(home,'reading')
 writeFileSync(flag,'1')
 const child=spawn('python3',['-u','-c',`import json, pathlib, sys
path,flag=map(pathlib.Path,sys.argv[1:])
invalid=reads=0
print('ready',flush=True)
while flag.exists():
 try: json.loads(path.read_text())
 except json.JSONDecodeError: invalid+=1
 reads+=1
print(json.dumps({'invalid':invalid,'reads':reads}),flush=True)`,path,flag])
 t.after(()=>child.kill())
 let output='';await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',x=>{output+=x;if(output.includes('ready'))resolve()})})
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('reader exited '+code)))})
 try {await Promise.all(Array.from({length:400},()=>module.prepareHermesNativePlugin(binding,home,async()=>{})))}finally{rmSync(flag);await exited}
 const result=JSON.parse(output.trim().split('\n').at(-1))
 assert.ok(result.reads>0)
 assert.equal(result.invalid,0,'native/child startup must not observe a truncated plugin config')
})

test('post office refreshes an installed native plugin after restart without spawning any agent',async t=>{
 const home=mkdtempSync(join(tmpdir(),'hermes-restart-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const deps={service:{},delivery:{},roster:()=>({self:{id:'test',label:'local'},remotes:[],agents:[]}),exec:{selfM4:()=> 'test'}}
 const close=hub.registerForeignHubHost(home,deps)
 const binding=hub.bindForeignHub('hermes','first',join(home,'agents/hermes'),()=>undefined)
 await module.prepareHermesNativePlugin(binding,join(home,'native'),async()=>{})
 binding.dispose();await close()
 const close2=hub.registerForeignHubHost(home,deps);t.after(close2)
 assert.equal(typeof module.refreshHermesNativeEndpoint,'function')
 await module.refreshHermesNativeEndpoint(()=>hub.foreignHubEndpoint(home),join(home,'native'))
 const config=JSON.parse(readFileSync(join(home,'native/plugins/superd-hub/connection.json'),'utf8'))
 assert.equal(config.token,undefined)
 const reply=await fetch(config.url,{method:'POST',body:JSON.stringify({action:'agents'})})
 assert.equal(reply.status,403)
 assert.match((await reply.json()).error,/E_HUB_ADDRESS_REQUIRED/)
})
