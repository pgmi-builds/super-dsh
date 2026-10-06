// The two parts of `codex-native-config.ts` that survived the 2026-10-04
// on-the-fly rework:
//
//   - `mergeModelCatalog` still builds the per-provider catalog a child is given
//     through `-c model_catalog_json`. Its hard-won property is that the list
//     REPLACES rather than accumulates (the reported bug: three providers
//     configured in sequence left all three models in the selector), while each
//     entry is still CLONED from a real catalog entry — codex 0.154 validates a
//     deep field set (`shell_type`, `priority`, `truncation_policy.…`) that only
//     a real entry carries, so a synthesized one is refused at config load.
//
//   - `readNativeSelection` reports what the user's own file puts in force. It is
//     a passive read now (the panel's "your own codex runs this" line and the
//     app-wide default model); nothing writes that file any more.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { mergeModelCatalog, readNativeSelection } = await import("../dist/codex-native-config.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "superd-codex-native-"));
}

/** A config shaped like a real user's: comments, projects, a foreign provider. */
const SAMPLE = `# my codex config — hand-edited
model_provider = "zai-plan"
model = "glm-5.2"
approval_policy = "on-request"

[model_providers]

[model_providers.zai-plan]
name = "Z.ai Plan"
base_url = "https://api.z.ai/api/coding/paas/v4"
wire_api = "responses"
requires_openai_auth = true
model = "not-the-top-level-one"

[projects."/home/u1/workspaces/superd"]
trust_level = "trusted"

# trailing comment
[projects."/tmp/x"]
trust_level = "trusted"
`;

const TEMPLATE = { slug: "old-model", display_name: "Old Model", priority: 10, base_instructions: "you are codex", shell_type: "default" };

test("mergeModelCatalog clones the template and overrides model identity and context window", () => {
  const out = JSON.parse(mergeModelCatalog(undefined, JSON.stringify({ models: [TEMPLATE] }), [
    { id: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 },
  ]));
  // ONLY the models we asked for are emitted — the absorbed catalog was a
  // template source, not a survivor.
  assert.deepEqual(out.models.map((model) => model.slug), ["glm-5.2"]);
  const mine = out.models[0];
  assert.equal(mine.display_name, "GLM-5.2");
  assert.equal(mine.context_window, 1000000);
  assert.equal(mine.max_context_window, 1000000);
  // The ~35 keys we do not understand come from the template, untouched.
  assert.equal(mine.base_instructions, "you are codex");
  assert.equal(mine.shell_type, "default");
  assert.equal(mine.priority, 10);
});

test("third-party models do not inherit OpenAI compaction compatibility", () => {
  const nativeTemplate = {
    ...TEMPLATE,
    slug: "gpt-6.1-sol",
    comp_hash: "3000",
    context_window: 272000,
    auto_compact_token_limit: 240000,
    effective_context_window_percent: 95,
    future_metadata: { enabled: true },
  };
  const out = JSON.parse(mergeModelCatalog(undefined, undefined, [
    { id: "deepseek-flash", contextWindow: 1000000 },
  ], nativeTemplate));
  const model = out.models[0];
  assert.equal(Object.hasOwn(model, "comp_hash"), false,
    "an OpenAI compatibility hash cannot describe an unrelated provider model");
  assert.equal(model.context_window, 1000000);
  assert.equal(model.max_context_window, 1000000);
  assert.equal(model.auto_compact_token_limit, 240000,
    "the explicit automatic compaction threshold still applies");
  assert.equal(model.effective_context_window_percent, 95);
  assert.deepEqual(model.future_metadata, { enabled: true });
  assert.equal(nativeTemplate.comp_hash, "3000", "native template remains unchanged");
});

test("regenerating a third-party catalog removes stale inherited compaction hashes", () => {
  const existing = JSON.stringify({ models: [{
    ...TEMPLATE,
    slug: "deepseek-flash",
    comp_hash: "2911",
    auto_compact_token_limit: 900000,
  }] });
  const model = JSON.parse(mergeModelCatalog(existing, undefined, [
    { id: "deepseek-flash" },
  ])).models[0];
  assert.equal(Object.hasOwn(model, "comp_hash"), false,
    "previously generated entries must not preserve the false compatibility claim");
  assert.equal(model.auto_compact_token_limit, 900000);
  assert.equal(model.base_instructions, "you are codex");
});

