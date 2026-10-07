/**
 * agy-hub-client.test.mjs — pins the three measured gotchas of the
 * `agy --hub` transport, because each of them fails SILENTLY against the
 * real engine and produces a misleading downstream error:
 *
 *   gotcha 1  a wrong `items` shape is dropped by protojson's unknown-field
 *             discard → HTTP 200 `{}` → an empty USER_INPUT step
 *   gotcha 2  `planModel` (enum) or `modelName` (catalog key) alone →
 *             "plan model not specified; you must specify a valid model"
 *   gotcha 3  non-blocking sends never validate → `{}` for success AND
 *             for garbage
 *
 * The first four groups are pure builders, so they fail loudly without any
 * engine. The last two run the client against a local fake Connect server
 * that records the exact request bodies — that is what makes the wire
 * contract assertable without an authenticated agy.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");

const {
  AGENT_API_SOURCE,
  CASCADE_TRAJECTORY_TYPE,
  AgyHubClient,
  AgyHubError,
  agyHubBaseUrl,
  assistantText,
  buildSendMessageRequest,
  buildStartCascadeRequest,
  cascadeConfig,
  errorText,
  parseAvailableModels,
  resolveModel,
  stepKind,
  userInputItems,
  workspaceUri,
} = await import(join(dist, "agy-hub-client.js"));

const SERVICE = "/exa.language_server_pb.LanguageServerService";

/** Local stand-in for `agy --hub`; records every RPC body it receives. */
async function fakeHub(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const method = req.url.startsWith(SERVICE) ? req.url.slice(SERVICE.length + 1) : null;
      calls.push({ method, url: req.url, headers: req.headers, body });
      handler({ method, url: req.url, headers: req.headers, body }, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

// ─── gotcha 1: the only surviving items shape ───────────────────────────────

test("userInputItems emits the sole shape protojson keeps, and trims", () => {
  assert.deepEqual(userInputItems("  hello  "), [{ text: "hello" }]);
  assert.throws(() => userInputItems("   "), AgyHubError);
});

test("buildSendMessageRequest items are [{text}] — never a wrapper object", () => {
  const request = buildSendMessageRequest({
    cascadeId: "c1",
    text: "say OK",
    planModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
    modelName: "gemini-3.8-flash-medium",
  });
  assert.deepEqual(request.items, [{ text: "say OK" }]);
  // exact key set: a guessed field would be discarded by the engine, and an
  // extra one here means someone reintroduced one.
  assert.deepEqual(Object.keys(request).sort(), [
    "blocking",
    "cascadeConfig",
    "cascadeId",
    "items",
  ]);
});

// ─── gotcha 2: planModel + modelName are a mandatory pair ───────────────────

test("cascadeConfig refuses a half-specified planner config", () => {
  assert.deepEqual(cascadeConfig("MODEL_X", "some-model"), {
    plannerConfig: { planModel: "MODEL_X", modelName: "some-model" },
  });
  assert.throws(() => cascadeConfig("", "some-model"), /both planModel/);
  assert.throws(() => cascadeConfig("MODEL_X", ""), /both planModel/);
});

test("buildSendMessageRequest propagates the missing-model failure", () => {
  assert.throws(
    () => buildSendMessageRequest({ cascadeId: "c1", text: "hi", planModel: "", modelName: "m" }),
    /both planModel/,
  );
  assert.throws(
    () => buildSendMessageRequest({ cascadeId: "", text: "hi", planModel: "M", modelName: "m" }),
    /cascadeId/,
  );
});

// ─── gotcha 3: blocking is what makes the engine validate ───────────────────

test("buildSendMessageRequest is always blocking — no opt-out exists", () => {
  const request = buildSendMessageRequest({
    cascadeId: "c1",
    text: "hi",
    planModel: "M",
    modelName: "m",
    blocking: false, // deliberately not part of the options type
  });
  assert.equal(request.blocking, true);
});

// ─── start-cascade request shape ────────────────────────────────────────────

test("buildStartCascadeRequest defaults to the agent-api source", () => {
  assert.deepEqual(buildStartCascadeRequest(), {
    source: AGENT_API_SOURCE,
    trajectoryType: CASCADE_TRAJECTORY_TYPE,
  });
  assert.deepEqual(buildStartCascadeRequest({ workspaces: ["/tmp/x"] }), {
    source: AGENT_API_SOURCE,
    trajectoryType: CASCADE_TRAJECTORY_TYPE,
    workspaceUris: ["file:///tmp/x"],
  });
  assert.deepEqual(buildStartCascadeRequest({ source: "OTHER", trajectoryType: "T", cascadeId: "c" }), {
    source: "OTHER",
    trajectoryType: "T",
    cascadeId: "c",
  });
});

test("workspaceUri insists on absolute paths", () => {
  assert.equal(workspaceUri("/home/u1/x"), "file:///home/u1/x");
  assert.throws(() => workspaceUri("relative/dir"), AgyHubError);
});

// ─── live wire contract against a fake Connect server ───────────────────────

test("rpc targets the LanguageServerService path and carries the CSRF header", async () => {
  const hub = await fakeHub((call, res) => json(res, 200, { ok: call.method }));
  try {
    const client = new AgyHubClient({ baseUrl: hub.baseUrl, csrfToken: "tok-1" });
    const result = await client.rpc("GetUserStatus", {});
    assert.deepEqual(result, { ok: "GetUserStatus" });
    assert.equal(hub.calls[0].url, `${SERVICE}/GetUserStatus`);
    assert.equal(hub.calls[0].headers["x-codeium-csrf-token"], "tok-1");
    assert.equal(hub.calls[0].headers["content-type"], "application/json");
  } finally {
    await hub.close();
  }
});

test("healthz reads the instance id without a token", async () => {
  const hub = await fakeHub((_call, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ instanceId: "inst-9", status: "ok" }));
  });
  try {
    const client = new AgyHubClient({ baseUrl: hub.baseUrl, csrfToken: "x" });
    assert.deepEqual(await client.healthz(), { instanceId: "inst-9", status: "ok" });
    assert.equal(hub.calls[0].url, "/healthz");
  } finally {
    await hub.close();
  }
});

