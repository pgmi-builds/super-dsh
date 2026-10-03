/**
 * codex-providers.ts — the adapter-owned multi-provider store behind the Hub's
 * Codex settings panel (2026-10-03 user ruling).
 *
 * Codex is a single-provider harness: its own `config.toml` can name exactly
 * ONE `model_provider`, so "switch provider" is a rewrite of that file. The
 * LIST of configured providers therefore has nowhere to live in Codex's home,
 * and this module is where it lives instead: `<worldHome>/codex-providers.json`
 * under the world's DSH home (`<dshHome>/agents/codex/`), the location
 * dev-rules §5/§13 already assigns to the adapter's own DSH state. The
 * SELECTION is a separate act — `codex-native-config.ts` materializes it into
 * the real `~/.codex` files, one write direction only.
 *
 * The file carries API keys, so it is written 0600 with the sibling
 * `.credentials.yaml` posture, and reads are fail-soft: a corrupt or partial
 * store must degrade to "no providers yet", never take the world down. A
 * provider entry that does not survive validation is DROPPED rather than
 * poisoning the whole list, and a `selected` that names a dropped entry is a
 * dangling reference that gets cleared (the list is the authority; the
 * selection can never outlive it).
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
 * `requires_openai_auth = true`. `env` is the shape a hand-written
 * `config.toml` usually has: the provider table names an `env_key` and the
 * value is expected in the world process's environment. Both are supported
 * because an imported native config may use either, and converting one into
 * the other without being asked would be a silent behaviour change.
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

/** One configured provider. */
export interface CodexProviderEntry {
  /** Stable slug; it becomes the `[model_providers.<id>]` table name. */
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly protocol: CodexWireProtocol;
  readonly auth: CodexProviderAuth;
  /** At least one; the first is the provider's default model. */
  readonly models: readonly CodexProviderModel[];
}

/** The persisted list plus the explicit choice, when the user has made one. */
export interface CodexProviderStore {
  readonly version: 1;
  readonly providers: readonly CodexProviderEntry[];
  /** Absent until the user picks one — absence is not the same as "none is active". */
  readonly selected?: string;
}

/**
 * A provider id becomes a TOML table name and is interpolated into the native
 * config, so the alphabet is deliberately narrow: lowercase alphanumerics and
 * interior hyphens. (Covers `zai-plan`, `deepseek`, `openai`; rejects spaces,
 * dots, quotes and anything that would need TOML escaping.)
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

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
    const secret = str(record["value"]);
    return secret === undefined ? undefined : { kind: "apiKey", value: secret };
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
 * unknown protocol, an id that cannot be a TOML table, no models — so the
 * caller can drop it and keep the rest.
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
  if (!Array.isArray(record["models"])) return undefined;
  const models = record["models"].map(model).filter((entry): entry is CodexProviderModel => entry !== undefined);
  // No models is not a provider: there would be nothing to put in the `model` key.
  if (models.length === 0) return undefined;
  return { id, label, baseUrl, protocol, auth: credentials, models };
}

/**
 * Read the store. Fail-soft by construction: a missing file, unparsable JSON,
 * a wrong top-level shape, or individual bad entries all degrade toward an
 * empty (or shorter) list rather than throwing.
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

  // The selection can only name something the list actually holds; anything
  // else is a dangling reference and is cleared rather than carried forward.
  const wanted = str(record["selected"]);
  const selected = wanted !== undefined && providers.some((entry) => entry.id === wanted) ? wanted : undefined;
  return { version: 1, providers, ...(selected === undefined ? {} : { selected }) };
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

/** Insert or replace one provider by id, preserving list order. */
export function upsertProvider(store: CodexProviderStore, entry: CodexProviderEntry): CodexProviderStore {
  const at = store.providers.findIndex((existing) => existing.id === entry.id);
  const providers = at === -1
    ? [...store.providers, entry]
    : store.providers.map((existing, index) => (index === at ? entry : existing));
  return { ...store, providers };
}

/** Drop one provider; a selection that pointed at it is cleared with it. */
export function removeProvider(store: CodexProviderStore, id: string): CodexProviderStore {
  const providers = store.providers.filter((entry) => entry.id !== id);
  if (store.selected !== id) return { ...store, providers };
  const { selected: _dropped, ...rest } = store;
  return { ...rest, providers };
}

/**
 * Set (or clear, with `null`) the explicit selection.
 *
 * @throws {TypeError} when `id` names no provider — a selection that is not in
 * the list is not a state this store can represent, so it is refused at the
 * boundary rather than persisted and cleaned up later.
 */
export function selectProvider(store: CodexProviderStore, id: string | null): CodexProviderStore {
  if (id === null) {
    const { selected: _cleared, ...rest } = store;
    return rest;
  }
  if (!store.providers.some((entry) => entry.id === id)) {
    throw new TypeError(`codexProviders: unknown provider ${JSON.stringify(id)}`);
  }
  return { ...store, selected: id };
}
