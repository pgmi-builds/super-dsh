// AgyAgent state machine (fake-client fixture replay, mirroring hermes agent tests):
//  - turn projection: turn/start → user/message → step/start → assistant/message
//    (stream records embedded) → step/end → turn/end {completed};
//  - onboarding (§17 minimal): awaitingKey turns NEVER touch the bridge; a pasted
//    key persists through onSaveApiKey (world home only) and is confirmed locally;
//  - usage is never fabricated (bridge gap); bridge errors map to stable codes.
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AgyAgent, classifyTurnError, looksLikeApiKey } = await import("../dist/agent.js");
const { AgyCliClient } = await import("../dist/agy-cli-client.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeSession() {
  const events = [];
  let seq = 0;
  return {
    id: "session-test",
    events,
    snapshotEvents: () => [...events],
    append: (type, data, opts) => {
      seq += 1;
      const event = { type, seq, time: Date.now(), data, ...(opts ?? {}) };
      events.push(event);
      return event;
    },
  };
}

function makeFakeClient({ chunks = ["OK"], cid = "conv-1", fail = null, thinking = [], usage = undefined, approval = undefined } = {}) {
  const calls = [];
  const approvalOps = [];
  let approvalHandler = undefined;
  let closed = 0;
  return {
    get conversationId() { return cid; },
    get lastUsage() { return usage; },
    _calls: calls,
    _closed: () => closed,
    _approvalOps: approvalOps,
    setApprovalHandler(handler) { approvalHandler = handler; },
    onThinkingDelta: undefined,
    async *turn(text) {
      calls.push(text);
      for (const t of thinking) this.onThinkingDelta?.(t);
      if (approval !== undefined) {
        // drive the handler the way the real client does, record the reply op
        const allow = await approvalHandler(approval.req);
        approvalOps.push({ id: approval.req.id, allow });
      }
      for (const chunk of chunks) {
        yield chunk;
        if (fail) throw fail;
      }
      return chunks.join("");
    },
    async close() { closed += 1; },
  };
}

function makeRuntimeInfo({ awaitingKey = false, savedKeys = [], turnDone = [] } = {}) {
  return {
    session: { cwd: "/tmp" },
    awaitingKey,
    onSaveApiKey: (key) => savedKeys.push(key),
    onTurnDone: () => turnDone.push(1),
  };
}

