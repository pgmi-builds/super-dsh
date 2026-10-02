import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards for the RPC-transport cutover (2026-10-03): the bundled bun sidecar +
 * `@oh-my-pi/pi-coding-agent` SDK line is gone and the adapter drives the
 * operator's own `omp --mode rpc` child. All assertions are source-level on
 * purpose: the deleted surface was a set of files + an import graph, and a
 * source check catches exactly that class of edit without booting a ~200 MB bun
 * sidecar (the `sidecar-singleton.test.mjs` precedent).
 */
const pkg = fileURLToPath(new URL("..", import.meta.url));

test("the SDK sidecar surface is gone", () => {
  for (const p of ["src/sdk-client.ts", "src/sidecar-client.ts", "src/protocol.ts", "sidecar"]) {
    assert.equal(existsSync(join(pkg, p)), false, `${p} must be deleted`);
  }
});

test("no source file mentions the sidecar/SDK client", () => {
  const offenders = [];
  for (const f of readdirSync(join(pkg, "src"))) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(pkg, "src", f), "utf8");
    if (/OmpSdkClient|OmpSdkSidecar|callShared/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("index.ts spawns through LazyOmpRpc only", () => {
  const index = readFileSync(join(pkg, "src", "index.ts"), "utf8");
  assert.doesNotMatch(index, /OmpRpcClient\.spawn\(/);
  assert.match(index, /new LazyOmpRpc\(/);
});

test("source: the periodic catalog refresh is gated on a live OMP session (tick never spawns when idle)", () => {
  const index = readFileSync(join(pkg, "src", "index.ts"), "utf8");
  // agent-omp/AGENTS.md §五·五 — the 30s reconcile tick must never materialize
  // an `omp`. `refreshOmpModelsCli()` runs a REAL `omp models --json`
  // subprocess, so a bare periodic call is the regression this pins.
  assert.doesNotMatch(index, /^\s*void refreshOmpModelsCli\(\);/m, "a bare tick refresh spawns omp while idle");
  assert.match(
    index,
    /if \(liveOmpSessionExists\(this\.liveSessions\)\) void refreshOmpModelsCli\(\);/,
    "the tick's catalog refresh must sit behind the live-session gate",
  );
  // The gate must ask a session whether its transport child exists — not be a
  // constant: a draft session holds a LazyOmpRpc with no child yet.
  const start = index.indexOf("function liveOmpSessionExists(");
  assert.notStrictEqual(start, -1, "index.ts must define the live-session gate");
  const end = index.indexOf("\n}", start);
  assert.notStrictEqual(end, -1, "liveOmpSessionExists() must close at column 0");
  assert.match(index.slice(start, end + 2), /\.spawned/, "the gate must consult LazyOmpRpc.spawned");
});

test("apply() diagnoses a missing omp binary instead of failing silently", () => {
  const src = readFileSync(join(pkg, "src", "world-plugin.ts"), "utf8");
  assert.match(src, /resolveOmpExecutable/, "world-plugin must probe the host binary");
  assert.match(src, /omp binary not found/, "world-plugin must log the missing-binary diagnostic");
});
