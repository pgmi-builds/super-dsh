// Route precedence (2026-10-04 multi-provider rework).
//
// This is the whole of Super D's model-selection policy, and it is deliberately
// the HARNESS's policy, not ours: `sessionController.selectionFor(agent).current`
// resolves `pending ?? logged ?? default`, so a session's route is decided by DSH
// exactly as it would be for a native agent. What this suite pins is that we
// read that order correctly — a mistake here is silent, and shows up only as a
// turn quietly running on the previous provider. The composite-key cases pin
// the mint/split pair that keeps the selector's single-id face honest now that
// one alias (`glm-5.2`) can name a model on several providers.
import assert from "node:assert/strict";
import { test } from "node:test";

const { compositeModelId, parseCompositeModelId, resolveRoute, routeOf, routeSeed } = await import(
  "../dist/claude-route.js"
);

test("routeOf accepts a complete selection and drops a half-filled one", () => {
  assert.deepEqual(routeOf({ provider: "glm", model: "glm-5.2" }), {
    provider: "glm",
    model: "glm-5.2",
  });
  // The claude line has no effort route face: a candidate that still carries
  // one (the codex shape) resolves, and the field never rides along.
  assert.deepEqual(routeOf({ provider: "glm", model: "glm-5.2", reasoningEffort: "high" }), {
    provider: "glm",
    model: "glm-5.2",
  });
  // A half route must never win the precedence: launching a child with an empty
  // model is worse than falling through to a complete candidate.
  assert.equal(routeOf({ provider: "glm" }), undefined);
  assert.equal(routeOf({ model: "glm-5.2" }), undefined);
  assert.equal(routeOf({ provider: "", model: "glm-5.2" }), undefined);
  assert.equal(routeOf({ provider: "glm", model: "" }), undefined);
  // Junk and the projection's `null` members are not routes.
  assert.equal(routeOf(null), undefined);
  assert.equal(routeOf(undefined), undefined);
  assert.equal(routeOf("glm/glm-5.2"), undefined);
  assert.equal(routeOf(["glm", "glm-5.2"]), undefined);
});

test("a pre-rework composite selection is revived from the legacy claude route", () => {
  // Sessions created before the per-provider-route rework pinned the hardcoded
  // `claude` route with the COMPOSITE id as the model half. A resumed session
  // hands that pair back as its logged header; read raw it names no store
  // entry, so the agent would fall back to NATIVE_LAUNCH and quietly resume on
  // the native endpoint instead of the provider the session was pinned to.
  const legacy = { provider: "claude", model: "glm/glm-5.3" };
  assert.deepEqual(resolveRoute({ logged: legacy }), { provider: "glm", model: "glm-5.3" });
  // Every candidate slot carries the same legacy shape, not just `logged`.
  assert.deepEqual(resolveRoute({ pending: legacy }), { provider: "glm", model: "glm-5.3" });
  assert.deepEqual(routeOf(legacy), { provider: "glm", model: "glm-5.3" });
  assert.deepEqual(routeSeed(legacy), { provider: "glm", model: "glm-5.3" });

  // A NEW-shape selection already names the provider as its route half and
  // passes through untouched.
  assert.deepEqual(resolveRoute({ logged: { provider: "glm", model: "glm-5.3" } }), {
    provider: "glm",
    model: "glm-5.3",
  });
  // Including a curated provider whose RAW model id carries a slash: the split
  // is keyed on the provider half, never on the model alone.
  assert.deepEqual(resolveRoute({ logged: { provider: "zai-plan", model: "anthropic/claude-sonnet-4" } }), {
    provider: "zai-plan",
    model: "anthropic/claude-sonnet-4",
  });

  // A genuinely native selection has no slash and must not be reinterpreted.
  assert.deepEqual(resolveRoute({ logged: { provider: "claude", model: "deepseek-flash" } }), {
    provider: "claude",
    model: "deepseek-flash",
  });
  assert.deepEqual(routeOf({ provider: "claude", model: "sonnet" }), { provider: "claude", model: "sonnet" });
});

