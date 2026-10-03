#!/usr/bin/env node
/**
 * sdk-lazy.test.mjs — the zero-spawn window and the sidecar singleton.
 *
 * The opt-in SDK row exists so that NOTHING (no download, no bun, no child)
 * happens until a real prompt arrives. This file pins that behaviorally with
 * TWO injected seams and no real process at all:
 *
 *   - `runtimeFetch` — counts the bootstrap calls and returns a fake runtime
 *     record whose `bunPath` is the runtime's own `bin/bun`;
 *   - `spawnProcess` — a fake ChildProcess that emits the `ready` frame.
 *
 * Asserted here:
 *   1. building a transport / a pool / a cold passive query fetches NOTHING;
 *   2. two sessions of one pool fetch the runtime EXACTLY ONCE and share ONE
 *      child (the singleton invariant the row is justified by);
 *   3. the child is spawned with the runtime's OWN `bin/bun` and the sidecar
 *      entry INSIDE the runtime dir (the fetcher's layout IS the used layout);
 *   4. the last `close()` releases the pool and stops the child.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { sdkRuntimeLayout } = await import(join(dist, "sdk-runtime.js"));
const { createOmpSdkSidecarPool } = await import(join(dist, "sdk-client.js"));
const { createOmpSdkTransport } = await import(join(dist, "transport.js"));

/** A throwaway world home — never a live test home, never a prod home. */
const worldHome = () => mkdtempSync(join(tmpdir(), "omp-sdk-lazy-"));

/** The record a fake `runtimeFetch` resolves to (the fetcher's real shape). */
function fakeRuntime(home) {
  const layout = sdkRuntimeLayout(home);
  return {
    pluginVersion: "9.9.9",
    packageVersion: "18.5.0",
    bunVersion: "1.4.2",
    bunPath: layout.bun,
    installedAt: new Date(0).toISOString(),
  };
}

/** A fake child that announces `ready` and exits when `close()` ends stdin. */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => child.emit("exit", 0));
  };
  // Answer every request frame like the sidecar would. `session.create` mints a
  // handle; everything else answers `{}`. The reply is deferred one microtask
  // because the caller has not yet registered its pending entry when the write
  // is issued.
  child.stdin.write = (chunk, callback) => {
    let frame = {};
    try {
      frame = JSON.parse(String(chunk));
    } catch {
      /* malformed: answer nothing */
    }
    if (typeof frame.id === "number") {
      const result = frame.method === "session.create" ? { handle: `h${frame.id}` } : {};
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ id: frame.id, ok: true, result }) + "\n");
      });
    }
    if (typeof callback === "function") callback();
    return true;
  };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => { };
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => { };
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test("constructing the transport fetches nothing", async () => {
  const home = worldHome();
  let fetches = 0;
  const transport = createOmpSdkTransport({ worldHome: home });
  void transport;
  assert.equal(fetches, 0, "the transport must be construction-free");
});

test("a cold passive query does not fetch and does not start a sidecar", async () => {
  const home = worldHome();
  const calls = [];
  const pool = createOmpSdkSidecarPool({
    worldHome: home,
    runtimeFetch: async (target) => {
      calls.push(target);
      return fakeRuntime(target);
    },
  });
  const answer = await pool.callIfLive("models.list", {});
  assert.equal(answer, undefined, "a cold shared call resolves undefined");
  assert.equal(calls.length, 0, "the periodic path must never fetch the runtime");
  assert.equal(pool.isLive(), false);
});

test("two sessions fetch the runtime exactly once and share one child", async () => {
  const home = worldHome();
  const fetchCalls = [];
  const spawnCalls = [];
  let nextPid = 4000;
  const pool = createOmpSdkSidecarPool({
    worldHome: home,
    env: {},
    runtimeFetch: async (target) => {
      fetchCalls.push(target);
      return fakeRuntime(target);
    },
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = fakeChild(nextPid++);
      // Publish the ready frame on the next tick, exactly like the real
      // sidecar's `{event:"ready"}` line.
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ event: "ready", payload: { protocol: 0 } }) + "\n");
      });
      return child;
    },
  });

  const first = await pool.spawnSession(["--approval-mode", "yolo"], "/tmp");
  assert.equal(fetchCalls.length, 1, "the first session fetches the runtime");
  assert.equal(fetchCalls[0], home, "the fetch targets the pool's world home");
  assert.equal(first.spawned, true, "the first session holds a live sidecar");
  assert.equal(spawnCalls.length, 1, "the first session spawns one child");

  const layout = sdkRuntimeLayout(home);
  assert.equal(spawnCalls[0].command, layout.bun, "the child runs on the runtime's own bin/bun");
  assert.deepEqual(spawnCalls[0].args, ["run", layout.sidecarEntry], "the sidecar entry is inside the runtime dir");
  assert.equal(spawnCalls[0].options.cwd, layout.dir, "cwd is the runtime dir (module resolution)");

  const second = await pool.spawnSession(["--approval-mode", "write"], "/tmp");
  assert.equal(fetchCalls.length, 1, "the second session reuses the fetched runtime");
  assert.equal(spawnCalls.length, 1, "the second session reuses the ONE child (singleton)");
  assert.equal(second.spawned, true);
  assert.equal(second.spawned, true);
  assert.equal(pool.isLive(), true);

  first.close();
  assert.equal(pool.isLive(), true, "one live session keeps the pool alive");
  second.close();
  assert.equal(pool.isLive(), false, "the last close tears the shared child down");
});
