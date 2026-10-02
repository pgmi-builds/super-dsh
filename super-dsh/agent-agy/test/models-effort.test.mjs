#!/usr/bin/env node
/**
 * models-effort.test.mjs — the `--effort` the adapter hands the CLI.
 *
 * Measured contract (2026-10-02, against the live Agent Platform plane):
 *
 *   $ agy --model=gemini-3.8-flash --print ...
 *   error: --model gemini-3.8-flash requires --effort (available: low, medium, high)
 *
 *   $ agy --model=gemini-3.1-pro --effort=medium --print ...
 *   error: gemini-3.1-pro has no "medium" effort (available: low, high)
 *
 * So: the flag is MANDATORY, and the vocabulary is PER-MODEL. The adapter must
 * therefore always send a level, and it must come from that model's own set —
 * never from a shared constant (the original defect: every model inherited
 * 3.6-flash's "low", which 3.1-pro cannot even accept).
 *
 * The authoritative vocabulary is the CLI's own `available:` set, and it
 * matches AGY_MODEL_CATALOG exactly: 3.8/3.7/3.6-flash = low|medium|high,
 * 3.1-pro = low|high.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");
const { CLI_DEFAULT_MODEL, defaultEffortFor, effortsFor, parseModelId, resolveEffort } =
  await import(join(dist, "models.js"));

test("every catalog model gets a level — the flag is mandatory, so never undefined", () => {
  for (const slug of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro"]) {
    const level = resolveEffort(slug);
    assert.equal(typeof level, "string", `${slug} must be given a level or the CLI will not start`);
    assert.ok(effortsFor(slug).includes(level), `${slug}: "${level}" must be in its own set ${effortsFor(slug)}`);
  }
});

test("the level comes from THAT model's vocabulary, never a shared constant", () => {
  // The original defect: 3.6-flash's "low" was sent to every model.
  assert.equal(resolveEffort("gemini-3.1-pro"), "low");
  assert.equal(resolveEffort("gemini-3.7-flash"), defaultEffortFor("gemini-3.7-flash"));
  assert.notEqual(resolveEffort("gemini-3.7-flash"), CLI_DEFAULT_MODEL.thinkingLevel,
    "3.7-flash must not inherit the 3.6-flash constant");
  // 3.1-pro has NO medium — the case that provably could not start before.
  assert.equal(effortsFor("gemini-3.1-pro").includes("medium"), false);
  assert.notEqual(resolveEffort("gemini-3.1-pro"), "medium");
});

test("an explicit session choice wins when the model serves it", () => {
  assert.equal(resolveEffort("gemini-3.7-flash", "high"), "high");
  assert.equal(resolveEffort("gemini-3.1-pro", "high"), "high");
  assert.equal(resolveEffort("gemini-3.7-flash", "high", "low"), "high", "explicit beats the legacy suffix");
});

test("a choice the model does NOT serve falls back instead of failing the turn", () => {
  // A stale session (model swapped under it) or a UI that offered a level this
  // model lacks: sending it is a guaranteed refusal, so fall back to the
  // model's own default rather than transmitting something unrunnable.
  assert.equal(resolveEffort("gemini-3.1-pro", "medium"), "low", "3.1-pro has no medium → its default");
  assert.equal(resolveEffort("gemini-3.1-pro", undefined, "medium"), "low", "same via the legacy suffix");
  assert.equal(resolveEffort("gemini-3.7-flash", "bogus"), defaultEffortFor("gemini-3.7-flash"));
});

test("an unmodelled slug forwards what was asked and invents nothing", () => {
  // No declared vocabulary ⇒ we cannot validate, so we must not fabricate one.
  assert.equal(resolveEffort("some-future-slug"), undefined);
  assert.equal(resolveEffort("some-future-slug", "high"), "high");
});

test("an empty choice is an absent choice", () => {
  assert.equal(resolveEffort("gemini-3.7-flash", ""), defaultEffortFor("gemini-3.7-flash"));
  assert.equal(resolveEffort("gemini-3.7-flash", undefined, ""), defaultEffortFor("gemini-3.7-flash"));
});

test("the catalog matches the CLI's own reported sets", () => {
  // These are the `available:` values the CLI printed for each model.
  assert.deepEqual(effortsFor("gemini-3.8-flash"), ["low", "medium", "high"]);
  assert.deepEqual(effortsFor("gemini-3.7-flash"), ["low", "medium", "high"]);
  assert.deepEqual(effortsFor("gemini-3.6-flash"), ["low", "medium", "high"]);
  assert.deepEqual(effortsFor("gemini-3.1-pro"), ["low", "high"]);
  // Retired slugs are absent rather than offered and refused.
  for (const gone of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.5-flash"]) {
    assert.equal(effortsFor(gone), undefined, `${gone} is not served`);
    assert.equal(parseModelId(gone), undefined, `${gone} must not be selectable`);
  }
});
