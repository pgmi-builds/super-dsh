#!/usr/bin/env node
/**
 * sdk-runtime.test.mjs — the lazy SDK runtime bootstrap.
 *
 * The 2026-10-04 ruling ships this package with NO SDK dependency and NO
 * postinstall: the pinned Codex SDK tree is fetched into the world home on the
 * first real prompt. That makes the bootstrap itself load-bearing, so it is
 * tested against a REAL filesystem with an injected `run` (zero network, zero
 * real npm; the fake install materializes the entry file so the real smoke
 * `import()` runs):
 *   - the layout and the install argv are fixed contracts;
 *   - a fresh fetch runs the npm install → smoke import → marker LAST;
 *   - a complete matching runtime short-circuits (second use is free);
 *   - an identity mismatch (adapter or pin) refetches; a corrupt marker is not trusted;
 *   - a concurrent fetch fails loudly; an abandoned lock is reclaimed;
 *   - a failed fetch (and a failed post-install smoke import) writes the error
 *     log and throws — never a marker, so the next call heals;
 *   - the manifest declares no SDK dependency and no install hook.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");
const {
  SDK_BINARY_PACKAGE,
  SDK_PACKAGE,
  SDK_PACKAGE_VERSION,
  createSdkRuntimeDeps,
  ensureSdkRuntime,
  readSdkRuntimeRecord,
  sdkInstallArgv,
  sdkRuntimeLayout,
  sdkRuntimeReady,
} = await import(join(dist, "sdk-runtime.js"));

/** A world home in a throwaway dir (never the live test home, never a prod home). */
const worldHome = () => mkdtempSync(join(tmpdir(), "codex-sdk-runtime-"));

const identity = (pluginVersion = "9.9.9") => ({
  pluginVersion,
  packageVersion: SDK_PACKAGE_VERSION,
  binaryVersion: SDK_PACKAGE_VERSION,
});

/** Materialize what a real `npm install` would: an importable SDK entry. */
function writeEntry(layout, source = "export class Codex {}\n") {
  const pkgDir = join(layout.nodeModules, SDK_PACKAGE);
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: SDK_PACKAGE, type: "module", version: SDK_PACKAGE_VERSION }));
  writeFileSync(layout.entry, source);
}

/**
 * Fake deps: records every call (with whether the success marker already
 * existed) and lets a test override the one external step, the npm install.
 */
function recorder(layout, overrides = {}) {
  const events = [];
  const push = (event) => events.push({ ...event, markerPresent: existsSync(layout.marker) });
  return {
    events,
    deps: {
      pluginVersion: "9.9.9",
      pluginDir: "/plugin-dir",
      log: (line) => push({ kind: "log", line }),
      async run(cmd, args, opts) {
        push({ kind: "run", cmd, args, opts });
        if (overrides.run) return overrides.run(cmd, args, opts);
        writeEntry(layout);
      },
    },
  };
}

const actions = (events) => events.filter((event) => event.kind !== "log");
const actionKinds = (events) => actions(events).map((event) => event.kind);

function seedMarker(home, record) {
  writeFileSync(sdkRuntimeLayout(home).marker, JSON.stringify(record, null, 2) + "\n");
}

test("the pinned pair is the codex SDK plus its binary package, both 0.154.0", () => {
  assert.equal(SDK_PACKAGE, "@openai/codex-sdk");
  assert.equal(SDK_BINARY_PACKAGE, "@openai/codex");
  assert.equal(SDK_PACKAGE_VERSION, "0.154.0");
});

test("sdkRuntimeLayout pins the runtime, the entry, the marker and the lock", () => {
  const home = "/world/home";
  const layout = sdkRuntimeLayout(home);
  assert.deepEqual(layout, {
    dir: join(home, "sdk-runtime"),
    manifest: join(home, "sdk-runtime", "package.json"),
    nodeModules: join(home, "sdk-runtime", "node_modules"),
    entry: join(home, "sdk-runtime", "node_modules", "@openai", "codex-sdk", "dist", "index.js"),
    marker: join(home, "sdk-runtime.json"),
    lock: join(home, "sdk-runtime.lock"),
    errorLog: join(home, "sdk-runtime.error.log"),
  });
});

