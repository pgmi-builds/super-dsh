#!/usr/bin/env node
/**
 * The adapter's fixed Agent preset — 0.1.7 registry model.
 *
 * 0.1.7 moved roster/selection/document RPC + the `agentPreset` session
 * projection into the host AgentPresetRegistry
 * (@deepseek-ai/dsh-agent-preset-registry, mounted by the dsh-web-app
 * bundle's `agent-preset-registry` row; the adapter patch pins
 * `default: "agy"`). The adapter no longer implements the `agentPresets`
 * service and no longer owns a projection fold — it only REGISTERS one
 * fixed, composition-less preset into the host registry.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { AgyCliClient } = await import(join(new URL(".", import.meta.url).pathname, "..", "dist", "agy-cli-client.js"));
const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "fixtures");

const { AGY_PRESET, registerAntigravityPreset } = await import("../dist/agent-preset-agy.js");

function makeHarness() {
  const calls = { inject: [], effect: [], registered: [], unregistered: 0 };
  const fakeRegistry = {
    register: async (definition) => {
      calls.registered.push(definition);
      return async () => { calls.unregistered += 1; };
    },
  };
  const ctx = {
    inject: (services, cb) => { calls.inject.push(services); cb({ agentPresets: fakeRegistry }); },
    effect: (fn, label) => { calls.effect.push({ fn, label }); },
  };
  return { calls, ctx };
}

test("fixed preset: composition-less, id/name/description published", () => {
  assert.deepEqual({ ...AGY_PRESET }, {
    id: "agy",
    name: "Antigravity",
    description: "Google Antigravity (Gemini) via the agent-agy adapter",
    plugins: [],
  });
});

test("registerAntigravityPreset injects agentPresets and registers the fixed definition", async () => {
  const { calls, ctx } = makeHarness();
  registerAntigravityPreset(ctx);
  assert.deepEqual(calls.inject, [["agentPresets"]]);
  assert.equal(calls.effect.length, 1, "the disposer is fiber-tied via ctx.effect");
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.registered[0], AGY_PRESET);
  assert.equal(calls.unregistered, 0);
  await new Promise((r) => setImmediate(r));
  const dispose = calls.effect[0].fn();
  await dispose();
  assert.equal(calls.unregistered, 1);
});

test("skipPermissions maps danger-full-access to --dangerously-skip-permissions in argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-argv-"));
  const trace = join(dir, "argv.jsonl");
  const nativeHome = mkdtempSync(join(tmpdir(), "agy-home-"));
  const client = new AgyCliClient({
    apiKey: "k-test",
    cwd: "/tmp",
    agyBin: join(fixtures, "mock_agy_bin.sh"),
    nativeCliHome: nativeHome,
    skipPermissions: true,
    trace: () => { },
  });
  // swap spawn args capture: the mock writes argv from process.argv
  process.env.AGY_MOCK_TRACE = trace;
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    { lines: [{ event: "init", conversation_id: "c1", init: { tools: ["t"], permission_mode: "request-review" } }] },
    { lines: [{ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hi" } }] },
    { lines: [{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "hi" } }] },
  ]);
  // mock needs the fixtures' script env — the mock reads AGY_MOCK_SCRIPT itself
  let full = "";
  for await (const piece of client.turn("hi")) full += piece;
  assert.equal(full, "hi");
  const argvLines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const argv = argvLines[0].argv;
  assert.ok(argv.includes("--dangerously-skip-permissions"), `argv includes skip flag: ${JSON.stringify(argv)}`);
  assert.ok(argv.some((a) => a.startsWith("--input-format=stream-json")), "stream-json input present");
  assert.equal(argv.includes("--print"), false, "--print must not appear (value-flag collision)");
  delete process.env.AGY_MOCK_TRACE;
  delete process.env.AGY_MOCK_SCRIPT;
  await client.close();
});
