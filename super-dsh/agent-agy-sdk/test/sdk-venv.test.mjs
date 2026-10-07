#!/usr/bin/env node
/**
 * sdk-venv.test.mjs — the lazy durable venv bootstrap.
 *
 * The 2026-10-02 ruling ships this package with NO Python dependency and NO
 * postinstall: the venv is fetched on first real use. That makes the bootstrap
 * itself load-bearing, so it is tested against a REAL filesystem with an
 * injected command runner (no network, no pip):
 *   - fresh fetch runs create-venv then install, in that order;
 *   - a complete venv short-circuits (second use is free);
 *   - a half-built venv repairs in place instead of re-creating;
 *   - failure leaves a durable trace and NO success marker;
 *   - a stale lock is reclaimed; a live lock is waited on, then reused.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");
const { ensureSdkVenv, readSdkVenvRecord, resolveSdkPython, sdkVenvLayout } =
  await import(join(dist, "sdk-venv.js"));

/** A world home in a throwaway dir (never the live test home). */
const worldHome = () => mkdtempSync(join(tmpdir(), "agy-sdkvenv-"));

/**
 * Fake `python3 -m venv` / `pip install`: materializes the files the real
 * commands would, so the existence checks in the bootstrap stay honest.
 */
function fakeRunner(log) {
  return (cmd, args) => {
    log.push([cmd, ...args]);
    if (args[0] === "-m" && args[1] === "venv") {
      const dir = args[2];
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin", "python"), "#!/bin/sh\n");
      return;
    }
    if (args[0] === "install") {
      // pip lives in the venv created by the previous step
      const pip = cmd;
      const bin = pip.slice(0, pip.lastIndexOf("/"));
      writeFileSync(join(bin, "python"), "#!/bin/sh\n");
      writeFileSync(join(bin, "pip"), "#!/bin/sh\n");
      return;
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
}

test("fresh fetch: creates the venv then installs the SDK, and returns its python", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);
  const log = [];

  const python = await ensureSdkVenv(home, { run: fakeRunner(log), basePython: "python3.12" });

  assert.equal(python, layout.python);
  assert.deepEqual(log, [
    ["python3.12", "-m", "venv", layout.dir],
    [layout.pip, "install", "-q", "google-antigravity"],
  ]);
  assert.ok(existsSync(layout.python), "interpreter exists");
  assert.ok(existsSync(layout.marker), "success marker written last");
  assert.equal(existsSync(layout.errorLog), false, "no failure trace on success");
  assert.equal(existsSync(layout.lock), false, "lock released");
  assert.deepEqual(readSdkVenvRecord(home)?.package, "google-antigravity");
  assert.equal(resolveSdkPython(home), layout.python);
});

test("second use is free: a complete venv runs nothing at all", async () => {
  const home = worldHome();
  const log = [];
  await ensureSdkVenv(home, { run: fakeRunner(log) });
  assert.equal(log.length, 2);

  const again = [];
  const python = await ensureSdkVenv(home, {
    run: (cmd, args) => {
      again.push([cmd, ...args]);
      throw new Error("must not run");
    },
  });
  assert.deepEqual(again, [], "idempotent: no create, no install, no network");
  assert.equal(python, sdkVenvLayout(home).python);
});

test("half-built venv (interpreter but no marker) repairs in place, not from scratch", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);
  mkdirSync(join(layout.dir, "bin"), { recursive: true });
  writeFileSync(layout.python, "#!/bin/sh\n");
  const log = [];

  await ensureSdkVenv(home, { run: fakeRunner(log) });

  assert.deepEqual(log, [[layout.pip, "install", "-q", "google-antigravity"]],
    "the venv is reused; only the install step re-runs");
  assert.ok(existsSync(layout.marker));
});

test("failure leaves a durable trace, no marker, and a single actionable error", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);

  await assert.rejects(
    () => ensureSdkVenv(home, {
      run: () => { throw new Error("pip: no network"); },
      basePython: "python3",
    }),
    (err) => {
      assert.match(err.message, /could not fetch the Python SDK venv/);
      assert.match(err.message, /pip: no network/);
      assert.match(err.message, new RegExp(layout.errorLog.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );

  assert.equal(existsSync(layout.marker), false, "a failed fetch never looks complete");
  assert.equal(resolveSdkPython(home), undefined);
  assert.match(readFileSync(layout.errorLog, "utf8"), /google-antigravity fetch failed: pip: no network/);
  assert.equal(existsSync(layout.lock), false, "lock released even on failure");
});

test("a retry after a failure succeeds and clears the stale trace", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);
  await assert.rejects(() => ensureSdkVenv(home, { run: () => { throw new Error("boom"); } }));
  assert.ok(existsSync(layout.errorLog));

  const log = [];
  const python = await ensureSdkVenv(home, { run: fakeRunner(log) });
  assert.equal(python, layout.python);
  assert.equal(existsSync(layout.errorLog), false, "trace cleared once the fetch succeeds");
});

test("a stale lock is reclaimed instead of deadlocking the first turn", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);
  mkdirSync(layout.lock);
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  utimesSync(layout.lock, old, old);

  const log = [];
  const python = await ensureSdkVenv(home, { run: fakeRunner(log), lockStaleMs: 60_000 });

  assert.equal(python, layout.python);
  assert.equal(log.length, 2, "the fetch ran despite the abandoned lock");
  assert.equal(existsSync(layout.lock), false);
});

test("a live lock is waited on; when a peer finishes, the waiter reuses it without fetching", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);
  mkdirSync(layout.lock);

  // Simulate the peer completing its fetch while we wait: the first poll tick
  // materializes the venv + marker.
  let ticks = 0;
  const sleep = async () => {
    ticks += 1;
    const dir = join(layout.dir, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(layout.python, "#!/bin/sh\n");
    writeFileSync(layout.marker, "{}\n");
  };
  const log = [];
  const python = await ensureSdkVenv(home, {
    run: fakeRunner(log),
    sleep,
    lockPollMs: 5,
    lockTimeoutMs: 5_000,
  });

  assert.equal(ticks, 1, "waited once, then saw the peer's completed venv");
  assert.deepEqual(log, [], "the waiter did not run create/install itself");
  assert.equal(python, layout.python);
  assert.ok(existsSync(layout.lock),
    "the lock belonged to the peer: a waiter that never acquired it must not release it");
});

test("a lock that is never released times out with a pointer to the lock path", async () => {
  const home = worldHome();
  const layout = sdkVenvLayout(home);
  mkdirSync(layout.lock);

  await assert.rejects(
    () => ensureSdkVenv(home, {
      run: () => { throw new Error("must not run"); },
      sleep: async () => { },
      lockPollMs: 1,
      lockTimeoutMs: 0,
    }),
    /timed out waiting for a concurrent SDK venv fetch/,
  );
  assert.ok(existsSync(layout.lock), "we never owned it, so we must not delete it");
});
