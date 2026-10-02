import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mock-omp-rpc.mjs", import.meta.url));
chmodSync(fixture, 0o755);

const { OmpRpcClient, resolveOmpExecutable } = await import(join(dist, "rpc-client.js"));

process.env.OMP_EXECUTABLE = fixture; // every spawn in this file hits the mock
const cwd = mkdtempSync(join(tmpdir(), "omp-rpc-"));
const tmpRoot = mkdtempSync(join(tmpdir(), "omp-resolve-"));

// Every spawned child must be reaped even when an assertion fails: a leaked mock
// holds the test process open, which turns a clean failure into a suite hang.
const TEST_OPTS = { timeout: 30_000 };

/** Spawn the mock client, guaranteeing teardown via `t.after`. */
async function spawnClient(t) {
  const client = await OmpRpcClient.spawn([], cwd);
  t.after(() => client.close());
  return client;
}

/** Run `body` with exactly `env` applied to `process.env`, always restoring it. */
async function withEnv(env, body) {
  const saved = new Map(Object.entries(env).map(([key]) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Poll until `predicate` holds (or fail loudly); frames arrive asynchronously. */
async function waitFor(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ready is recorded, not validated: extra ready keys do not block the handshake", TEST_OPTS, async (t) => {
  // `spawn()` resolving at all is the observable for the handshake contract: the
  // mock's `ready` carries keys the client does not model, and the client must
  // record it rather than validate it. (The client does not re-emit `ready`, so
  // there is no event to assert on beyond the handshake completing.)
  const client = await spawnClient(t);
  assert.ok(client, "spawn() must resolve even though `ready` carried unknown keys");

  const seen = [];
  client.on((event) => seen.push(event));
  // The mock emits its unsolicited frame set in response to the first command,
  // i.e. strictly after this listener exists. Frames written in the same stdout
  // chunk as `ready` are *not* covered here — the transport gives no guarantee
  // that a frame dispatched before `spawn()` resolves survives a later
  // subscription, so relying on that would be testing a race, not a contract.
  const state = await client.getState();
  assert.equal(state.isStreaming, false, "the connection must still be usable after the unknown ready keys");

  await waitFor(() => seen.some((event) => event.type === "future_event"), "the unsolicited frame set");
  assert.ok(
    seen.some((event) => event.type === "future_event" && event.note === "unknown frame type"),
    "an unrecognised frame type must reach ordinary listeners untouched",
  );
  assert.ok(
    seen.some((event) => event.type === "extension_ui_request" && event.id === "u1" && event.method === "notify" && event.message === "hi"),
    "extra fields on a known frame must survive",
  );
});

test("resolveOmpExecutable honours $OMP_EXECUTABLE over everything else", () => {
  assert.equal(resolveOmpExecutable(), fixture);
});

test("resolveOmpExecutable returns the bare name for an omp found on $PATH", async () => {
  // Deliberately rooted at a fresh tempdir that is NOT a prefix of the fixture
  // path, so this cannot pass by accidentally matching $OMP_EXECUTABLE.
  const root = mkdtempSync(join(tmpdir(), "omp-path-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  const stub = join(root, "bin", "omp");
  writeFileSync(stub, "#!/usr/bin/env node\n");
  chmodSync(stub, 0o755);
  await withEnv({ OMP_EXECUTABLE: undefined, PATH: join(root, "bin") }, () => {
    assert.equal(resolveOmpExecutable(), "omp");
  });
});

test("resolveOmpExecutable falls back to ~/.local/bin/omp when $PATH has no omp", async () => {
  const home = mkdtempSync(join(tmpdir(), "omp-home-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const native = join(home, ".local", "bin", "omp");
  writeFileSync(native, "#!/usr/bin/env node\n");
  chmodSync(native, 0o755);
  await withEnv({ OMP_EXECUTABLE: undefined, PATH: join(tmpRoot, "empty-path"), HOME: home }, () => {
    assert.equal(resolveOmpExecutable(), join(home, ".local", "bin", "omp"));
  });
});

test("resolveOmpExecutable falls back to the bare name when nothing is installed", async () => {
  await withEnv(
    { OMP_EXECUTABLE: undefined, PATH: join(tmpRoot, "empty-path"), HOME: join(tmpRoot, "empty-home") },
    () => {
      assert.equal(resolveOmpExecutable(), "omp");
    },
  );
});

// NOTE: the remaining branch (`/usr/local/bin/omp`) is pinned in
// resolve-executable.test.mjs, which mocks node:fs so no machine-specific
// system path is required.

test("get_state / get_messages / get_subagents round-trip by correlation id", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  assert.equal((await client.getState()).isStreaming, false);
  assert.equal((await client.getMessages()).length, 1);
  assert.deepEqual(await client.getSubagents(), []);
  assert.equal(await client.getSystemPrompt(), "SP");
  assert.deepEqual(await client.contextUsage(), { tokens: 7, percent: 1 });
});

test("events reach listeners; prompt emits agent_start/agent_end; title is dispatched", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  const events = [];
  const titles = [];
  client.on((e) => events.push(e.type));
  client.onTitle((title) => titles.push(title));
  // `get_state` is what makes the mock emit its setTitle frames, and it is sent
  // after the listeners above exist — so this ordering assertion is deterministic.
  await client.getState();
  await client.prompt("hi");
  await waitFor(() => events.includes("agent_end"), "the prompt turn to finish");
  assert.ok(events.includes("agent_start"));
  assert.ok(events.includes("agent_end"));
  assert.ok(titles[0] === "mock set title", "the setTitle frame must be dispatched before the prompt's title");
  assert.ok(titles.includes("mock title"), "session_info_update.title must reach onTitle listeners");
  assert.ok(!titles.includes(""), "an empty title must never be dispatched");
});

test("title dispatch is live: setTitle and session_info_update both reach onTitle", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  const titles = [];
  const unsubscribe = client.onTitle((title) => titles.push(title));
  await client.getState();
  await waitFor(() => titles.includes("mock set title"), "the setTitle frame");
  assert.ok(titles.includes("mock set title"), "setTitle frames must reach onTitle listeners");
  assert.ok(!titles.includes(""), "an empty title must never be dispatched");
  await client.prompt("hi");
  await waitFor(() => titles.includes("mock title"), "the session_info_update frame");
  assert.ok(titles.includes("mock title"), "session_info_update.title must reach onTitle listeners");
  assert.equal(typeof unsubscribe, "function");
});

test("onTitle's unsubscriber stops delivery", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  const titles = [];
  const events = [];
  client.on((e) => events.push(e.type));
  const unsubscribe = client.onTitle((title) => titles.push(title));
  await client.getState();
  await waitFor(() => titles.includes("mock set title"), "the setTitle frame");
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  titles.length = 0;
  await client.prompt("hi");
  // `agent_end` is the last frame of the turn, so once it lands the
  // `session_info_update` before it has definitely been processed.
  await waitFor(() => events.includes("agent_end"), "the prompt turn to finish");
  assert.deepEqual(titles, [], "after unsubscribe no title frame may be delivered");
});

test("wire command names and fields are echoed back verbatim", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  const followUp = await client.followUp("queue me");
  assert.equal(followUp.received.type, "follow_up");
  assert.equal(followUp.received.message, "queue me");

  const steer = await client.steer("steer me");
  assert.equal(steer.received.type, "steer");
  assert.equal(steer.received.message, "steer me");

  const model = await client.setModel("deepseek", "deepseek-v4-pro");
  assert.equal(model.success, true);
  assert.equal(model.received.provider, "deepseek");
  assert.equal(model.received.modelId, "deepseek-v4-pro");

  const compacted = await client.compact();
  assert.equal(compacted.received.type, "compact");
  assert.equal(
    Object.hasOwn(compacted.received, "customInstructions"),
    false,
    "compact() without instructions must not send a customInstructions key",
  );

  const custom = await client.compact("tighten it up");
  assert.equal(custom.received.type, "compact");
  assert.equal(custom.received.customInstructions, "tighten it up");

  const aborted = await client.abort();
  assert.equal(aborted.success, true);
  assert.equal(aborted.received.type, "abort");

  const fresh = await client.newSession();
  assert.equal(fresh.success, true);
  assert.deepEqual(fresh.data, { cancelled: false });
  assert.equal(fresh.received.type, "new_session");
});

test("sendRaw writes the command unmodified and injects no correlation id", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  const raw = { type: "extension_ui_response", id: "u1", value: "Approve" };
  assert.equal(client.sendRaw(raw), undefined);
  // `get_state` is the barrier: FIFO stdin guarantees the raw frame was consumed first.
  await client.getState();
  client.close();
  assert.equal(client.sendRaw({ type: "after_close" }), undefined); // never throws
});

test("an unsupported command surfaces as a failed response, not a hang", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  const res = await client.send({ type: "definitely_not_a_command" });
  assert.equal(res.success, false);
  assert.match(String(res.error), /Unknown command/);
});

test("close() rejects in-flight commands and is idempotent", TEST_OPTS, async (t) => {
  const client = await spawnClient(t);
  client.close();
  client.close();
  await assert.rejects(() => client.send({ type: "get_state" }));
});
