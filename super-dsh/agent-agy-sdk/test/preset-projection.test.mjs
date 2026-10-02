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
const { AgyBridgeClient } = await import(join(new URL(".", import.meta.url).pathname, "..", "dist", "agy-client.js"));
const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "..", "fixtures");

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

test("the SDK start frame carries key, model, thinking level and approval mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-sdk-frame-"));
  const trace = join(dir, "frame.jsonl");
  const client = new AgyBridgeClient({
    apiKey: "k-test",
    model: "gemini-3.5-flash",
    thinkingLevel: "high",
    approvalMode: "allow",
    workspaces: ["/tmp"],
    bridgePath: join(fixtures, "mock_bridge.mjs"),
    pythonBin: process.execPath,
    trace: () => { },
  });
  process.env.AGY_MOCK_TRACE = trace;
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    { events: [{ event: "started" }] },
    { events: [{ event: "chunk", text: "hi" }, { event: "done", conversation_id: "c1", turn_ms: 3 }] },
  ]);
  let full = "";
  for await (const piece of client.turn("hi")) full += piece;
  assert.equal(full, "hi");
  const frames = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = frames.find((f) => f.op === "start");
  assert.ok(start, `a start frame is sent: ${JSON.stringify(frames)}`);
  assert.equal(start.api_key, "k-test", "api key rides the frame (never an env var)");
  assert.equal(start.model, "gemini-3.5-flash");
  assert.equal(start.thinking_level, "high");
  assert.equal(start.approval_mode, "allow");
  assert.deepEqual(start.workspaces, ["/tmp"]);
  delete process.env.AGY_MOCK_TRACE;
  delete process.env.AGY_MOCK_SCRIPT;
  await client.close();
});
