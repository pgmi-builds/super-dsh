/**
 * codex-providers.ts — the adapter-owned multi-provider store behind the Hub's
 * Codex settings panel (2026-10-03 user ruling; reworked 2026-10-04).
 *
 * Codex is a single-provider harness: its own `config.toml` can name exactly
 * ONE `model_provider`, so the LIST of configured providers has nowhere to live
 * in Codex's home, and this module is where it lives instead:
 * `<worldHome>/codex-providers.json` under the world's DSH home
 * (`<dshHome>/agents/codex/`), the location dev-rules §5/§13 already assigns to
 * the adapter's own DSH state.
 *
 * This file is the CANONICAL provider list. The native `config.toml` is a
 * SOURCE, not a peer: `syncNativeProviders` folds whatever it declares into
 * this list, deduplicated by endpoint URL (the only identity a hand-written
 * codex config reliably carries), and never deletes anything. There is no
 * "selected" provider any more — which provider a session runs on is DSH's own
 * per-session `model/selection`, and the native home is written by nobody.
 *
 * The file carries API keys, so it is written 0600 with the sibling
 * `.credentials.yaml` posture, and reads are fail-soft: a corrupt or partial
 * store must degrade to "no providers yet", never take the world down. A
 * provider entry that does not survive validation is DROPPED rather than
 * poisoning the whole list.
 *
 * @module agent-codex/codex-providers
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The two wire protocols an OpenAI-compatible endpoint can speak. */
export type CodexWireProtocol = "responses" | "chat";

/**
 * How the provider authenticates.
 *
 * `apiKey` is the cc-switch shape: the value is materialized into the native
 * `auth.json` as `OPENAI_API_KEY` and the provider table says
 * `requires_openai_auth = true`. Since the 2026-10-04 on-the-fly rework a
 * NON-EMPTY value never needs `auth.json` at all: the launch injects a
 * synthetic `env_key` and hands the child the secret through its own
 * environment, which also sidesteps the ChatGPT-login shadowing footgun. The
 * empty-value case still means "the runtime's own auth.json holds this one".
 *
 * `env` is the shape a hand-written `config.toml` usually has: the provider
 * table names an `env_key` and the value is expected in the world process's
 * environment. Both are supported because an imported native config may use
 * either, and converting one into the other without being asked would be a
 * silent behaviour change.
 */
export type CodexProviderAuth =
  | { readonly kind: "apiKey"; readonly value: string }
  | { readonly kind: "env"; readonly name: string };

/** One model a provider serves — the Codex "model slot" the user is wiring up. */
export interface CodexProviderModel {
  /** The real provider model id, passed to Codex as `--model` / config `model`. */
  readonly id: string;
  /** Display label; falls back to the id when absent. */
  readonly displayName?: string;
  /** Context window in tokens, when known — lands in the model catalog. */
  readonly contextWindow?: number;
}

/**
 * Where an entry came from. `native` = folded in from the user's own
 * `config.toml` by {@link syncNativeProviders}; absent or `user` = added or
 * edited in the Hub panel. Provenance decides only how much a later sync may
 * overwrite, never whether the entry is listed.
 */
export type CodexProviderOrigin = "native" | "user";

/** One configured provider. */
export interface CodexProviderEntry {
  /** Stable slug; it becomes the `[model_providers.<id>]` table name. */
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly protocol: CodexWireProtocol;
  readonly auth: CodexProviderAuth;
  /**
   * The models this provider is known to serve. Deliberately allowed to be
   * EMPTY: a provider folded in from a native `config.toml` that is not the
   * provider in force has no discoverable model list at all (Codex's catalog
   * is per-provider-in-force), and inventing one would be a lie. An empty
   * provider is listed in the panel and registers no model route.
   */
  readonly models: readonly CodexProviderModel[];
  readonly origin?: CodexProviderOrigin;
}

/** The persisted list. There is no "selected" member: DSH owns the choice. */
export interface CodexProviderStore {
  readonly version: 1;
  readonly providers: readonly CodexProviderEntry[];
  /**
   * Endpoint keys (see endpointKey) the user has explicitly REMOVED from the
   * list. The sync skips them, which is the whole point: a provider declared in
   * the user own config.toml would otherwise reappear on the next reconcile, so
   * `remove` would silently undo itself within ten minutes.
   */
  readonly removed?: readonly string[];
}

/**
 * A provider id becomes a TOML table name and is interpolated into the native
 * config, so the alphabet is deliberately narrow: lowercase alphanumerics and
 * interior hyphens. (Covers `zai-plan`, `deepseek`, `openai`; rejects spaces,
 * dots, quotes and anything that would need TOML escaping.)
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Longest generated id: the slug part plus its 7-character discriminator. */
const MAX_ID_LENGTH = 48;

/** Whether `value` may be used as a provider id. */
export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID.test(value);
}

/** Whether `value` names a wire protocol this adapter understands. */
export function isWireProtocol(value: unknown): value is CodexWireProtocol {
  return value === "responses" || value === "chat";
}

