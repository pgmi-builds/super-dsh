import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The new-chat permission contract (2026-10-03).
 *
 * OMP pins `--approval-mode` at launch and neither the RPC nor the SDK face can
 * move it mid-session, so the ONLY moment a user's permission pick can become
 * real is the materialization of that session's child. Both halves are pinned
 * here:
 *
 *   1. the launch flag is resolved AT SPAWN from the session's own
 *      `permission/preset` events (the draft's pin is only a fallback), and
 *   2. `/permission` is applied while the child does not exist yet and refused
 *      once it does — the adapter must never append a preset it cannot honor.
 *
 * The argv half (a thunk resolved only when the sidecar session is created) is
 * pinned behaviorally at the bottom of this file, with a fake spawn.
 *
 *   1. the launch flag is resolved AT SPAWN from the session's own
 *      `permission/preset` events (the draft's pin is only a fallback), and
 *   2. `/permission` is applied while the child does not exist yet and refused
 *      once it does — the adapter must never append a preset it cannot honor.
 */
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const { ompPermissionCommand, resolveSpawnPermission } = await import(join(dist, "permission.js"));
const { sdkRuntimeLayout } = await import(join(dist, "sdk-runtime.js"));
const { LazyOmpRpc } = await import(join(dist, "lazy-rpc.js"));
const { createOmpSdkSidecarPool } = await import(join(dist, "sdk-client.js"));

const preset = (name) => ({ type: "permission/preset", time: 1, data: { preset: name } });
const NAMES = ["read-only", "workspace-write", "danger-full-access"];

test("spawn approval mode follows the session's LATEST preset, not the create-time default", () => {
  // The draft is stamped `danger-full-access` by pinInitialPermission when it
  // publishes; the user then picks `workspace-write` in the new chat before the
  // first prompt. The child must launch `write`.
  assert.deepEqual(
    resolveSpawnPermission([preset("danger-full-access"), preset("workspace-write")], "danger-full-access", undefined),
    { approvalMode: "write", preset: "workspace-write" },
  );
});

test("no preset event → the composition default decides; OMP_APPROVAL_MODE still wins", () => {
  assert.deepEqual(resolveSpawnPermission([], "workspace-write", undefined), { approvalMode: "write", preset: "workspace-write" });
  assert.deepEqual(resolveSpawnPermission([], undefined, undefined), { approvalMode: "yolo", preset: undefined });
  assert.deepEqual(resolveSpawnPermission([preset("read-only")], "workspace-write", "yolo"), { approvalMode: "yolo", preset: "read-only" });
});

test("an unknown preset name in the log is ignored, never forwarded to omp", () => {
  assert.deepEqual(
    resolveSpawnPermission([preset("read-only"), preset("nope")], undefined, undefined),
    { approvalMode: "always-ask", preset: "read-only" },
  );
});

test("/permission before the child exists applies the pick (the new-chat path)", () => {
  const d = ompPermissionCommand({ rawInput: " workspace-write ", spawned: false, names: NAMES, current: "danger-full-access" });
  assert.equal(d.action, "apply");
  assert.equal(d.preset, "workspace-write");
  assert.equal(d.result.kind, "success");
});

test("/permission after the child exists is refused instead of faking a pre-spawn fact", () => {
  const d = ompPermissionCommand({ rawInput: "read-only", spawned: true, names: NAMES, current: "danger-full-access" });
  assert.equal(d.action, "settled");
  assert.equal(d.result.kind, "error");
  assert.match(d.result.text, /new chat|first prompt/i);
});

test("/permission with no argument reports the current preset; an unknown name errors", () => {
  const info = ompPermissionCommand({ rawInput: "  ", spawned: true, names: NAMES, current: "workspace-write" });
  assert.equal(info.result.kind, "success");
  assert.match(info.result.text, /workspace-write/);

  const bad = ompPermissionCommand({ rawInput: "sudo", spawned: false, names: NAMES, current: "workspace-write" });
  assert.equal(bad.action, "settled");
  assert.equal(bad.result.kind, "error");
  assert.match(bad.result.text, /unknown preset/);
});

/**
 * The argv-thunk half: a permission pick made AFTER the wrapper exists must
 * still reach the sidecar session. `LazyOmpRpc` therefore takes a thunk, and
 * the thunk is invoked exactly once, at the first dispatch — never at
 * construction.
 *
 * The SDK face has no `omp --mode rpc` process to inspect, so the observable
 * argv is the `session.create` params the pool sends (the fake child records
 * them). No bun, no network: `runtimeFetch` + `spawnProcess` are injected.
 */
test("the spawn-args thunk is resolved at first dispatch and reaches session.create", async () => {
  const home = mkdtempSync(join(tmpdir(), "omp-sdk-perm-"));
  const createRequests = [];
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.stdin.write = (chunk, callback) => {
    let frame = {};
    try {
      frame = JSON.parse(String(chunk));
    } catch {
      /* ignore */
    }
    if (frame.method === "session.create") createRequests.push(frame.params);
    if (typeof frame.id === "number") {
      const result = frame.method === "session.create" ? { handle: `h${frame.id}` } : {};
      queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ id: frame.id, ok: true, result }) + "\n"));
    }
    if (typeof callback === "function") callback();
    return true;
  };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};

  const pool = createOmpSdkSidecarPool({
    worldHome: home,
    env: {},
    runtimeFetch: async (target) => {
      const layout = sdkRuntimeLayout(target);
      return {
        pluginVersion: "9.9.9",
        packageVersion: "18.5.0",
        bunVersion: "1.4.2",
        bunPath: layout.bun,
        installedAt: new Date(0).toISOString(),
      };
    },
    spawnProcess: () => {
      queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ event: "ready", payload: { protocol: 0 } }) + "\n"));
      return child;
    },
  });

  let resolutions = 0;
  const rpc = new LazyOmpRpc(() => {
    resolutions += 1;
    return ["--approval-mode", "write"];
  }, "/tmp", pool);

  // Construction is inert: the thunk has not been consulted and no session
  // exists on the sidecar.
  assert.equal(resolutions, 0, "the thunk must not run at construction");
  assert.deepEqual(createRequests, [], "no sidecar session before the first dispatch");

  await rpc.ensureStarted();
  assert.equal(resolutions, 1, "the thunk runs exactly once, at the first dispatch");
  assert.equal(createRequests.length, 1, "exactly one session was created");
  assert.equal(createRequests[0].approvalMode, "write", "the resolved approval mode reached session.create");

  await rpc.ensureStarted();
  assert.equal(resolutions, 1, "later dispatches reuse the spawned session (no re-resolve)");
  assert.equal(createRequests.length, 1);
  rpc.close();
});
