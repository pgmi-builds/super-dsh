import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmpProvider } from '../dist/index.js';
import { initBridgeStore, closeBridgeStore } from '../dist/store/index.js';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';

test('cold resume closes interrupted turn before preparing future input', async()=>{
 const home=mkdtempSync(join(tmpdir(),'omp-cold-'));
 const store=initBridgeStore(join(home,'bridge.sqlite'));
 store.upsert({omp_session_id:'cold-native',dsh_session_id:'session-cold',session_file:join(home,'native.jsonl'),cwd:home,title:null,created_at:1,last_modified_at:1,transcript_size:0,model_provider:null,model_id:null,agent_preset:'omp',permission_preset:null,forked_from:null,archived:0,last_visited_at:null});
 const events=[{type:'turn/start',seq:0,time:1,data:{turn:1}},{type:'step/start',seq:1,time:1,data:{turn:1,step:1}},{type:'step/end',seq:2,time:1,data:{turn:1,step:1}}];
 const appended=[];let seed;
 const handle={header:{id:'session-cold',cwd:home},inheritedEventCount:0,read:async()=>({events,eventState:{}}),append:async e=>appended.push(...e),close:async()=>{}};
 const ctx={get:name=>name==='sessionPersistence'?{open:async()=>handle}:undefined,sessions:{prepare:(_id,opts)=>{seed=opts.seed;throw new Error('captured preparation');}}};
 const provider=Object.create(OmpProvider.prototype);provider.runtime={ctx};
 try {
  await assert.rejects(provider.resume(ctx,{resumeSessionId:'session-cold'}),/captured preparation/);
  assert.equal(appended.at(-1)?.type,'turn/end');assert.equal(appended.at(-1)?.data.reason.kind,'interrupted');
  const future=[...seed,{type:'turn/start',seq:seed.length,time:2,data:{turn:2}}];
  assertReleasedV4Relationships({header:handle.header,inheritedEventCount:0,events:future},new Set(future.map(e=>e.type)));
 } finally {closeBridgeStore();}
});
