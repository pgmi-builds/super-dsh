import test from "node:test";
import assert from "node:assert/strict";
import { OmpSdkSidecar } from "../dist/sidecar-client.js";

test("sidecar skeleton roundtrip", { skip: "AW-C0: sidecar home redirection (OMP_HOME->PI_CONFIG_DIR plumbing) lands with world boot; sandbox red line blocks real ~/.omp writes" }, async (t) => {
  // AW red line: never touch the real ~/.omp — redirect into the nested home
  // (spec S7 detach-by-redirection; env override for local runs).
  const { mkdirSync } = await import("node:fs");
  const ompHome = process.env.AW_OMP_HOME
    ?? "/home/u1/workspaces/superd/.superd-test/aw/agents/omp";
  mkdirSync(ompHome, { recursive: true });
  const sidecar = new OmpSdkSidecar({ ompHome });
  t.after(() => sidecar.stop());
  const ready = await sidecar.start();
  assert.equal(ready.protocol, 0);

  const ping = await sidecar.call("sys.ping");
  assert.equal(ping.pong, true);
  assert.match(ping.sdk, /^\d+\./);
  assert.match(ping.bun, /^1\./);

  const models = await sidecar.call("models.list");
  assert.ok(models.models.length > 0, "has models");
  assert.ok(models.providers.includes("deepseek"));
  console.log("models:", models.models.length, "providers:", models.providers.join(","));

  const created = await sidecar.call("session.create", { persistence: "memory" });
  assert.ok(created.handle);
  assert.ok(created.sessionId);

  const info = await sidecar.call("session.state", { handle: created.handle });
  assert.equal(info.sessionId, created.sessionId);
  assert.equal(info.isStreaming, false);
  assert.equal(info.messageCount, 0);

  const prompt = await sidecar.call("session.systemPrompt", { handle: created.handle });
  assert.equal(typeof prompt.systemPrompt, "string");
  assert.ok(prompt.systemPrompt.length > 0, "live session renders a non-empty system prompt");

  const disposed = await sidecar.call("session.dispose", { handle: created.handle });
  assert.equal(disposed.disposed, true);

  const listed = await sidecar.call("sessions.list", { all: true });
  assert.ok(Array.isArray(listed.sessions));
  console.log("sessions listed:", listed.sessions.length);
});