test("a pending switch outranks everything, including the logged header", () => {
  // The measured behaviour this encodes: switching provider while a turn is
  // running must apply to the NEXT turn. The harness records the intent as
  // `model/selection`; its projection exposes it as `pending` until a
  // `request/header` consumes it. Because pending wins, the next turn runs on
  // the new provider with no interruption of the live one.
  assert.deepEqual(
    resolveRoute({
      pending: { provider: "deepseek", model: "deepseek-flash" },
      logged: { provider: "glm", model: "glm-5.2" },
      preferred: { provider: "claude", model: "sonnet" },
      fallback: { provider: "claude", model: "sonnet" },
    }),
    { provider: "deepseek", model: "deepseek-flash" },
  );
});

test("the logged header is what a resumed session reports", () => {
  // After the switch is consumed there is no pending value left, so the route
  // comes from the durable `request/header` — which is how a resumed session
  // can still say which provider produced its transcript.
  assert.deepEqual(
    resolveRoute({
      pending: null,
      logged: { provider: "deepseek", model: "deepseek-flash" },
      preferred: { provider: "glm", model: "glm-5.2" },
    }),
    { provider: "deepseek", model: "deepseek-flash" },
  );
});

test("a session that never ran falls through to the deployment default, then the factory options", () => {
  assert.deepEqual(
    resolveRoute({
      pending: undefined,
      logged: undefined,
      preferred: { provider: "glm", model: "glm-5.2" },
      fallback: { provider: "deepseek", model: "deepseek-flash" },
    }),
    { provider: "glm", model: "glm-5.2" },
  );
  // A half-filled deployment default is skipped, not healed: the factory's own
  // options answer instead.
  assert.deepEqual(
    resolveRoute({
      preferred: { provider: "", model: "" },
      fallback: { provider: "deepseek", model: "deepseek-flash" },
    }),
    { provider: "deepseek", model: "deepseek-flash" },
  );
});

test("nothing usable resolves to undefined rather than to a partial route", () => {
  assert.equal(resolveRoute({}), undefined);
  assert.equal(resolveRoute({ pending: null, logged: null, preferred: null, fallback: null }), undefined);
  // The legacy shape a pre-rework session carries is a complete route, and must
  // resolve: the provider id simply names no store entry, which the agent reads
  // as "launch native — inject nothing".
  assert.deepEqual(resolveRoute({ logged: { provider: "claude", model: "sonnet" } }), {
    provider: "claude",
    model: "sonnet",
  });
});

test("compositeModelId joins a provider and a model with exactly one slash", () => {
  assert.equal(compositeModelId("glm", "glm-5.2"), "glm/glm-5.2");
  assert.equal(compositeModelId("deepseek", "deepseek-flash"), "deepseek/deepseek-flash");
});

test("parseCompositeModelId splits on the first slash only", () => {
  assert.deepEqual(parseCompositeModelId("deepseek/deepseek-flash"), {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  // A model id may carry slashes of its own while a provider id never does
  // (slug alphabet), so the FIRST slash is the only separator that
  // round-trips: a later split point would shred the model half.
  assert.deepEqual(parseCompositeModelId("openrouter/anthropic/claude-sonnet-4"), {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
  });
  // A bare CLI alias names no provider — the caller must not read one in.
  assert.equal(parseCompositeModelId("sonnet"), undefined);
  assert.equal(parseCompositeModelId(""), undefined);
  // An empty half is not a half: same completeness rule as routeOf.
  assert.equal(parseCompositeModelId("/glm-5.2"), undefined);
  assert.equal(parseCompositeModelId("glm/"), undefined);
});

test("composite ids round-trip through the pair", () => {
  const pairs = [
    ["glm", "glm-5.2"],
    ["deepseek", "deepseek-flash"],
    ["zai-plan", "anthropic/claude-sonnet-4"],
  ];
  for (const [provider, model] of pairs) {
    assert.deepEqual(parseCompositeModelId(compositeModelId(provider, model)), { provider, model });
  }
});

test("routeSeed seeds a new session's log from the reconciled pair as one object", () => {
  // ONE argument, on purpose: the seed must come from the factory's reconciled
  // options only — building it from a provider id and a default model
  // independently is the two-sources bug that once minted
  // `zhipu-cn/deepseek-flash`, a route no provider serves.
  assert.deepEqual(routeSeed({ provider: "glm", model: "glm-5.2" }), {
    provider: "glm",
    model: "glm-5.2",
  });
});

test("resolveRoute skips a bad routeSeed fallback (routeOf screens it)", () => {
  assert.equal(resolveRoute({ fallback: routeSeed({ provider: "", model: "x" }) }), undefined);
});