/** Where the store lives: `<worldHome>/codex-providers.json`. */
export function providerStorePath(worldHome: string): string {
  return join(worldHome, "codex-providers.json");
}

/** The empty store — also the fail-soft answer for every unreadable input. */
function emptyStore(): CodexProviderStore {
  return { version: 1, providers: [] };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function auth(value: unknown): CodexProviderAuth | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "apiKey") {
    // An EMPTY value is a real state, not a malformed entry: it means "this
    // provider is keyed by auth.json and Super D does not hold a copy", which is
    // how a provider seeded from the user's own config arrives. Refusing it would
    // make the user's currently-working provider unrepresentable.
    const secret = record["value"];
    return typeof secret === "string" ? { kind: "apiKey", value: secret } : undefined;
  }
  if (record["kind"] === "env") {
    const name = str(record["name"]);
    return name === undefined ? undefined : { kind: "env", name };
  }
  return undefined;
}

function model(value: unknown): CodexProviderModel | undefined {
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

/**
 * Validate one raw entry. Returns `undefined` for anything unusable — an
 * unknown protocol, an id that cannot be a TOML table, a missing endpoint — so
 * the caller can drop it and keep the rest. An empty `models` list is VALID
 * (see {@link CodexProviderEntry.models}).
 */
export function providerEntry(value: unknown): CodexProviderEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const label = str(record["label"]);
  const baseUrl = str(record["baseUrl"]);
  const protocol = record["protocol"];
  const credentials = auth(record["auth"]);
  if (!isProviderId(id) || label === undefined || baseUrl === undefined || !isWireProtocol(protocol) || credentials === undefined) {
    return undefined;
  }
  const rawModels = record["models"];
  const models = (Array.isArray(rawModels) ? rawModels : [])
    .map(model)
    .filter((entry): entry is CodexProviderModel => entry !== undefined);
  const origin = record["origin"] === "native" ? "native" as const : "user" as const;
  return { id, label, baseUrl, protocol, auth: credentials, models, origin };
}

/**
 * Read the store. Fail-soft by construction: a missing file, unparsable JSON,
 * a wrong top-level shape, or individual bad entries all degrade toward an
 * empty (or shorter) list rather than throwing.
 *
 * A `selected` member written by an earlier build is ignored on purpose — the
 * global selection was retired in favour of DSH's per-session `model/selection`.
 */
export function readProviderStore(worldHome: string): CodexProviderStore {
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
    .filter((entry): entry is CodexProviderEntry => entry !== undefined);

  const rawRemoved = record["removed"];
  const removed = (Array.isArray(rawRemoved) ? rawRemoved : [])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");

  return { version: 1, providers, ...(removed.length === 0 ? {} : { removed }) };
}

/**
 * Persist the store atomically (tmp + rename) and 0600 — the file holds API
 * keys in the clear, exactly like the sibling `.credentials.yaml`, so it must
 * never be group- or world-readable even for the instant before a rewrite.
 */
