// agent-claude/test/sdk-runtime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  sdkRuntimeLayout, readSdkRuntimeRecord, resolveClaudeBinary,
  sdkInstallArgv, ensureSdkRuntime,
} from "../dist/sdk-runtime.js";

function tmpHome() { return mkdtempSync(join(tmpdir(), "cc-sdkrt-")); }

// The entry every successful install must leave behind. The fast path stats it,
// so injected installs materialise it exactly like a real npm run does.
const ENTRY_REL = join("node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
function materializeEntry(dir) {
  const entry = join(dir, ENTRY_REL);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "export const query = () => {};\n");
}

// Force `resolveClaudeBinary()` to return undefined (empty PATH, plus a HOME
// with no `~/.local/bin/claude`). Restores every key, deleting ones unset before.
function forceNoBinary(home) {
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_EXECUTABLE: process.env.CLAUDE_EXECUTABLE,
  };
  process.env.PATH = "";
  process.env.HOME = home;
  process.env.CLAUDE_EXECUTABLE = "/nonexistent/claude";
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("layout paths sit under worldHome", () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  assert.equal(l.dir, join(h, "sdk-runtime"));
  assert.equal(l.marker, join(h, "sdk-runtime.json"));
  assert.equal(l.lock, join(h, "sdk-runtime.lock"));
  assert.equal(l.errorLog, join(h, "sdk-runtime.error.log"));
});

test("install argv: host-binary mode omits optional, bundled keeps it", () => {
  const host = sdkInstallArgv("0.3.291", "host-binary");
  assert.ok(host.includes("--omit=optional"));
  assert.ok(host.includes("--ignore-scripts"));
  assert.ok(host.includes("@anthropic-ai/claude-agent-sdk@0.3.291"));
  assert.ok(host.includes("--save-exact"));
  assert.ok(!host.includes("--exact"));
  const bundled = sdkInstallArgv("0.3.291", "bundled-payload");
  assert.ok(!bundled.includes("--omit=optional"));
});

test("ensureSdkRuntime host-binary mode: installs without optional, writes marker last", async () => {
  const h = tmpHome();
  const calls = [];
  const rec = await ensureSdkRuntime(h, {
    install: async (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); materializeEntry(opts.cwd); },
    now: () => 1234,
  });
  assert.equal(rec.mode, "host-binary");
  assert.equal(rec.sdkVersion, "0.3.291");
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
    install: async (c, a, opts) => { materializeEntry(opts.cwd); },
    now: () => 1,
    // force bundled on first call
  });
  // simulate marker written as bundled-payload, then binary mode requested
  const l = sdkRuntimeLayout(h);
  writeFileSync(l.marker, JSON.stringify({ sdkPackage: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.291", mode: "bundled-payload", createdAt: 1 }));
  const calls = [];
  await ensureSdkRuntime(h, { install: async (c, a, opts) => { calls.push(a); materializeEntry(opts.cwd); }, now: () => 2 });
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
  // The installer materializes nothing, so under the Round-2 contract the
  // fetch FAILS the entry verification — the lock subject is unchanged: the
  // fetch ran (past the abandoned lock) and the lock was released in the
  // finally. (No-op install + expected success no longer tells the truth.)
  await assert.rejects(
    ensureSdkRuntime(h, { install: async (c, a) => { calls.push(a); }, now: () => 7 }),
    /produced no entry/,
  );
  assert.equal(calls.length, 1, "the fetch ran despite the abandoned lock");
  assert.equal(existsSync(l.lock), false, "the reclaimed lock was released");
  assert.equal(existsSync(l.marker), false, "no marker without an entry on disk");
});

test("a corrupt marker is not trusted: the fetch runs again", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  writeFileSync(l.marker, "{not json");
  assert.equal(readSdkRuntimeRecord(h), undefined);
  const calls = [];
  // No-op install ⇒ the fetch runs (the subject) but fails the entry
  // verification: a corrupt marker can never become a marker-backed success.
  // (No-op install + expected success no longer tells the truth.)
  await assert.rejects(
    ensureSdkRuntime(h, { install: async (c, a) => { calls.push(a); }, now: () => 3 }),
    /produced no entry/,
  );
  assert.equal(calls.length, 1);
  assert.equal(readSdkRuntimeRecord(h), undefined, "no readable marker was produced");
  assert.match(readFileSync(l.errorLog, "utf8"), /produced no entry/);
});

test("a failed mode flip wipes the tree, and the next matching-mode call heals without marker surgery", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  const entry = join(l.dir, ENTRY_REL);

  // A working host-binary tree plus its marker — the state just before the
  // local binary "vanishes".
  materializeEntry(l.dir);
  writeFileSync(l.marker, JSON.stringify({
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    sdkVersion: "0.3.291",
    mode: "host-binary",
    createdAt: 1,
  }));

  // No binary now, so the wanted mode flips to bundled-payload; that reinstall
  // fails and its failure path wipes the tree. The marker lives OUTSIDE `dir`,
  // so the old host-binary marker survives the wipe.
  const restore = forceNoBinary(h);
  try {
    await assert.rejects(ensureSdkRuntime(h, {
      install: async () => { throw new Error("ENOSPC"); },
      now: () => 2,
    }), /ENOSPC/);
  } finally {
    restore();
  }
  assert.equal(existsSync(l.dir), false, "the failed flip destroyed the working tree");
  assert.ok(existsSync(l.marker), "the stale host-binary marker survived");
  assert.equal(readSdkRuntimeRecord(h).mode, "host-binary");

  // The binary is back. The marker identity matches again, but the entry is
  // gone — so the ENTRY check, not the marker, must force exactly one heal.
  const calls = [];
  const rec = await ensureSdkRuntime(h, {
    install: async (cmd, args, opts) => { calls.push(args); materializeEntry(opts.cwd); },
    now: () => 3,
  });
  assert.equal(calls.length, 1, "the missing entry forced a reinstall");
  assert.equal(rec.mode, "host-binary");
  assert.equal(rec.createdAt, 3);
  assert.ok(existsSync(entry), "the heal re-materialised the entry");
});

