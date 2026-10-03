/**
 * codex-route.ts — which provider/model a Codex turn must run
 * (2026-10-04 multi-provider rework).
 *
 * This is the whole of Super D's model-selection policy, and the point is that
 * there is almost none: the precedence below is the harness's own
 * (`sessionController.selectionFor(agent).current`), so a session's route is
 * decided by DSH exactly as it would be for a native agent, and Super D only
 * has to read it.
 *
 *   pending   the durable `modelSelection` projection's `pending` — a switch
 *             made through `session/selectModel` that no `request/header` has
 *             retired yet. This is what makes a mid-turn switch land on the NEXT
 *             turn, for free: the harness records the intent and the next
 *             request consumes it.
 *   logged    the last `request/header` snapshot — what the session ACTUALLY ran
 *             last. It is also what lets a resumed session name the provider
 *             that produced its transcript.
 *   default   `ctx.agentDefaultModel` — the deployment default for a session
 *             that has never run.
 *   fallback  the agent's own options, which the factory built from the user's
 *             native `config.toml`.
 *
 * Extracted from `agent.ts` so the precedence can be pinned without standing up
 * a Session, a Context and a client: it is the one piece of this feature whose
 * mistakes are silent.
 *
 * @module agent-codex/codex-route
 */

/** A resolved request route. */
export interface RouteSelection {
  readonly provider: string;
  readonly model: string;
  /** Adapter-owned reasoning effort; absent means the provider's own default. */
  readonly reasoningEffort?: string;
}

/**
 * Read a route out of one candidate value.
 *
 * Every candidate arrives as untyped projection/config data, so this validates
 * structurally and answers `undefined` for anything incomplete. A half-filled
 * route must never win the precedence: falling through to a complete one is
 * always better than launching a child with an empty model.
 *
 * @param value - a candidate route (a `ModelSelection`-shaped object, or junk).
 * @returns the route, or `undefined` when it does not name both halves.
 */
export function routeOf(value: unknown): RouteSelection | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = record["provider"];
  const model = record["model"];
  if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return undefined;
  const reasoningEffort = record["reasoningEffort"];
  return {
    provider,
    model,
    ...(typeof reasoningEffort === "string" && reasoningEffort !== "" ? { reasoningEffort } : {}),
  };
}

/**
 * Resolve the route for the next request by the harness's own precedence.
 *
 * @param candidates - the candidates in descending priority: `pending`,
 * `logged`, `preferred`, `fallback`. `preferred` is the harness default
 * (`agentDefaultModel`); `fallback` is the factory's own options.
 * @returns the first complete route, or `undefined` when none is usable.
 */
export function resolveRoute(candidates: {
  readonly pending?: unknown;
  readonly logged?: unknown;
  readonly preferred?: unknown;
  readonly fallback?: unknown;
}): RouteSelection | undefined {
  return routeOf(candidates.pending)
    ?? routeOf(candidates.logged)
    ?? routeOf(candidates.preferred)
    ?? routeOf(candidates.fallback);
}
