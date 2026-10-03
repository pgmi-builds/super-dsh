// Permission 3:3 mapping (plan Task 7) — preset table, env override, event replay.
import test from "node:test";
import assert from "node:assert/strict";

const { isPresetName, envApprovalMode, codexApprovalMode, permissionEventsFor, presetFromEvents } = await import("../dist/permission.js");

test("preset table maps 3 Dash presets onto codex sandbox + approvalPolicy", async () => {
  assert.deepEqual(
    ["danger-full-access", "workspace-write", "read-only"].map((preset) => codexApprovalMode(preset)),
    ["never", "on-request", "never"],
  );
  assert.deepEqual(["danger-full-access", "workspace-write", "read-only"].map(isPresetName), [true, true, true]);
  // The sandbox half rides the permission events (Dash-side facts).
  const events = permissionEventsFor("workspace-write", 1000);
  assert.deepEqual(events.map((event) => event.type), ["permission/preset", "sandbox/mode", "approval/policy"]);
  assert.deepEqual(events[1].data, { mode: "workspace-write" });
  assert.deepEqual(events[2].data, { policy: "ask" });
});

test("unknown/missing preset falls back to never (sandbox remains the constraint)", () => {
  assert.equal(codexApprovalMode(undefined), "never");
  assert.equal(codexApprovalMode("yolo"), "never");
  assert.equal(isPresetName("yolo"), false);
});

test("CODEX_APPROVAL_MODE: valid policy overrides, invalid ignored", async () => {
  const original = process.env.CODEX_APPROVAL_MODE;
  try {
    process.env.CODEX_APPROVAL_MODE = "untrusted";
    assert.equal(envApprovalMode(), "untrusted");
    process.env.CODEX_APPROVAL_MODE = "on-failure";
    assert.equal(envApprovalMode(), "on-failure");
    process.env.CODEX_APPROVAL_MODE = "yolo"; // omp vocabulary is not codex vocabulary
    assert.equal(envApprovalMode(), undefined);
    process.env.CODEX_APPROVAL_MODE = "";
    assert.equal(envApprovalMode(), undefined);
    delete process.env.CODEX_APPROVAL_MODE;
    assert.equal(envApprovalMode(), undefined);
  } finally {
    if (original === undefined) delete process.env.CODEX_APPROVAL_MODE;
    else process.env.CODEX_APPROVAL_MODE = original;
  }
});

