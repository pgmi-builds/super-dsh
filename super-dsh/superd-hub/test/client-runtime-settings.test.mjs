#!/usr/bin/env node
/**
 * client-runtime-settings.test.mjs — the panel's browser-side transport.
 *
 * The wire shape is not ours to invent: `/hub/api` decodes upstream's
 * `client-request` envelope and forwards `method` verbatim to the world's
 * gateway, which insists the payload be exactly `{ args: {...} }` with the
 * adapter's own parameter names. A drift here fails as an opaque 400 at the
 * gateway, far from this file — so the envelope is asserted literally, and every
 * failure branch (transport, framing, gateway business error) is pinned to a
 * distinct, non-empty message.
 *
 * `fetch` is injected, so this runs under `node --test` with no DOM.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist", "client");
const {
  callRuntimeSettings,
  fetchAuthView,
  fetchProvidersView,
  mintRpcId,
  removeProvider,
  saveProvider,
  setAuthMode,
  settingsEnvelope,
} = await import(join(dist, "runtime-settings-api.js"));

const VIEW = {
  methods: [
    { key: "apiKey", label: "Gemini API key", available: true, placeholder: false, hint: "h" },
    { key: "adc", label: "ADC (Vertex)", available: true, placeholder: false, hint: "h" },
  ],
  selected: "adc",
  effective: "adc",
  settingsPath: "/home/u/.gemini/antigravity-cli/settings.json",
};

/** A fetch stub recording the call and answering with one server-response. */
function stub(answer, { ok = true, status = 200 } = {}) {
  const calls = [];
  const send = async (input, init) => {
    calls.push({ input, init, body: JSON.parse(init.body) });
    return {
      ok,
      status,
      text: async () => (typeof answer === "string" ? answer : JSON.stringify(answer)),
    };
  };
  return { calls, send };
}

const answerWith = (result) => ({ type: "server-response", rpcId: "x", result });

test("the get envelope is exactly what the /hub gateway decodes", async () => {
  const { calls, send } = stub(answerWith({ ok: true, value: VIEW }));

  const view = await fetchAuthView("agy", "agyAuth", send);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/hub/api?agent=agy", "the family's prefix mount, demux key in the query");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin", "ctx0's cookie carries the auth");
  const body = calls[0].body;
  assert.equal(body.type, "client-request");
  assert.equal(body.method, "agyAuth/get", "two segments: the gateway claims exactly two");
  assert.deepEqual(body.payload, { args: {} }, "get takes no arguments");
  assert.equal(typeof body.rpcId, "string");
  assert.ok(body.rpcId.length > 0);
  assert.deepEqual(view.methods.map((m) => m.key), ["apiKey", "adc"], "the parsed view comes back");
});

test("the set envelope nests the request under its own parameter name", async () => {
  const { calls, send } = stub(answerWith({ ok: true, value: VIEW }));

  await setAuthMode("agy", "agyAuth", "apiKey", send);
  assert.deepEqual(calls[0].body.payload, { args: { request: { mode: "apiKey" } } });

  // Clearing the choice is an explicit null, not an omitted field: the adapter
  // distinguishes "let the ladder decide" from "no instruction".
  await setAuthMode("agy", "agyAuth", null, send);
  assert.deepEqual(calls[1].body.payload, { args: { request: { mode: null } } });
  assert.equal(calls[1].body.method, "agyAuth/set");
});

test("the demux key is encoded, so a hostile roster key cannot forge a query", () => {
  const envelope = settingsEnvelope("agyAuth", "get", {});
  assert.equal(envelope.method, "agyAuth/get");
  assert.equal(typeof envelope.rpcId, "string");
  assert.notEqual(envelope.rpcId, settingsEnvelope("agyAuth", "get", {}).rpcId, "rpcIds are unique per call");
});

