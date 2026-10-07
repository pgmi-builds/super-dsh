#!/usr/bin/env node
/**
 * sdk-lazy.test.mjs — the lazy-spawn invariant of the opt-in SDK line.
 *
 * The 2026-10-04 ruling: nothing is fetched at install time, and a session that
 * is created but never prompted must fetch nothing either. The provider calls
 * `CodexSdkClient.spawn(...)` at session-create, so THAT call — with the real
 * default factory, not the test seam — is the one that has to stay at zero IO:
 * no world-home write, no runtime directory, no npm, no SDK import.
 *
 * This file deliberately does NOT call `setCodexFactory`: it exercises the
 * production default factory. The fetch itself (real npm + network) is never
 * reached, because a fetch that happens without a prompt is exactly the bug.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { CodexSdkClient, codexClientRefCount } = await import(join(dist, "codex-sdk-client.js"));

/** A world home that does not exist yet, so any write is observable. */
const absentWorldHome = () => join(mkdtempSync(join(tmpdir(), "codex-sdk-lazy-")), "agents", "codex-sdk");

test("constructing a client (the production factory) touches no disk and fetches nothing", async () => {
  const worldHome = absentWorldHome();
  assert.equal(codexClientRefCount(), 0);

  const client = await CodexSdkClient.spawn(["--approval-mode", "on-request"], "/tmp/cwd", worldHome);

  assert.equal(existsSync(worldHome), false, "session-create must not create the world home");
  assert.equal(existsSync(join(worldHome, "sdk-runtime")), false, "no runtime was fetched");
  assert.equal(existsSync(join(worldHome, "sdk-runtime.json")), false, "no marker");
  assert.equal(client.threadId, null, "the deferred thread has no id before its first turn");
  assert.equal(codexClientRefCount(), 1, "the shared handle is refcounted at spawn");

  client.close();
  assert.equal(codexClientRefCount(), 0, "refcount fully released");
});

test("passive queries never materialize the runtime either", async () => {
  const worldHome = absentWorldHome();
  const client = await CodexSdkClient.spawn([], "/tmp/cwd", worldHome);

  // The passive surface the provider/agent uses before a real prompt.
  assert.deepEqual(await client.getState(), { isStreaming: false });
  assert.deepEqual(await client.getMessages(), []);
  assert.deepEqual(await client.getSessionStats(), {});
  assert.deepEqual(await client.getSubagents(), []);
  assert.equal(client.threadId, null);
  assert.equal(client.spawned, true, "the client's surface is live from construction");

  assert.equal(existsSync(worldHome), false, "passive reads must not fetch the runtime");
  client.close();
});

test("a missing world home is refused instead of guessing one from ambient env", async () => {
  assert.equal(codexClientRefCount(), 0);
  await assert.rejects(
    () => CodexSdkClient.spawn([], "/tmp/cwd"),
    /needs the world home to fetch its SDK runtime into/,
  );
  assert.equal(codexClientRefCount(), 0, "a refused spawn leaks no refcount");
});

test("source-level: the runtime fetch is reachable only from the client's default factory", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  // models.ts retired with the provider-store rework (2026-10-04); the
  // canonical catalog now lives in codex-native-config.ts.
  const pluginFiles = ["index.ts", "world-plugin.ts", "agent.ts", "adapter.ts", "codex-store.ts"];
  for (const file of pluginFiles) {
    const text = readFileSync(join(src, file), "utf8");
    assert.doesNotMatch(text, /loadCodexSdk|ensureSdkRuntime/, `${file} must not fetch the SDK runtime`);
  }
  // The one importer of the loader is the client (its default factory).
  assert.match(readFileSync(join(src, "codex-sdk-client.ts"), "utf8"), /loadCodexSdk/);
});
