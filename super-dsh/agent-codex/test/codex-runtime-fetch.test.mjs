#!/usr/bin/env node
/**
 * codex-runtime-fetch.test.mjs — the lazy world-home runtime fetch guard.
 *
 * 2026-10-06 user ruling: the pinned `@openai/codex` package must NEVER ride
 * the installation (0.1.11 shipped it as a dependency and every registry
 * consumer downloaded six platform binaries). It is fetched at RUNTIME into
 * the world home, and only when the operator's own CODEX_BIN / PATH CLI /
 * desktop core all miss. These tests run the real algorithm over injected
 * boundaries — zero network, zero real npm.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_RUNTIME_PACKAGE,
  CODEX_RUNTIME_VERSION,
  codexInstallArgv,
  codexRuntimeLayout,
  codexRuntimeCurrent,
  createCodexRuntimeDeps,
  ensureCodexRuntime,
  readCodexRuntimeRecord,
} from "../dist/codex-runtime-fetch.js";

/** One isolated world home per test. */
function makeHome() {
  return mkdtemp(join(tmpdir(), "codex-runtime-fetch-"));
}
function mkdtemp(prefix) {
  const home = `${prefix}${Math.random().toString(36).slice(2)}`;
  mkdirSync(home, { recursive: true });
  return home;
}

/** Deps with every boundary recorded; `run`/`smoke` are replaceable per test. */
function makeDeps(overrides = {}) {
  const calls = { runs: [], smokes: [], logs: [] };
  const deps = {
    run: async (cmd, args, opts) => {
      calls.runs.push([cmd, ...args, opts?.cwd]);
    },
    smoke: async (cmd, args) => {
      calls.smokes.push([cmd, ...args]);
      return "codex 0.160.0\n";
    },
    pluginVersion: "0.1.0",
    log: (line) => calls.logs.push(line),
    // A PATH-less env + an emptied desktop ladder keep discovery off the test
    // host: nothing on this machine can satisfy the operator tiers, so the
    // fetch ladder is exact.
    env: { PATH: "" },
    discovery: { desktopCandidates: [] },


    ...overrides,
  };
  return { deps, calls };
}

/** Materialize a complete fetched runtime (as the real npm install would). */
function fakeFetch(home) {
  const layout = codexRuntimeLayout(home);
  mkdirSync(dirname(layout.entry), { recursive: true });
  writeFileSync(layout.entry, "#!/usr/bin/env node\n");
  return layout;
}

test("install argv is exact, scriptless and dev-less — the ruling, as argv", () => {
  assert.deepEqual(codexInstallArgv(), [
    "install",
    "--exact",
    "--ignore-scripts",
    "--omit=dev",
    `${CODEX_RUNTIME_PACKAGE}@${CODEX_RUNTIME_VERSION}`,
  ]);
  assert.equal(CODEX_RUNTIME_PACKAGE, "@openai/codex");
  assert.equal(CODEX_RUNTIME_VERSION, "0.160.0");
});