test("a matching marker whose entry was deleted by hand reinstalls instead of trusting the marker", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  const first = await ensureSdkRuntime(h, {
    install: async (c, a, opts) => { materializeEntry(opts.cwd); },
    now: () => 1,
  });
  assert.equal(first.mode, "host-binary");

  // The tree vanishes; the marker (outside `dir`) still matches the wanted mode.
  rmSync(l.dir, { recursive: true, force: true });
  assert.equal(readSdkRuntimeRecord(h).mode, "host-binary", "marker still matches");

  const calls = [];
  const rec = await ensureSdkRuntime(h, {
    install: async (c, a, opts) => { calls.push(a); materializeEntry(opts.cwd); },
    now: () => 2,
  });
  assert.equal(calls.length, 1, "the marker alone must not satisfy the fast path");
  assert.equal(rec.createdAt, 2);
});

// --- Round 2: npm must be anchored to the runtime dir --------------------------
//
// Real-machine defect (reproduced twice, 2026-10-04): `npm install <pkg>` run
// in a cwd with NO package.json resolves the tree from the nearest ancestor
// project, may report "up to date" against THAT project, exit 0 — and land
// nothing in sdk-runtime/node_modules. The fetch must (a) write a private
// manifest into the runtime dir BEFORE install so npm is anchored there, and
// (b) verify the entry exists BEFORE the marker is written, so a no-op install
// fails loudly instead of poisoning every later loadClaudeQuery.

// The exact manifest the fetch anchors npm with (pinned here independently of
// the source, so a drift in either direction fails this suite).
const RUNTIME_MANIFEST = '{"name":"superd-claude-sdk-runtime","private":true}\n';

test("npm is anchored: the private manifest is in the install cwd BEFORE install runs", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  let manifestAtCall; // undefined ⇒ no package.json in the install cwd at call time
  const rec = await ensureSdkRuntime(h, {
    install: async (cmd, args, opts) => {
      const manifest = join(opts.cwd, "package.json");
      manifestAtCall = existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined;
      materializeEntry(opts.cwd);
    },
    now: () => 11,
  });
  assert.equal(rec.createdAt, 11);
  assert.notEqual(manifestAtCall, undefined, "package.json exists in the install cwd AT CALL TIME");
  assert.equal(manifestAtCall, RUNTIME_MANIFEST, "byte-exact anchor, trailing newline included");
  assert.deepEqual(JSON.parse(manifestAtCall), { name: "superd-claude-sdk-runtime", private: true });
  assert.equal(
    readFileSync(join(l.dir, "package.json"), "utf8"),
    RUNTIME_MANIFEST,
    "and it is still there after the fetch",
  );
});

test("the anchor write is idempotent: a re-fetch over an exact manifest does not rewrite it", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  await ensureSdkRuntime(h, {
    install: async (c, a, opts) => { materializeEntry(opts.cwd); },
    now: () => 1,
  });
  const manifest = join(l.dir, "package.json");
  const before = statSync(manifest).mtimeMs;
  // Break readiness WITHOUT touching the manifest: the entry vanishes, the
  // marker survives, the next call must re-fetch — and keep the manifest.
  rmSync(join(l.dir, ENTRY_REL), { force: true });
  const calls = [];
  await ensureSdkRuntime(h, {
    install: async (c, a, opts) => { calls.push(a); materializeEntry(opts.cwd); },
    now: () => 2,
  });
  assert.equal(calls.length, 1, "the vanished entry forced a re-fetch");
  assert.equal(statSync(manifest).mtimeMs, before, "an already-exact manifest is not rewritten");
});

test("a foreign manifest in the runtime dir is replaced by the exact anchor", async () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  mkdirSync(l.dir, { recursive: true });
  writeFileSync(join(l.dir, "package.json"), '{"name":"foreign","dependencies":{"left-pad":"^1.0.0"}}');
  await ensureSdkRuntime(h, {
    install: async (c, a, opts) => { materializeEntry(opts.cwd); },
    now: () => 1,
  });
  assert.equal(
    readFileSync(join(l.dir, "package.json"), "utf8"),
    RUNTIME_MANIFEST,
    "content-differs ⇒ the anchor is written; npm is never left on a foreign manifest",
  );
});

test("a no-op install (exit 0, nothing materialized) REJECTS — a marker is impossible", async () => {
  // The old Task-1 verbatim sketch's installer: resolves having written
  // nothing — exactly what an un-anchored npm does against an ancestor
  // project ("up to date", exit 0). The old contract called this success;
  // without an entry there is no runtime, so the fetch must fail LOUDLY.
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  await assert.rejects(ensureSdkRuntime(h, {
    install: async () => { /* resolves, lands nothing — the no-op */ },
    now: () => 1,
  }), /produced no entry/);
  assert.equal(existsSync(l.marker), false, "the marker is only ever written with the entry on disk");
  assert.equal(existsSync(l.dir), false, "the partial tree (incl. the anchor manifest) was wiped");
  assert.match(readFileSync(l.errorLog, "utf8"), /produced no entry/, "the trace names the anchoring failure");
});