function makeUserMessage(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

const types = (events) => events.map((e) => e.type);

test('split native tool frames keep released V4 relationships valid', async () => {
  const home=mkdtempSync(join(tmpdir(),'agy-split-'));const saved=process.env.AGY_MOCK_SCRIPT;
  process.env.AGY_MOCK_SCRIPT=JSON.stringify([{wait:true,lines:[{event:'init',conversation_id:'native-id',init:{tools:['superd-hub']}}]}]);
  const client=new AgyCliClient({apiKey:'test',cwd:home,realHome:home,agyBin:new URL('../fixtures/mock_agy_bin.sh',import.meta.url).pathname});
  const session=makeFakeSession();const agent=new AgyAgent(new Context(),'s1',{provider:'agy'},session,client);
  const validate=()=>assertReleasedV4Relationships({header:{id:session.id},inheritedEventCount:0,events:session.events},new Set(session.events.map(e=>e.type)));
  const frame=x=>client.consume(JSON.stringify(x)+'\n');
  try {
    agent.followup(makeUserMessage('call Hub'));for(let n=0;n<100&&!client.readyReceived;n++)await delay(5);assert.equal(client.readyReceived,true);
    frame({event:'step_update',step_update:{step_type:'tool',state:'ACTIVE',step_index:1,tool_name:'superd-hub',tool_info:{parameters:{action:'exec'}}}});await delay(5);validate();
    frame({event:'step_update',step_update:{step_type:'tool',state:'DONE',step_index:1,tool_name:'superd-hub',tool_info:{output:'actual'}}});
    frame({event:'result',result:{conversation_id:'native-id',status:'SUCCESS'}});await agent.whenIdle();validate();
    assert.equal(session.events.filter(e=>e.type==='tool/call').length,1);assert.equal(session.events.filter(e=>e.type==='tool/result').length,1);
  } finally {await agent.dispose();if(saved===undefined)delete process.env.AGY_MOCK_SCRIPT;else process.env.AGY_MOCK_SCRIPT=saved;}
});

test('queued Hub input runs after a failed older turn', async () => {
  const session=makeFakeSession();const client=makeFakeClient();let fail;
  client.turn=async function*(text){this._calls.push(text);if(this._calls.length===1)await new Promise((_,reject)=>{fail=reject;});yield 'peer reply';return 'peer reply';};
  const agent=new AgyAgent(new Context(),'s1',{provider:'agy'},session,client);
  agent.send(makeUserMessage('old'), 'next-turn',true);await delay(5);
  agent.followup(makeUserMessage('Hub incoming'));fail(new Error('older turn failed'));
  await delay(25);assert.deepEqual(client._calls,['old','Hub incoming']);
  assert.deepEqual(session.events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['error','completed']);await agent.dispose();
});

test('deadline stops the old transport before opening queued Hub input', async () => {
  const session=makeFakeSession();const client=makeFakeClient();let rejectOld,stopped=false;
  client.turn=async function*(text){this._calls.push(text);if(this._calls.length===1)await new Promise((_,reject)=>rejectOld=reject);else assert.equal(stopped,true);yield 'peer reply';return 'peer reply';};
  client.interrupt=async()=>{await delay(10);stopped=true;rejectOld(new Error('deadline stopped CLI'));};
  const agent=new AgyAgent(new Context(),'s1',{provider:'agy'},session,client);
  agent.send(makeUserMessage('old'), 'next-turn',true);await delay(5);
  agent.followup(makeUserMessage('Hub incoming'));agent.turnDeadlineTimer._onTimeout();
  assert.equal(session.events.some(e=>e.type==='turn/end'),false,'old execution owns its turn until stopped');
  await delay(30);assert.deepEqual(client._calls,['old','Hub incoming']);await agent.dispose();
});

test('a buffered success during deadline shutdown cannot reuse the stopping CLI', async () => {
  const session=makeFakeSession();const client=makeFakeClient();let finishOld,finishStop,stopped=false;
  client.turn=async function*(text){this._calls.push(text);if(this._calls.length===1)await new Promise(resolve=>finishOld=resolve);else assert.equal(stopped,true);yield 'reply';return 'reply';};
  client.interrupt=()=>new Promise(resolve=>finishStop=()=>{stopped=true;resolve();});
  const agent=new AgyAgent(new Context(),'s1',{provider:'agy'},session,client);
  agent.send(makeUserMessage('old'),'next-turn',true);await delay(5);agent.followup(makeUserMessage('Hub incoming'));
  agent.turnDeadlineTimer._onTimeout();finishOld();await delay(5);assert.deepEqual(client._calls,['old']);
  finishStop();await delay(20);assert.deepEqual(client._calls,['old','Hub incoming']);await agent.dispose();
});

test("turn projection: bridge chunks → stream records → assistant/message → completed turn", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ chunks: ["hel", "lo"], cid: "conv-77" });
  const turnDone = [];
  const agent = new AgyAgent(new Context(), "s1", { provider: "agy" }, session, client, undefined, makeRuntimeInfo({ turnDone }));

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(20);

  const t = types(session.events);
  const idx = (x) => t.indexOf(x);
  assert.ok(idx("turn/start") >= 0 && idx("user/message") > idx("turn/start"));
  // v4 native shape: the head co-writer opens step 1 BEFORE the first user
  // message (the adapter's own step/start for it is dropped as a duplicate).
  assert.ok(idx("step/start") >= 0 && idx("user/message") > idx("step/start"), "step/start precedes the user message");
  assert.ok(idx("assistant/message") > idx("step/start"), "assistant/message after step/start");
  assert.ok(idx("step/end") > idx("assistant/message"), "step/end after assistant/message");
  assert.ok(idx("turn/end") > idx("step/end"), "turn/end closes last");

  // turn/step invariants: one turn, steps 1..n inside it
  const turnStart = session.events.find((e) => e.type === "turn/start");
  const stepStarts = session.events.filter((e) => e.type === "step/start");
  assert.equal(turnStart.data.turn, 1);
  assert.deepEqual(stepStarts.map((e) => e.data.step), [1]);
  for (const scoped of session.events.filter((e) => ["assistant/message", "step/end", "step/start"].includes(e.type))) {
    assert.equal(scoped.data.turn, 1, "step-scoped events ride the open turn");
  }

  const assistant = session.events.find((e) => e.type === "assistant/message");
  assert.deepEqual(assistant.data.message.content, [{ type: "text", text: "hello" }]);
  assert.ok(Array.isArray(assistant.data.stream) && assistant.data.stream.length >= 2, "both chunks embedded as stream records");
  assert.equal(assistant.data.usage, undefined, "usage never fabricated (bridge gap)");

  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd.data.reason.kind, "completed");
  assert.equal(agent.status, "idle");
  assert.deepEqual(client._calls, ["hi"]);
  assert.equal(turnDone.length, 1, "onTurnDone fired (provider upserts the conversation id)");
});

test("bridge error → turn/end error with a stable code (QUOTA for 429 wording)", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient({ chunks: [""], fail: new Error("request failed (code 429): prepayment credits depleted") });
  const agent = new AgyAgent(new Context(), "s1", { provider: "agy" }, session, client, undefined, makeRuntimeInfo());

  agent.send(makeUserMessage("hi"), "next-turn", true);
  await delay(20);

  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd.data.reason.kind, "error");
  assert.equal(turnEnd.data.reason.error.code, "QUOTA");
  assert.equal(agent.status, "idle");
});

