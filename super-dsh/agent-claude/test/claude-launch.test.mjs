// claude-launch: provider → SDK `Options` slice (2026-10-04 multi-provider rework).
//
// A session's provider reaches the CLI child through exactly ONE channel: the
// child's environment (`Options.env`). `claudeLaunchFor` therefore has no I/O
// and no Context — it turns (route, provider entry, resolved binary) into the
// slice Task 9 merges into the SDK options, and this suite pins every key it
// may and may NOT emit. The "may not" half is the dangerous half: an alias key
// emitted for an undeclared alias would silently point the child at a model
// the user never chose, and a path key emitted for an unresolved binary would
// point it at a file that does not exist.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { NATIVE_LAUNCH, claudeLaunchFor } = await import("../dist/claude-launch.js");

/**
 * A GLM/Z.AI entry in the shape the native fold-in produces (spec §1/§2.2):
 * Bearer auth, three aliases, one curated model.
 */
function glmEntry(overrides = {}) {
  return {
    id: "glm",
    label: "GLM (Z.AI)",
    baseUrl: "https://api.z.ai/api/anthropic",
    auth: { kind: "authToken", value: "zai-secret" },
    models: [{ id: "glm-5.2" }],
    aliases: { sonnet: "glm-4.6", opus: "glm-4.6", haiku: "glm-4.5-air" },
    origin: "user",
    ...overrides,
  };
}

test("authToken entry + declared aliases + host binary: the exact slice", () => {
  const spec = claudeLaunchFor({ provider: "glm", model: "glm-5.2" }, glmEntry(), "/usr/bin/claude");

  // One deepEqual is deliberate: it pins the env key SET as well as the values,
  // so an accidental extra key (an empty alias, a stray BASE_URL variant) fails.
  assert.deepEqual(spec, {
    providerId: "glm",
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "zai-secret",
      ANTHROPIC_MODEL: "glm-5.2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
    },
    model: "glm-5.2",
    pathToClaudeCodeExecutable: "/usr/bin/claude",
  });
});

test("apiKey kind authenticates through ANTHROPIC_API_KEY, never the token variable", () => {
  const spec = claudeLaunchFor(
    { provider: "deepseek", model: "deepseek-flash" },
    glmEntry({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      auth: { kind: "apiKey", value: "sk-deepseek" },
    }),
  );

  assert.equal(spec.env.ANTHROPIC_API_KEY, "sk-deepseek");
  assert.equal("ANTHROPIC_AUTH_TOKEN" in spec.env, false);
  assert.equal(spec.providerId, "deepseek");
});

test("an entry that declares no aliases emits no ANTHROPIC_DEFAULT_* key at all", () => {
  const spec = claudeLaunchFor({ provider: "glm", model: "glm-5.2" }, glmEntry({ aliases: undefined }));

  assert.deepEqual(spec.env, {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "zai-secret",
    ANTHROPIC_MODEL: "glm-5.2",
  });
  assert.equal(
    Object.keys(spec.env).some((key) => key.startsWith("ANTHROPIC_DEFAULT_")),
    false,
  );
});

test("only the aliases the entry actually declares are emitted", () => {
  const spec = claudeLaunchFor(
    { provider: "glm", model: "glm-5.2" },
    glmEntry({ aliases: { haiku: "glm-4.5-air" } }),
  );

  assert.equal(spec.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-4.5-air");
  assert.equal("ANTHROPIC_DEFAULT_SONNET_MODEL" in spec.env, false);
  assert.equal("ANTHROPIC_DEFAULT_OPUS_MODEL" in spec.env, false);
});

test("an empty alias value is not a declaration (no empty-string key)", () => {
  const spec = claudeLaunchFor(
    { provider: "glm", model: "glm-5.2" },
    glmEntry({ aliases: { sonnet: "", opus: "glm-4.6" } }),
  );

  assert.equal("ANTHROPIC_DEFAULT_SONNET_MODEL" in spec.env, false);
  assert.equal(spec.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-4.6");
});

test("an empty auth value still emits its kind's variable (the runtime trims it to unset)", () => {
  // The entry's auth KIND names the channel, so the variable is always present;
  // a provider we hold no copy of rides as "". The CLI reads these names with
  // `.trim() || undefined` (measured in @anthropic-ai/claude-agent-sdk
  // 2.1.263), so an empty value is unset rather than a fabricated secret.
  const spec = claudeLaunchFor(
    { provider: "native-ish", model: "glm-5.2" },
    glmEntry({ id: "native-ish", auth: { kind: "authToken", value: "" } }),
  );

  assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal("ANTHROPIC_API_KEY" in spec.env, false);
});

test("no host binary resolved: the path key is absent, not undefined", () => {
  const spec = claudeLaunchFor({ provider: "glm", model: "glm-5.2" }, glmEntry());

  // `in` rather than a value check: a present-but-undefined key would still
  // travel through a spread into Options and shadow a caller default.
  assert.equal("pathToClaudeCodeExecutable" in spec, false);
  assert.deepEqual(Object.keys(spec).sort(), ["env", "model", "providerId"]);
});

test("an empty host binary is treated as unresolved", () => {
  const spec = claudeLaunchFor({ provider: "glm", model: "glm-5.2" }, glmEntry(), "");

  assert.equal("pathToClaudeCodeExecutable" in spec, false);
});

test("the raw route model is the wire model; the composite selector id never leaks", () => {
  const spec = claudeLaunchFor({ provider: "glm", model: "glm-5.2" }, glmEntry());

  assert.equal(spec.model, "glm-5.2");
  assert.equal(spec.env.ANTHROPIC_MODEL, "glm-5.2");
  // The selector speaks `glm/glm-5.2`; the wire must not.
  assert.equal(JSON.stringify(spec).includes("glm/glm-5.2"), false);
});

test("NATIVE_LAUNCH is the zero-injection slice (providerId null, no model, no path)", () => {
  assert.deepEqual(NATIVE_LAUNCH, { providerId: null, env: {} });
  assert.equal("model" in NATIVE_LAUNCH, false);
  assert.equal("pathToClaudeCodeExecutable" in NATIVE_LAUNCH, false);
});

test("the slice is computed from the entry alone — ambient process.env is never read", () => {
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "https://ambient.example/anthropic";
  try {
    const spec = claudeLaunchFor({ provider: "glm", model: "glm-5.2" }, glmEntry());
    assert.equal(spec.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  }
});

test("the built module is pure: the type-only imports leave no runtime import behind", () => {
  // The type imports from claude-providers.ts / claude-route.ts are erased by
  // tsc, so the artifact must carry no import/require at all — that is what
  // makes this slice safe to unit-test without a Context, a home or a child.
  const source = readFileSync(new URL("../dist/claude-launch.js", import.meta.url), "utf8");

  assert.equal(/^\s*import[\s{"'*]/m.test(source), false, "an import statement survived into dist");
  assert.equal(/\brequire\s*\(/.test(source), false, "a require() survived into dist");
  assert.equal(/node:(fs|child_process)/.test(source), false, "an I/O module survived into dist");
});
