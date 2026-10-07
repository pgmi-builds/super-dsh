/**
 * agy-hub-supervisor.test.mjs — the SPAWN contract and the failure taxonomy
 * of the `agy --hub` lifetime.
 *
 * The distinction this file exists to protect: "this binary has no hub face"
 * is permanent and must push the caller onto the documented stream-json
 * transport, while "we lost a race" is transient and must not. Collapsing
 * the two into one error is how a fallback silently becomes the only path.
 *
 * Second contract, and the one that cost real debugging time on 2026-10-03:
 * `--hub` without `AGY_ENABLE_HUB=1` does NOT error — the binary falls
 * through to the TUI and dies with a bubbletea message that says nothing
 * about hub mode. The env is therefore asserted from the child's own view
 * (AGY_MOCK_TRACE), not from our intentions.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const fixtures = join(here, "..", "fixtures");
const dist = join(here, "..", "dist");
const mockBin = join(fixtures, "mock_agy_hub_bin.sh");

const {
  AgyHubSupervisor,
  AgyHubUnavailableError,
  DEFAULT_HUB_STARTUP_TIMEOUT_MS,
  HUB_ENV,
  buildHubArgs,
  buildHubEnv,
  hubDiscoveryDir,
  parseHubBanner,
  pickFreePort,
  readHubDiscovery,
} = await import(join(dist, "agy-hub-supervisor.js"));

const BANNER = `
  Antigravity server is running.

  Server version:  2.19.1
  CLI version:  1.2.15

  \u279c  Open in your browser:  http://localhost:5395

  Press Ctrl-C to stop the server.
`;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ─── pure: argv / env / banner / ports / discovery ──────────────────────────

test("buildHubArgs is the measured argv, in order, with extras last", () => {
  assert.deepEqual(
    buildHubArgs({ port: 5395, csrfToken: "tok" }),
    ["--hub", "--hub-port=5395", "--app_data_dir=antigravity", "--csrf_token=tok"],
  );
  assert.deepEqual(
    buildHubArgs({ port: 1, csrfToken: "t", appDataDir: "antigravity-ide", extraArgs: ["--add-dir=/tmp"] }),
    ["--hub", "--hub-port=1", "--app_data_dir=antigravity-ide", "--csrf_token=t", "--add-dir=/tmp"],
  );
});

test("buildHubEnv forces the four hub-critical vars over the ambient env", () => {
  const env = buildHubEnv(
    { PATH: "/usr/bin", AGY_ENABLE_HUB: "0", GEMINI_API_KEY: "k" },
    { AGY_MOCK_TRACE: "/tmp/t" },
  );
  assert.equal(env.AGY_ENABLE_HUB, "1");
  assert.equal(env.ANTIGRAVITY_VSCODE_HOST, "1");
  assert.equal(env.ANTIGRAVITY_AUTH_SUCCESS_APP, "vscode");
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GEMINI_API_KEY, "k");
  assert.equal(env.AGY_MOCK_TRACE, "/tmp/t");
  assert.deepEqual(Object.keys(HUB_ENV).sort(), [
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "AGY_ENABLE_HUB",
    "ANTIGRAVITY_AUTH_SUCCESS_APP",
    "ANTIGRAVITY_VSCODE_HOST",
  ]);
});

test("parseHubBanner reads the only version source, and stays quiet otherwise", () => {
  assert.deepEqual(parseHubBanner(BANNER), {
    serverVersion: "2.19.1",
    cliVersion: "1.2.15",
    url: "http://localhost:5395",
  });
  assert.deepEqual(parseHubBanner("flags provided but not defined: -hub"), {});
  // the banner arrives interleaved with the partial line before it
  assert.deepEqual(parseHubBanner(`noise\n  Antigravity server is running.\n\n  Server version:  3.0.0\n`), {
    serverVersion: "3.0.0",
    cliVersion: undefined,
    url: undefined,
  });
});

test("pickFreePort hands back a bindable port", async () => {
  const port = await pickFreePort();
  assert.ok(port > 1024);
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
});

test("readHubDiscovery is best-effort and path-derived", () => {
  const geminiDir = tempDir("agy-discovery-");
  assert.equal(readHubDiscovery(geminiDir, "antigravity"), undefined);
  const dir = hubDiscoveryDir(geminiDir, "antigravity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ls_e3b0c442.json"),
    JSON.stringify({ pid: 1234, httpsPort: 40849, httpPort: 5395, lsVersion: "1.11.0" }),
  );
  assert.equal(readHubDiscovery(geminiDir, "antigravity")?.lsVersion, "1.11.0");
  assert.equal(hubDiscoveryDir("/home/u1/.gemini", "antigravity"), "/home/u1/.gemini/antigravity/daemon");
});

// ─── spawn: the lifetime and its failure taxonomy ───────────────────────────

test("start() spawns the measured env/argv, serves, and stop() reaps it", async (t) => {
  const trace = join(tempDir("agy-hub-trace-"), "trace.jsonl");
  const geminiDir = tempDir("agy-hub-gemini-");
  const daemonDir = hubDiscoveryDir(geminiDir, "antigravity");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(daemonDir, "ls_abc.json"), JSON.stringify({ lsVersion: "1.11.0", pid: 1 }));

  const supervisor = new AgyHubSupervisor({
    agyBin: mockBin,
    geminiDir,
    env: { AGY_MOCK_TRACE: trace },
  });
  const handle = await supervisor.start();
  t.after(async () => {
    await handle.stop();
  });

  assert.match(handle.endpoint.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(handle.endpoint.instanceId, `mock-${new URL(handle.endpoint.baseUrl).port}`);
  assert.equal(handle.endpoint.lsVersion, "1.11.0", "discovery file feeds version negotiation");
  assert.deepEqual(handle.banner, {
    serverVersion: "2.19.1",
    cliVersion: "1.2.15",
    url: `http://localhost:${new URL(handle.endpoint.baseUrl).port}`,
  });
  assert.deepEqual(await handle.client.healthz(), {
    instanceId: handle.endpoint.instanceId,
    status: "ok",
  });

  const traced = JSON.parse(readFileSync(trace, "utf8").trim());
  assert.deepEqual(traced.argv.slice(0, 4), [
    "--hub",
    `--hub-port=${new URL(handle.endpoint.baseUrl).port}`,
    "--app_data_dir=antigravity",
    `--csrf_token=${handle.endpoint.csrfToken}`,
  ]);
  // the contract that a bare --hub is not enough
  assert.equal(traced.env.AGY_ENABLE_HUB, "1");
  assert.equal(traced.env.ANTIGRAVITY_VSCODE_HOST, "1");
  assert.equal(traced.env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");

  const pid = handle.pid;
  assert.ok(pid);
  await handle.stop();
  assert.equal(await waitForExit(pid), true, "SIGTERM must reap the hub");
  await handle.stop(); // idempotent
});

test("a binary without a hub face is permanent, not transient", async () => {
  const supervisor = new AgyHubSupervisor({ agyBin: mockBin, env: { AGY_HUB_MODE: "no-flag" } });
  await assert.rejects(supervisor.start(), (error) => {
    assert.ok(error instanceof AgyHubUnavailableError);
    assert.equal(error.reason, "no-hub-flag");
    assert.equal(error.permanent, true);
    assert.match(error.message, /no --hub face/);
    return true;
  });
});

test("the missing-AGY_ENABLE_HUB symptom surfaces as exited-early, with the output", async () => {
  const supervisor = new AgyHubSupervisor({ agyBin: mockBin, env: { AGY_HUB_MODE: "tty" } });
  await assert.rejects(supervisor.start(), (error) => {
    assert.equal(error.reason, "exited-early");
    assert.equal(error.permanent, false);
    assert.match(error.output, /bubbletea/);
    assert.match(error.message, /exited with code 1/);
    return true;
  });
});

test("a hub that never answers /healthz times out and is reaped, not orphaned", async () => {
  const pidFile = join(tempDir("agy-hub-pid-"), "pid");
  const supervisor = new AgyHubSupervisor({
    agyBin: mockBin,
    env: { AGY_HUB_MODE: "hang", AGY_MOCK_PID_FILE: pidFile },
    startupTimeoutMs: 1500,
    pollIntervalMs: 100,
    stopGraceMs: 1000,
  });
  await assert.rejects(supervisor.start(), (error) => {
    assert.ok(error instanceof AgyHubUnavailableError);
    assert.equal(error.reason, "startup-timeout");
    assert.equal(error.permanent, false);
    assert.match(error.message, /did not answer \/healthz/);
    return true;
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0, "the mock must have reported its pid");
  assert.equal(await waitForExit(pid), true, "a timed-out hub must not be left running");
});


test("defaults are sane", () => {
  assert.equal(DEFAULT_HUB_STARTUP_TIMEOUT_MS, 30_000);
});
