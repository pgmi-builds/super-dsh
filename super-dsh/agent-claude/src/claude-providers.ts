/**
 * claude-providers.ts — the adapter-owned multi-provider store behind the Hub's
 * Claude settings panel (2026-10-04 multi-provider ruling).
 *
 * Claude Code is a single-provider harness: its own `settings.json` env block
 * names exactly ONE `ANTHROPIC_BASE_URL` with one key, so the LIST of
 * configured providers has nowhere to live in Claude's home, and this module
 * is where it lives instead: `<worldHome>/claude-providers.json` under the
 * world's DSH home (`<dshHome>/agents/claude/`), the location dev-rules §5/§13
 * already assigns to the adapter's own DSH state.
 *
 * This file is the CANONICAL provider list. The native `settings.json` env
 * block is a SOURCE, not a peer: `syncNativeProviders` folds whatever it
 * declares into this list, deduplicated by endpoint URL (the only identity a
 * hand-written settings env reliably carries), and never deletes anything.
 * There is no "selected" provider — which provider a session runs on is DSH's
 * own per-session `model/selection`, and the native home is written by nobody.
 *
 * The file carries API keys, so it is written 0600 with the sibling
 * `.credentials.yaml` posture, and reads are fail-soft: a corrupt or partial
 * store must degrade to "no providers yet", never take the world down. A
 * provider entry that does not survive validation is DROPPED rather than
 * poisoning the whole list.
 *
 * @module agent-claude/claude-providers
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * How the provider authenticates.
 *
 * `authToken` is the Bearer shape (`Authorization: Bearer …`, injected as
 * `ANTHROPIC_AUTH_TOKEN`) — how the GLM/Z.AI Anthropic endpoints authenticate.
 *
 * `apiKey` is the `x-api-key` shape (injected as `ANTHROPIC_API_KEY`) — how
 * Anthropic-compatible endpoints such as DeepSeek's authenticate.
 *
 * Both carry the literal secret value: there is no OAuth shape and no
 * by-reference env shape (2026-10-04 spec §2.2 ruling). An EMPTY value is a
 * real state, not a malformed entry: it means "this provider is keyed outside
 * Super D and Super D does not hold a copy", which is how a provider seeded
 * from the user's own settings arrives when it names no key. Refusing it would
 * make the user's currently-working provider unrepresentable.
 */
export type ClaudeProviderAuth =
  | { readonly kind: "authToken"; readonly value: string }
  | { readonly kind: "apiKey"; readonly value: string };

/** One model a provider serves — the model slot the user is wiring up. */
export interface ClaudeProviderModel {
  /** The real provider model id — one half of the composite id DSH selects per session. */
  readonly id: string;
  /** Display label; falls back to the id when absent. */
  readonly displayName?: string;
  /** Context window in tokens, when known — lands in the model catalog. */
  readonly contextWindow?: number;
}

/**
 * The model aliases a native settings env block declares through
 * `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`. Optional because a
 * hand-written entry may carry none.
 */
export interface ClaudeProviderAliases {
  readonly sonnet?: string;
  readonly opus?: string;
  readonly haiku?: string;
}

/**
 * Where an entry came from. `native` = folded in from the user's own
 * `settings.json` env by {@link syncNativeProviders}; absent or `user` = added
 * or edited in the Hub panel. Provenance decides only how much a later sync may
 * overwrite, never whether the entry is listed.
 */
export type ClaudeProviderOrigin = "native" | "user";

/** One configured provider. */
export interface ClaudeProviderEntry {
  /**
   * Stable slug; it becomes the provider half of the composite model id
   * (`<id>/<modelId>`) that DSH's per-session model selection carries.
   */
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly auth: ClaudeProviderAuth;
  /**
   * The models this provider is known to serve. Deliberately allowed to be
   * EMPTY: a provider folded in from a settings env that names neither
   * `ANTHROPIC_MODEL` nor any `ANTHROPIC_DEFAULT_*_MODEL` has no discoverable
   * model list at all, and inventing one would be a lie. An empty provider is
   * listed in the panel and registers no model route.
   */
  readonly models: readonly ClaudeProviderModel[];
  readonly aliases?: ClaudeProviderAliases;
  readonly origin: ClaudeProviderOrigin;
}

/**
 * The persisted list. There is no "selected" member: DSH owns the choice.
 * `removed` is always carried, even when empty.
 */
