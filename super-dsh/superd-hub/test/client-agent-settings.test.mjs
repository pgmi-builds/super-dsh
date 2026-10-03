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
  parseProvidersView,
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
  assert.deepEqual(settingsPanelFor("agy"), { namespace: "agyAuth", kind: "auth" });
  // The codex row expands into the MULTI-PROVIDER surface (2026-10-03 ruling): a
  // provider list, not an auth-method radio group. The `kind` is what tells the
  // panel which of the two bodies to mount.
  assert.deepEqual(settingsPanelFor("codex"), { namespace: "codexProviders", kind: "providers" });
  assert.equal(hasSettingsPanel("codex"), true);
  // Both Codex lines answer the same panel (2026-10-04): the SDK half is the
  // same agent over another transport, and the two worlds keep separate stores.
  assert.deepEqual(settingsPanelFor("codex-sdk"), { namespace: "codexProviders", kind: "providers" });
  assert.equal(hasSettingsPanel("codex-sdk"), true);
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

// ------------------------------------------------------- the providers body

/**
 * A faithful `codexProviders/get` answer, trimmed to the fields the parse
 * keeps. Deliberately carries NO `selected`/`effective`: that active half was
 * removed (which provider a session runs is DSH's own model selection), so the
 * parse must not invent one.
 */
const providersAnswer = {
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      protocol: "responses",
      models: [{ id: "deepseek-flash", displayName: "DeepSeek Flash", contextWindow: 1048576 }],
      authKind: "env",
      envName: "DEEPSEEK_API_KEY",
      hasKey: true,
    },
  ],
  native: { providerId: "deepseek", model: "deepseek-flash" },
  protocols: [
    { value: "responses", label: "Responses API", available: true, hint: "the only one 0.154 accepts" },
    { value: "chat", label: "Chat Completions", available: false, hint: '`wire_api = "chat"` is no longer supported.' },
  ],
  paths: { store: "/h/agents/codex/codex-providers.json", config: "/u/.codex/config.toml", auth: "/u/.codex/auth.json", catalogs: "/u/.codex/superd-model-catalogs" },
  syncedAt: 1759500000000,
};

test("a well-formed providers answer parses through intact", () => {
  const view = parseProvidersView(providersAnswer);
  assert.ok(view, "parses");
  assert.deepEqual(view.providers.map((p) => p.id), ["deepseek"]);
  assert.equal(view.providers[0].models[0].label, "DeepSeek Flash", "a display name is used when present");
  assert.equal(view.providers[0].models[0].contextWindow, 1048576);
  assert.equal(view.providers[0].hasKey, true);
  assert.deepEqual(view.native, { providerId: "deepseek", model: "deepseek-flash" }, "the user's own config rides as the informational `native`");
  assert.deepEqual(view.protocols.map((p) => [p.value, p.available]), [["responses", true], ["chat", false]]);
  assert.equal(view.paths.catalogs, "/u/.codex/superd-model-catalogs");
  assert.equal(view.syncedAt, 1759500000000, "the reconcile stamp is kept");
  assert.equal(view.note, undefined, "an absent note stays absent");
});

test("the removed active-selection half never comes back, even from a stale adapter", () => {
  // The panel keys on `native`; an old adapter's extra `selected`/`effective`
  // keys are ignored, and an answer carrying none of them still parses (that is
  // exactly what today's adapter sends).
  const view = parseProvidersView({ ...providersAnswer, selected: "deepseek", effective: { providerId: "deepseek", model: "x" } });
  assert.ok(view, "legacy keys do not break the parse");
  assert.equal("selected" in view, false, "no `selected` is invented");
  assert.equal("effective" in view, false, "the renamed field is not resurrected");
  assert.deepEqual(view.native, { providerId: "deepseek", model: "deepseek-flash" });

  assert.equal(parseProvidersView({ ...providersAnswer, native: null }).native, null, "a null native reads as null");
  const { native: _dropped, ...noNativeKey } = providersAnswer;
  assert.equal(parseProvidersView(noNativeKey).native, null, "an adapter that omits `native` reads as null too");
});

test("a provider may legitimately carry an EMPTY model list", () => {
  // A provider folded in from the user's config.toml that the file does not
  // name has no discoverable list; the row says "no models yet" instead of the
  // view failing to parse.
  const view = parseProvidersView({
    ...providersAnswer,
    providers: [{ id: "zai", label: "Z.ai", baseUrl: "https://api.z.ai/v1", protocol: "responses", models: [], authKind: "apiKey", hasKey: false }],
  });
  assert.ok(view, "an empty per-provider model list is a state, not a parse failure");
  assert.deepEqual(view.providers[0].models, []);
  assert.equal(view.providers[0].protocol, "responses");
});

test("an EMPTY provider list is a state, not an error (the fresh-install panel)", () => {
  const view = parseProvidersView({ ...providersAnswer, providers: [], native: null });
  assert.ok(view, "the panel must offer Add provider, not an error");
  assert.deepEqual(view.providers, []);
  assert.equal(view.native, null);
});

test("an unusable providers answer is rejected outright", () => {
  for (const bad of [null, undefined, 42, "nope", {}, { providers: "no" }, { protocols: [] }, { providers: [] }]) {
    assert.equal(parseProvidersView(bad), undefined, `rejected: ${JSON.stringify(bad) ?? String(bad)}`);
  }
  // Rows missing what the panel keys on are dropped; an all-dropped list is still
  // a legitimate empty list, because the user can add one.
  const mixed = parseProvidersView({
    ...providersAnswer,
    providers: [providersAnswer.providers[0], { label: "no id" }, { id: "no-url" }, null],
  });
  assert.deepEqual(mixed?.providers.map((p) => p.id), ["deepseek"]);
});

test("missing optionals read conservatively, and an unknown protocol is not invented", () => {
  const view = parseProvidersView({
    providers: [{ id: "x", label: "X", baseUrl: "https://x/v1", protocol: "grpc", models: [{ id: "m" }] }],
    native: null,
    protocols: providersAnswer.protocols,
    paths: providersAnswer.paths,
  });
  assert.ok(view);
  assert.equal(view.providers[0].authKind, "apiKey", "an unstated auth kind reads as keyed");
  assert.equal(view.providers[0].hasKey, false, "and an unstated key is never assumed present");
  assert.equal(view.providers[0].models[0].label, "m", "a nameless model falls back to its id");
  // a protocol the hub does not know is dropped rather than echoed into a control
  assert.equal(view.providers[0].protocol, "responses");
  assert.equal(view.native, null);
  assert.equal(view.syncedAt, undefined, "an absent reconcile stamp stays absent");
});