test("an operator runtime short-circuits: no npm, no marker, no runtime dir", async () => {
  const home = makeHome();
  const operatorBin = join(home, "operator-codex");
  writeFileSync(operatorBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const { deps, calls } = makeDeps();
  const runtime = await ensureCodexRuntime(home, { ...deps, env: { PATH: "", CODEX_BIN: operatorBin } });
  assert.equal(runtime.source, "override");
  assert.equal(calls.runs.length, 0, "an operator runtime must never trigger a fetch");
  assert.equal(readCodexRuntimeRecord(home), undefined);

  assert.equal(existsSync(codexRuntimeLayout(home).dir), false, "the runtime dir must not even exist");
});

test("with no operator runtime, the pinned package is fetched into the world home", async () => {
  const home = makeHome();
  const { deps, calls } = makeDeps({
    run: async (cmd, args, opts) => {
      calls.runs.push([cmd, ...args, opts?.cwd]);
      fakeFetch(home);
    },
  });
  const runtime = await ensureCodexRuntime(home, deps);
  const layout = codexRuntimeLayout(home);
  assert.deepEqual(calls.runs[0].slice(0, 5), ["npm", "install", "--exact", "--ignore-scripts", "--omit=dev"]);
  assert.equal(calls.runs[0].at(-1), layout.dir, "npm runs inside the runtime dir");
  assert.equal(runtime.source, "package");
  assert.equal(runtime.command, layout.entry);
  assert.equal(runtime.nodeScript, true);
  const record = readCodexRuntimeRecord(home);
  assert.ok(record, "the marker must be written");
  assert.equal(record.packageVersion, CODEX_RUNTIME_VERSION);
  assert.equal(record.smokeVersion, "codex 0.160.0");
  assert.ok(calls.smokes[0].join(" ").endsWith("--version"), "the smoke run exercises the real entry");
  assert.equal(existsSync(layout.lock), false, "the lock must be released");
});

test("a complete fetched runtime reuses without touching npm again", async () => {
  const home = makeHome();
  const layout = fakeFetch(home);
  writeFileSync(layout.manifest, JSON.stringify({ name: "codex-runtime", private: true, version: "0.0.0" }, null, 2));
  writeFileSync(layout.marker, JSON.stringify({
    pluginVersion: "0.1.0",
    packageVersion: CODEX_RUNTIME_VERSION,
    entryPath: layout.entry,
    smokeVersion: "codex 0.160.0",
    installedAt: new Date().toISOString(),
  }, null, 2));
  const { deps, calls } = makeDeps();
  const runtime = await ensureCodexRuntime(home, deps);
  assert.equal(runtime.source, "package");
  assert.equal(calls.runs.length, 0, "a complete matching runtime must short-circuit");
});

test("a pin bump refetches instead of running a stale tree forever", async () => {
  const home = makeHome();
  const layout = fakeFetch(home);
  writeFileSync(layout.marker, JSON.stringify({
    pluginVersion: "0.1.0",
    packageVersion: "0.100.0-old",
    entryPath: layout.entry,
    smokeVersion: "codex 0.100.0",
    installedAt: new Date().toISOString(),
  }, null, 2));
  const { deps, calls } = makeDeps({
    run: async (cmd, args) => {
      calls.runs.push([cmd, ...args]);
      fakeFetch(home);
    },
  });
  await ensureCodexRuntime(home, deps);
  assert.equal(calls.runs.length, 1, "a version-mismatched runtime must be refetched");
});

test("a failed fetch leaves a trace and a clean lock, never a success marker", async () => {
  const home = makeHome();
  const layout = codexRuntimeLayout(home);
  const { deps } = makeDeps({
    run: async () => {
      throw new Error("ETIMEDOUT (fake)");
    },
  });
  await assert.rejects(
    () => ensureCodexRuntime(home, deps),
    /could not fetch the runtime.*ETIMEDOUT.*fetch-codex-runtime/s,
  );
  assert.equal(existsSync(layout.marker), false, "no marker behind a failed fetch");
  assert.ok(existsSync(layout.errorLog), "the failure must leave a trace on disk");
  assert.ok(readFileSync(layout.errorLog, "utf8").includes("ETIMEDOUT"));
  assert.equal(existsSync(layout.lock), false, "the lock must be released on failure");
});

test("a fresh lock refuses with an in-progress error; a stale lock is reclaimed", async () => {
  const home = makeHome();
  const layout = codexRuntimeLayout(home);
  mkdirSync(layout.lock);
  const { deps } = makeDeps();
  await assert.rejects(() => ensureCodexRuntime(home, deps), /already in progress/);

  const ancient = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(layout.lock, ancient, ancient);
  await ensureCodexRuntime(home, {
    ...deps,
    run: async () => {
      fakeFetch(home);
    },
  });
  assert.ok(readCodexRuntimeRecord(home), "the stale lock must be reclaimed and the fetch must complete");
});

test("codexRuntimeCurrent mirrors the marker + entry contract", () => {
  const home = makeHome();
  const layout = codexRuntimeLayout(home);
  const identity = { pluginVersion: "0.1.0", packageVersion: CODEX_RUNTIME_VERSION };
  assert.equal(codexRuntimeCurrent(home, identity), undefined);
  writeFileSync(layout.marker, JSON.stringify(identity, null, 2));
  assert.equal(codexRuntimeCurrent(home, identity), undefined, "no entry, not ready");
  mkdirSync(dirname(layout.entry), { recursive: true });
  writeFileSync(layout.entry, "export {}\n");
  assert.ok(codexRuntimeCurrent(home, identity));
  assert.equal(codexRuntimeCurrent(home, { pluginVersion: "0.2.0", packageVersion: CODEX_RUNTIME_VERSION }), undefined, "plugin bump invalidates");
});

test("production deps read this package's own version and expose npm/Node runners", () => {
  const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const created = createCodexRuntimeDeps({ pluginDir });
  assert.match(created.pluginVersion, /^\d+\.\d+\.\d+/);
  assert.equal(typeof created.run, "function");
  assert.equal(typeof created.smoke, "function");
  assert.equal(typeof created.log, "function");
});
