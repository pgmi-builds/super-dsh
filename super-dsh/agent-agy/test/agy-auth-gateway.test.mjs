#!/usr/bin/env node
/**
 * agy-auth-gateway.test.mjs — the Hub settings panel's adapter-side Remote.
 *
 * Two independent things must hold for P3 to work at all, so both are pinned:
 *
 *   1. TRANSPORT — the class must actually register as a Typert Remote under
 *      namespace `agyAuth` with methods `get`/`set`. That rests entirely on the
 *      standard method decorators landing on the prototype; if a tsconfig ever
 *      flips to `experimentalDecorators`, the emit changes shape and the
 *      endpoints silently vanish. `remoteMethods()` is the gateway's own
 *      discovery path, so asserting through it proves what dispatch will see.
 *
 *   2. SEMANTICS — the ladder, the annotations, and the native-settings flip.
 *      Selecting a form really rewrites the user's own settings.json
 *      (2026-10-02 ruling 「拥抱用户自己的使用环境」), including the removal of a
 *      stale `modelProvider` pin, so it is exercised against a real filesystem.
 */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");
const { AgyAuthGateway, buildAuthView, normalizeSetRequest } = await import(join(dist, "agy-auth-gateway.js"));
const { readAdapterState } = await import(join(dist, "agy-store.js"));
const { nativeSettingsPath } = await import(join(dist, "agy-auth.js"));

const AVAILABILITY = {
  none: { apiKey: false, oauth: false, adc: false },
  adcOnly: { apiKey: false, oauth: false, adc: true },
  keyOnly: { apiKey: true, oauth: false, adc: false },
  both: { apiKey: true, oauth: false, adc: true },
};

const SETTINGS = "/home/u/.gemini/antigravity-cli/settings.json";

/** A temp world home plus a temp real home (the user's, which we really write). */
function homes() {
  const home = mkdtempSync(join(tmpdir(), "agy-gw-home-"));
  const realHome = mkdtempSync(join(tmpdir(), "agy-gw-real-"));
  mkdirSync(join(realHome, ".gemini", "antigravity-cli"), { recursive: true });
  return { home, realHome };
}

function writeNativeSettings(realHome, value) {
  writeFileSync(nativeSettingsPath(realHome), JSON.stringify(value, null, 2) + "\n");
}

function readNativeSettings(realHome) {
  return JSON.parse(readFileSync(nativeSettingsPath(realHome), "utf8"));
}

function gateway(availability, { home, realHome } = homes()) {
  return {
    home,
    realHome,
    instance: new AgyAuthGateway(new Context(), home, () => realHome, () => availability),
  };
}

// ----------------------------------------------------------------- transport

test("the class registers as the `agyAuth` Remote with get and set — the decorators survive the build", () => {
  const { instance } = gateway(AVAILABILITY.adcOnly);
  assert.equal(instance.name, "agyAuth", "Cordis service key == the wire namespace");
  assert.equal(instance.typertRemote.namespace, "agyAuth", "the gateway's source-claim binding");

  const methods = remoteMethods(instance).map((m) => m.exportName ?? m.method);
  assert.deepEqual(methods, ["get", "set"], "endpoint segments the carrier will forward verbatim");
  for (const marker of remoteMethods(instance)) {
    assert.equal(marker.mode, undefined, "unary: neither method is a stream");
    assert.deepEqual(marker.invocation, { kind: "direct" }, "no context-scoped resolution");
  }
});

test("the wire payload maps to the JS signature: `set` takes exactly one `request` argument", () => {
  const { instance } = gateway(AVAILABILITY.adcOnly);
  const set = remoteMethods(instance).find((m) => m.method === "set");
  assert.ok(set);
  // Under SRC the JS signature IS the contract, so the parameter name is the
  // wire field: `payload: { args: { request: {...} } }`.
  assert.equal(instance.set.length, 1, "one declared parameter → wire field `request`");
  assert.equal(set.exportName, undefined, "endpoint name == method name, so no override is recorded");
  assert.equal(set.method, "set");
});

// ---------------------------------------------------------------- view/parse

test("the view marks the effective form and renders every option in ladder order", () => {
  const view = buildAuthView({ availability: AVAILABILITY.both, selected: "adc", settingsPath: SETTINGS });
  assert.deepEqual(view.methods.map((m) => m.key), ["apiKey", "oauth", "adc"]);
  assert.equal(view.selected, "adc");
  assert.equal(view.effective, "adc");
  assert.equal(view.settingsPath, SETTINGS);
  assert.equal(view.note, undefined, "an honoured choice needs no explanation");
  // OAuth is the CLI's own Google sign-in (Agent Platform) and is now REAL:
  // selectable, and available exactly when that sign-in is on disk.
  assert.equal(view.methods.find((m) => m.key === "oauth").placeholder, false, "no longer a placeholder");
  assert.equal(view.methods.find((m) => m.key === "oauth").available, false,
    "AVAILABILITY here comes from the injected probe (this fixture has oauth:false)");
});

test("an unset choice falls to the ladder silently; the first available form wins", () => {
  const view = buildAuthView({ availability: AVAILABILITY.adcOnly, selected: undefined, settingsPath: SETTINGS });
  assert.equal(view.selected, null, "absence is reported as null, not an invented default");
  assert.equal(view.effective, "adc", "the ladder decides");
  assert.equal(view.note, undefined);

  // Order is the ruling's: key → oauth → adc (oauth can never win this round).
  const both = buildAuthView({ availability: AVAILABILITY.both, selected: null, settingsPath: SETTINGS });
  assert.equal(both.effective, "apiKey", "key outranks adc in the declared order");
});

