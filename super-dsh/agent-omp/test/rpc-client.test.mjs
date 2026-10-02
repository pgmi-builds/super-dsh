import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mock-omp-rpc.mjs", import.meta.url));
chmodSync(fixture, 0o755);

const { OmpRpcClient, resolveOmpExecutable } = await import(join(dist, "rpc-client.js"));

process.env.OMP_EXECUTABLE = fixture; // every spawn in this file hits the mock
const cwd = mkdtempSync(join(tmpdir(), "omp-rpc-"));

test("ready handshake tolerates the v18 payload and any extra fields", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  assert.ok(client);
  client.close();
});

test("resolveOmpExecutable honours $OMP_EXECUTABLE", () => {
  assert.equal(resolveOmpExecutable(), fixture);
});

test("get_state / get_messages / get_subagents round-trip by correlation id", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  assert.equal((await client.getState()).isStreaming, false);
  assert.equal((await client.getMessages()).length, 1);
  assert.deepEqual(await client.getSubagents(), []);
  assert.equal(await client.getSystemPrompt(), "SP");
  assert.deepEqual(await client.contextUsage(), { tokens: 7, percent: 1 });
  client.close();
});

test("events reach listeners; prompt emits agent_start/agent_end; title is dispatched", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  const events = [];
  const titles = [];
  client.on((e) => events.push(e.type));
  client.onTitle((t) => titles.push(t));
  await client.prompt("hi");
  await new Promise((r) => setTimeout(r, 100)); // frames are async
  assert.ok(events.includes("agent_start"));
  assert.ok(events.includes("agent_end"));
  assert.deepEqual(titles, ["mock title"]);
  client.close();
});

test("an unsupported command surfaces as a failed response, not a hang", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  const res = await client.send({ type: "definitely_not_a_command" });
  assert.equal(res.success, false);
  assert.match(String(res.error), /Unknown command/);
  client.close();
});

test("close() rejects in-flight commands and is idempotent", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  client.close();
  client.close();
  await assert.rejects(() => client.send({ type: "get_state" }));
});