test("onboarding (§17 minimal): awaitingKey turn never touches the bridge", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient();
  const savedKeys = [];
  const agent = new AgyAgent(new Context(), "s1", { provider: "agy" }, session, client, undefined, makeRuntimeInfo({ awaitingKey: true, savedKeys }));

  agent.send(makeUserMessage("hello?"), "next-turn", true);
  await delay(20);

  assert.deepEqual(client._calls, [], "bridge never invoked without a key");
  const t = types(session.events);
  assert.ok(t.includes("system/message"), "onboarding notice emitted");
  const notice = session.events.find((e) => e.type === "system/message" && e.data.message.content.length > 0);
  assert.match(notice.data.message.content[0].text, /Gemini API key/);
  const turnEnd = session.events.find((e) => e.type === "turn/end");
  assert.equal(turnEnd.data.reason.kind, "completed");
  assert.equal(agent.status, "idle");
});

test("onboarding key-paste turn persists via onSaveApiKey and stays local", async () => {
  const session = makeFakeSession();
  const client = makeFakeClient();
  const savedKeys = [];
  const agent = new AgyAgent(new Context(), "s1", { provider: "agy" }, session, client, undefined, makeRuntimeInfo({ awaitingKey: true, savedKeys }));

  agent.send(makeUserMessage("AIzaSyA123456789012345678901234567890123"), "next-turn", true);
  await delay(20);

  assert.deepEqual(savedKeys, ["AIzaSyA123456789012345678901234567890123"]);
  assert.deepEqual(client._calls, [], "key-paste turn is answered locally (no bridge)");
  const t = types(session.events);
  assert.ok(t.includes("system/message"), "confirmation emitted");
  const notice = session.events.find((e) => e.type === "system/message" && e.data.message.content.length > 0);
  assert.match(notice.data.message.content[0].text, /已保存/);
  assert.equal(agent.status, "idle");
});

test("busy guard: a second delivery while the turn is open parks as follow-up", async () => {
  const session = makeFakeSession();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = {
    conversationId: "c",
    _calls: [],
    async *turn(text) {
      this._calls.push(text);
      yield "a";
      await gate;
      yield "b";
      return "ab";
    },
    setApprovalHandler() { },
    get lastUsage() { return undefined; },
    onThinkingDelta: undefined,
    async close() { },
  };
  const agent = new AgyAgent(new Context(), "s1", { provider: "agy" }, session, client, undefined, makeRuntimeInfo());
  agent.send(makeUserMessage("one"), "next-turn", true);
  await delay(10);
  agent.followup(makeUserMessage("two"));
  await delay(10);
  assert.deepEqual(client._calls, ["one"], "follow-up parked while busy");
  release();
  await delay(30);
  assert.deepEqual(client._calls, ["one", "two"], "follow-up flushed at idle");
  assert.equal(agent.status, "idle");
});

test("pure helpers: looksLikeApiKey + classifyTurnError codes", () => {
  assert.equal(looksLikeApiKey("AIzaSyA123456789012345678901234567890123"), true);
  assert.equal(looksLikeApiKey("short"), false);
  assert.equal(looksLikeApiKey("has spaces in it so not a key at all"), false);
  assert.equal(classifyTurnError(new Error("request failed (code 429): quota")).code, "QUOTA");
  assert.equal(classifyTurnError(new Error("A Gemini API key is required")).code, "AUTH");
  assert.equal(classifyTurnError(new Error("bridge exited code=3")).code, "BRIDGE_CRASH");
  assert.equal(classifyTurnError(new Error("mystery")).code, "UNKNOWN");
});

test("every tool_call gets the transparency placeholder result in DSH storage", async () => {
  const session = makeFakeSession();
  const toolEvents = [
    { event: "tool_call", id: "a:1", name: "view_file", args: "{\"p\":1}" },
    { event: "tool_call", id: "a:2", name: "write_to_file", args: "{\"p\":2}" },
    { event: "tool_call", id: "a:3", name: "run_command", args: "{}" },
  ];
  const client = {
    get conversationId() { return "conv-x"; },
    get lastUsage() { return undefined; },
    onThinkingDelta: undefined,
    onToolEvent: undefined,
    setApprovalHandler() { },
    async *turn(text) {
      for (const tev of toolEvents) this.onToolEvent?.(tev);
      yield "built";
      return "built";
    },
    async close() { },
  };
  const agent = new AgyAgent(new Context(), "s1", { provider: "agy" }, session, client, undefined, makeRuntimeInfo());
  agent.send(makeUserMessage("build it"), "next-turn", true);
  await delay(20);

  const calls = session.events.filter((e) => e.type === "tool/call");
  const results = session.events.filter((e) => e.type === "tool/result");
  assert.equal(calls.length, 3);
  assert.equal(results.length, 3, "every call paired at turn end");
  for (const r of results) {
    // 0.1.7: tool results are first-class tool-role messages — raw content
    // blocks on the message, call identity on message.toolCallId (no
    // wrapping `tool-result` block anymore).
    const msg = r.data.message;
    const text = msg.content.find((b) => b.type === "text").text;
    assert.match(text, /Antigravity SDK does not expose tool execution results/);
    assert.equal(msg.isError, false);
  }
  // every call's callId got a paired result
  const callIds = new Set(calls.map((e) => JSON.stringify(e.data.callId)));
  for (const r of results) assert.ok(callIds.has(JSON.stringify(r.data.message.toolCallId)), "pairing by callId");
});