test("the install argv installs BOTH pins exactly, with scripts and dev deps off", () => {
  assert.deepEqual(sdkInstallArgv("0.154.0"), [
    "install",
    "--exact",
    "--ignore-scripts",
    "--omit=dev",
    "@openai/codex-sdk@0.154.0",
    "@openai/codex@0.154.0",
  ]);
  assert.deepEqual(sdkInstallArgv(), sdkInstallArgv(SDK_PACKAGE_VERSION));
});

test("createSdkRuntimeDeps reads the real package version (the marker identity half)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deps = createSdkRuntimeDeps();
  assert.equal(deps.pluginVersion, manifest.version);
  assert.ok(typeof deps.run === "function");
});

test("sdkRuntimeReady compares the marker identity and requires the entry file", () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  writeEntry(layout);
  const record = { ...identity(), entryPath: layout.entry, installedAt: new Date().toISOString() };
  seedMarker(home, record);

  assert.deepEqual(sdkRuntimeReady(home, identity()), record);
  assert.equal(sdkRuntimeReady(home, identity("0.0.1")), undefined, "plugin version changed");
  assert.equal(
    sdkRuntimeReady(home, { ...identity(), packageVersion: "0.0.1" }),
    undefined,
    "SDK pin changed",
  );
  assert.equal(
    sdkRuntimeReady(home, { ...identity(), binaryVersion: "0.0.1" }),
    undefined,
    "binary pin changed",
  );

  writeFileSync(layout.marker, "{not json");
  assert.equal(sdkRuntimeReady(home, identity()), undefined, "corrupt marker is not trusted");
});

test("a matching marker with the entry file gone is not ready", () => {
  const home = worldHome();
  seedMarker(home, { ...identity(), entryPath: sdkRuntimeLayout(home).entry, installedAt: "x" });
  assert.equal(sdkRuntimeReady(home, identity()), undefined);
});

test("fresh fetch: npm install → smoke import → marker LAST, and the lock is released", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  const { deps, events } = recorder(layout);

  const record = await ensureSdkRuntime(home, deps);

  assert.deepEqual(actionKinds(events), ["run"]);
  const install = actions(events)[0];
  assert.equal(install.cmd, "npm");
  assert.deepEqual(install.args, sdkInstallArgv(SDK_PACKAGE_VERSION));
  assert.equal(install.opts.cwd, layout.dir, "npm install runs in the runtime dir");
  assert.ok(
    actions(events).every((event) => event.markerPresent === false),
    "no step ran after the success marker existed",
  );

  assert.equal(existsSync(layout.manifest), true, "the private manifest was written");
  assert.equal(JSON.parse(readFileSync(layout.manifest, "utf8")).private, true);
  assert.ok(existsSync(layout.marker), "marker written");
  assert.equal(existsSync(layout.lock), false, "lock released");
  assert.equal(existsSync(layout.errorLog), false, "no failure trace on success");

  assert.deepEqual(readSdkRuntimeRecord(home), record);
  assert.equal(record.pluginVersion, "9.9.9");
  assert.equal(record.packageVersion, SDK_PACKAGE_VERSION);
  assert.equal(record.binaryVersion, SDK_PACKAGE_VERSION);
  assert.equal(record.entryPath, layout.entry);
});

test("a complete matching runtime short-circuits: no command runs at all", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  await ensureSdkRuntime(home, recorder(layout).deps);

  const again = recorder(layout, {
    run: () => {
      throw new Error("must not run");
    },
  });
  const record = await ensureSdkRuntime(home, again.deps);

  assert.deepEqual(actionKinds(again.events), [], "idempotent: the second call is free");
  assert.equal(record.packageVersion, SDK_PACKAGE_VERSION);
});