test("a stale selection is explained, not silently obeyed", () => {
  const view = buildAuthView({ availability: AVAILABILITY.adcOnly, selected: "apiKey", settingsPath: SETTINGS });
  assert.equal(view.selected, "apiKey", "the stored choice is still reported honestly");
  assert.equal(view.effective, "adc", "but the ladder is what actually runs");
  assert.match(view.note, /no longer present/);
  assert.match(view.note, /ADC \(Vertex\)/, "the note names the form it fell back to");
});

test("nothing available is stated plainly, and a garbage stored value is ignored", () => {
  const empty = buildAuthView({ availability: AVAILABILITY.none, selected: undefined, settingsPath: SETTINGS });
  assert.equal(empty.effective, null);
  assert.match(empty.note, /No auth form is available/);

  const junk = buildAuthView({ availability: AVAILABILITY.adcOnly, selected: "nonsense", settingsPath: SETTINGS });
  assert.equal(junk.selected, null, "an unknown persisted value is not echoed back as a choice");
  assert.equal(junk.effective, "adc");
});

test("per-option hints say what is missing rather than restating the label", () => {
  const view = buildAuthView({ availability: AVAILABILITY.none, selected: undefined, settingsPath: SETTINGS });
  const hint = (key) => view.methods.find((m) => m.key === key).hint;
  assert.match(hint("apiKey"), /No key yet/);
  assert.match(hint("adc"), /gcloud auth application-default login/, "the ADC hint names the fix");
  assert.ok(hint("oauth").length > 0);
  // The available case flips the wording rather than repeating it.
  const ok = buildAuthView({ availability: AVAILABILITY.both, selected: undefined, settingsPath: SETTINGS });
  assert.doesNotMatch(ok.methods.find((m) => m.key === "adc").hint, /No ADC/);
});

// ------------------------------------------------------------------ set/get

test("normalizeSetRequest: null clears, a known mode passes, an unknown mode is rejected", () => {
  assert.equal(normalizeSetRequest(undefined), null, "absent → clear");
  assert.equal(normalizeSetRequest(null), null);
  assert.equal(normalizeSetRequest({}), null);
  assert.equal(normalizeSetRequest({ mode: null }), null);
  assert.equal(normalizeSetRequest({ mode: "adc" }), "adc");
  assert.equal(normalizeSetRequest({ mode: "apiKey" }), "apiKey");
  assert.throws(() => normalizeSetRequest({ mode: "vertex" }), /unknown auth mode/);
  assert.throws(() => normalizeSetRequest({ mode: 7 }), /unknown auth mode/);
});

test("selecting a form persists it AND rewrites the user's own settings.json", async () => {
  const { home, realHome, instance } = gateway(AVAILABILITY.both);
  writeNativeSettings(realHome, { model: "Gemini 3.5 Pro (High)", theme: "dark" });

  const view = await instance.set({ mode: "apiKey" });
  assert.equal(view.selected, "apiKey");
  assert.equal(readAdapterState(home).authMode, "apiKey", "choice lives in the WORLD home");
  const native = readNativeSettings(realHome);
  assert.equal(native.modelProvider, "gemini", "the CLI's key mode is pinned in the USER's settings");
  assert.equal(native.model, "Gemini 3.5 Pro (High)", "unrelated keys survive the flip");
  assert.equal(native.theme, "dark");
});

test("switching to a non-key form REMOVES the stale pin instead of leaving the TUI stuck", async () => {
  const { home, realHome, instance } = gateway(AVAILABILITY.both);
  writeNativeSettings(realHome, { modelProvider: "gemini", model: "Gemini 3.5 Pro (High)" });

  await instance.set({ mode: "adc" });

  const native = readNativeSettings(realHome);
  assert.equal("modelProvider" in native, false, "the pin is deleted, not merely unset");
  assert.equal(native.model, "Gemini 3.5 Pro (High)", "other keys are preserved");
  assert.equal(readAdapterState(home).authMode, "adc");
  assert.equal((await instance.get()).effective, "adc");
});

test("clearing the choice hands the decision back to the ladder and still unpins key mode", async () => {
  const { home, realHome, instance } = gateway(AVAILABILITY.adcOnly);
  writeNativeSettings(realHome, { modelProvider: "gemini" });

  const view = await instance.set({ mode: null });

  assert.equal(readAdapterState(home).authMode, undefined, "no explicit choice is persisted");
  assert.equal(view.selected, null);
  assert.equal(view.effective, "adc", "the ladder answers instead");
  assert.equal("modelProvider" in readNativeSettings(realHome), false, "a stale pin is still undone");
});

test("selecting a form this machine does not have follows the ladder for the native flip", async () => {
  // Key is gone; the user taps it anyway (stale UI / another machine's state).
  const { home, realHome, instance } = gateway(AVAILABILITY.adcOnly);
  writeNativeSettings(realHome, { modelProvider: "gemini" });

  const view = await instance.set({ mode: "apiKey" });

  assert.equal(readAdapterState(home).authMode, "apiKey", "the request is recorded verbatim");
  assert.equal(view.effective, "adc", "but ADC is what would run");
  assert.match(view.note, /no longer present/);
  assert.equal("modelProvider" in readNativeSettings(realHome), false,
    "the native flip follows the EFFECTIVE form, so the dead key pin is not re-applied");
});

test("set rejects an unknown mode before touching any file", async () => {
  const { home, realHome, instance } = gateway(AVAILABILITY.both);
  writeNativeSettings(realHome, { modelProvider: "gemini" });

  await assert.rejects(() => instance.set({ mode: "vertex" }), /unknown auth mode/);
  assert.deepEqual(readAdapterState(home), {}, "nothing persisted");
  assert.deepEqual(readNativeSettings(realHome), { modelProvider: "gemini" }, "nothing rewritten");
});
