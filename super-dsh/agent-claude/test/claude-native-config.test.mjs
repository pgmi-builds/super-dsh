// Reading the user's own `~/.claude/settings.json` env block as the provider
// source (2026-10-04).
//
// This is the sync's read-only half. Claude Code's settings env can name at
// most ONE endpoint (`ANTHROPIC_BASE_URL` + one key variable), so the read is
// a 0-or-1 table, and this suite pins the folds that matter:
//
//  - a base URL with NO key variable is the real "keyed outside Super D"
//    state (`apiKey` with an empty value), not a malformed entry;
//  - `ANTHROPIC_AUTH_TOKEN` (Bearer) outranks `ANTHROPIC_API_KEY` when the env
//    carries both, and an explicitly-empty key variable reads as unset — the
//    codex port's own behavior for an empty `env_key`;
//  - `models` is the DEDUPLICATED sequence of the three DEFAULT_*_MODEL alias
//    values and nothing else — `ANTHROPIC_MODEL` is readNativeModel's own
//    view, not a catalog entry the aliases never named;
//  - no base URL means no provider: the store's identity IS the endpoint.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { readNativeModel, readNativeProviders, resolveClaudeHome } =
  await import("../dist/claude-native-config.js");

/** A claude home with `settings.json` written (`undefined` = file absent, string = verbatim). */
function claudeHome(settings) {
  const home = mkdtempSync(join(tmpdir(), "superd-claude-native-config-"));
  if (settings !== undefined) {
    writeFileSync(
      join(home, "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  }
  return home;
}

// The measured live shape (spec §1, 2026-10-04): a DeepSeek endpoint keyed
// with `ANTHROPIC_API_KEY`, the sonnet/haiku aliases collapsed onto one model,
// and non-ANTHROPIC keys (one numeric) that must simply be ignored.
const LIVE = {
  permissions: { allow: ["Bash(ls:*)"] },
  model: "sonnet",
  env: {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_API_KEY: "sk-x",
    ANTHROPIC_MODEL: "deepseek-flash",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
  },
};

test("the live settings shape folds into exactly one table", () => {
  const tables = readNativeProviders(claudeHome(LIVE));
  assert.equal(tables.length, 1);

  const [table] = tables;
  assert.equal(table.baseUrl, "https://api.deepseek.com/anthropic");
  // The key VARIABLE names the auth shape: API_KEY is the x-api-key form.
  assert.deepEqual(table.auth, { kind: "apiKey", value: "sk-x" });
  assert.deepEqual(table.aliases, {
    sonnet: "deepseek-flash",
    opus: "deepseek-v4-pro",
    haiku: "deepseek-flash",
  });
  // The deduplicated alias VALUES, in sonnet/opus/haiku order — the two
  // aliases collapsed onto `deepseek-flash` yield two entries, not three.
  assert.deepEqual(table.models, [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }]);

  // ANTHROPIC_MODEL is its own read, and it is the env member — the top-level
  // `model: "sonnet"` sibling must not leak into it.
  assert.equal(readNativeModel(claudeHome(LIVE)), "deepseek-flash");
});

test("ANTHROPIC_AUTH_TOKEN outranks ANTHROPIC_API_KEY when both are carried", () => {
  const both = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "glmtok",
      ANTHROPIC_API_KEY: "sk-ignored",
    },
  });
  assert.deepEqual(readNativeProviders(both)[0].auth, { kind: "authToken", value: "glmtok" });

  const tokenOnly = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "glmtok",
    },
  });
  assert.deepEqual(readNativeProviders(tokenOnly)[0].auth, { kind: "authToken", value: "glmtok" });
});

test("a base URL with no key variable folds as the keyed-outside-Super-D state", () => {
  const home = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      API_TIMEOUT_MS: "3000000",
    },
  });
  // An EMPTY apiKey value is a real state: the provider works, the user holds
  // the key outside Super D, and the store may adopt a real key later.
  assert.deepEqual(readNativeProviders(home)[0].auth, { kind: "apiKey", value: "" });
});

