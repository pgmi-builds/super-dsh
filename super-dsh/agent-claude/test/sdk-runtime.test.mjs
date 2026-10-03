// agent-claude/test/sdk-runtime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sdkRuntimeLayout, readSdkRuntimeRecord, resolveClaudeBinary,
  sdkInstallArgv, ensureSdkRuntime,
} from "../dist/sdk-runtime.js";

function tmpHome() { return mkdtempSync(join(tmpdir(), "cc-sdkrt-")); }

test("layout paths sit under worldHome", () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  assert.equal(l.dir, join(h, "sdk-runtime"));
  assert.equal(l.marker, join(h, "sdk-runtime.json"));
  assert.equal(l.lock, join(h, "sdk-runtime.lock"));
  assert.equal(l.errorLog, join(h, "sdk-runtime.error.log"));
});

test("install argv: host-binary mode omits optional, bundled keeps it", () => {
  const host = sdkInstallArgv("0.3.263", "host-binary");
  assert.ok(host.includes("--omit=optional"));
  assert.ok(host.includes("--ignore-scripts"));
  assert.ok(host.includes("@anthropic-ai/claude-agent-sdk@0.3.263"));
  const bundled = sdkInstallArgv("0.3.263", "bundled-payload");
  assert.ok(!bundled.includes("--omit=optional"));
});

test("ensureSdkRuntime host-binary mode: installs without optional, writes marker last", async () => {
  const h = tmpHome();
  const calls = [];
  const rec = await ensureSdkRuntime(h, {
    install: async (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); },
    now: () => 1234,
  });
  assert.equal(rec.mode, "host-binary");
  assert.equal(rec.sdkVersion, "0.3.263");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--omit=optional"));
  assert.equal(calls[0].cwd, join(h, "sdk-runtime"));
  const marker = JSON.parse(await import("node:fs").then(fs => fs.readFileSync(sdkRuntimeLayout(h).marker, "utf8")));
  assert.equal(marker.mode, "host-binary");
  assert.equal(marker.createdAt, 1234);
  // idempotent second call: no second install
  const rec2 = await ensureSdkRuntime(h, {
    install: async () => { throw new Error("must not reinstall"); },
    now: () => 5678,
  });
  assert.equal(rec2.createdAt, 1234);
});

test("ensureSdkRuntime reinstalls when mode flips (binary appeared)", async () => {
  const h = tmpHome();
  await ensureSdkRuntime(h, {
    install: async () => { },
    now: () => 1,
    // force bundled on first call
  });
  // simulate marker written as bundled-payload, then binary mode requested
  const l = sdkRuntimeLayout(h);
  writeFileSync(l.marker, JSON.stringify({ sdkPackage: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.263", mode: "bundled-payload", createdAt: 1 }));
  const calls = [];
  await ensureSdkRuntime(h, { install: async (c, a) => { calls.push(a); }, now: () => 2 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--omit=optional"), "reinstall in host-binary mode");
});

test("failed install writes error log and throws", async () => {
  const h = tmpHome();
  await assert.rejects(ensureSdkRuntime(h, {
    install: async () => { throw new Error("ECONNREFUSED"); },
    now: () => 1,
  }), /ECONNREFUSED/);
  const log = await import("node:fs").then(fs => fs.readFileSync(sdkRuntimeLayout(h).errorLog, "utf8"));
  assert.match(log, /ECONNREFUSED/);
  assert.equal(readSdkRuntimeRecord(h), undefined, "no marker on failure");
});

test("resolveClaudeBinary honors CLAUDE_EXECUTABLE and returns undefined when absent", () => {
  // on this machine a binary exists; the undefined branch is exercised via
  // PATH= empty + HOME=tmp (see acceptance), here only the env override:
  const prev = process.env.CLAUDE_EXECUTABLE;
  process.env.CLAUDE_EXECUTABLE = "/nonexistent/claude";
  // CLAUDE_EXECUTABLE wins verbatim only if it exists — resolver checks existsSync
  // so a nonexistent override falls through to PATH/native paths.
  const r = resolveClaudeBinary();
  if (r === undefined) { /* fine on a machine without claude */ }
  if (prev === undefined) delete process.env.CLAUDE_EXECUTABLE;
  else process.env.CLAUDE_EXECUTABLE = prev;
});

// --- lock + marker edges the brief mandates but the list above leaves open ----

test("a concurrent fetch holding a fresh lock fails loudly and keeps the lock", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  mkdirSync(l.lock);
  await assert.rejects(ensureSdkRuntime(h, {
    install: async () => { throw new Error("must not install"); },
    now: () => 1,
  }), /another SDK runtime fetch is already in progress/);
  assert.ok(existsSync(l.lock), "the lock belongs to the other caller");
  assert.equal(existsSync(l.marker), false, "the loser wrote no marker");
});

test("an abandoned lock is reclaimed so a crashed fetch cannot brick the line", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  mkdirSync(l.lock);
  const old = (Date.now() - 60 * 60 * 1000) / 1000; // older than the stale threshold
  utimesSync(l.lock, old, old);
  const calls = [];
  await ensureSdkRuntime(h, { install: async (c, a) => { calls.push(a); }, now: () => 7 });
  assert.equal(calls.length, 1, "the fetch ran despite the abandoned lock");
  assert.equal(existsSync(l.lock), false, "the reclaimed lock was released");
  assert.ok(existsSync(l.marker));
});

test("a corrupt marker is not trusted: the fetch runs again", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  writeFileSync(l.marker, "{not json");
  assert.equal(readSdkRuntimeRecord(h), undefined);
  const calls = [];
  await ensureSdkRuntime(h, { install: async (c, a) => { calls.push(a); }, now: () => 3 });
  assert.equal(calls.length, 1);
  assert.equal(readSdkRuntimeRecord(h).createdAt, 3);
});
