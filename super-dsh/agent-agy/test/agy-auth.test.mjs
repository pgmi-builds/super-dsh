/**
 * agy-auth.test.mjs — the auth ladder contract + the native-settings mutation.
 *
 * Two load-bearing pins:
 *
 *  1. `authSettingsMutation` — ADC/OAuth must actively REMOVE `modelProvider`,
 *     not merely omit it. Omitting would leave a previously selected key mode
 *     in force and the user's TUI stuck on "Gemini API key" with no
 *     `GEMINI_API_KEY` exported.
 *  2. `authChildEnv` — no HOME handling anywhere. The previous design isolated
 *     HOME, which destroyed ADC (`$HOME/.config/gcloud`) and the keyring and is
 *     how this adapter mis-concluded "the CLI cannot use ADC" (2026-10-02).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "..", "dist");

const {
  AGY_AUTH_ORDER,
  AGY_AUTH_LABELS,
  authAvailable,
  resolveAuthMode,
  authSettingsMutation,
  authChildEnv,
  nativeCliDir,
  nativeSettingsPath,
  hasSigninCredential,
  signinTokenPath,
} = await import(join(dist, "agy-auth.js"));
const { applyAgySettings } = await import(join(dist, "agy-cli-client.js"));

const NONE = { apiKey: false, oauth: false, adc: false };
const ADC_ONLY = { apiKey: false, oauth: false, adc: true };
const ALL = { apiKey: true, oauth: true, adc: true };

test("declared order is Gemini API key → OAuth → ADC (user ruling 2026-10-02)", () => {
  assert.deepEqual([...AGY_AUTH_ORDER], ["apiKey", "oauth", "adc"]);
});

test("every mode has a label (the Hub panel renders them)", () => {
  for (const mode of AGY_AUTH_ORDER) {
    assert.equal(typeof AGY_AUTH_LABELS[mode], "string");
    assert.notEqual(AGY_AUTH_LABELS[mode], "");
  }
});

test("availability answers per form", () => {
  assert.equal(authAvailable(ADC_ONLY, "adc"), true);
  assert.equal(authAvailable(ADC_ONLY, "apiKey"), false);
  assert.equal(authAvailable(ADC_ONLY, "oauth"), false);
});

test("without a selection the ladder takes the first available form", () => {
  assert.equal(resolveAuthMode(ALL), "apiKey", "API key outranks the rest");
  assert.equal(resolveAuthMode({ apiKey: false, oauth: true, adc: true }), "oauth");
  assert.equal(resolveAuthMode(ADC_ONLY), "adc", "the live face on this machine");
  assert.equal(resolveAuthMode(NONE), undefined, "nothing present ⇒ onboarding");
});

test("an explicit available selection wins over the ladder", () => {
  assert.equal(resolveAuthMode(ALL, "adc"), "adc", "user picked ADC even though a key exists");
  assert.equal(resolveAuthMode(ADC_ONLY, "adc"), "adc");
});

test("a stale selection falls through to the ladder instead of wedging", () => {
  // The user picked API key, then removed GEMINI_API_KEY from the machine.
  assert.equal(resolveAuthMode(ADC_ONLY, "apiKey"), "adc", "never fail on config that no longer matches the machine");
  assert.equal(resolveAuthMode(NONE, "apiKey"), undefined);
});

test("the ladder honours OAuth if a probe ever reports it — the deferral lives in the PROBE, not here", () => {
  // Guards the deferred layer: today no probe returns oauth:true, so OAuth can
  // never win the ladder in production. The ladder itself is complete — when
  // the OAuth probe lands it needs no change here. If this assertion ever
  // starts failing, the ladder's order was edited by mistake.
  assert.equal(resolveAuthMode({ apiKey: false, oauth: true, adc: false }), "oauth");
});

test("native settings path is hard-coded user-relative (the TUI shares it)", () => {
  assert.equal(nativeCliDir("/home/u"), "/home/u/.gemini/antigravity-cli");
  assert.equal(nativeSettingsPath("/home/u"), "/home/u/.gemini/antigravity-cli/settings.json");
});

test("key mode SETS modelProvider; ADC and OAuth REMOVE it", () => {
  assert.deepEqual(authSettingsMutation("apiKey"), { set: { modelProvider: "gemini" }, remove: [] });
  assert.deepEqual(authSettingsMutation("adc"), { set: {}, remove: ["modelProvider"] });
  assert.deepEqual(authSettingsMutation("oauth"), { set: {}, remove: ["modelProvider"] });
  // The removal is the point: without it a stale pin survives in the TUI.
  assert.ok(authSettingsMutation("adc").remove.includes("modelProvider"));
});

test("ADC child env is exactly AGY_ADC_AUTH + the auto-update pin", () => {
  assert.deepEqual(authChildEnv("adc", "unused-key"), {
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    AGY_ADC_AUTH: "1",
  });
  assert.equal(authChildEnv("adc").AGY_ADC_AUTH, "1", "no key needed");
});

test("key-mode child env carries GEMINI_API_KEY only when non-empty", () => {
  assert.deepEqual(authChildEnv("apiKey", "sk-test"), {
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    GEMINI_API_KEY: "sk-test",
  });
  assert.equal("GEMINI_API_KEY" in authChildEnv("apiKey", ""), false, "empty ⇒ omitted, never passed as ''");
  assert.equal("GEMINI_API_KEY" in authChildEnv("apiKey", undefined), false);
});

test("the auto-update pin rides EVERY mode (the binary silently self-updated on 2026-10-02)", () => {
  for (const mode of AGY_AUTH_ORDER) {
    assert.equal(authChildEnv(mode, "k").AGY_CLI_DISABLE_AUTO_UPDATE, "1", mode);
  }
});

test("only ADC sets AGY_ADC_AUTH (it would hijack the other modes)", () => {
  assert.equal("AGY_ADC_AUTH" in authChildEnv("apiKey", "k"), false);
  assert.equal("AGY_ADC_AUTH" in authChildEnv("oauth"), false);
});

test("no mode ever emits HOME (isolating it destroyed ADC + the keyring)", () => {
  for (const mode of AGY_AUTH_ORDER) {
    assert.equal("HOME" in authChildEnv(mode, "k"), false, mode);
  }
});

// ---- applyAgySettings: the real user-facing settings mutation --------------

function fixtureHome(settings) {
  const home = mkdtempSync(join(tmpdir(), "agy-auth-"))
  if (settings !== undefined) {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true })
    writeFileSync(nativeSettingsPath(home), JSON.stringify(settings, null, 2) + "\n")
  }
  return home
}

function readSettings(home) {
  return JSON.parse(readFileSync(nativeSettingsPath(home), "utf8"))
}

test("selecting the key mode really writes modelProvider into the user's config", () => {
  const home = fixtureHome({ permissions: { allow: ["command(ls)"] } })
  assert.equal(applyAgySettings(home, authSettingsMutation("apiKey")), true, "reports a change")
  const s = readSettings(home)
  assert.equal(s.modelProvider, "gemini")
  assert.deepEqual(s.permissions, { allow: ["command(ls)"] }, "unrelated user config is preserved")
})

test("selecting ADC REMOVES a previously pinned modelProvider (TUI falls back to sign-in)", () => {
  const home = fixtureHome({ modelProvider: "gemini", trustedWorkspaces: ["/w"] })
  assert.equal(applyAgySettings(home, authSettingsMutation("adc")), true)
  const s = readSettings(home)
  assert.equal("modelProvider" in s, false, "the pin must be gone, not merely unset")
  assert.deepEqual(s.trustedWorkspaces, ["/w"], "unrelated user config is preserved")
})

test("selecting OAuth REMOVES the pin too", () => {
  const home = fixtureHome({ modelProvider: "gemini" })
  applyAgySettings(home, authSettingsMutation("oauth"))
  assert.equal("modelProvider" in readSettings(home), false)
})

test("applyAgySettings is idempotent and reports no change on the second run", () => {
  const home = fixtureHome({})
  assert.equal(applyAgySettings(home, authSettingsMutation("adc")), false, "nothing to remove ⇒ no write")
  applyAgySettings(home, authSettingsMutation("apiKey"))
  assert.equal(applyAgySettings(home, authSettingsMutation("apiKey")), false, "already pinned ⇒ no write")
})

test("applyAgySettings creates the app-data dir for a brand-new user", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-auth-fresh-"))
  assert.equal(applyAgySettings(home, authSettingsMutation("apiKey")), true)
  assert.equal(readSettings(home).modelProvider, "gemini")
})

test("a corrupt settings.json is replaced rather than crashing the spawn", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-auth-bad-"))
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true })
  writeFileSync(nativeSettingsPath(home), "{ not json")
  assert.equal(applyAgySettings(home, authSettingsMutation("apiKey")), true)
  assert.equal(readSettings(home).modelProvider, "gemini")
})

test("the CLI's own sign-in is DETECTED, not assumed absent", () => {
  // Regression (2026-10-02): oauth was hardcoded unavailable, so the ladder
  // fell through to ADC — whose project has cloudcode-pa disabled — and the
  // adapter could never start a turn, even though the interactive TUI worked on
  // the very same machine. OAuth IS the Agent Platform plane headless uses.
  const home = mkdtempSync(join(tmpdir(), "agy-signin-"));
  assert.equal(hasSigninCredential(home), false, "no credential file → not signed in");

  mkdirSync(nativeCliDir(home), { recursive: true });
  writeFileSync(signinTokenPath(home), "");
  assert.equal(hasSigninCredential(home), false, "an empty file is not a credential");

  writeFileSync(signinTokenPath(home), JSON.stringify({ auth_method: "gcp", project_id: "p" }));
  assert.equal(hasSigninCredential(home), true);

  // And with it present, the ladder picks sign-in rather than ADC.
  assert.equal(resolveAuthMode({ apiKey: false, oauth: true, adc: true }), "oauth");
  assert.equal(resolveAuthMode({ apiKey: true, oauth: true, adc: true }), "apiKey", "key still outranks it");
  assert.equal(resolveAuthMode({ apiKey: false, oauth: true, adc: true }, "adc"), "adc",
    "an explicit ADC choice is still honoured");
});