export function writeProviderStore(worldHome: string, store: CodexProviderStore): void {
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
export function upsertProvider(store: CodexProviderStore, entry: CodexProviderEntry): CodexProviderStore {
  const at = store.providers.findIndex((existing) => existing.id === entry.id);
  const providers = at === -1
    ? [...store.providers, entry]
    : store.providers.map((existing, index) => (index === at ? entry : existing));
  const key = endpointKey(entry.baseUrl);
  const removed = (store.removed ?? []).filter((candidate) => candidate !== key);
  // `removed` must be CLEARED, not merely omitted: spreading the old store would
  // carry the tombstone forward, and the next sync would keep skipping the
  // endpoint the user just re-added.
  const { removed: _stale, ...rest } = store;
  return { ...rest, providers, ...(removed.length === 0 ? {} : { removed }) };
}

/**
 * Drop one provider, and TOMBSTONE its endpoint so the reconcile cannot bring
 * it back: the user's own `config.toml` still declares it, and a list editor
 * whose delete button undoes itself every ten minutes is worse than no button.
 *
 * Removing from this list is still not "unconfiguring Codex": nothing native is
 * touched, and the user's own CLI keeps running whatever their file says.
 */
export function removeProvider(store: CodexProviderStore, id: string): CodexProviderStore {
  const entry = store.providers.find((candidate) => candidate.id === id);
  const providers = store.providers.filter((candidate) => candidate.id !== id);
  if (entry === undefined) return { ...store, providers };
  const key = endpointKey(entry.baseUrl);
  const removed = store.removed?.includes(key) === true ? store.removed : [...store.removed ?? [], key];
  return { ...store, providers, removed };
}

/**
 * The comparison key for "the same endpoint". Codex itself treats two provider
 * tables with the same `base_url` as the same service, and a hand-written
 * config carries no other identity worth trusting — so the endpoint IS the
 * dedupe key. Case, a trailing slash, and the default port are noise.
 *
 * @param baseUrl - a provider's `base_url` (any shape; unparsable input is compared verbatim).
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
 * The provider id for an endpoint that arrives without a usable one. Codex's
 * own `config.toml` tables are already valid ids and are preferred by the
 * caller; this is the fallback for a UI-added provider and for a native table
 * name that cannot be a TOML key.
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
 * @param wanted - the preferred id (a native table name, or a generated slug).
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

/** One provider as it arrives from the native config (see `codex-native-config.ts`). */
export interface NativeProviderImport {
  /** The `[model_providers.<id>]` table name, when it can be a provider id. */
  readonly nativeId?: string;
  readonly baseUrl: string;
  readonly protocol: CodexWireProtocol;
  readonly auth: CodexProviderAuth;
  /** Model ids the native home reveals (only knowable for the provider in force). */
  readonly models: readonly string[];
}

/** What one sync did, for the panel's note and for tests. */
export interface ProviderSyncResult {
  readonly store: CodexProviderStore;
  readonly added: readonly string[];
  readonly updated: readonly string[];
}

/** Append the models of `incoming` that `existing` does not already carry. */
function unionModels(
  existing: readonly CodexProviderModel[],
  incoming: readonly string[],
): readonly CodexProviderModel[] {
  const known = new Set(existing.map((entry) => entry.id));
  const additions = incoming
    .filter((id) => id !== "" && !known.has(id))
    .map((id) => ({ id }));
  return additions.length === 0 ? existing : [...existing, ...additions];
}

/**
 * Structural auth equality.
 *
 * Reference equality is wrong here: a native sync re-parses the config on every
 * tick, so the incoming auth object is a FRESH one each time and `!==` would
 * report a change forever. That is not a cosmetic difference — it makes the
 * "only write when something moved" contract fail, so every scheduled reconcile
 * would rewrite a 0600 secrets file (observed: `updated=["deepseek","zhipu-cn"]`
 * on an unchanged config).
 */
function sameAuth(left: CodexProviderAuth, right: CodexProviderAuth): boolean {
  if (left.kind === "env") return right.kind === "env" && left.name === right.name;
  return right.kind === "apiKey" && left.value === right.value;
}
/**
 * Fold the providers a native `config.toml` declares into the canonical store.
 *
 * Identity is the endpoint (see {@link endpointKey}); a native provider whose id
 * or endpoint already matches an entry refreshes that entry's endpoint,
 * protocol, model list and — only when the entry holds no secret of its own —
 * its auth shape. Anything unmatched is appended, labelled with its endpoint
 * URL, because that is the only name a hand-written codex config gives it.
 * Nothing is ever deleted here: a provider dropped from `config.toml` may still
 * be one the user uses through Super D. The one exception runs the other way —
 * an endpoint the user REMOVED in the panel is skipped, so their removal is not
 * undone by the next reconcile.
 *
 * @param store - the canonical list.
 * @param imported - providers parsed from the native config, in file order.
 * @returns the new store plus which ids were added and which were refreshed.
 */
export function syncNativeProviders(
  store: CodexProviderStore,
  imported: readonly NativeProviderImport[],
): ProviderSyncResult {
  const providers: CodexProviderEntry[] = [...store.providers];
  const added: string[] = [];
  const updated: string[] = [];

  for (const incoming of imported) {
    const baseUrl = incoming.baseUrl.trim();
    if (baseUrl === "") continue;
    const key = endpointKey(baseUrl);
    if (store.removed?.includes(key) === true) continue;
    const wantedId = incoming.nativeId !== undefined && isProviderId(incoming.nativeId) ? incoming.nativeId : undefined;

    const at = providers.findIndex((entry) =>
      (wantedId !== undefined && entry.id === wantedId) || endpointKey(entry.baseUrl) === key);
    if (at === -1) {
      const id = uniqueProviderId(wantedId ?? providerIdFromEndpoint(baseUrl), providers.map((entry) => entry.id));
      providers.push({
        id,
        label: baseUrl,
        baseUrl,
        protocol: incoming.protocol,
        auth: incoming.auth,
        models: unionModels([], incoming.models),
        origin: "native",
      });
      added.push(id);
      continue;
    }

    const entry = providers[at];
    const models = unionModels(entry.models, incoming.models);
    // The native table is the user's own statement about how codex should
    // authenticate, but a secret Super D already holds must not be dropped in
    // favour of "look in auth.json" — an empty apiKey value is the only shape
    // that defers to the runtime, so only that one follows the native file.
    const adoptAuth = entry.auth.kind === "env" || entry.auth.value === "";
    const next: CodexProviderEntry = {
      ...entry,
      baseUrl,
      protocol: incoming.protocol,
      ...(adoptAuth ? { auth: incoming.auth } : {}),
      models,
    };
    const changed = next.baseUrl !== entry.baseUrl
      || next.protocol !== entry.protocol
      || next.models !== entry.models
      || !sameAuth(next.auth, entry.auth);
    if (changed) {
      providers[at] = next;
      updated.push(entry.id);
    }
  }

  const removed = store.removed ?? [];
  const next = removed.length === 0
    ? { version: 1 as const, providers }
    : { version: 1 as const, providers, removed };
  return { store: next, added, updated };
}