test("presetFromEvents: last permission/preset event wins, others ignored", () => {
  const events = [
    { type: "permission/preset", seq: 0, time: 1, data: { preset: "read-only" } },
    { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
    { type: "permission/preset", seq: 2, time: 3, data: { preset: "danger-full-access" } },
    { type: "permission/preset", seq: 3, time: 4, data: { preset: "not-a-preset" } },
  ];
  assert.equal(presetFromEvents(events), "danger-full-access");
  assert.equal(presetFromEvents([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]), undefined);
  assert.equal(presetFromEvents([]), undefined);
});

// ── app-server line: the per-turn fold (2026-10-03) ─────────────────────────

const {
  approvalPolicyFromEvents,
  isSandboxMode,
  sandboxModeForPreset,
  sandboxModeFromEvents,
  sandboxPolicyFor,
  turnPolicyFromEvents,
} = await import("../dist/permission.js");

const WS = "/home/u/ws";

/** Build a session-log-shaped event. */
const ev = (type, data, seq) => ({ type, seq, time: seq, data });

test("sandboxPolicyFor: the three Dash modes become the structured v2 SandboxPolicy", () => {
  assert.deepEqual(sandboxPolicyFor("danger-full-access", WS), { type: "dangerFullAccess" });
  assert.deepEqual(sandboxPolicyFor("read-only", WS), { type: "readOnly", networkAccess: false });
  assert.deepEqual(sandboxPolicyFor("workspace-write", WS), {
    type: "workspaceWrite",
    writableRoots: [WS],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test("sandboxModeForPreset: preset → mode, unknown/absent → danger-full-access (the profile pin)", () => {
  assert.equal(sandboxModeForPreset("read-only"), "read-only");
  assert.equal(sandboxModeForPreset("workspace-write"), "workspace-write");
  assert.equal(sandboxModeForPreset("danger-full-access"), "danger-full-access");
  assert.equal(sandboxModeForPreset(undefined), "danger-full-access");
  assert.equal(sandboxModeForPreset("yolo"), "danger-full-access");
  assert.equal(isSandboxMode("workspace-write"), true);
  assert.equal(isSandboxMode("yolo"), false);
});

test("event folds: only the LAST valid event of each kind wins", () => {
  const events = [
    ev("sandbox/mode", { mode: "read-only" }, 0),
    ev("approval/policy", { policy: "ask" }, 1),
    ev("sandbox/mode", { mode: "workspace-write" }, 2),
    ev("approval/policy", { policy: "bogus" }, 3),
  ];
  assert.equal(sandboxModeFromEvents(events), "workspace-write");
  // The bogus policy is skipped over — the earlier valid one still stands.
  assert.equal(approvalPolicyFromEvents(events), "on-request");
  assert.equal(sandboxModeFromEvents([]), undefined);
  assert.equal(approvalPolicyFromEvents([]), undefined);
});

test("turnPolicyFromEvents: the log drives both halves (this is what makes /permission live)", () => {
  const events = [ev("permission/preset", { preset: "danger-full-access" }, 0), ev("sandbox/mode", { mode: "read-only" }, 1), ev("approval/policy", { policy: "ask" }, 2)];
  assert.deepEqual(turnPolicyFromEvents(events, "danger-full-access", WS), {
    approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false },
  });
});

test("turnPolicyFromEvents: a log with only the preset falls back to the preset table", () => {
  assert.deepEqual(turnPolicyFromEvents([ev("permission/preset", { preset: "workspace-write" }, 0)], "workspace-write", WS), {
    approvalPolicy: "on-request",
    sandbox: { type: "workspaceWrite", writableRoots: [WS], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  });
});

test("turnPolicyFromEvents: an empty log with no preset degrades to the profile pin (danger-full-access / never)", () => {
  assert.deepEqual(turnPolicyFromEvents([], undefined, WS), { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } });
  assert.deepEqual(turnPolicyFromEvents([], "yolo", WS), { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } });
});

test("turnPolicyFromEvents: a HALF-specified log folds the two halves independently", () => {
  // Only a sandbox event: the approval half keeps the preset's value.
  const sandboxOnly = turnPolicyFromEvents([ev("sandbox/mode", { mode: "read-only" }, 0)], "danger-full-access", WS);
  assert.equal(sandboxOnly.approvalPolicy, "never");
  assert.deepEqual(sandboxOnly.sandbox, { type: "readOnly", networkAccess: false });
  // Only an approval event: the sandbox half keeps the preset's value.
  const approvalOnly = turnPolicyFromEvents([ev("approval/policy", { policy: "ask" }, 0)], "workspace-write", WS);
  assert.equal(approvalOnly.approvalPolicy, "on-request");
  assert.equal(approvalOnly.sandbox.type, "workspaceWrite");
});

test("turnPolicyFromEvents: CODEX_APPROVAL_MODE still wins for the approval half only", () => {
  const original = process.env.CODEX_APPROVAL_MODE;
  try {
    process.env.CODEX_APPROVAL_MODE = "untrusted";
    const policy = turnPolicyFromEvents([ev("approval/policy", { policy: "never" }, 0), ev("sandbox/mode", { mode: "read-only" }, 1)], undefined, WS);
    assert.equal(policy.approvalPolicy, "untrusted");
    assert.deepEqual(policy.sandbox, { type: "readOnly", networkAccess: false });
  } finally {
    if (original === undefined) delete process.env.CODEX_APPROVAL_MODE;
    else process.env.CODEX_APPROVAL_MODE = original;
  }
});
