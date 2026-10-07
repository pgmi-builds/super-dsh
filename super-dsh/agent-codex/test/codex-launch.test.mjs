// On-the-fly provider injection (2026-10-04).
//
// A provider reaches a `codex app-server` child as process arguments, never as a
// write to the user's `~/.codex`. This suite pins the exact argv/env shape, and
// every clause in it was measured against the real 0.154 binary first:
//
//   - a HYPHENATED id is legal in a `-c` dotted path (probed: `zhipu-cn`);
//   - `model_catalog_json` is resolved against the process CWD when it arrives
//     as an override, so the injected path must be ABSOLUTE (a relative one
//     failed `ENOENT`);
//   - `env_key` is the one auth shape that never consults the auth manager, so a
//     stored key rides the CHILD's environment under a synthetic name — which is
//     also what makes a keyed provider usable behind a ChatGPT login, where
//     `requires_openai_auth` is silently shadowed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

const { providerLaunch, syntheticKeyName, NATIVE_LAUNCH } = await import("../dist/codex-launch.js");
const { providerCatalogPath } = await import("../dist/codex-native-config.js");

function homes() {
  return {
    worldHome: mkdtempSync(join(tmpdir(), "superd-codex-world-")),
    codexHome: mkdtempSync(join(tmpdir(), "superd-codex-native-")),
  };
}

/** The value of one `-c key=value` override, or undefined. */
function override(argv, key) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "-c") continue;
    const [left, ...rest] = argv[index + 1].split("=");
    if (left === key) return rest.join("=");
  }
  return undefined;
}

const ENV_PROVIDER = {
  id: "zhipu-cn",
  label: "https://open.bigmodel.cn/api/v1",
  baseUrl: "https://open.bigmodel.cn/api/v1",
  protocol: "responses",
  auth: { kind: "env", name: "ZHIPU_API_KEY" },
  models: [{ id: "glm-5.3-flash" }, { id: "glm-4.7" }],
};

test("an env-shaped provider is pinned by env_key and adds nothing to the child's environment", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerLaunch(worldHome, codexHome, ENV_PROVIDER);
  // The hyphen is deliberate: this is the id shape that had to be probed.
  assert.equal(override(launch.argv, "model_providers.zhipu-cn.name"), '"https://open.bigmodel.cn/api/v1"');
  assert.equal(override(launch.argv, "model_providers.zhipu-cn.base_url"), '"https://open.bigmodel.cn/api/v1"');
  assert.equal(override(launch.argv, "model_providers.zhipu-cn.wire_api"), '"responses"');
  assert.equal(override(launch.argv, "model_providers.zhipu-cn.env_key"), '"ZHIPU_API_KEY"');
  assert.equal(override(launch.argv, "model_provider"), '"zhipu-cn"');
  // The user's own environment already holds the key: we must not invent one.
  assert.deepEqual(launch.env, {});
  assert.equal(override(launch.argv, "model_providers.zhipu-cn.requires_openai_auth"), undefined);
});

test("a stored key is handed to the child under a synthetic env_key, never through auth.json", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerLaunch(worldHome, codexHome, {
    ...ENV_PROVIDER,
    id: "my-proxy",
    auth: { kind: "apiKey", value: "sk-secret" },
  });
  const name = syntheticKeyName("my-proxy");
  assert.equal(name, "SUPERD_CODEX_KEY_MY_PROXY");
  assert.equal(override(launch.argv, "model_providers.my-proxy.env_key"), `"${name}"`);
  assert.deepEqual(launch.env, { [name]: "sk-secret" });
  // requires_openai_auth would route the call through the auth manager, which is
  // exactly the path a ChatGPT login shadows.
  assert.equal(override(launch.argv, "model_providers.my-proxy.requires_openai_auth"), undefined);
});

test("an apiKey entry with an empty value defers to the runtime's own auth.json", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerLaunch(worldHome, codexHome, {
    ...ENV_PROVIDER,
    id: "seeded",
    auth: { kind: "apiKey", value: "" },
  });
  // The seeded shape: Super D holds no copy, so the only honest statement is
  // "this provider authenticates like the runtime does".
  assert.equal(override(launch.argv, "model_providers.seeded.requires_openai_auth"), "true");
  assert.equal(override(launch.argv, "model_providers.seeded.env_key"), undefined);
  assert.deepEqual(launch.env, {});
});

test("the model catalog is written to the WORLD home and injected as an absolute path", () => {
  const { worldHome, codexHome } = homes();
  const launch = providerLaunch(worldHome, codexHome, ENV_PROVIDER);
  const injected = override(launch.argv, "model_catalog_json");
  assert.ok(injected !== undefined, "a provider with models must inject a catalog");
  // Unquoted TOML string value as it appears in the argv pair.
  const path = injected.replace(/^"|"$/g, "");
  assert.ok(isAbsolute(path), `the override must be absolute (codex resolves it against cwd): ${path}`);
  assert.equal(path, providerCatalogPath(worldHome, "zhipu-cn"));
  // It lives in OUR tree; nothing is written into the native home.
  assert.ok(existsSync(path));
  assert.equal(existsSync(join(codexHome, "superd-model-catalog.json")), false);
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(catalog.models.map((entry) => entry.slug), ["glm-5.3-flash", "glm-4.7"]);
});

test("a provider with no models injects no catalog and claims no models", () => {
  const { worldHome, codexHome } = homes();
  // The state a provider imported from a config.toml that is not the one in
  // force arrives in: codex's catalog is per-provider-in-force, so its model list
  // is genuinely unknown. Registering a route for it would be an invention.
  const launch = providerLaunch(worldHome, codexHome, { ...ENV_PROVIDER, id: "empty-one", models: [] });
  assert.equal(override(launch.argv, "model_catalog_json"), undefined);
  assert.equal(existsSync(providerCatalogPath(worldHome, "empty-one")), false);
  // The provider itself is still fully pinned — only the model list is unknown.
  assert.equal(override(launch.argv, "model_provider"), '"empty-one"');
});

test("the no-injection launch is empty, which is the legacy route's honest fallback", () => {
  assert.deepEqual(NATIVE_LAUNCH, { argv: [], env: {} });
});
