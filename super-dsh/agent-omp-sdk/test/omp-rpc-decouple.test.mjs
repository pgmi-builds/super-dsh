#!/usr/bin/env node
/**
 * omp-rpc-decouple.test.mjs — the SDK line's two load-bearing trims.
 *
 * The pre-transition adapter this package was copied from was built around a
 * bun sidecar that the adapter's own `sidecar-client.ts` STARTED (and around a
 * data plane that went through that sidecar). Both were replaced:
 *
 *   1. the runtime is fetched LAZILY — `ensureSdkRuntime` may be awaited in
 *      exactly ONE place (`OmpSdkSidecar#start`, `src/sidecar-client.ts`), and
 *      `start()` is only reachable from `LazyOmpRpc#ensure()`. A fetch at
 *      module scope, at world mount, in the provider constructor or on any
 *      passive path would download ~900 MB for a row the user never enabled;
 *   2. the model catalog / modelRoles data plane is the operator's own
 *      `omp … --json` (subprocess), NOT the sidecar — otherwise booting the
 *      world or opening the model selector would itself start the sidecar and
 *      trigger that fetch.
 *
 * These are source-level assertions on purpose: a live "did it fetch?" probe
 * cannot run without the very network/bun the invariant exists to avoid. The
 * behavioral half lives in `sdk-lazy.test.mjs` (injected seams).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("ensureSdkRuntime is awaited in exactly one module: sidecar-client.ts", () => {
  const owning = read("src/sidecar-client.ts");
  // Once in the import, once in the default deps factory. No third use.
  const uses = owning.match(/ensureSdkRuntime\(/g) ?? [];
  assert.equal(uses.length, 1, `sidecar-client.ts must call ensureSdkRuntime exactly once:\n${owning}`);

  for (const file of ["src/index.ts", "src/transport.ts", "src/lazy-rpc.ts", "src/sdk-client.ts", "src/world-plugin.ts"]) {
    const text = read(file);
    assert.doesNotMatch(text, /ensureSdkRuntime\s*\(/, `${file} must not fetch the runtime`);
  }
});

test("the world plugin's runtime diagnostic never fetches, spawns or imports the runtime", () => {
  const world = read("src/world-plugin.ts");
  assert.doesNotMatch(world, /ensureSdkRuntime\s*\(/, "the mount path must stay report-only");
  assert.doesNotMatch(world, /child_process|\bspawn\(/, "the mount path must not spawn");
  assert.match(world, /sdkRuntimeLayout\(/, "the diagnostic reports the layout it is missing");
});

test("the provider entry builds wrappers through the transport, never by spawning directly", () => {
  const index = read("src/index.ts");
  assert.doesNotMatch(index, /new OmpSdkSidecar\(/, "index.ts must not construct a sidecar");
  assert.doesNotMatch(index, /sidecar-client\.js/, "index.ts must not import the sidecar client at all");
  assert.doesNotMatch(index, /from "node:child_process"|\bspawn\(/, "index.ts must not spawn");
  assert.match(index, /this\.transport\.create\(\{/, "both create and resume build wrappers through the transport");
  assert.match(index, /createOmpSdkTransport\(\)/, "the provider owns one SDK transport");
});

test("the model catalog and modelRoles data plane go through the omp CLI, not the sidecar", () => {
  for (const file of ["src/omp-cli.ts", "src/models.ts", "src/omp-store.ts"]) {
    const text = read(file);
    assert.doesNotMatch(text, /sdk-client\.js/, `${file} must not go through the shared sidecar`);
  }
  const cli = read("src/omp-cli.ts");
  assert.match(cli, /resolveOmpExecutable\(\)/, "the CLI path resolves the operator's omp binary");
  assert.match(cli, /ompModelRoles|ompSetModelRoles|ompAvailableModels/, "the CLI exposes the modelRoles/catalog surface");
});

test("the sidecar is spawned only by sidecar-client.ts", () => {
  const owners = ["src/index.ts", "src/transport.ts", "src/lazy-rpc.ts", "src/sdk-client.ts"];
  for (const file of owners) {
    assert.doesNotMatch(read(file), /child_process/, `${file} must not own a child process`);
  }
  assert.match(read("src/sidecar-client.ts"), /from "node:child_process"/, "the sidecar client owns the child");
});

test("no compiled source outside sidecar/ imports the SDK package", () => {
  // sidecar/main.ts is the ONE deliberate exception: it is copied into the
  // fetched runtime dir and executed there, where the package exists. Every
  // other source in this package must survive `dsh plugin add` with no
  // node_modules at all.
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts")) {
        assert.doesNotMatch(read(next), /(?:from|require\()\s*["']@oh-my-pi\//, `${next} must not import the SDK`);
        assert.doesNotMatch(read(next), /from "bun"|require\("bun"\)/, `${next} must not import bun`);
      }
    }
  };
  walk("src");
  walk("scripts");
});
