import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mock-omp-rpc.mjs", import.meta.url));
chmodSync(fixture, 0o755);
process.env.OMP_EXECUTABLE = fixture;

const { LazyOmpRpc } = await import(join(dist, "lazy-rpc.js"));
const cwd = mkdtempSync(join(tmpdir(), "omp-lazy-"));

test("construction spawns nothing; passive queries answer synthetically", async () => {
  const rpc = new LazyOmpRpc([], cwd);
  assert.equal(rpc.spawned, false);
  assert.deepEqual(await rpc.getState(), { isStreaming: false });
  assert.deepEqual(await rpc.getSubagents(), []);
  rpc.close();
});

test("the first prompt materializes the child", async () => {
  const rpc = new LazyOmpRpc([], cwd);
  await rpc.ensureStarted();
  assert.equal(rpc.spawned, true);
  rpc.close();
});

test("a model selected before spawn is applied ahead of the prompt", async () => {
  const rpc = new LazyOmpRpc([], cwd);
  const events = [];
  rpc.on((e) => events.push(e));
  await rpc.setModel("deepseek", "deepseek-flash"); // parked: no child exists yet
  assert.equal(rpc.spawned, false);
  await rpc.prompt("hi");
  await new Promise((r) => setTimeout(r, 100));
  const modelAt = events.findIndex((e) => e.type === "config_update");
  const turnAt = events.findIndex((e) => e.type === "agent_start");
  assert.equal(rpc.spawned, true);
  assert.notEqual(modelAt, -1, "the parked set_model must reach the child");
  assert.ok(modelAt < turnAt, "set_model must be applied ahead of the prompt turn");
  rpc.close();
});
