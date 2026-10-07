#!/usr/bin/env node
/**
 * hub-page-row-shape.test.mjs — source guard for the Agent Runtimes row.
 *
 * Why a source assertion: the 2026-10-02 P3 round removes the disclosure arrow
 * (the whole row is the expand target) while KEEPING the runtime's own mark.
 * Those two glyphs sit next to each other, and deleting the arrow by range took
 * `<RuntimeMark>` with it — the row lost the icon that runtime-icons.tsx exists
 * to draw, and no behavioural test noticed because nothing asserted the row's
 * shape.
 *
 * These pins make that specific mistake impossible to repeat silently:
 *   - no disclosure arrow character in the row;
 *   - `<RuntimeMark>` still rendered, and rendered BEFORE the label;
 *   - no leftover URL-routing path chip (the `/omp`, `/codex` chips are gone:
 *     there is no per-runtime URL family any more).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = join(new URL(".", import.meta.url).pathname, "..", "src", "client", "HubPage.tsx");
const text = readFileSync(src, "utf8");

/** The Agent Runtimes row body (row start → the closing of HoverRow's children). */
function renderRowSource() {
  const start = text.indexOf("const renderRow = (agent: AgentLink, showMachine: boolean)");
  assert.notEqual(start, -1, "renderRow must exist");
  const end = text.indexOf("</HoverRow>", start);
  assert.notEqual(end, -1, "renderRow must close its HoverRow");
  return text.slice(start, end);
}

test("the disclosure arrow is gone — the whole row is the expand target", () => {
  const row = renderRowSource();
  assert.equal(row.includes("\u25B6"), false, "no ▶ disclosure glyph in the row");
  assert.equal(/aria-hidden[\s\S]{0,400}rotate\(90deg\)/.test(row), false, "no rotating chevron left behind");
});

test("the runtime's own mark SURVIVES — it is identity, not the disclosure affordance", () => {
  const row = renderRowSource();
  assert.match(text, /import \{ RuntimeMark \} from '\.\/runtime-icons\.js'/, "the mark is still imported");
  const markAt = row.indexOf("<RuntimeMark");
  assert.notEqual(markAt, -1, "the row must render <RuntimeMark>");
  const labelAt = row.indexOf("{agent.label}");
  assert.ok(markAt < labelAt, "the mark leads the label");
});

test("no per-runtime path chip: URL routing is gone", () => {
  const row = renderRowSource();
  assert.equal(row.includes("displayPath(agent.path)"), false,
    "the `/omp`-style path chip was removed with the URL family");
});

test("the switch is a live button, never a disabled one", () => {
  const row = renderRowSource();
  assert.match(row, /<button/, "the switch is a button");
  assert.equal(/\bdisabled=\{/.test(row), false,
    "a disabled switch reads as inert plain text (the reported bug) — use the decision table's no-op instead");
});
