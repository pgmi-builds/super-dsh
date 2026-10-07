/**
 * claude-route.ts — which provider/model a Claude turn must run
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
 *   preferred `ctx.agentDefaultModel` — the deployment default for a session
 *             that has never run.
 *   fallback  the agent's own reconciled options — the pair the factory built
 *             from the provider store and the user's native `settings.json`.
 *
 * The Dash model selector, though, speaks one id per model, and with more than
 * one provider a bare CLI alias (`glm-5.2`) is ambiguous. The catalog therefore
 * mints every entry's id as `provider/model` (`compositeModelId`), and a
 * selection's id splits back into its halves here (`parseCompositeModelId`) —
 * on the FIRST slash, because a provider id is slug-alphabet and never carries
 * one while a model id may.
 *
 * One shape predates the per-provider routes and is still in the wild: sessions
 * created before the rework pinned the hardcoded `claude` route with the
 * COMPOSITE id as their model half (`{provider: "claude", model: "glm/glm-5.3"}`).
 * Read raw it names no store entry, so the session would silently relaunch on
 * the native endpoint; {@link routeOf} revives it by splitting that one legacy
 * shape, and only that one — a new-shape selection's raw model id may carry a
 * slash of its own (`zai-plan` + `anthropic/claude-sonnet-4`).
 *
 * Kept out of `agent.ts` so the precedence can be pinned without standing up
 * a Session, a Context and a client: it is the one piece of this feature whose
 * mistakes are silent.
 *
 * @module agent-claude/claude-route
 */

/** A resolved request route. */
export interface RouteSelection {
  readonly provider: string;
  readonly model: string;
}

/**
 * The route id every selection was pinned under BEFORE the per-provider-route
 * rework. A local literal on purpose: importing `CLAUDE_PROVIDER_ID` from
 * `adapter.ts` would close a module cycle (`adapter → models → claude-route`).
 */
const LEGACY_ROUTE_ID = "claude";

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
  // Revive a selection from the pre-per-provider-route architecture: the route
  // half was hardcoded `claude` and the model half was the COMPOSITE id, so a
  // resumed session hands back `{provider: "claude", model: "glm/glm-5.3"}`.
  // Read raw that pair misses the provider store, and the agent falls back to
  // NATIVE_LAUNCH — the session quietly resumes on the native endpoint instead
  // of its pinned provider until the user re-picks. Keyed on the provider half
  // so a new-shape selection passes through untouched, even when its raw model
  // id carries a slash of its own.
  if (provider === LEGACY_ROUTE_ID) return parseCompositeModelId(model) ?? { provider, model };
  return { provider, model };
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

/**
 * Mint the Dash-facing model id for one provider's model: `${provider}/${model}`.
 *
 * The catalog publishes this composite as the entry id because the selector
 * picks by a single id and a bare CLI alias is ambiguous across providers. The
 * provider half is a store id (slug alphabet — `isProviderId` in
 * claude-providers.ts), so it can never itself contain the separator.
 *
 * @param provider - the store provider id.
 * @param model - the real model id the provider serves.
 */
export function compositeModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Split a composite model id back into its halves, on the FIRST `/` only.
 *
 * The split is anchored at the first slash because the MODEL half may carry
 * slashes of its own while the provider half never does; any later split point
 * would shred the model half and would not round-trip through
 * {@link compositeModelId}.
 *
 * @param id - a composite model id (`provider/model`), e.g. a selection the
 * catalog minted.
 * @returns the halves, or `undefined` when there is no `/` at all or either
 * half is empty — the same completeness rule `routeOf` enforces.
 */
export function parseCompositeModelId(id: string): { provider: string; model: string } | undefined {
  const slash = id.indexOf("/");
  if (slash === -1) return undefined;
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  if (provider === "" || model === "") return undefined;
  return { provider, model };
}

/**
 * The route a brand-new session's log is SEEDED with.
 *
 * The single argument is deliberate. The factory's reconciled options are the
 * only acceptable source, because they are already ONE pair: a first attempt
 * at this (the codex line) built the seed from the native provider id and the
 * deployment default model independently, which produced
 * `zhipu-cn/deepseek-flash` — a route no provider serves, and which had to be
 * caught by reading a live session's projection rather than by any unit test.
 * Taking one object makes that mistake unrepresentable.
 *
 * @param options - the factory's reconciled agent options.
 * @returns the seed. The declared input already names both halves, so the
 * `routeOf` screen inside always answers a route for it; a pair that somehow
 * arrives half-empty surfaces as `undefined` to the caller's own guard rather
 * than as a broken seed.
 */
export function routeSeed(options: {
  readonly provider: string;
  readonly model: string;
}): RouteSelection {
  return routeOf(options)!;
}
