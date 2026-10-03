// The route a session starts from must be ONE coherent pair (2026-10-04).
//
// Two ways to get this wrong, both of which produce a session that runs a model
// its provider does not serve — the kind of thing no unit test caught, and which
// only showed up as `lastUsed = zhipu-cn/deepseek-flash` in a live session's
// projection:
//
//  1. building the pair from two independent sources (the native provider id and
//     the deployment default model);
//  2. honouring a cached deployment default whose model the provider no longer
//     serves, because the panel removed it since — upstream persists the last
//     pick as the world default, so this is reachable without anyone asking.
//
// `sessionAgentOptions` is the factory's reconciliation and `seedRoute` is the
// one-object entry point, so both are pinned here. There is no live Agent or
// client in this suite: the whole decision is a pair of file reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";

const { CodexProvider } = await import("../dist/index.js");
const { seedRoute, resolveRoute } = await import("../dist/codex-route.js");
const { writeProviderStore } = await import("../dist/codex-providers.js");

const ZHIPU = {
  id: "zhipu-cn",
  label: "zhipu-cn",
  baseUrl: "https://open.bigmodel.cn/api/v1",
  protocol: "responses",
  auth: { kind: "env", name: "ZHIPU_API_KEY" },
  models: [{ id: "glm-5.3-flash" }, { id: "glm-4.7" }],
};
const DEEPSEEK = {
  id: "deepseek",
  label: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  protocol: "responses",
  auth: { kind: "env", name: "DEEPSEEK_API_KEY" },
  models: [{ id: "deepseek-flash" }],
};

const CATALOG = { models: [{ slug: "glm-5.3-flash" }, { slug: "glm-4.7" }] };

/** A native home where `zhipu-cn/glm-5.3-flash` is in force, plus a world home holding our list. */
function fixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "superd-codex-session-native-"));
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "models.json"), JSON.stringify(CATALOG));
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_provider = "zhipu-cn"
model = "glm-5.3-flash"
model_catalog_json = "models.json"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"

[model_providers.zhipu-cn]
name = "zhipu-cn"
base_url = "https://open.bigmodel.cn/api/v1"
wire_api = "responses"
env_key = "ZHIPU_API_KEY"
`,
  );
  const worldHome = mkdtempSync(join(tmpdir(), "superd-codex-session-world-"));
  writeProviderStore(worldHome, { version: 1, providers: [DEEPSEEK, ZHIPU] });

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  const ctx = new Context();
  ctx.provide("dshHomePath", worldHome);
  ctx.provide("agents", { setFactory() { } });
  const provider = new CodexProvider(ctx);

  return {
    provider,
    worldHome,
    codexHome,
    restore() {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    },
  };
}

test("with no request the factory starts from the pair the user's own config.toml runs", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.provider.sessionAgentOptions(undefined), {
      provider: "zhipu-cn",
      model: "glm-5.3-flash",
    });
  } finally {
    f.restore();
  }
});

test("a request the provider actually serves is honoured", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.provider.sessionAgentOptions({ provider: "deepseek", model: "deepseek-flash" }), {
      provider: "deepseek",
      model: "deepseek-flash",
    });
    assert.deepEqual(f.provider.sessionAgentOptions({ provider: "zhipu-cn", model: "glm-4.7" }), {
      provider: "zhipu-cn",
      model: "glm-4.7",
    });
  } finally {
    f.restore();
  }
});

test("a cached default naming a model its provider no longer serves is rejected, not honoured", () => {
  // The reachable path: the user picks `deepseek/glm-4.7` some other way, or
  // edits deepseek's model list in the panel afterwards. Upstream still holds the
  // old pick as the world default, so a NEW session would otherwise be seeded
  // with a route nobody can run.
  const f = fixture();
  try {
    assert.deepEqual(f.provider.sessionAgentOptions({ provider: "deepseek", model: "glm-4.7" }), {
      provider: "zhipu-cn",
      model: "glm-5.3-flash",
    });
  } finally {
    f.restore();
  }
});

test("a cached default naming a model from a DIFFERENT provider is rejected too", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.provider.sessionAgentOptions({ provider: "deepseek", model: "glm-5.3-flash" }), {
      provider: "zhipu-cn",
      model: "glm-5.3-flash",
    });
  } finally {
    f.restore();
  }
});

test("the retired single `codex` route resolves to the native pair", () => {
  // Sessions created before the multi-provider rework carry this id. It names no
  // store entry, so the user's own config.toml is the only honest answer.
  const f = fixture();
  try {
    assert.deepEqual(f.provider.sessionAgentOptions({ provider: "codex", model: "glm-5.3-flash" }), {
      provider: "zhipu-cn",
      model: "glm-5.3-flash",
    });
  } finally {
    f.restore();
  }
});

test("whatever the factory emits, the seeded provider serves the seeded model", () => {
  // The property, stated as a property: this is what `zhipu-cn/deepseek-flash`
  // violated, and the reason `seedRoute` takes ONE object rather than a provider
  // and a model that a caller can source separately.
  const f = fixture();
  try {
    const requests = [
      undefined,
      { provider: "deepseek", model: "deepseek-flash" },
      { provider: "deepseek", model: "glm-4.7" },
      { provider: "deepseek", model: "glm-5.3-flash" },
      { provider: "zhipu-cn", model: "glm-4.7" },
      { provider: "codex", model: "glm-5.3-flash" },
      { provider: "no-such-provider", model: "whatever" },
    ];
    for (const request of requests) {
      const options = f.provider.sessionAgentOptions(request);
      const seed = seedRoute(options);
      assert.ok(seed !== undefined, `a seed must exist for ${JSON.stringify(request)}`);
      const entry = [DEEPSEEK, ZHIPU].find((candidate) => candidate.id === seed.provider);
      assert.ok(entry !== undefined, `seed names a provider we know: ${seed.provider}`);
      assert.ok(
        entry.models.some((model) => model.id === seed.model),
        `${seed.provider} must serve ${seed.model} (from ${JSON.stringify(request)})`,
      );
    }
  } finally {
    f.restore();
  }
});

test("seedRoute refuses a half pair, so an incomplete default seeds nothing", () => {
  assert.deepEqual(seedRoute({ provider: "zhipu-cn", model: "glm-5.3-flash" }), {
    provider: "zhipu-cn",
    model: "glm-5.3-flash",
  });
  assert.equal(seedRoute({ provider: "zhipu-cn" }), undefined);
  assert.equal(seedRoute({ model: "glm-5.3-flash" }), undefined);
  assert.equal(seedRoute({ provider: "", model: "glm-5.3-flash" }), undefined);
  assert.equal(seedRoute({}), undefined);
});

test("a session with its own logged selection is not re-seeded from the default", () => {
  // `#resolveRoute` prefers what the session already ran over the deployment
  // default, which is what keeps a resumed session on the provider that produced
  // its transcript even after the default moved.
  assert.deepEqual(
    resolveRoute({
      pending: undefined,
      logged: { provider: "deepseek", model: "deepseek-flash" },
      preferred: { provider: "zhipu-cn", model: "glm-5.3-flash" },
    }),
    { provider: "deepseek", model: "deepseek-flash" },
  );
});