test("a gateway business error surfaces the ADAPTER's message, not a status code", async () => {
  const { send } = stub(answerWith({ ok: false, error: { code: "gateway/dispatch", message: "agyAuth/set: unknown auth mode \"vertex\"" } }));
  await assert.rejects(
    () => callRuntimeSettings("agy", "agyAuth", "set", { request: { mode: "vertex" } }, send),
    /unknown auth mode/,
  );
});

test("transport and framing failures are distinct and never silently empty", async () => {
  // Unreadable body (a proxy answered HTML, say).
  const html = stub("<html>nope</html>");
  await assert.rejects(() => fetchAuthView("agy", "agyAuth", html.send), /unreadable answer/);

  // Valid JSON, wrong shape.
  const shapeless = stub({ type: "server-response", rpcId: "x" });
  await assert.rejects(() => fetchAuthView("agy", "agyAuth", shapeless.send), /malformed answer/);

  // An error result with no usable message still throws something actionable.
  const mute = stub({ type: "server-response", rpcId: "x", result: { ok: false } }, { ok: false, status: 400 });
  await assert.rejects(() => fetchAuthView("agy", "agyAuth", mute.send), /settings agyAuth\/get: failed \(HTTP 400\)/);

  // A 200 whose value is not a usable view must not read as "no options".
  const empty = stub(answerWith({ ok: true, value: { methods: [] } }));
  await assert.rejects(() => fetchAuthView("agy", "agyAuth", empty.send), /no usable auth options/);
});

test("mintRpcId always produces a non-empty correlation id", () => {
  const id = mintRpcId();
  assert.equal(typeof id, "string");
  assert.ok(id.length >= 8, `unexpectedly short rpcId: ${id}`);
  assert.notEqual(mintRpcId(), id);
});

// ------------------------------------------------- the codex providers body

/** A minimal, parseable `codexProviders/*` answer. */
const PROVIDERS = {
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      protocol: "responses",
      models: [{ id: "deepseek-flash" }],
      authKind: "env",
      envName: "DEEPSEEK_API_KEY",
      hasKey: true,
    },
  ],
  native: { providerId: "deepseek", model: "deepseek-flash" },
  protocols: [{ value: "responses", label: "Responses API", available: true, hint: "h" }],
  paths: { store: "/s", config: "/c", auth: "/a", catalogs: "/k" },
};

test("the three providers envelopes are exactly what the /hub gateway decodes", async () => {
  const { calls, send } = stub(answerWith({ ok: true, value: PROVIDERS }));

  await fetchProvidersView("codex", "codexProviders", send);
  assert.deepEqual(calls[0].body, { ...calls[0].body, method: "codexProviders/get", payload: { args: {} } });
  assert.equal(calls[0].input, "/hub/api?agent=codex");

  const provider = { id: "openrouter", label: "OR", baseUrl: "https://openrouter.ai/api/v1", protocol: "responses", auth: { kind: "apiKey", value: "sk" }, models: [{ id: "glm-5.2" }] };
  await saveProvider("codex", "codexProviders", provider, send);
  assert.equal(calls[1].body.method, "codexProviders/save");
  assert.deepEqual(calls[1].body.payload, { args: { request: { provider } } }, "the adapter's own parameter name, nested");

  await removeProvider("codex", "codexProviders", "openrouter", send);
  assert.equal(calls[2].body.method, "codexProviders/remove");
  assert.deepEqual(calls[2].body.payload, { args: { request: { id: "openrouter" } } });

  assert.equal(calls.length, 3, "get / save / remove only — the select op is gone");
});

test("a providers call rejects an unusable answer instead of rendering an empty list", async () => {
  const shapeless = stub(answerWith({ ok: true, value: { providers: [] } }));
  await assert.rejects(() => fetchProvidersView("codex", "codexProviders", shapeless.send), /no usable provider list/);

  const mute = stub(answerWith({ ok: false }), { ok: false, status: 400 });
  await assert.rejects(
    () => saveProvider("codex", "codexProviders", { id: "x" }, mute.send),
    /settings codexProviders\/save: failed \(HTTP 400\)/,
  );
});