export interface ClaudeProviderStore {
  readonly providers: readonly ClaudeProviderEntry[];
  /**
   * Endpoint keys (see endpointKey) the user has explicitly REMOVED from the
   * list. The sync skips them, which is the whole point: a provider declared in
   * the user's own settings env would otherwise reappear on the next reconcile,
   * so `remove` would silently undo itself within ten minutes.
   */
  readonly removed: readonly string[];
}

/**
 * A provider id becomes one half of the composite model id and is shown in the
 * panel, so the alphabet is deliberately narrow: lowercase alphanumerics and
 * interior hyphens. (Covers `zai-plan`, `deepseek`, `glm`; rejects spaces,
 * dots, quotes, the composite-key separator `/` and anything else a slug was
 * never meant to carry.)
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Longest generated id: the slug part plus its 7-character discriminator. */
const MAX_ID_LENGTH = 48;

/** Whether `value` may be used as a provider id. */
export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID.test(value);
}

/** Where the store lives: `<worldHome>/claude-providers.json`. */
export function providerStorePath(worldHome: string): string {
  return join(worldHome, "claude-providers.json");
}

/** The empty store — also the fail-soft answer for every unreadable input. */
function emptyStore(): ClaudeProviderStore {
  return { providers: [], removed: [] };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function auth(value: unknown): ClaudeProviderAuth | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind !== "authToken" && kind !== "apiKey") return undefined;
  // An EMPTY value is a real state, not a malformed entry: it means "this
  // provider is keyed outside Super D", which is how a provider seeded from
  // the user's own settings arrives. See ClaudeProviderAuth.
  const secret = record["value"];
  return typeof secret === "string" ? { kind, value: secret } : undefined;
}

function model(value: unknown): ClaudeProviderModel | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = str(record["id"]);
  if (id === undefined) return undefined;
  const displayName = str(record["displayName"]);
  const contextWindow = record["contextWindow"];
  return {
    id,
    ...(displayName === undefined ? {} : { displayName }),
    ...(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {}),
  };
}

function aliases(value: unknown): ClaudeProviderAliases | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const sonnet = str(record["sonnet"]);
  const opus = str(record["opus"]);
  const haiku = str(record["haiku"]);
  if (sonnet === undefined && opus === undefined && haiku === undefined) return undefined;
  return {
    ...(sonnet === undefined ? {} : { sonnet }),
    ...(opus === undefined ? {} : { opus }),
    ...(haiku === undefined ? {} : { haiku }),
  };
}

/**
 * Validate one raw entry. Returns `undefined` for anything unusable — an id
 * outside the alphabet, a missing endpoint, an auth shape this build does not
 * understand — so the caller can drop it and keep the rest. An empty `models`
 * list is VALID (see {@link ClaudeProviderEntry.models}).
 */
export function providerEntry(value: unknown): ClaudeProviderEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const label = str(record["label"]);
  const baseUrl = str(record["baseUrl"]);
  const credentials = auth(record["auth"]);
  if (!isProviderId(id) || label === undefined || baseUrl === undefined || credentials === undefined) {
    return undefined;
  }
  const rawModels = record["models"];
  const models = (Array.isArray(rawModels) ? rawModels : [])
    .map(model)
    .filter((entry): entry is ClaudeProviderModel => entry !== undefined);
  const parsedAliases = aliases(record["aliases"]);
  const origin = record["origin"] === "native" ? "native" as const : "user" as const;
  return {
    id,
    label,
    baseUrl,
    auth: credentials,
    models,
    ...(parsedAliases === undefined ? {} : { aliases: parsedAliases }),
    origin,
  };
}

/**
 * Read the store. Fail-soft by construction: a missing file, unparsable JSON,
 * a wrong top-level shape, or individual bad entries all degrade toward an
 * empty (or shorter) list rather than throwing.
 */
export function readProviderStore(worldHome: string): ClaudeProviderStore {
  const path = providerStorePath(worldHome);
  if (!existsSync(path)) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyStore();
  }
  if (parsed === null || typeof parsed !== "object") return emptyStore();
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record["providers"])) return emptyStore();

  const providers = record["providers"]
    .map(providerEntry)
    .filter((entry): entry is ClaudeProviderEntry => entry !== undefined);

  const rawRemoved = record["removed"];
  const removed = (Array.isArray(rawRemoved) ? rawRemoved : [])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");

  return { providers, removed };
}

/**
 * Persist the store atomically (tmp + rename) and 0600 — the file holds API
 * keys in the clear, exactly like the sibling `.credentials.yaml`, so it must
 * never be group- or world-readable even for the instant before a rewrite.
 */
