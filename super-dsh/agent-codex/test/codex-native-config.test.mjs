// src/codex-native-config.ts — the write side of the Hub multi-provider panel:
// the ACT of switching a provider, expressed as three file mutations in the
// foreign runtime's own home.
//
// The pure string→string functions are the whole test surface; the fs layer is
// deliberately thin. What is pinned here:
//   - the TOML surgery touches ONLY the four regions we own and preserves every
//     other byte (the user's [projects.*] trust_level entries and comments are
//     real data that cc-switch's wholesale rewrite destroys);
//   - a `model` key nested inside [model_providers.x] is not mistaken for the
//     top-level `model`;
//   - re-applying is idempotent and switching leaves the previous provider's
//     table intact;
//   - auth.json is MERGED, never rebuilt — a ChatGPT login must survive — and an
//     unreadable auth.json is refused rather than clobbered;
//   - the model catalog absorbs whatever the current `model_catalog_json` names
//     and clones a template for new entries (D5, measured in Task 2).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
  SUPERD_CATALOG_FILE,
  applyProviderToConfigToml,
  mergeAuthJson,
  mergeModelCatalog,
  readNativeSelection,
  writeNativeSelection,
} = await import("../dist/codex-native-config.js");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "superd-codex-native-"));
}

function provider(overrides = {}) {
  return {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "responses",
    auth: { kind: "env", name: "DEEPSEEK_API_KEY" },
    models: [{ id: "deepseek-flash", displayName: "DeepSeek Flash", contextWindow: 1048576 }],
    ...overrides,
  };
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

// ---------------------------------------------------------------- TOML surgery

test("empty text grows a complete config", () => {
  const out = applyProviderToConfigToml("", { provider: provider(), model: "deepseek-flash" });
  assert.match(out, /^model_provider = "deepseek"$/m);
  assert.match(out, /^model = "deepseek-flash"$/m);
  assert.match(out, /^model_catalog_json = "superd-model-catalog.json"$/m);
  assert.match(out, /^\[model_providers\.deepseek\]$/m);
  assert.match(out, /^name = "DeepSeek"$/m);
  assert.match(out, /^base_url = "https:\/\/api\.deepseek\.com\/v1"$/m);
  assert.match(out, /^wire_api = "responses"$/m);
  assert.match(out, /^env_key = "DEEPSEEK_API_KEY"$/m);
});

test("only the four owned regions move; every other byte survives", () => {
  const out = applyProviderToConfigToml(SAMPLE, { provider: provider(), model: "deepseek-flash" });

  // the untouched regions, verbatim
  assert.ok(out.includes("# my codex config — hand-edited\n"), "leading comment kept");
  assert.ok(out.includes(`[projects."/home/u1/workspaces/superd"]\ntrust_level = "trusted"\n`), "projects kept");
  assert.ok(out.includes("# trailing comment\n[projects.\"/tmp/x\"]\ntrust_level = \"trusted\"\n"), "trailing block kept");
  assert.ok(out.includes("approval_policy = \"on-request\"\n"), "unrelated top-level key kept");
  assert.ok(out.includes("[model_providers.zai-plan]"), "the other provider's table is not ours to delete");
  assert.ok(out.includes('model = "not-the-top-level-one"'), "a nested model key is data, not config");
  assert.ok(out.includes("[model_providers]\n"), "the bare table header stays");

  // the owned regions
  assert.match(out, /^model_provider = "deepseek"$/m);
  assert.match(out, /^model = "deepseek-flash"$/m);
  assert.equal([...out.matchAll(/^model = /gm)].length, 2, "top-level model + the nested one");
  assert.ok(!/^model_provider = "zai-plan"$/m.test(out));
});

test("the top-level keys stay above the first table header", () => {
  const out = applyProviderToConfigToml(SAMPLE, { provider: provider(), model: "deepseek-flash" });
  const lines = out.split("\n");
  const lastOwned = Math.max(
    lines.findIndex((l) => l.startsWith("model_provider = ")),
    lines.findIndex((l) => l.startsWith("model = ")),
    lines.findIndex((l) => l.startsWith("model_catalog_json = ")),
  );
  const firstHeader = lines.findIndex((l) => l.startsWith("["));
  assert.ok(lastOwned < firstHeader, `owned keys (${lastOwned}) must precede the first header (${firstHeader})`);
});

test("re-applying the same provider is idempotent", () => {
  const once = applyProviderToConfigToml(SAMPLE, { provider: provider(), model: "deepseek-flash" });
  const twice = applyProviderToConfigToml(once, { provider: provider(), model: "deepseek-flash" });
  assert.equal(twice, once);
  assert.equal([...once.matchAll(/^\[model_providers\.deepseek\]$/gm)].length, 1);
});

test("switching to a second provider keeps the first provider's table", () => {
  const first = applyProviderToConfigToml(SAMPLE, { provider: provider(), model: "deepseek-flash" });
  const second = applyProviderToConfigToml(first, {
    provider: provider({ id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: { kind: "apiKey", value: "sk-or" } }),
    model: "glm-5.2",
  });
  assert.match(second, /^model_provider = "openrouter"$/m);
  assert.match(second, /^model = "glm-5\.2"$/m);
  assert.match(second, /^\[model_providers\.deepseek\]$/m);
  assert.match(second, /^\[model_providers\.openrouter\]$/m);
  assert.ok(second.includes("[model_providers.zai-plan]"), "a provider we did not select is left alone");
  // and the switch is reversible: going back flips the two owned keys and
  // leaves every provider table (ours and theirs) in place.
  const back = applyProviderToConfigToml(second, { provider: provider(), model: "deepseek-flash" });
  assert.match(back, /^model_provider = "deepseek"$/m);
  assert.match(back, /^model = "deepseek-flash"$/m);
  assert.ok(back.includes("[model_providers.openrouter]") && back.includes("[model_providers.zai-plan]"));
});

test("apiKey auth emits requires_openai_auth and no env_key; env auth the reverse", () => {
  const keyed = applyProviderToConfigToml("", {
    provider: provider({ auth: { kind: "apiKey", value: "sk-secret" } }),
    model: "deepseek-flash",
  });
  assert.match(keyed, /^requires_openai_auth = true$/m);
  assert.ok(!keyed.includes("env_key"), "an apiKey provider must not also name an env var");
  assert.ok(!keyed.includes("sk-secret"), "the key is materialized into auth.json, never into config.toml");

  const env = applyProviderToConfigToml("", { provider: provider(), model: "deepseek-flash" });
  assert.match(env, /^env_key = "DEEPSEEK_API_KEY"$/m);
  assert.ok(!env.includes("requires_openai_auth"));
});

// ---------------------------------------------------------------- auth.json

test("mergeAuthJson keeps the ChatGPT login and sets the provider key", () => {
  const existing = JSON.stringify({ OPENAI_API_KEY: "old", tokens: { access_token: "chatgpt" }, last_refresh: "2026-01-01" });
  const merged = JSON.parse(mergeAuthJson(existing, "sk-new"));
  assert.equal(merged.OPENAI_API_KEY, "sk-new");
  assert.deepEqual(merged.tokens, { access_token: "chatgpt" });
  assert.equal(merged.last_refresh, "2026-01-01");
});

test("mergeAuthJson starts from empty only when there is no file to preserve", () => {
  assert.deepEqual(JSON.parse(mergeAuthJson(undefined, "sk-new")), { OPENAI_API_KEY: "sk-new" });
  assert.deepEqual(JSON.parse(mergeAuthJson("", "sk-new")), { OPENAI_API_KEY: "sk-new" });
});

test("mergeAuthJson REFUSES an unreadable auth.json instead of clobbering credentials", () => {
  assert.throws(() => mergeAuthJson("{ this is not json", "sk-new"), /auth\.json/);
});

// ---------------------------------------------------------------- catalog

const TEMPLATE = { slug: "old-model", display_name: "Old Model", priority: 10, base_instructions: "you are codex", shell_type: "default" };

test("mergeModelCatalog clones the template and overrides identity fields only", () => {
  const out = JSON.parse(mergeModelCatalog(undefined, JSON.stringify({ models: [TEMPLATE] }), [
    { id: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 },
  ]));
  const slugs = out.models.map((m) => m.slug);
  assert.deepEqual(slugs, ["old-model", "glm-5.2"], "the absorbed entry stays, ours is appended");
  const mine = out.models[1];
  assert.equal(mine.display_name, "GLM-5.2");
  assert.equal(mine.context_window, 1000000);
  assert.equal(mine.max_context_window, 1000000);
  // the 35 keys we do not understand come from the template, untouched
  assert.equal(mine.base_instructions, "you are codex");
  assert.equal(mine.shell_type, "default");
  assert.equal(mine.priority, 10);
});

test("mergeModelCatalog re-selects an existing model in place and never drops a foreign entry", () => {
  const existing = JSON.stringify({ models: [{ slug: "glm-5.2", display_name: "old label", base_instructions: "kept", priority: 5 }] });
  const out = JSON.parse(mergeModelCatalog(existing, undefined, [{ id: "glm-5.2", displayName: "GLM-5.2" }]));
  assert.equal(out.models.length, 1, "upsert by slug, not append");
  assert.equal(out.models[0].display_name, "GLM-5.2");
  assert.equal(out.models[0].base_instructions, "kept", "existing entry wins as its own template");
});

test("mergeModelCatalog tolerates garbage on either side", () => {
  const out = JSON.parse(mergeModelCatalog("{ not json", "also not json", [{ id: "m", displayName: "M" }]));
  assert.deepEqual(out.models.map((m) => m.slug), ["m"]);
  // no template anywhere: the entry is still written, just without the 35 unknown keys
  assert.equal(out.models[0].display_name, "M");
});

// ---------------------------------------------------------------- fs layer

test("readNativeSelection reports what is actually in force", () => {
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

test("writeNativeSelection writes three files, backs each up once, and is read back", () => {
  const home = tempHome();
  assert.deepEqual(writeNativeSelection(home, { provider: provider({ auth: { kind: "apiKey", value: "sk-secret" } }), model: "deepseek-flash" }, { stamp: 12345 }).written,
    [join(home, "config.toml"), join(home, "auth.json"), join(home, SUPERD_CATALOG_FILE)]);

  // A backup is of the USER's file, so it happens only where one already
  // existed — and at most once per target per run (the stamp), so a long-lived
  // world rewriting config.toml every switch does not pile up snapshots.
  const backups = readdirSync(home).filter((f) => f.includes("superd-bak-12345"));
  assert.deepEqual(backups, [], "nothing pre-existed, so there was nothing to preserve");
  writeNativeSelection(home, { provider: provider(), model: "glm-5.2" }, { stamp: 999 });
  const later = readdirSync(home).filter((f) => f.includes("superd-bak-999")).sort();
  assert.deepEqual(later, ["auth.json.superd-bak-999", "config.toml.superd-bak-999", "superd-model-catalog.json.superd-bak-999"]);
  // and the backup really is the pre-write content
  assert.equal(readNativeSelection(home).model, "glm-5.2");
  assert.equal(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).OPENAI_API_KEY, "sk-secret", "an env provider leaves auth.json alone");
  assert.deepEqual(readNativeSelection(home), { providerId: "deepseek", model: "glm-5.2", baseUrl: "https://api.deepseek.com/v1", protocol: "responses", auth: { kind: "env", name: "DEEPSEEK_API_KEY" } });
});

test("writeNativeSelection absorbs the catalog currently named by model_catalog_json", () => {
  const home = tempHome();
  writeFileSync(join(home, "config.toml"), 'model_catalog_json = "cc-switch-model-catalog.json"\n');
  writeFileSync(join(home, "cc-switch-model-catalog.json"), JSON.stringify({ models: [TEMPLATE] }));

  writeNativeSelection(home, {
    provider: provider({ models: [{ id: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1000000 }] }),
    model: "glm-5.2",
  }, { stamp: 1 });
  const ours = JSON.parse(readFileSync(join(home, SUPERD_CATALOG_FILE), "utf8"));
  assert.deepEqual(ours.models.map((m) => m.slug), ["old-model", "glm-5.2"]);
  assert.equal(ours.models[1].base_instructions, "you are codex", "the foreign catalog supplied the template");
});

test("writeNativeSelection keeps the previous provider usable and its own file intact", () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), SAMPLE);
  writeNativeSelection(home, { provider: provider(), model: "deepseek-flash" }, { stamp: 7 });
  const first = readFileSync(join(home, "config.toml"), "utf8");
  assert.ok(first.includes("[model_providers.zai-plan]"));
  writeNativeSelection(home, { provider: provider({ id: "openrouter", label: "OR", baseUrl: "https://openrouter.ai/api/v1" }), model: "glm-5.2" }, { stamp: 7 });
  const second = readFileSync(join(home, "config.toml"), "utf8");
  assert.ok(second.includes("[model_providers.zai-plan]") && second.includes("[model_providers.deepseek]") && second.includes("[model_providers.openrouter]"));
  assert.equal(readNativeSelection(home).providerId, "openrouter");
});
