#!/usr/bin/env node
/**
 * sdk-runtime.test.mjs — the lazy SDK runtime bootstrap.
 *
 * The 2026-10-03 ruling ships this package with NO SDK/bun dependency and NO
 * postinstall: bun + the pinned coding-agent package + the sidecar are fetched
 * on the first real prompt. That makes the bootstrap itself load-bearing, so it
 * is tested against a REAL filesystem with injected `download`/`run`/`copy`
 * (zero network, zero real bun):
 *   - the layout and the slim install argv are fixed contracts;
 *   - a fresh fetch runs download → unzip → slim install → copies → smoke → marker LAST;
 *   - a complete matching runtime short-circuits (second use is free);
 *   - a half-built runtime heals in place without re-downloading;
 *   - an identity mismatch refetches; a corrupt marker is not trusted;
 *   - a concurrent fetch fails loudly; an abandoned lock is reclaimed;
 *   - a failed fetch (and a failed post-install smoke import) writes the error
 *     log and throws — never a marker;
 *   - the manifest declares no SDK/bun dependency and no install hook.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");
const {
  SDK_BUN_PLATFORM,
  SDK_BUN_VERSION,
  SDK_NATIVES_PACKAGE_PREFIX,
  SDK_PACKAGE,
  SDK_PACKAGE_VERSION,
  bunReleaseZipUrl,
  ensureSdkRuntime,
  readSdkRuntimeRecord,
  sdkInstallArgv,
  sdkNativesPackage,
  sdkNativesPlatform,
  sdkRuntimeLayout,
  sdkRuntimeProtocolEntry,
  sdkRuntimeReady,
} = await import(join(dist, "sdk-runtime.js"));

/** A world home in a throwaway dir (never the live test home, never a prod home). */
const worldHome = () => mkdtempSync(join(tmpdir(), "omp-sdk-runtime-"));

const identity = (pluginVersion = "9.9.9") => ({
  pluginVersion,
  packageVersion: SDK_PACKAGE_VERSION,
  bunVersion: SDK_BUN_VERSION,
});

