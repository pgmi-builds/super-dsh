// Route precedence (2026-10-04 multi-provider rework).
//
// This is the whole of Super D's model-selection policy, and it is deliberately
// the HARNESS's policy, not ours: `sessionController.selectionFor(agent).current`
// resolves `pending ?? logged ?? default`, so a session's route is decided by DSH
// exactly as it would be for a native agent. What this suite pins is that we
// read that order correctly — a mistake here is silent, and shows up only as a
// turn quietly running on the previous provider.
import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveRoute, routeOf } = await import("../dist/codex-route.js");

test("routeOf accepts a complete selection and drops a half-filled one", () => {
  assert.deepEqual(routeOf({ provider: "zhipu-cn", model: "glm-5.3-flash" }), {
    provider: "zhipu-cn",
    model: "glm-5.3-flash",
  });
  assert.deepEqual(routeOf({ provider: "zhipu-cn", model: "glm-4.7", reasoningEffort: "high" }), {
    provider: "zhipu-cn",
    model: "glm-4.7",
    reasoningEffort: "high",
  });
  // A half route must never win the precedence: launching a child with an empty
  // model is worse than falling through to a complete candidate.
  assert.equal(routeOf({ provider: "zhipu-cn" }), undefined);
  assert.equal(routeOf({ model: "glm-4.7" }), undefined);
  assert.equal(routeOf({ provider: "", model: "glm-4.7" }), undefined);
  assert.equal(routeOf({ provider: "zhipu-cn", model: "" }), undefined);
  // Junk and the projection's `null` members are not routes.
  assert.equal(routeOf(null), undefined);
  assert.equal(routeOf(undefined), undefined);
  assert.equal(routeOf("zhipu-cn/glm-4.7"), undefined);
  assert.equal(routeOf(["zhipu-cn", "glm-4.7"]), undefined);
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
      logged: { provider: "zhipu-cn", model: "glm-5.3-flash" },
      preferred: { provider: "codex", model: "codex-default" },
      fallback: { provider: "codex", model: "codex-default" },
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
      preferred: { provider: "zhipu-cn", model: "glm-5.3-flash" },
    }),
    { provider: "deepseek", model: "deepseek-flash" },
  );
});

test("a session that never ran falls through to the deployment default, then the factory options", () => {
  assert.deepEqual(
    resolveRoute({
      pending: undefined,
      logged: undefined,
      preferred: { provider: "zhipu-cn", model: "glm-5.3-flash" },
      fallback: { provider: "deepseek", model: "deepseek-flash" },
    }),
    { provider: "zhipu-cn", model: "glm-5.3-flash" },
  );
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
  // as "let the user's own config.toml decide".
  assert.deepEqual(resolveRoute({ logged: { provider: "codex", model: "glm-5.3-flash" } }), {
    provider: "codex",
    model: "glm-5.3-flash",
  });
});
