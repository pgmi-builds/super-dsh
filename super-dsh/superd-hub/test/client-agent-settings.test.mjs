#!/usr/bin/env node
/**
 * client-agent-settings.test.mjs — the Hub runtime settings panel's pure seams.
 *
 * P3 (2026-10-02 user ruling): the row body expands that runtime's own
 * settings inline; the adapter owns the config and answers a `*Auth/get` RPC.
 * These pins cover the two things that would silently misrender:
 *   - the accordion transition (one panel open at a time);
 *   - the defensive parse of the adapter's answer, including the conservative
 *     default that an option lacking `available` is NOT shown as usable.
 *
 * Imports the host tsc's dual-emitted copy (`dist/client/agent-settings.js`) —
 * the roster/mesh-groups precedent; the browser lane consumes the same source.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist", "client");
const {
  activeMethod,
  hasSettingsPanel,
  settingsPanelFor,
  parseAuthView,
  selectable,
  toggleExpanded,
} = await import(join(dist, "agent-settings.js"));

test("accordion: one panel at a time, and the open row closes on a second click", () => {
  assert.equal(toggleExpanded(null, "agy"), "agy", "closed → open");
  assert.equal(toggleExpanded("agy", "agy"), null, "open → closed (same row)");
  assert.equal(toggleExpanded("agy", "omp"), "omp", "switching rows moves the panel in one click");
  assert.equal(toggleExpanded("omp", "agy"), "agy", "and back again");
});

test("only the runtimes that own settings advertise a panel", () => {
  assert.equal(hasSettingsPanel("agy"), true);
  assert.equal(hasSettingsPanel("agy-sdk"), false, "the SDK half has no settings panel this round");
  assert.equal(hasSettingsPanel("omp"), false);
  assert.equal(hasSettingsPanel("native"), false);
  // The spec names the adapter Remote the panel calls — the hub forwards the
  // method verbatim, so a wrong namespace here is a silent 404 on expand.
  assert.deepEqual(settingsPanelFor("agy"), { namespace: "agyAuth" });
  assert.equal(settingsPanelFor("omp"), undefined);
});

/** A faithful adapter answer, trimmed to the fields the parse keeps. */
const adapterAnswer = {
  methods: [
    { key: "apiKey", label: "Gemini API key", available: true, placeholder: false, hint: "GEMINI_API_KEY or a saved key" },
    { key: "oauth", label: "Google account sign-in", available: false, placeholder: true, hint: "Detection lands with the next round" },
    { key: "adc", label: "Application Default Credentials", available: true, placeholder: false, hint: "gcloud ADC on this machine" },
  ],
  selected: "adc",
  effective: "adc",
  settingsPath: "/home/u/.gemini/antigravity-cli/settings.json",
};

test("a well-formed adapter answer parses through intact", () => {
  const view = parseAuthView(adapterAnswer);
  assert.ok(view, "parses");
  assert.deepEqual(view.methods.map((m) => m.key), ["apiKey", "oauth", "adc"], "adapter order is preserved");
  assert.equal(view.selected, "adc");
  assert.equal(view.effective, "adc");
  assert.equal(view.settingsPath, "/home/u/.gemini/antigravity-cli/settings.json");
  assert.equal(view.note, undefined, "an absent note stays absent");
});

test("an unusable answer is rejected outright, never rendered as an empty success", () => {
  for (const bad of [null, undefined, 42, "nope", {}, { methods: "no" }, { methods: [] }]) {
    assert.equal(parseAuthView(bad), undefined, `rejected: ${JSON.stringify(bad) ?? String(bad)}`);
  }
  // Rows missing the fields the panel keys on are dropped, not defaulted.
  const mixed = parseAuthView({
    methods: [{ key: "adc", label: "ADC", available: true }, { label: "no key" }, { key: "orphan" }, null],
  });
  assert.deepEqual(mixed?.methods.map((m) => m.key), ["adc"], "only complete options survive");
  assert.equal(parseAuthView({ methods: [{ label: "no key" }] }), undefined, "all-dropped → unusable");
});

test("missing flags default to the conservative reading, not to 'usable'", () => {
  const view = parseAuthView({ methods: [{ key: "adc", label: "ADC" }] });
  assert.ok(view);
  assert.equal(view.methods[0].available, false, "an adapter that omits `available` never yields a green option");
  assert.equal(view.methods[0].placeholder, false);
  assert.equal(view.methods[0].hint, "", "absent hint reads as empty, not undefined");
  assert.equal(view.selected, null, "absent selection is null, not undefined");
  assert.equal(view.effective, null);
});

test("the in-force option is the effective one, falling back to the selection", () => {
  const view = parseAuthView(adapterAnswer);
  assert.equal(activeMethod(view).key, "adc");

  // A stale selection (the form left the machine) still resolves honestly: the
  // adapter's ladder answer wins, and the UI marks what actually runs.
  const stale = parseAuthView({ ...adapterAnswer, selected: "oauth", effective: "apiKey" });
  assert.equal(activeMethod(stale).key, "apiKey", "effective wins over a stale selection");

  // No effective answer and no selection → mark nothing rather than guess.
  assert.equal(activeMethod(parseAuthView({ ...adapterAnswer, selected: null, effective: null })), undefined);
  // An id the adapter never listed resolves to nothing (no phantom option).
  assert.equal(activeMethod(parseAuthView({ ...adapterAnswer, selected: "ghost", effective: "ghost" })), undefined);
});

test("placeholders render but are never selectable", () => {
  const view = parseAuthView(adapterAnswer);
  const byKey = Object.fromEntries(view.methods.map((m) => [m.key, m]));
  assert.equal(selectable(byKey.apiKey), true);
  assert.equal(selectable(byKey.adc), true);
  assert.equal(selectable(byKey.oauth), false, "the OAuth placeholder is inert this round");
});
