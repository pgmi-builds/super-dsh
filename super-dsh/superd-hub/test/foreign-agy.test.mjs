import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {prepareAgyNativePlugin,refreshAgyNativeEndpoint} from '../dist/foreign-agy.js';

test('AGY plugin bridges real stdio tool calls without putting capabilities in native files', async t=>{
 const root=await mkdtemp(join(tmpdir(),'superd-agy-')); t.after(()=>rm(root,{recursive:true,force:true}));
 const native=join(root,'native');const stage=join(root,'stage');
 const definition={name:'superd-hub',description:'actual hub',inputSchema:{type:'object',properties:{action:{type:'string'}},required:['action']}};
 const requests=[];
 const server=createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;requests.push({auth:req.headers.authorization,args:JSON.parse(b)});res.writeHead(req.headers.authorization==='Bearer private-token'?200:403,{'content-type':'application/json'});res.end(JSON.stringify(req.headers.authorization==='Bearer private-token'?{result:{stdout:'ACTUAL'}}:{error:'E_HUB_ADDRESS_REQUIRED'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/tool`;
 const transport={url,token:'private-token',definition};let installs=0;
 const privateEnv=await prepareAgyNativePlugin({transport:async()=>transport},native,stage,async dir=>{installs++;assert.equal(dir,stage);await mkdir(join(native,'plugins','superd-hub'),{recursive:true});for(const f of ['server.cjs','connection.json','plugin.json','mcp_config.json','.superd-owner'])await writeFile(join(native,'plugins','superd-hub',f),await readFile(join(stage,f)));});
 assert.equal(installs,1);assert.equal(JSON.parse(privateEnv).token,'private-token');
 await prepareAgyNativePlugin({transport:async()=>transport},native,stage,async()=>{installs++;});
 assert.equal(installs,2,'repeat installs retain ownership');
 await refreshAgyNativeEndpoint(async()=>url,native);
 const dir=join(native,'plugins','superd-hub');
 assert.equal((await readFile(join(dir,'connection.json'),'utf8')).includes('private-token'),false);
 assert.equal((await readFile(join(dir,'mcp_config.json'),'utf8')).includes('private-token'),false);
 async function call(privateSession){const env={...process.env};delete env.SUPERD_HUB_SESSION;if(privateSession)env.SUPERD_HUB_SESSION=privateEnv;const p=spawn(process.execPath,[join(dir,'server.cjs')],{env,stdio:['pipe','pipe','pipe']});const lines=createInterface({input:p.stdout})[Symbol.asyncIterator]();try{p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n');const init=JSON.parse((await lines.next()).value);assert.equal(init.result.protocolVersion,'2024-11-05');p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');const catalog=JSON.parse((await lines.next()).value);assert.equal(catalog.result.tools[0].name,'superd-hub');p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'superd-hub',arguments:{action:'exec'}}})+'\n');return JSON.parse((await lines.next()).value).result;}finally{p.kill();}}
 assert.match((await call(false)).content[0].text,/E_HUB_ADDRESS_REQUIRED/);
 assert.equal((await call(true)).content[0].text,'{"stdout":"ACTUAL"}');
 assert.deepEqual(requests.map(x=>x.auth),[undefined,'Bearer private-token']);
});

test('AGY installation is dormant without a Hub and refuses an unowned native plugin',async t=>{
 const root=await mkdtemp(join(tmpdir(),'superd-agy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 assert.equal(await prepareAgyNativePlugin({transport:async()=>undefined},root,join(root,'stage'),()=>assert.fail('install')),undefined);
 await mkdir(join(root,'plugins','superd-hub'),{recursive:true});await writeFile(join(root,'plugins','superd-hub','user-file'),'keep');
 await assert.rejects(prepareAgyNativePlugin({transport:async()=>({url:'http://127.0.0.1:9/tool',token:'private',definition:{}})},root,join(root,'stage'),()=>assert.fail('install')),/unowned/);
 assert.equal(await readFile(join(root,'plugins','superd-hub','user-file'),'utf8'),'keep');
});