test("mergeModelCatalog reuses an existing entry for the same slug as its own template", () => {
  const existing = JSON.stringify({ models: [{ slug: "glm-5.2", display_name: "old label", base_instructions: "kept", priority: 5 }] });
  const out = JSON.parse(mergeModelCatalog(existing, undefined, [{ id: "glm-5.2", displayName: "GLM-5.2" }]));
  assert.equal(out.models.length, 1, "one entry per requested model, no strays");
  assert.equal(out.models[0].display_name, "GLM-5.2");
  assert.equal(out.models[0].base_instructions, "kept", "the existing entry wins as its own template");
});

// The bug as reported from use (2026-10-03): three providers configured in
// sequence left all three models in the model selector.
test("a catalog REPLACES its list and never accumulates a previous provider's models", () => {
  const ccSwitch = JSON.stringify({ models: [TEMPLATE, { slug: "deepseek-flash", display_name: "DeepSeek Flash", base_instructions: "t", priority: 2 }] });

  let ours = mergeModelCatalog(undefined, ccSwitch, [{ id: "glm-5.2", displayName: "GLM-5.2" }]);
  assert.deepEqual(JSON.parse(ours).models.map((model) => model.slug), ["glm-5.2"]);

  ours = mergeModelCatalog(ours, ccSwitch, [{ id: "deepseek-flash", displayName: "DeepSeek Flash" }]);
  assert.deepEqual(JSON.parse(ours).models.map((model) => model.slug), ["deepseek-flash"], "GLM must not linger");
  assert.equal(JSON.parse(ours).models[0].base_instructions, "t", "and it is still cloned, not synthesized");

  ours = mergeModelCatalog(ours, undefined, [
    { id: "glm-5.3-flash", displayName: "GLM-5.3 Flash" },
    { id: "glm-4.7", displayName: "GLM-4.7" },
  ]);
  assert.deepEqual(JSON.parse(ours).models.map((model) => model.slug), ["glm-5.3-flash", "glm-4.7"]);

  // Re-materializing the same provider is idempotent and duplicates collapse.
  const again = mergeModelCatalog(ours, undefined, [
    { id: "glm-5.3-flash" },
    { id: "glm-5.3-flash" },
    { id: "glm-4.7" },
  ]);
  assert.deepEqual(JSON.parse(again).models.map((model) => model.slug), ["glm-5.3-flash", "glm-4.7"]);
});

test("mergeModelCatalog tolerates garbage on either side", () => {
  const out = JSON.parse(mergeModelCatalog("{ not json", "also not json", [{ id: "m", displayName: "M" }]));
  assert.deepEqual(out.models.map((model) => model.slug), ["m"]);
  // No template anywhere: the entry is still written, just without the unknown keys.
  assert.equal(out.models[0].display_name, "M");
});

test("readNativeSelection reports what the user's own config actually puts in force", () => {
  const home = tempHome();
  assert.deepEqual(readNativeSelection(home), {});
  writeFileSync(join(home, "config.toml"), SAMPLE);
  assert.deepEqual(readNativeSelection(home), {
    providerId: "zai-plan",
    model: "glm-5.2",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    protocol: "responses",
    auth: { kind: "apiKey" },
  });
});

test("readNativeSelection does not mistake a provider-nested model for the top-level one", () => {
  const home = tempHome();
  writeFileSync(join(home, "config.toml"), SAMPLE);
  // The sample's [model_providers.zai-plan] carries `model = "not-the-top-level-one"`;
  // the in-force model is the top-level key, and only that one.
  assert.equal(readNativeSelection(home).model, "glm-5.2");
});

test('third-party models do not inherit an OpenAI-only tool wire mode', () => {
  const template = { ...TEMPLATE, tool_mode: 'code_mode_only' };
  const stale = JSON.stringify({models:[{slug:'deepseek-flash',tool_mode:'code_mode_only'}]});
  const model = JSON.parse(mergeModelCatalog(stale, undefined, [{id:'deepseek-flash'}], template)).models[0];
  assert.equal(Object.hasOwn(model, 'tool_mode'), false);
  assert.equal(template.tool_mode, 'code_mode_only');
});
