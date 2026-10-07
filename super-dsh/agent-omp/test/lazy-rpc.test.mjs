import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mock-omp-rpc.mjs", import.meta.url));
chmodSync(fixture, 0o755);
process.env.OMP_EXECUTABLE = fixture;

const { LazyOmpRpc } = await import(join(dist, "lazy-rpc.js"));
const cwd = mkdtempSync(join(tmpdir(), "omp-lazy-"));

// A leaked mock child holds the test process's stdio open, which turns a clean
// assertion failure into a suite hang. Every test that can spawn therefore wires
// its teardown through `t.after`, and the per-test timeout is the backstop if a
// wait itself never settles.
const TEST_OPTS = { timeout: 30_000 };

test('async extension preparation finishes before spawn and remains lazy', TEST_OPTS, async t => {
  let prepared = 0;
  const rpc = new LazyOmpRpc(async () => {
    await Promise.resolve();
    prepared++;
    return ['--extension', '/shared/hub.mjs'];
  }, cwd);
  t.after(() => rpc.close());
  assert.equal(prepared, 0);
  await rpc.ensureStarted();
  assert.equal(prepared, 1);
  assert.equal(rpc.spawned, true);
});

test('closing while async extension preparation runs prevents child spawn', TEST_OPTS, async t => {
  let release;
  const rpc = new LazyOmpRpc(() => new Promise(resolve => { release = resolve; }), cwd);
  t.after(() => rpc.close());
  const pending = rpc.ensureStarted();
  await Promise.resolve();
  rpc.close();
  release([]);
  await assert.rejects(pending, /closed/);
  assert.equal(rpc.spawned, false);
});

/** Poll until `predicate` holds (or fail loudly); frames arrive asynchronously. */
async function waitFor(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("construction spawns nothing; passive queries answer synthetically", TEST_OPTS, async (t) => {
  const rpc = new LazyOmpRpc([], cwd);
  t.after(() => rpc.close()); // a no-op unless a later edit makes this path spawn
  assert.equal(rpc.spawned, false);
  assert.deepEqual(await rpc.getState(), { isStreaming: false });
  assert.deepEqual(await rpc.getSubagents(), []);
});

test("the first prompt materializes the child", TEST_OPTS, async (t) => {
  const rpc = new LazyOmpRpc([], cwd);
  t.after(() => rpc.close());
  await rpc.ensureStarted();
  assert.equal(rpc.spawned, true);
});

test("a model selected before spawn is applied ahead of the prompt", TEST_OPTS, async (t) => {
  const rpc = new LazyOmpRpc([], cwd);
  t.after(() => rpc.close());
  const events = [];
  rpc.on((e) => events.push(e));
  await rpc.setModel("deepseek", "deepseek-flash"); // parked: no child exists yet
  assert.equal(rpc.spawned, false);
  await rpc.prompt("hi");
  // The mock writes the prompt burst AFTER the response `prompt()` awaits, so a
  // fixed sleep is a race. `agent_end` is that burst's last frame, so waiting for
  // it proves `config_update` and `agent_start` were already dispatched — and the
  // assertions below still fail on the real condition if either never arrives.
  await waitFor(() => events.some((e) => e.type === "agent_end"), "the prompt burst to finish");
  const modelAt = events.findIndex((e) => e.type === "config_update");
  const turnAt = events.findIndex((e) => e.type === "agent_start");
  assert.equal(rpc.spawned, true);
  assert.notEqual(modelAt, -1, "the parked set_model must reach the child");
  assert.ok(modelAt < turnAt, "set_model must be applied ahead of the prompt turn");
});

test("spawn args are resolved AT SPAWN, so a preset picked after create still reaches the child", TEST_OPTS, async (t) => {
  // The new-chat permission pick (and the mcp/model/cwd facts the UI finalizes
  // on the draft) land AFTER the wrapper exists but BEFORE the first prompt.
  // Freezing argv at construction would freeze the wrong preset into the child.
  const argvFile = join(mkdtempSync(join(tmpdir(), "omp-argv-")), "argv.log");
  const previous = process.env.MOCK_OMP_ARGV_FILE;
  process.env.MOCK_OMP_ARGV_FILE = argvFile;
  t.after(() => {
    if (previous === undefined) delete process.env.MOCK_OMP_ARGV_FILE;
    else process.env.MOCK_OMP_ARGV_FILE = previous;
  });
  let mode = "yolo";
  const rpc = new LazyOmpRpc(() => ["--approval-mode", mode], cwd);
  t.after(() => rpc.close());
  mode = "write"; // the user's selection, made before the first prompt
  await rpc.ensureStarted();
  const argv = readFileSync(argvFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(argv.length, 1, "exactly one child must have been spawned");
  assert.deepEqual(argv[0].slice(-2), ["--approval-mode", "write"], "the child must launch with the preset the session holds at spawn");
});