/**
 * Fake deps: materializes the files each real step would, records every call
 * (with whether the success marker already existed), and lets a test override
 * one step to fail.
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
      async download(url, dest) {
        push({ kind: "download", url, dest });
        if (overrides.download) return overrides.download(url, dest);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "not-a-real-zip");
      },
      async run(cmd, args, opts) {
        push({ kind: "run", cmd, args, opts });
        if (overrides.run) return overrides.run(cmd, args, opts);
        if (cmd === layout.bun && args[0] === "add") {
          mkdirSync(join(layout.dir, ".cache"), { recursive: true });
        }
      },
      copy(from, to) {
        push({ kind: "copy", from, to });
        if (overrides.copy) return overrides.copy(from, to);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, "");
      },
    },
  };
}

const actions = (events) => events.filter((event) => event.kind !== "log");
const actionKinds = (events) => actions(events).map((event) => event.kind);

function seedBun(layout) {
  mkdirSync(dirname(layout.bun), { recursive: true });
  writeFileSync(layout.bun, "#!/bin/sh\n");
}

function seedMarker(home, record) {
  writeFileSync(sdkRuntimeLayout(home).marker, JSON.stringify(record, null, 2) + "\n");
}

test("the SDK package is the omp coding-agent package", () => {
  assert.equal(SDK_PACKAGE, "@oh-my-pi/pi-coding-agent");
  assert.equal(SDK_NATIVES_PACKAGE_PREFIX, "@oh-my-pi/pi-natives");
});

test("the pin defaults to 18.5.0 (18.4.9 is broken for source-level import)", {
  skip:
    process.env.OMP_SDK_PACKAGE_VERSION !== undefined
      ? `OMP_SDK_PACKAGE_VERSION=${process.env.OMP_SDK_PACKAGE_VERSION}`
      : false,
}, () => {
  assert.equal(SDK_PACKAGE_VERSION, "18.5.0");
  assert.equal(SDK_BUN_VERSION, "1.4.2");
});

test("sdkRuntimeLayout pins the runtime, its sources, the marker and the lock", () => {
  const home = "/world/home";
  const layout = sdkRuntimeLayout(home);
  assert.deepEqual(layout, {
    dir: join(home, "sdk-runtime"),
    bun: join(home, "sdk-runtime", "bin", "bun"),
    marker: join(home, "sdk-runtime.json"),
    lock: join(home, "sdk-runtime.lock"),
    errorLog: join(home, "sdk-runtime.error.log"),
    sidecarDir: join(home, "sdk-runtime", "sidecar"),
    sidecarEntry: join(home, "sdk-runtime", "sidecar", "main.ts"),
    protocolDir: join(home, "sdk-runtime", "dist"),
  });
  assert.equal(sdkRuntimeProtocolEntry(layout), join(home, "sdk-runtime", "dist", "protocol.js"));
});

test("bunReleaseZipUrl is the pinned linux-x64 GitHub asset", () => {
  assert.equal(SDK_BUN_PLATFORM, "linux-x64");
  assert.equal(
    bunReleaseZipUrl("1.4.2"),
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip",
  );
});

test("sdkNativesPlatform maps every supported tuple and rejects the rest", () => {
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
    ["win32", "arm64"],
  ]) {
    const key = sdkNativesPlatform(platform, arch);
    assert.equal(key, `${platform}-${arch}`);
    assert.equal(sdkNativesPackage(key), `${SDK_NATIVES_PACKAGE_PREFIX}-${platform}-${arch}`);
  }
  assert.throws(() => sdkNativesPlatform("linux", "arm"), /no binding for linux-arm/);
  assert.throws(() => sdkNativesPlatform("freebsd", "x64"), /no binding for freebsd-x64/);
});

test("the install argv is slim: --omit=optional plus the explicit platform binding", () => {
  assert.deepEqual(sdkInstallArgv("18.5.0", "linux-x64"), [
    "add",
    "--exact",
    "--ignore-scripts",
    "--omit=optional",
    `${SDK_PACKAGE}@18.5.0`,
    `${SDK_NATIVES_PACKAGE_PREFIX}-linux-x64@18.5.0`,
  ]);
  assert.deepEqual(sdkInstallArgv("18.5.0", "darwin-arm64", true), [
    "add",
    "--exact",
    "--ignore-scripts",
    `${SDK_PACKAGE}@18.5.0`,
    `${SDK_NATIVES_PACKAGE_PREFIX}-darwin-arm64@18.5.0`,
  ]);
});

test("sdkRuntimeReady compares the marker identity and requires the bun binary", () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  seedBun(layout);
  const record = { ...identity(), bunPath: layout.bun, installedAt: new Date().toISOString() };
  seedMarker(home, record);

  assert.deepEqual(sdkRuntimeReady(home, identity()), record);
  assert.equal(sdkRuntimeReady(home, identity("0.0.1")), undefined, "plugin version changed");
  assert.equal(
    sdkRuntimeReady(home, { ...identity(), packageVersion: "18.0.0" }),
    undefined,
    "package pin changed",
  );
  assert.equal(
    sdkRuntimeReady(home, { ...identity(), bunVersion: "0.0.1" }),
    undefined,
    "bun version changed",
  );

  writeFileSync(layout.marker, "{not json");
  assert.equal(sdkRuntimeReady(home, identity()), undefined, "corrupt marker is not trusted");
});

test("a matching marker with the bun binary gone is not ready", () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  seedMarker(home, { ...identity(), bunPath: layout.bun, installedAt: "2026-10-03T00:00:00.000Z" });
  assert.equal(sdkRuntimeReady(home, identity()), undefined);
});

test("fresh fetch: download → unzip → slim install → copies → smoke → marker LAST", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  const { deps, events } = recorder(layout);

  const record = await ensureSdkRuntime(home, deps);

  assert.deepEqual(actionKinds(events), [
    "download",
    "run",
    "copy",
    "run",
    "copy",
    "copy",
    "run",
  ]);

  const download = actions(events).find((event) => event.kind === "download");
  const unzip = actions(events).find((event) => event.kind === "run" && event.cmd === "unzip");
  const install = actions(events).find(
    (event) => event.kind === "run" && event.cmd === layout.bun && event.args[0] === "add",
  );
  assert.equal(download.url, bunReleaseZipUrl(SDK_BUN_VERSION));
  assert.equal(download.dest, join(layout.dir, `bun-${SDK_BUN_PLATFORM}.zip`));
  assert.equal(unzip.cmd, "unzip");
  assert.deepEqual(unzip.args, [
    "-o",
    join(layout.dir, `bun-${SDK_BUN_PLATFORM}.zip`),
    "-d",
    join(layout.dir, ".bun-unzip"),
  ]);

  assert.equal(install.cmd, layout.bun);
  assert.deepEqual(install.args, sdkInstallArgv(SDK_PACKAGE_VERSION, sdkNativesPlatform()));
  assert.equal(install.opts.cwd, layout.dir, "bun add runs in the runtime dir");
  assert.equal(install.opts.env.BUN_INSTALL_CACHE_DIR, join(layout.dir, ".cache"));

  assert.deepEqual(
    actions(events)
      .filter((event) => event.kind === "copy")
      .map((event) => [event.from, event.to]),
    [
      [join(layout.dir, ".bun-unzip", `bun-${SDK_BUN_PLATFORM}`, "bun"), layout.bun],
      [join("/plugin-dir", "sidecar", "main.ts"), layout.sidecarEntry],
      [join("/plugin-dir", "dist", "protocol.js"), sdkRuntimeProtocolEntry(layout)],
    ],
  );

  const smoke = actions(events).at(-1);
  assert.equal(smoke.cmd, layout.bun);
  assert.deepEqual(smoke.args, ["-e", `await import(${JSON.stringify(SDK_PACKAGE)})`]);
  assert.equal(smoke.opts.cwd, layout.dir);
  assert.ok(
    smoke.opts.env.PI_CODING_AGENT_DIR.startsWith(layout.dir),
    "smoke import must not touch the operator's ~/.omp",
  );
  assert.equal(smoke.opts.env.OMP_HOME, smoke.opts.env.PI_CODING_AGENT_DIR);

  assert.ok(
    actions(events).every((event) => event.markerPresent === false),
    "no step ran after the success marker existed",
  );
  assert.ok(existsSync(layout.marker), "marker written");
  assert.equal(existsSync(layout.lock), false, "lock released");
  assert.equal(existsSync(layout.errorLog), false, "no failure trace on success");
  assert.equal(existsSync(join(layout.dir, ".cache")), false, "install cache deleted");
  assert.equal(existsSync(join(layout.dir, ".smoke")), false, "smoke scratch dir deleted");

  assert.deepEqual(readSdkRuntimeRecord(home), record);
  assert.equal(record.packageVersion, SDK_PACKAGE_VERSION);
  assert.equal(record.bunVersion, SDK_BUN_VERSION);
  assert.equal(record.bunPath, layout.bun);
  assert.equal(record.pluginVersion, "9.9.9");
});

test("a complete matching runtime short-circuits: zero downloads, commands or copies", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  await ensureSdkRuntime(home, recorder(layout).deps);

  const again = recorder(layout, {
    download: () => {
      throw new Error("must not download");
    },
    run: () => {
      throw new Error("must not run");
    },
    copy: () => {
      throw new Error("must not copy");
    },
  });
  const record = await ensureSdkRuntime(home, again.deps);

  assert.deepEqual(actionKinds(again.events), [], "idempotent: the second call is free");
  assert.equal(record.packageVersion, SDK_PACKAGE_VERSION);
});

test("a half-built runtime (bun but no marker) heals without re-downloading", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  seedBun(layout);

  const { deps, events } = recorder(layout);
  await ensureSdkRuntime(home, deps);

  assert.deepEqual(actionKinds(events), ["run", "copy", "copy", "run"]);
  assert.ok(existsSync(layout.marker));
});

test("an identity mismatch refetches instead of trusting the marker", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  seedBun(layout);
  seedMarker(home, { ...identity("0.0.1"), bunPath: layout.bun, installedAt: "x" });

  const { deps, events } = recorder(layout);
  const record = await ensureSdkRuntime(home, deps);

  assert.deepEqual(actionKinds(events), ["run", "copy", "copy", "run"], "the fetch re-ran");
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

  assert.equal(actionKinds(events)[0], "download", "the fetch ran despite the abandoned lock");
  assert.equal(existsSync(layout.lock), false);
});

test("a failed fetch writes the error log, rethrows, and leaves no marker", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  const { deps } = recorder(layout, {
    download: () => {
      throw new Error("curl: (22) 404 Not Found");
    },
  });

  await assert.rejects(
    () => ensureSdkRuntime(home, deps),
    (error) => {
      assert.match(error.message, /could not fetch the SDK runtime/);
      assert.match(error.message, /curl: \(22\) 404 Not Found/);
      assert.ok(error.message.includes(layout.errorLog), "the error names the trace file");
      return true;
    },
  );

  assert.equal(existsSync(layout.marker), false, "a failed fetch never looks complete");
  assert.equal(existsSync(layout.lock), false, "lock released even on failure");
  assert.match(
    readFileSync(layout.errorLog, "utf8"),
    /omp-sdk runtime fetch failed: curl: \(22\) 404 Not Found/,
  );
});

test("a pin that cannot be smoke-imported fails loud (the 18.4.9 case)", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  const { deps } = recorder(layout, {
    run: (_cmd, args) => {
      if (args[0] === "-e") {
        throw new Error(
          "SyntaxError: Export named 'createRatchetPrelude' not found in module '.../src/ratchet/prelude.js'",
        );
      }
    },
  });

  await assert.rejects(
    () => ensureSdkRuntime(home, deps),
    (error) => {
      assert.match(error.message, /smoke import of @oh-my-pi\/pi-coding-agent@/);
      assert.match(error.message, /OMP_SDK_PACKAGE_VERSION/, "the override is named");
      assert.match(error.message, /createRatchetPrelude/);
      return true;
    },
  );

  assert.equal(existsSync(layout.marker), false, "a failed smoke import never looks complete");
  assert.equal(existsSync(layout.lock), false);
  assert.match(readFileSync(layout.errorLog, "utf8"), /smoke import .* failed/);
});

test("a retry after a failure succeeds and clears the stale trace", async () => {
  const home = worldHome();
  const layout = sdkRuntimeLayout(home);
  await assert.rejects(
    () =>
      ensureSdkRuntime(
        home,
        recorder(layout, {
          download: () => {
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

test("the manifest declares no SDK/bun dependency and no install hook", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(manifest.dependencies, {}, "dependencies must be empty");
  assert.equal(manifest.optionalDependencies, undefined, "no optionalDependencies");
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
    "bundledDependencies",
  ]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      assert.ok(!name.includes("@oh-my-pi"), `${section} must not declare ${name}`);
      assert.notEqual(name, "bun", `${section} must not declare bun`);
    }
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `no ${hook} hook`);
  }
  for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    assert.equal(meta.optional, true, `${name} must be declared as an optional peer`);
  }
});

test("the package skeleton exports the world entry and ships the runtime sources", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "@pgmi-builds/agent-omp-sdk");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.exports, {
    ".": "./dist/index.js",
    "./world": "./dist/world-plugin.js",
  });
  assert.deepEqual(manifest.files, ["dist", "sidecar", "cordis.patch.yml", "README.md"]);
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(manifest.scripts?.build, "tsc -p tsconfig.json");
  assert.equal(manifest.scripts?.test, "node --test test/*.test.mjs");
  assert.equal(manifest.scripts?.["fetch-sdk-runtime"], "node scripts/fetch-sdk-runtime.mjs");
});