test("Connect failures surface as AgyHubError with code and status", async () => {
  const hub = await fakeHub((call, res) => {
    if (call.method === "StartCascade") {
      json(res, 400, { code: "invalid_argument", message: "CortexTrajectorySource is unspecified" });
      return;
    }
    if (call.method === "GetUserStatus") {
      json(res, 401, { code: "unauthenticated", message: "missing CSRF token" });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404 page not found");
  });
  try {
    const client = new AgyHubClient({ baseUrl: hub.baseUrl, csrfToken: "x" });
    await assert.rejects(client.startCascade(), (error) => {
      assert.ok(error instanceof AgyHubError);
      assert.equal(error.code, "invalid_argument");
      assert.equal(error.status, 400);
      return true;
    });
    await assert.rejects(client.rpc("GetUserStatus"), /missing CSRF token/);
    await assert.rejects(client.rpc("NoSuchMethod"), (error) => {
      assert.equal(error.code, "unimplemented");
      return true;
    });
  } finally {
    await hub.close();
  }
});

test("startCascade rejects an empty cascadeId instead of carrying undefined onward", async () => {
  const hub = await fakeHub((_call, res) => json(res, 200, {}));
  try {
    const client = new AgyHubClient({ baseUrl: hub.baseUrl, csrfToken: "x" });
    await assert.rejects(client.startCascade(), /returned no cascadeId/);
  } finally {
    await hub.close();
  }
});

test("runTurn drives start → send(blocking) → steps and returns the reply", async () => {
  const hub = await fakeHub((call, res) => {
    if (call.method === "StartCascade") return json(res, 200, { cascadeId: "cascade-7" });
    if (call.method === "SendUserCascadeMessage") return json(res, 200, {});
    if (call.method === "GetCascadeTrajectorySteps") {
      return json(res, 200, {
        steps: [
          { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE", userInput: { items: [{ text: "say OK" }] } },
          { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE", plannerResponse: { response: "OK" } },
        ],
      });
    }
    throw new Error(`unexpected method ${call.method}`);
  });
  try {
    const client = new AgyHubClient({ baseUrl: hub.baseUrl, csrfToken: "tok" });
    const turn = await client.runTurn({
      workspaces: ["/tmp/ws"],
      text: "say OK",
      planModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
      modelName: "gemini-3.8-flash-medium",
    });
    assert.equal(turn.cascadeId, "cascade-7");
    assert.equal(turn.text, "OK");
    assert.equal(turn.error, undefined);
    assert.deepEqual(
      hub.calls.map((call) => call.method),
      ["StartCascade", "SendUserCascadeMessage", "GetCascadeTrajectorySteps"],
    );
    const sent = JSON.parse(hub.calls[1].body);
    assert.equal(sent.cascadeId, "cascade-7");
    assert.equal(sent.blocking, true);
    assert.deepEqual(sent.items, [{ text: "say OK" }]);
    assert.deepEqual(sent.cascadeConfig.plannerConfig, {
      planModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
      modelName: "gemini-3.8-flash-medium",
    });
    assert.deepEqual(JSON.parse(hub.calls[0].body).workspaceUris, ["file:///tmp/ws"]);
  } finally {
    await hub.close();
  }
});

// ─── step helpers ───────────────────────────────────────────────────────────

test("assistantText takes the LAST planner response and tolerates both field names", () => {
  const steps = [
    { type: "T", plannerResponse: { response: "first" } },
    { type: "T", errorMessage: { error: { modelErrorMessage: "boom" } } },
    { type: "T", plannerResponse: { modifiedResponse: "final" } },
  ];
  assert.equal(assistantText(steps), "final");
  assert.equal(assistantText([{ type: "T", userInput: {} }]), undefined);
  assert.equal(errorText(steps), "boom");
  assert.equal(stepKind(steps[0]), "plannerResponse");
  assert.equal(stepKind({ type: "T", status: "S", metadata: {} }), undefined);
});

// ─── model catalog: resolve the enum instead of hard-coding it ──────────────

const CATALOG = {
  response: {
    models: {
      "gemini-3.8-flash-medium": {
        displayName: "Gemini 3.8 Flash (Medium)",
        model: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
        apiProvider: "API_PROVIDER_GOOGLE_VERTEX",
        quotaInfo: { remainingFraction: 1 },
      },
      "gemini-3.1-pro-low": {
        displayName: "Gemini 3.1 Pro (Low)",
        model: "MODEL_GOOGLE_GEMINI_3_1_PRO",
        apiProvider: "API_PROVIDER_GOOGLE_VERTEX",
      },
    },
  },
};

test("parseAvailableModels flattens response.models, sorted by catalog key", () => {
  const models = parseAvailableModels(CATALOG);
  assert.deepEqual(models.map((model) => model.name), [
    "gemini-3.1-pro-low",
    "gemini-3.8-flash-medium",
  ]);
  assert.equal(models[1].planModel, "MODEL_GOOGLE_GEMINI_2_5_FLASH");
  assert.equal(models[1].remainingFraction, 1);
});

test("resolveModel answers with the live enum, and lists the catalog on a miss", () => {
  const models = parseAvailableModels(CATALOG);
  assert.deepEqual(resolveModel(models, "gemini-3.1-pro-low"), {
    name: "gemini-3.1-pro-low",
    planModel: "MODEL_GOOGLE_GEMINI_3_1_PRO",
    displayName: "Gemini 3.1 Pro (Low)",
    apiProvider: "API_PROVIDER_GOOGLE_VERTEX",
    remainingFraction: undefined,
  });
  assert.throws(
    () => resolveModel(models, "gemini-9.9-flash-ultra"),
    /gemini-3\.1-pro-low, gemini-3\.8-flash-medium/,
  );
  assert.throws(() => resolveModel([{ name: "x", planModel: "" }], "x"), /no planModel enum/);
});

test("agyHubBaseUrl is origin-only", () => {
  assert.equal(agyHubBaseUrl(5395), "http://127.0.0.1:5395");
});
