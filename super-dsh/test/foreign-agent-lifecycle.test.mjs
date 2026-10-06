import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';
const message = id => ({id, role:'user',content:[{type:'text',text:id}],source:{kind:'user'}});
for (const runtime of ['pi','omp','codex']) {
  const module = await import(`../agent-${runtime}/dist/agent.js`);
  const Agent = module[`${runtime[0].toUpperCase()+runtime.slice(1)}Agent`];
  function fixture() {
    const events=[];const listeners=[];const failures=[];const titles=[];
    const session={id:'unit-session',header:{},append(type,data,opts){const event={type,data,seq:events.length,time:Date.now(),...opts};events.push(event);return event},snapshotEvents:()=>events.slice(),requestHeader:()=>undefined};
    const rpc={spawned:true,on(fn){listeners.push(fn)},onFailure(fn){failures.push(fn)},onTitle(fn){titles.push(fn)},setServerRequestHandler(){},getState:async()=>({isStreaming:false}),getSystemPrompt:async()=>undefined,getSessionStats:async()=>({}),ensureStarted:async()=>{},prompt:async()=>{},followUp:async()=>{},steer:async()=>{},setModel:async()=>{},applyLaunch(){},setTurnPolicy(){},reattach:async()=>rpc.ensureStarted(),close(){}};
    const agent=new Agent(new Context(),'unit-session',{},session,rpc);
    return {agent,rpc,events,emit:e=>listeners.forEach(fn=>fn(e)),fail:e=>failures.forEach(fn=>fn(e)),title:t=>titles.forEach(fn=>fn(t))};
  }
  test(`${runtime}: queued reply keeps native step ownership valid`,async()=>{
    const f=fixture();f.agent.followup(message('original'));await new Promise(r=>setTimeout(r,10));
    f.emit({type:'agent_start'});f.emit({type:'turn_start'});f.emit({type:'message_start',message:{role:'user',content:'original'}});
    f.emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ready'}]}});
    f.agent.followup(message('hub-reply'));
    f.emit({type:'turn_end'});f.emit({type:'turn_start'});f.emit({type:'message_start',message:{role:'user',content:'hub-reply'}});
    f.emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'received'}]}});
    f.emit({type:'turn_end'});f.emit({type:'agent_end'});
    assert.doesNotThrow(()=>assertReleasedV4Relationships({header:{id:'unit-session'},inheritedEventCount:0,events:f.events},new Set(f.events.map(event => event.type))));
    assert.deepEqual(f.events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2]);
  });
  test(`${runtime}: startup failure cannot close an uncommitted turn`,async()=>{
    const f=fixture();f.rpc.ensureStarted=async()=>{const error=new Error('native launch failed');f.fail(error);throw error};
    f.agent.followup(message('original'));await new Promise(r=>setTimeout(r,10));
    assert.doesNotThrow(()=>assertReleasedV4Relationships({header:{id:'unit-session'},inheritedEventCount:0,events:f.events},new Set(f.events.map(event => event.type))));
    assert.equal(f.events.at(-1).type,'turn/end');
  });
  test(`${runtime}: interrupted tools get conservative outcomes before terminal boundaries`,async()=>{
    const f=fixture();f.agent.followup(message('original'));await new Promise(r=>setTimeout(r,10));
    f.emit({type:'agent_start'});f.emit({type:'turn_start'});f.emit({type:'message_start',message:{role:'user',content:'original'}});
    f.emit({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'pending',name:'bash',arguments:{command:'printf test'}}]}});
    f.emit({type:'tool_execution_start',toolCallId:'pending',toolName:'bash',args:{command:'printf test'}});
    f.fail(new Error('transport failed'));
    assert.doesNotThrow(()=>assertReleasedV4Relationships({header:{id:'unit-session'},inheritedEventCount:0,events:f.events},new Set(f.events.map(event=>event.type))));
    const recovered=f.events.find(event=>event.type==='tool/result');
    assert.equal(recovered.data.error.code,'TOOL_OUTCOME_UNKNOWN');
    assert.match(recovered.data.message.content[0].text,/Do not retry blindly/);
  });
  test(`${runtime}: abrupt failure closes an open native step`,async()=>{
    const f=fixture();f.agent.followup(message('original'));await new Promise(r=>setTimeout(r,10));
    f.emit({type:'agent_start'});f.emit({type:'turn_start'});f.emit({type:'message_start',message:{role:'user',content:'original'}});f.fail(new Error('transport failed'));
    assert.doesNotThrow(()=>assertReleasedV4Relationships({header:{id:'unit-session'},inheritedEventCount:0,events:f.events},new Set(f.events.map(event => event.type))));
    assert.equal(f.events.at(-1).type,'turn/end');
  });
}