test("an identity mismatch refetches instead of trusting the marker", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  writeEntry(layout);
  seedMarker(home, { ...identity("0.0.1"), entryPath: layout.entry, installedAt: "x" });

  const { deps, events } = recorder(layout);
  const record = await ensureSdkRuntime(home, deps);

  assert.deepEqual(actionKinds(events), ["run"], "the fetch re-ran");
  assert.equal(record.pluginVersion, "9.9.9");
});

test("a concurrent fetch holding the lock fails loudly and is not released", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  mkdirSync(layout.lock);

  const { deps, events } = recorder(layout);
  await assert.rejects(
    () => ensureSdkRuntime(home, deps),
    (error) => {
      assert.match(error.message, /another SDK runtime fetch is already in progress/);
      assert.match(error.message, /sdk-runtime\.lock/);
      return true;
    },
  );

  assert.deepEqual(actions(events), [], "the loser does nothing");
  assert.ok(existsSync(layout.lock), "the lock belongs to the other caller");
  assert.equal(existsSync(layout.marker), false);
});

test("an abandoned lock is reclaimed so a crashed fetch cannot brick the line", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  mkdirSync(layout.lock);
  // Older than the 30 min stale threshold, so the lock reads as abandoned.
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(layout.lock, old, old);

  const { deps, events } = recorder(layout);
  await ensureSdkRuntime(home, deps);

  assert.equal(actionKinds(events)[0], "run", "the fetch ran despite the abandoned lock");
  assert.equal(existsSync(layout.lock), false);
  assert.ok(existsSync(layout.marker));
});

test("a failed install writes the error log, rethrows, and leaves no marker", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  const { deps } = recorder(layout, {
    run: () => {
      throw new Error("npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openai%2fcodex-sdk");
    },
  });

  await assert.rejects(
    () => ensureSdkRuntime(home, deps),
    (error) => {
      assert.match(error.message, /could not fetch the SDK runtime/);
      assert.match(error.message, /404 Not Found/);
      assert.match(error.message, /npm run fetch-sdk-runtime/, "the pre-warm command is named");
      assert.ok(error.message.includes(layout.errorLog), "the error names the trace file");
      return true;
    },
  );

  assert.equal(existsSync(layout.marker), false, "a failed fetch never looks complete");
  assert.equal(existsSync(layout.lock), false, "lock released even on failure");
  assert.match(readFileSync(layout.errorLog, "utf8"), /codex-sdk runtime fetch failed: npm ERR! 404 Not Found/);
});

test("an install that produces no importable constructor fails loud at fetch time", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  const { deps } = recorder(layout, {
    run: () => {
      writeEntry(layout, "export const NotCodex = 1;\n");
    },
  });

  await assert.rejects(
    () => ensureSdkRuntime(home, deps),
    (error) => {
      assert.match(error.message, /smoke import of @openai\/codex-sdk@0\.154\.0 exposed no Codex constructor/);
      return true;
    },
  );

  assert.equal(existsSync(layout.marker), false, "a failed smoke import never looks complete");
  assert.equal(existsSync(layout.lock), false);
  assert.match(readFileSync(layout.errorLog, "utf8"), /exposed no Codex constructor/);
});

test("a retry after a failure succeeds and clears the stale trace", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  await assert.rejects(
    () =>
      ensureSdkRuntime(
        home,
        recorder(layout, {
          run: () => {
            throw new Error("boom");
          },
        }).deps,
      ),
  );
  assert.ok(existsSync(layout.errorLog));

  await ensureSdkRuntime(home, recorder(layout).deps);
  assert.equal(existsSync(layout.errorLog), false, "trace cleared once the fetch succeeds");
  assert.ok(existsSync(layout.marker));
});

test("the manifest declares no SDK dependency and no install hook", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(manifest.dependencies, {}, "dependencies must be empty");
  assert.equal(manifest.optionalDependencies, undefined, "no optionalDependencies");
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      assert.ok(!/@openai\/|codex/i.test(name), `${section} must not declare ${name}`);
    }
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `no ${hook} hook`);
  }
  for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    assert.equal(meta.optional, true, `${name} must be declared as an optional peer`);
  }
});
