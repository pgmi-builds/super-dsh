import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards for the RPC-transport cutover (2026-10-03): the bundled bun sidecar +
 * `@oh-my-pi/pi-coding-agent` SDK line is gone and the adapter drives the
 * operator's own `omp --mode rpc` child. The deletion assertions are
 * source-level on purpose: the removed surface was a set of files + an import
 * graph, and a source check catches exactly that class of edit without booting
 * a ~200 MB bun sidecar (the `sidecar-singleton.test.mjs` precedent).
 *
 * The tick gate is pinned BOTH ways: a source assertion that the liveness set
 * is populated on the publish path, AND a behavioural truth table over the
 * compiled gate — a shape regex alone once certified a gate whose input set was
 * permanently empty (the refresh was dead code but everything matched).
 */
const pkg = fileURLToPath(new URL("..", import.meta.url));

// Imported for the truth-table check below; `dist/index.js` is the shipped
// plugin entry, so this exercises the gate that actually runs in the daemon.
const { liveOmpSessionExists } = await import("../dist/index.js");

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
  // ...AND that the gate's input set is actually populated on publish: without
  // `liveSessions.add(rpc)` the set is permanently empty (constant false) and
  // the tick's refresh is dead code even though every shape assertion above
  // still matches. Both halves are load-bearing (idle → no spawn; live → fresh).
  const heldStart = index.indexOf("private readonly registerHeld =");
  assert.notStrictEqual(heldStart, -1, "index.ts must still declare registerHeld()");
  const heldEnd = index.indexOf("\n  };", heldStart);
  assert.notStrictEqual(heldEnd, -1, "registerHeld() must close at column 2");
  const published = index.slice(heldStart, heldEnd);
  assert.match(published, /this\.liveSessions\.add\(rpc\)/, "the publish path must register the wrapper with the gate");
  assert.match(published, /this\.liveSessions\.delete\(rpc\)/, "the handle's dispose must drop it again");
});

test("the live-session gate answers its truth table (a fake spawned child opens it)", () => {
  assert.equal(typeof liveOmpSessionExists, "function", "the compiled gate must be importable");
  assert.equal(liveOmpSessionExists([]), false, "no sessions → no refresh");
  assert.equal(liveOmpSessionExists([{ spawned: false }]), false, "a draft session holds no child → no refresh");
  assert.equal(liveOmpSessionExists([{ spawned: false }, { spawned: true }]), true, "any spawned child → refresh");
  assert.equal(liveOmpSessionExists(new Set([{ spawned: true }])), true, "the provider's input is a Set");
});

test("apply() diagnoses a missing omp binary instead of failing silently", () => {
  const src = readFileSync(join(pkg, "src", "world-plugin.ts"), "utf8");
  assert.match(src, /resolveOmpExecutable/, "world-plugin must probe the host binary");
  assert.match(src, /omp binary not found/, "world-plugin must log the missing-binary diagnostic");
});
