#!/usr/bin/env node
/**
 * The adapter's fixed Agent preset — 0.1.7 registry model.
 *
 * 0.1.7 moved roster/selection/document RPC + the `agentPreset` session
 * projection into the host AgentPresetRegistry
 * (@deepseek-ai/dsh-agent-preset-registry, mounted by the dsh-web-app
 * bundle's `agent-preset-registry` row; the adapter patch pins
 * `default: "codex"`). The adapter no longer implements the `agentPresets`
 * service — the 0.1.6 SingleCodexPresetRoster and its remote face are retired — it only
 * REGISTERS one fixed, composition-less preset into the host registry.
 * Covers the contract the Web surfaces need:
 *
 *   - the fixed preset declares exactly { id, name, description, plugins: [] }
 *     (mounting it composes nothing — the foreign agent drives its own tools);
 *   - registerCodexPreset wires through ctx.inject(["agentPresets"]) and
 *     registers that definition, tying the registry disposer to the fiber;
 *   - disposing the effect unregisters (roster membership is plugin-load
 *     scoped, never ambient).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { CODEX_PRESET, registerCodexPreset } = await import("../dist/agent-preset-codex.js");

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
  assert.deepEqual({ ...CODEX_PRESET }, {
    id: "codex",
    name: "Codex",
    description: "Codex agent via the agent-codex adapter",
    plugins: [],
  });
});

test("registerCodexPreset injects agentPresets and registers the fixed definition", async () => {
  const { calls, ctx } = makeHarness();
  registerCodexPreset(ctx);
  assert.deepEqual(calls.inject, [["agentPresets"]]);
  assert.equal(calls.effect.length, 1, "the disposer is fiber-tied via ctx.effect");
  // registration fires synchronously through the inject callback
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.registered[0], CODEX_PRESET);
  // unregister only after the fiber effect disposes
  assert.equal(calls.unregistered, 0);
  // let the register() promise's `.then` land before disposing
  await new Promise((r) => setImmediate(r));
  // cordis effect semantics: the callback is a factory whose return value is
  // the fiber's dispose closure.
  const dispose = calls.effect[0].fn();
  await dispose();
  assert.equal(calls.unregistered, 1);
});
