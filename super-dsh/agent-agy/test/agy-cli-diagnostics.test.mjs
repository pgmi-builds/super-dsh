#!/usr/bin/env node
/**
 * agy-cli-diagnostics.test.mjs — the CLI's OUT-OF-BAND failure text must reach
 * the turn.
 *
 * Regression (observed live 2026-10-02): a refused turn showed only
 * "agy cli: agy exited code=1" / "unknown error". The CLI had in fact said
 * exactly why — on stderr, or as a non-JSON stdout line — and the client threw
 * those lines away (they went to `trace`, off unless AGY_TRACE=1). Every
 * failure was therefore undiagnosable, which is what let a wrong `--effort`
 * look like a mystery instead of a one-line fix.
 *
 * Both channels are pinned here, on the exit path and on the failed-result path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "..", "fixtures");
const dist = join(here, "..", "dist");
const { AgyCliClient } = await import(join(dist, "agy-cli-client.js"));

/** A CLI client pointed at the mock binary, with tracing off (the prod shape). */
function client(extra = {}) {
  const trace = join(mkdtempSync(join(tmpdir(), "agy-diag-")), "argv.jsonl");
  process.env.AGY_MOCK_TRACE = trace;
  return new AgyCliClient({
    apiKey: "k-diag",
    cwd: "/tmp",
    agyBin: join(fixtures, "mock_agy_bin.sh"),
    trace: () => { },
    ...extra,
  });
}

/** Drive one turn to completion and return the text of whatever it threw. */
async function failureText(spec) {
  process.env.AGY_MOCK_SCRIPT = JSON.stringify(spec);
  const c = client();
  try {
    for await (const _ of c.turn("hi")) { /* drain */ }
    assert.fail("the turn was expected to fail");
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  } finally {
    delete process.env.AGY_MOCK_SCRIPT;
    delete process.env.AGY_MOCK_TRACE;
    await c.close().catch(() => { });
  }
}

test("a refusal on stderr reaches the turn instead of 'exited code=1'", async () => {
  const message = await failureText([
    { stderr: "error: invalid model selection (--model \"gemini-3.7-flash\" --effort \"low\"): --effort is not supported for model \"gemini-3.7-flash\"\n", exit: 1 },
  ]);
  assert.match(message, /agy exited code=1/);
  assert.match(message, /--effort is not supported for model/, "the CLI's own words survive");
  assert.match(message, /gemini-3\.7-flash/, "including the model it named");
});

test("an eligibility refusal on stderr is not flattened into an exit code", async () => {
  const message = await failureText([
    { stderr: "error: Eligibility check failed: Your current account is not eligible for Antigravity\n", exit: 1 },
  ]);
  assert.match(message, /Eligibility check failed/);
});

test("a refusal printed to stdout as a NON-JSON line still reaches the turn", async () => {
  // The CLI sometimes answers on stdout, which the JSONL reader cannot frame —
  // those lines used to be dropped as "bad json".
  const message = await failureText([
    { lines: ["error: model gemini-3.5-flash is not recognized as a known model"] },
    { exit: 1 },
  ]);
  assert.match(message, /not recognized as a known model/);
});

test("a failed result carries the CLI's reason AND the diagnostic tail", async () => {
  const message = await failureText([
    { lines: [{ event: "init", conversation_id: "c1", init: { tools: [] } }], wait: true },
    { stderr: "adc_auth.go:73 adcAuth: authenticated successfully\n" },
    { lines: [{ event: "result", result: { conversation_id: "c1", status: "ERROR", error: "plan model not specified" } }] },
  ]);
  assert.match(message, /plan model not specified/, "the structured reason is kept");
  assert.match(message, /authenticated successfully/, "and the surrounding CLI context with it");
});

test("a failure consumes its diagnostic tail — the next failure does not repeat it", async () => {
  // Diagnostics belong to ONE failure. Without the consume, a second failure in
  // the same child would re-attach the first failure's stderr and send the
  // reader hunting a cause that had already been reported.
  const c = client();
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    // Prologue: the CLI emits init before reading stdin.
    { lines: [{ event: "init", conversation_id: "c1", init: { tools: [] } }], wait: true },
    // First prompt: the refusal reason lands on stderr, then the result fails.
    { stderr: "noise-one\n", lines: [{ event: "result", result: { conversation_id: "c1", status: "ERROR", error: "boom-one" } }] },
    // Second prompt: a different failure with NO new stderr.
    { lines: [{ event: "result", result: { conversation_id: "c1", status: "ERROR", error: "boom-two" } }] },
  ]);
  const messages = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      for await (const _ of c.turn("hi")) { /* drain */ }
    } catch (error) {
      messages.push(String(error instanceof Error ? error.message : error));
    }
  }
  delete process.env.AGY_MOCK_SCRIPT;
  delete process.env.AGY_MOCK_TRACE;
  await c.close().catch(() => { });

  assert.equal(messages.length, 2, `both turns failed: ${JSON.stringify(messages)}`);
  assert.match(messages[0], /boom-one/);
  assert.match(messages[0], /noise-one/, "the first failure carries its CLI context");
  assert.match(messages[1], /boom-two/);
  assert.doesNotMatch(messages[1], /noise-one/, "the tail was consumed by the first failure");
});

test("the mock still records argv, so spawn-args assertions keep working", async () => {
  const trace = join(mkdtempSync(join(tmpdir(), "agy-diag-argv-")), "argv.jsonl");
  process.env.AGY_MOCK_TRACE = trace;
  process.env.AGY_MOCK_SCRIPT = JSON.stringify([
    { lines: [{ event: "init", conversation_id: "c1", init: { tools: [] } }], wait: true },
  ]);
  const c = new AgyCliClient({
    apiKey: "k",
    cwd: "/tmp",
    model: "gemini-3.7-flash",
    effort: "medium",
    agyBin: join(fixtures, "mock_agy_bin.sh"),
    trace: () => { },
  });
  const running = (async () => { for await (const _ of c.turn("hi")) { /* drain */ } })();
  await new Promise((r) => setTimeout(r, 150));
  const argv = JSON.parse(readFileSync(trace, "utf8").trim().split("\n")[0]).argv;
  delete process.env.AGY_MOCK_SCRIPT;
  delete process.env.AGY_MOCK_TRACE;
  await c.close().catch(() => { });
  await running.catch(() => { });
  assert.ok(argv.includes("--effort=medium"), `effort rides argv: ${JSON.stringify(argv)}`);
  assert.ok(argv.includes("--model=gemini-3.7-flash"));
});
