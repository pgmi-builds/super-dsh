#!/usr/bin/env node
/**
 * The adapter's fixed Agent preset — 0.1.7 registry model.
 *
 * 0.1.7 moved roster/selection/document RPC + the `agentPreset` session
 * projection into the host AgentPresetRegistry
 * (@deepseek-ai/dsh-agent-preset-registry, mounted by the dsh-web-app
 * bundle's `agent-preset-registry` row; the adapter patch pins
 * `default: "claude"`). The adapter no longer implements the `agentPresets`
 * service and no longer owns a projection fold — it only REGISTERS one
 * fixed, composition-less preset into the host registry.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { CLAUDE_PRESET, registerClaudePreset } = await import("../dist/agent-preset-claude.js");

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
  assert.deepEqual({ ...CLAUDE_PRESET }, {
    id: "claude",
    name: "Claude",
    description: "Claude Code via the agent-claude adapter",
    plugins: [],
  });
});

test("registerClaudePreset injects agentPresets and registers the fixed definition", async () => {
  const { calls, ctx } = makeHarness();
  registerClaudePreset(ctx);
  assert.deepEqual(calls.inject, [["agentPresets"]]);
  assert.equal(calls.effect.length, 1, "the disposer is fiber-tied via ctx.effect");
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.registered[0], CLAUDE_PRESET);
  assert.equal(calls.unregistered, 0);
  await new Promise((r) => setImmediate(r));
  const dispose = calls.effect[0].fn();
  await dispose();
  assert.equal(calls.unregistered, 1);
});
