import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The new-chat permission contract (2026-10-03).
 *
 * OMP pins `--approval-mode` at launch and no RPC moves it, so the ONLY moment
 * a user's permission pick can become real is the spawn of that session's
 * `omp --mode rpc` child. Both halves are pinned here:
 *
 *   1. the launch flag is resolved AT SPAWN from the session's own
 *      `permission/preset` events (the draft's pin is only a fallback), and
 *   2. `/permission` is applied while the child does not exist yet and refused
 *      once it does — the adapter must never append a preset it cannot honor.
 */
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const { ompPermissionCommand, resolveSpawnPermission } = await import(join(dist, "permission.js"));

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
