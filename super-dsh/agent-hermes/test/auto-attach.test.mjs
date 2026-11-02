// Auto-attach (G5, agent-adapter-rules/10-dsh-checkpoints.md): transport mode
// `auto` — the default since 0.3.4-c — starts on stdio and flips to attach,
// process-wide sticky, the moment hermes refuses a stdio spawn because a
// resident gateway owns `~/.hermes`:
//   [gateway-exit] refused: /home/u1/.hermes is owned by a running gateway;
//   attach to it instead
// All child-process behavior is faked through the GatewayProcessFactory seam
// (same pattern as hermes-client.test.mjs): no real python child is spawned.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  HermesGatewayClient,
  setGatewayFactory,
  resolveHermesTransportMode,
  resetHermesAutoAttachForTests,
} from "../dist/hermes-client.js";

const REFUSAL = "[gateway-exit] refused: /home/u1/.hermes is owned by a running gateway; attach to it instead";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends Writable {
  constructor() {
    super();
    this.requests = [];
  }

  _write(chunk, _enc, cb) {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        this.requests.push(JSON.parse(line));
      } catch {
        this.requests.push({ malformed: line });
      }
    }
    cb();
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStdin();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this._exited = false;
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.emitExit(null, signal);
  }

  emitExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  emitLine(obj) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  emitEvent(type, sessionId, payload) {
    const params = { type };
    if (sessionId !== undefined) params.session_id = sessionId;
    if (payload !== undefined) params.payload = payload;
    this.emitLine({ jsonrpc: "2.0", method: "event", params });
  }
}

function withEnv(value, fn) {
  return async () => {
    resetHermesAutoAttachForTests();
    const prev = process.env.SUPERD_HERMES_TRANSPORT;
    if (value === undefined) delete process.env.SUPERD_HERMES_TRANSPORT;
    else process.env.SUPERD_HERMES_TRANSPORT = value;
    try {
      await fn();
    } finally {
      setGatewayFactory(null);
      resetHermesAutoAttachForTests();
      if (prev === undefined) delete process.env.SUPERD_HERMES_TRANSPORT;
      else process.env.SUPERD_HERMES_TRANSPORT = prev;
    }
  };
}

const isStdio = (args) => args.includes("tui_gateway.entry");
const isBridge = (args) => args.some((a) => String(a).includes("hermes-ws-bridge.py"));

/** stdio attempt → refusal on stderr then exit; bridge attempt → gateway.ready. */
function installRefusingFactory(spawns) {
  setGatewayFactory((opts) => {
    spawns.push(opts.args);
    const child = new FakeChild();
    if (isStdio(opts.args)) {
      setImmediate(() => {
        child.stderr.write(`${REFUSAL}\n`);
        setTimeout(() => child.emitExit(1), 10);
      });
    } else {
      setImmediate(() => child.emitEvent("gateway.ready"));
    }
    return child;
  });
}

test("resolveHermesTransportMode: env wins, then .env key, default auto, unknown → auto", () => {
  const prev = process.env.SUPERD_HERMES_TRANSPORT;
  delete process.env.SUPERD_HERMES_TRANSPORT;
  try {
    assert.equal(resolveHermesTransportMode({}), "auto");
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "stdio" }), "stdio");
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "attach" }), "attach");
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "Attach " }), "attach");
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "bogus" }), "auto");
    process.env.SUPERD_HERMES_TRANSPORT = "attach";
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "stdio" }), "attach");
    process.env.SUPERD_HERMES_TRANSPORT = "auto";
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "stdio" }), "auto");
  } finally {
    if (prev === undefined) delete process.env.SUPERD_HERMES_TRANSPORT;
    else process.env.SUPERD_HERMES_TRANSPORT = prev;
  }
});

test("auto: stdio refusal flips to attach within the attempt budget, and the flip is sticky",
  withEnv("auto", async () => {
    const spawns = [];
    installRefusingFactory(spawns);

    const client = HermesGatewayClient.spawn({ lazy: true, readyTimeoutMs: 3000 });
    await client.ensureStarted();
    assert.equal(spawns.length, 2, `expected exactly stdio-then-bridge, got ${JSON.stringify(spawns)}`);
    assert.ok(isStdio(spawns[0]), "first attempt must be stdio (auto starts cheap)");
    assert.ok(isBridge(spawns[1]), "second attempt must be the WS-attach bridge");
    client.close();

    // Sticky: a LATER client in the same process skips the doomed stdio spawn.
    const spawns2 = [];
    setGatewayFactory((opts) => {
      spawns2.push(opts.args);
      const child = new FakeChild();
      setImmediate(() => child.emitEvent("gateway.ready"));
      return child;
    });
    const client2 = HermesGatewayClient.spawn({ lazy: true, readyTimeoutMs: 3000 });
    await client2.ensureStarted();
    assert.equal(spawns2.length, 1);
    assert.ok(isBridge(spawns2[0]), "sticky flip must make the next client's FIRST spawn attach");
    client2.close();
  }));

test("explicit stdio: locked — ownership refusal never flips, budget exhausted, honest failure",
  withEnv("stdio", async () => {
    const spawns = [];
    installRefusingFactory(spawns);

    const client = HermesGatewayClient.spawn({ lazy: true, readyTimeoutMs: 500 });
    await assert.rejects(
      () => client.ensureStarted(),
      (error) => {
        assert.match(error.message, /owned by a running gateway/);
        return true;
      },
    );
    assert.equal(spawns.length, 3, "locked stdio retries stdio only");
    for (const args of spawns) assert.ok(isStdio(args));

    // Lock holds even after a refusal was observed: mode stays stdio.
    assert.equal(resolveHermesTransportMode({ SUPERD_HERMES_TRANSPORT: "stdio" }), "stdio");
  }));

test("explicit attach: never wastes a stdio attempt", withEnv("attach", async () => {
  const spawns = [];
  setGatewayFactory((opts) => {
    spawns.push(opts.args);
    const child = new FakeChild();
    setImmediate(() => child.emitEvent("gateway.ready"));
    return child;
  });
  const client = HermesGatewayClient.spawn({ lazy: true, readyTimeoutMs: 3000 });
  await client.ensureStarted();
  assert.equal(spawns.length, 1);
  assert.ok(isBridge(spawns[0]));
  client.close();
  await delay(5);
}));