test("an explicitly-empty key variable reads as unset, so the other one wins", () => {
  // Env semantics (the codex port treats an empty env_key the same way): an
  // empty string is not a credential, and discarding a real key for it would
  // lie about what the user's file actually says.
  const emptyToken = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-real",
    },
  });
  assert.deepEqual(readNativeProviders(emptyToken)[0].auth, { kind: "apiKey", value: "sk-real" });

  const emptyKey = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      ANTHROPIC_API_KEY: "  ",
    },
  });
  // Both unusable ⇒ the same keyed-outside fold as an absent variable.
  assert.deepEqual(readNativeProviders(emptyKey)[0].auth, { kind: "apiKey", value: "" });
});

test("no ANTHROPIC_BASE_URL means no provider, whatever else the env carries", () => {
  const noUrl = claudeHome({
    env: {
      ANTHROPIC_API_KEY: "sk-x",
      ANTHROPIC_MODEL: "deepseek-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash",
      API_TIMEOUT_MS: "3000000",
    },
  });
  assert.deepEqual(readNativeProviders(noUrl), []);
  // The model read is independent: a native setup on the default Anthropic
  // endpoint has no BASE_URL but a perfectly meaningful ANTHROPIC_MODEL.
  assert.equal(readNativeModel(noUrl), "deepseek-flash");

  const blankUrl = claudeHome({ env: { ANTHROPIC_BASE_URL: "   ", ANTHROPIC_API_KEY: "sk-x" } });
  assert.deepEqual(readNativeProviders(blankUrl), []);
});

test("fail-soft: a missing settings.json, corrupt JSON, or a missing env block all read as empty", () => {
  assert.deepEqual(readNativeProviders(claudeHome(undefined)), []);
  assert.equal(readNativeModel(claudeHome(undefined)), undefined);

  assert.deepEqual(readNativeProviders(claudeHome("{ this is not json")), []);
  assert.equal(readNativeModel(claudeHome("{ this is not json")), undefined);

  // A settings file without an env block (or with an unusable one) declares
  // nothing either.
  assert.deepEqual(readNativeProviders(claudeHome({ permissions: { allow: [] } })), []);
  assert.deepEqual(readNativeProviders(claudeHome({ env: "nope" })), []);
  assert.deepEqual(readNativeProviders(claudeHome({ env: ["nope"] })), []);
});

test("non-string env values coerce to their string forms; unusable shapes are skipped", () => {
  // A hand-edited file may carry numbers or booleans; everything downstream
  // of an env block is a string (process-env semantics), so the reader takes
  // the value as the process would see it rather than dropping the provider.
  const coerced = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://coerce.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: 987654321,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
    },
  });
  const [table] = readNativeProviders(coerced);
  assert.deepEqual(table.auth, { kind: "authToken", value: "987654321" });
  assert.deepEqual(table.models, [{ id: "glm-5.3" }]);

  // Objects/arrays/null have no string form worth honoring — the variable is
  // skipped, and with no usable key variable left the fold is keyed-outside.
  const unusable = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://coerce.example/anthropic",
      ANTHROPIC_API_KEY: { secret: "no" },
      ANTHROPIC_AUTH_TOKEN: null,
    },
  });
  assert.deepEqual(readNativeProviders(unusable)[0].auth, { kind: "apiKey", value: "" });
});

test("no aliases means an empty model list and no aliases field; partial aliases land alone", () => {
  const bare = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://bare.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_MODEL: "named-but-not-an-alias",
    },
  });
  const [table] = readNativeProviders(bare);
  // ANTHROPIC_MODEL is deliberately NOT a model entry (ledgered ruling): the
  // aliases are the only model source the env reveals.
  assert.deepEqual(table.models, []);
  assert.equal(table.aliases, undefined);

  const partial = claudeHome({
    env: {
      ANTHROPIC_BASE_URL: "https://partial.example/anthropic",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7-air",
    },
  });
  const [one] = readNativeProviders(partial);
  assert.deepEqual(one.aliases, { haiku: "glm-4.7-air" });
  assert.deepEqual(one.models, [{ id: "glm-4.7-air" }]);
});

test("resolveClaudeHome is the claude-home module's own function, re-exported", async () => {
  // Non-duplicating option: one resolver, two faces. The behavior itself is
  // pinned by claude-home.test.mjs; this only pins the identity.
  const { resolveClaudeHome: original } = await import("../dist/claude-home.js");
  assert.equal(resolveClaudeHome, original);
});
