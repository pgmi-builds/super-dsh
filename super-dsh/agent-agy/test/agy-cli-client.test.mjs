/**
 * agy-cli-client.test.mjs — the SPAWN-ENV contract of the CLI transport.
 *
 * This layer had no tests at all until 2026-10-02, which is how two real
 * defects shipped together:
 *
 *   1. `ensureCliKeyMode` wrote `<nativeHome>/.gemini/…/settings.json` while
 *      the child ran under an ISOLATED home — the file was never read by the
 *      process it was meant for, and it mutated a config the adapter had no
 *      business touching.
 *   2. That isolation overrode `HOME`, which silently destroyed ADC
 *      (`$HOME/.config/gcloud`) and the keyring — the mechanism behind the
 *      wrong conclusion "the CLI cannot use ADC".
 *
 * Both are pinned here: the mock records the child's auth-relevant env, and
 * the settings file is read back from the user's real home.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "..", "fixtures");
const dist = join(here, "..", "dist");

const { AgyCliClient } = await import(join(dist, "agy-cli-client.js"));
const { nativeSettingsPath } = await import(join(dist, "agy-auth.js"));

/** One startup entry emitting the `init` frame `ping()` waits for. */
const INIT = [{ lines: [{ event: "init", init: { tools: [] } }] }];

const AMBIENT_HOME = process.env.HOME;

function fixture(settings) {
  const home = mkdtempSync(join(tmpdir(), "agy-spawn-"));
  const trace = join(home, "trace.jsonl");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(nativeSettingsPath(home), JSON.stringify(settings, null, 2) + "\n");
  }
  return { home, trace };
}

/** Spawn one client against the mock and return the child's recorded env. */
async function spawnAndTrace(fx, over) {
  const saved = { trace: process.env.AGY_MOCK_TRACE, script: process.env.AGY_MOCK_SCRIPT };
  process.env.AGY_MOCK_TRACE = fx.trace;
  process.env.AGY_MOCK_SCRIPT = JSON.stringify(INIT);
  try {
    const client = new AgyCliClient({
      apiKey: () => over.key,
      cwd: fx.home,
      realHome: fx.home,
      agyBin: join(fixtures, "mock_agy_bin.sh"),
      authMode: over.authMode,
    });
    await client.ping();
    await client.close();
  } finally {
    for (const [k, v] of [["AGY_MOCK_TRACE", saved.trace], ["AGY_MOCK_SCRIPT", saved.script]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const entries = readFileSync(fx.trace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const spawn = entries.find((e) => e.env !== undefined);
  assert.ok(spawn !== undefined, "the mock must have recorded a spawn");
  return spawn;
}

function settingsOf(home) {
  const p = nativeSettingsPath(home);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

test("ADC spawn: AGY_ADC_AUTH=1, no key leaked, and the stale modelProvider pin is REMOVED", async () => {
  const fx = fixture({ modelProvider: "gemini", trustedWorkspaces: ["/w"] });
  const spawn = await spawnAndTrace(fx, { authMode: "adc" });

  assert.equal(spawn.env.AGY_ADC_AUTH, "1", "the ADC switch is what makes the CLI read ADC");
  assert.equal(spawn.env.GEMINI_API_KEY, null, "ADC must not smuggle a key into the child");
  assert.equal(spawn.env.AGY_CLI_DISABLE_AUTO_UPDATE, "1", "the self-update pin rides every mode");

  const settings = settingsOf(fx.home);
  assert.equal("modelProvider" in settings, false, "leaving the pin would strand the user's TUI on 'Gemini API key'");
  assert.deepEqual(settings.trustedWorkspaces, ["/w"], "unrelated user config survives");
});

test("key-mode spawn: GEMINI_API_KEY rides the child and modelProvider is pinned", async () => {
  const fx = fixture({ trustedWorkspaces: ["/w"] });
  const spawn = await spawnAndTrace(fx, { authMode: "apiKey", key: "sk-test" });

  assert.equal(spawn.env.GEMINI_API_KEY, "sk-test");
  assert.equal(spawn.env.AGY_ADC_AUTH, null, "AGY_ADC_AUTH would hijack key mode");
  assert.equal(spawn.env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");

  const settings = settingsOf(fx.home);
  assert.equal(settings.modelProvider, "gemini", "the pin lands in the config the user's TUI reads");
  assert.deepEqual(settings.trustedWorkspaces, ["/w"]);
});

test("HOME is NEVER overridden — isolation is what destroyed ADC and the keyring", async () => {
  const fx = fixture({});
  const adc = await spawnAndTrace(fx, { authMode: "adc" });
  const key = await spawnAndTrace(fx, { authMode: "apiKey", key: "sk-test" });

  // `realHome` points at the fixture, yet the child must still see the ambient
  // HOME: overriding it would hide `$HOME/.config/gcloud` (ADC) and the keyring.
  assert.equal(adc.env.HOME, AMBIENT_HOME ?? null, "ADC runs against the real HOME");
  assert.equal(key.env.HOME, AMBIENT_HOME ?? null, "key mode runs against the real HOME too");
});

test("an absent authMode defaults to key mode (the §17 onboarding path)", async () => {
  const fx = fixture({});
  const spawn = await spawnAndTrace(fx, { key: "sk-default" });

  assert.equal(spawn.env.GEMINI_API_KEY, "sk-default");
  assert.equal(spawn.env.AGY_ADC_AUTH, null);
  assert.equal(settingsOf(fx.home).modelProvider, "gemini");
});