export function writeProviderStore(worldHome: string, store: ClaudeProviderStore): void {
  const path = providerStorePath(worldHome);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Insert or replace one provider by id, preserving list order.
 *
 * An explicit add also clears the endpoint's removal tombstone: re-adding a
 * provider is the user overruling their own earlier removal, and leaving the
 * tombstone would make the next sync skip it again.
 */
export function upsertProvider(store: ClaudeProviderStore, entry: ClaudeProviderEntry): ClaudeProviderStore {
  const at = store.providers.findIndex((existing) => existing.id === entry.id);
  const providers = at === -1
    ? [...store.providers, entry]
    : store.providers.map((existing, index) => (index === at ? entry : existing));
  const key = endpointKey(entry.baseUrl);
  // The endpoint's tombstone is FILTERED OUT, not carried forward: leaving it
  // would make the next sync skip the endpoint the user just re-added.
  const removed = store.removed.filter((candidate) => candidate !== key);
  return { providers, removed };
}

/**
 * Drop one provider, and TOMBSTONE its endpoint so the reconcile cannot bring
 * it back: the user's own `settings.json` still declares it, and a list editor
 * whose delete button undoes itself every ten minutes is worse than no button.
 *
 * Removing from this list is still not "unconfiguring Claude Code": nothing
 * native is touched, and the user's own CLI keeps running whatever their file
 * says.
 */
export function removeProvider(store: ClaudeProviderStore, id: string): ClaudeProviderStore {
  const entry = store.providers.find((candidate) => candidate.id === id);
  const providers = store.providers.filter((candidate) => candidate.id !== id);
  if (entry === undefined) return { providers, removed: store.removed };
  const key = endpointKey(entry.baseUrl);
  const removed = store.removed.includes(key) ? store.removed : [...store.removed, key];
  return { providers, removed };
}

/**
 * The comparison key for "the same endpoint". A settings env block has no
 * identity beyond its `ANTHROPIC_BASE_URL`, and a hand-written one carries no
 * other identity worth trusting — so the endpoint IS the dedupe key. Case, a
 * trailing slash, and the default port are noise.
 *
 * @param baseUrl - a provider's `ANTHROPIC_BASE_URL` (any shape; unparsable input is compared verbatim).
 * @returns a stable key.
 */
export function endpointKey(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const port = parsed.port === "" || (parsed.protocol === "https:" && parsed.port === "443")
    || (parsed.protocol === "http:" && parsed.port === "80")
    ? ""
    : `:${parsed.port}`;
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

/** Reduce arbitrary text to the provider-id alphabet, collapsing runs of junk. */
function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "provider" : slug.slice(0, MAX_ID_LENGTH - 8);
}

/** A short, stable discriminator so two endpoints sharing a host stay distinct. */
function discriminator(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(-6);
}

/**
 * The provider id for an endpoint. A settings env block carries no provider
 * name at all, so this is the path every folded provider takes, and the one a
 * UI-added provider reuses.
 *
 * @param baseUrl - the provider's endpoint.
 * @returns a slug that satisfies {@link isProviderId}.
 */
export function providerIdFromEndpoint(baseUrl: string): string {
  const key = endpointKey(baseUrl);
  let host = "provider";
  let path = "";
  try {
    const parsed = new URL(key);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    // keep the defaults
  }
  return `${slugify(`${host}${path}`)}-${discriminator(key)}`;
}

/**
 * Make `wanted` usable and unique within `taken`.
 *
 * @param wanted - the preferred id (usually a generated slug).
 * @param taken - ids already claimed by other entries.
 * @returns a valid id not present in `taken`.
 */
export function uniqueProviderId(wanted: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = isProviderId(wanted) ? wanted : slugify(wanted);
  if (!used.has(base)) return base;
  const salted = `${base.slice(0, MAX_ID_LENGTH - 7)}-${discriminator(wanted)}`;
  if (!used.has(salted)) return salted;
  for (let index = 2; ; index += 1) {
    const candidate = `${base.slice(0, MAX_ID_LENGTH - 4)}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** One provider as it arrives from the native settings env (see `claude-native-config.ts`). */
export interface NativeProviderImport {
  readonly baseUrl: string;
  readonly auth: ClaudeProviderAuth;
  /** Model entries the native home reveals (`ANTHROPIC_MODEL` and the alias values). */
  readonly models?: readonly ClaudeProviderModel[];
  /** The `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` mapping, when the env declares one. */
  readonly aliases?: ClaudeProviderAliases;
}

/** Append the models of `incoming` that `existing` does not already carry. */
function unionModels(
  existing: readonly ClaudeProviderModel[],
  incoming: readonly ClaudeProviderModel[],
): readonly ClaudeProviderModel[] {
  const known = new Set(existing.map((entry) => entry.id));
  const additions: ClaudeProviderModel[] = [];
  for (const candidate of incoming) {
    // Same validation a store read applies: junk in an import is skipped, not
    // propagated — and a duplicate id (even twice within one import) is noise.
    const parsed = model(candidate);
    if (parsed === undefined || known.has(parsed.id)) continue;
    known.add(parsed.id);
    additions.push(parsed);
  }
  return additions.length === 0 ? existing : [...existing, ...additions];
}

/**
 * Structural auth equality.
 *
 * Reference equality is wrong here: a native sync re-parses the settings on
 * every tick, so the incoming auth object is a FRESH one each time and `!==`
 * would report a change forever. That is not a cosmetic difference — it makes
 * the "only write when something moved" contract fail, so every scheduled
 * reconcile would rewrite a 0600 secrets file.
 */
function sameAuth(left: ClaudeProviderAuth, right: ClaudeProviderAuth): boolean {
  return left.kind === right.kind && left.value === right.value;
}

/** Structural alias equality — same reasoning as {@link sameAuth}. */
function sameAliases(left: ClaudeProviderAliases | undefined, right: ClaudeProviderAliases | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.sonnet === right.sonnet && left.opus === right.opus && left.haiku === right.haiku;
}

/**
 * Fold the providers a native settings env declares into the canonical store.
 *
 * Identity is the endpoint (see {@link endpointKey}); an import whose endpoint
 * already matches an entry refreshes that entry's endpoint, model list, aliases
 * and — only when the entry holds no secret of its own — its auth shape.
 * Anything unmatched is appended, labelled with its endpoint URL, because that
 * is the only name a settings env block gives it. Nothing is ever deleted
 * here: a provider dropped from the settings may still be one the user uses
 * through Super D. The one exception runs the other way — an endpoint the user
 * REMOVED in the panel is skipped, so their removal is not undone by the next
 * reconcile.
 *
 * @param store - the canonical list.
 * @param imported - providers parsed from the native settings env, in file order.
 * @returns the new store plus which ids were added and which were refreshed.
 */
export function syncNativeProviders(
  store: ClaudeProviderStore,
  imported: readonly NativeProviderImport[],
): { store: ClaudeProviderStore; added: string[]; updated: string[] } {
  const providers: ClaudeProviderEntry[] = [...store.providers];
  const added: string[] = [];
  const updated: string[] = [];

  for (const incoming of imported) {
    const baseUrl = incoming.baseUrl.trim();
    if (baseUrl === "") continue;
    const key = endpointKey(baseUrl);
    if (store.removed.includes(key)) continue;

    const at = providers.findIndex((entry) => endpointKey(entry.baseUrl) === key);
    if (at === -1) {
      const id = uniqueProviderId(providerIdFromEndpoint(baseUrl), providers.map((entry) => entry.id));
      providers.push({
        id,
        label: baseUrl,
        baseUrl,
        auth: incoming.auth,
        models: unionModels([], incoming.models ?? []),
        ...(incoming.aliases === undefined ? {} : { aliases: incoming.aliases }),
        origin: "native",
      });
      added.push(id);
      continue;
    }

    const entry = providers[at];
    const models = unionModels(entry.models, incoming.models ?? []);
    // The native env block is the user's own statement about how Claude Code
    // should authenticate, but a secret Super D already holds must not be
    // dropped in favour of it — an EMPTY value is the only shape that defers
    // ("Super D holds no copy"), so only that one follows the native file.
    const adoptAuth = entry.auth.value === "";
    const next: ClaudeProviderEntry = {
      ...entry,
      baseUrl,
      ...(adoptAuth ? { auth: incoming.auth } : {}),
      models,
      ...(incoming.aliases === undefined ? {} : { aliases: incoming.aliases }),
    };
    const changed = next.baseUrl !== entry.baseUrl
      || next.models !== entry.models
      || !sameAuth(next.auth, entry.auth)
      || !sameAliases(next.aliases, entry.aliases);
    if (changed) {
      providers[at] = next;
      updated.push(entry.id);
    }
  }

  return { store: { providers, removed: store.removed }, added, updated };
}
