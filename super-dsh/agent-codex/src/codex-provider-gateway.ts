/**
 * codex-provider-gateway.ts — the adapter-owned Remote behind the Hub's Codex
 * settings panel (2026-10-03 user ruling; `agyAuth` is the working precedent).
 *
 * Why a Remote and not a hub route: the provider list, the native-file mutation
 * and the "which one is in force" read are all ADAPTER config (dev-rules §12),
 * so the adapter owns them and the hub only forwards. `TypertRemoteService` +
 * `@Remote` is the whole mechanism — standard (TC39) method decorators recorded
 * on the class prototype, read back at dispatch time by the gateway's
 * source-claim scan. No codegen, no compiler-injected metadata, which is why a
 * plain `tsc` adapter build can ship one.
 *
 * Wire contract (`superd-hub/src/client/runtime-settings-api.ts` builds each
 * envelope; the hub carrier forwards `envelope.method` verbatim):
 *
 *   request   POST /hub/api?agent=codex
 *             { type:'client-request', rpcId, method:'codexProviders/<op>',
 *               payload: { args: { request?: … } } }
 *   response  { type:'server-response', rpcId, result:{ ok:true, value:<view> } }
 *
 * The class is a delegation shell on purpose: every operation is a plain
 * function over (worldHome, codexHome), so the entire contract — the key
 * privacy rule, the validation, the seeding, the write ordering — is pinnable
 * under `node --test` with no Cordis Context and no real home.
 *
 * @module agent-codex/codex-provider-gateway
 */

import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import {
  isProviderId,
  isWireProtocol,
  providerStorePath,
  readProviderStore,
  removeProvider,
  selectProvider,
  upsertProvider,
  writeProviderStore,
  type CodexProviderEntry,
  type CodexProviderModel,
  type CodexProviderStore,
  type CodexWireProtocol,
} from "./codex-providers.js";
import {
  SUPERD_CATALOG_FILE,
  readNativeSelection,
  writeNativeSelection,
  type NativeSelection,
} from "./codex-native-config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One wire protocol as the panel renders it. */
export interface CodexProtocolOptionView {
  readonly value: CodexWireProtocol;
  readonly label: string;
  /** Selectable this round. */
  readonly available: boolean;
  /** One short line saying what it is, or why it is inert. */
  readonly hint: string;
}

/**
 * Both protocols are advertised, because the user asked for that dropdown — and
 * because a user arriving from cc-switch has seen exactly these two options
 * there. `chat` is rendered but not selectable: codex 0.154 refuses it at config
 * load, and the hint is the binary's own sentence rather than our paraphrase.
 */
export const PROTOCOL_OPTIONS: readonly CodexProtocolOptionView[] = [
  {
    value: "responses",
    label: "Responses API",
    available: true,
    hint: "Codex's native wire protocol — the only one 0.154 accepts.",
  },
  {
    value: "chat",
    label: "Chat Completions",
    available: false,
    hint: '`wire_api = "chat"` is no longer supported.\nHow to fix: set `wire_api = "responses"` in your provider config.',
  },
];

/** One provider as the panel consumes it — never carries a key. */
export interface CodexProviderView {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly protocol: CodexWireProtocol;
  readonly models: readonly CodexProviderModel[];
  readonly authKind: "apiKey" | "env";
  /** The variable an `env` provider expects, when that is its shape. */
  readonly envName?: string;
  /** A key is available (stored, or already in the runtime's own auth.json). */
  readonly hasKey: boolean;
}

/** The panel's whole state. */
export interface CodexProvidersView {
  readonly providers: readonly CodexProviderView[];
  /** The user's explicit choice, `null` until they make one. */
  readonly selected: string | null;
  /** What `config.toml` actually puts in force right now. */
  readonly effective: { readonly providerId?: string; readonly model?: string } | null;
  readonly protocols: readonly CodexProtocolOptionView[];
  /** The files a switch writes — shown so the effect is never a surprise. */
  readonly paths: {
    readonly store: string;
    readonly config: string;
    readonly auth: string;
    readonly catalog: string;
  };
  /** Populated only when something needs explaining. */
  readonly note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Whether the runtime's own auth.json already holds a key (never read out). */
function authJsonHasKey(codexHome: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    return isRecord(parsed) && nonEmpty(parsed["OPENAI_API_KEY"]) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whether the runtime's own auth.json is signed in with a ChatGPT account.
 *
 * Measured 2026-10-03 on this machine: when `auth_mode` is `chatgpt`, codex's
 * auth manager refreshes the OAuth token FIRST and never falls through to the
 * `OPENAI_API_KEY` in the same file — so a `requires_openai_auth` provider is
 * silently unusable behind a ChatGPT login (here the refresh is 403
 * `unsupported_country_region_territory`; the `env_key` shape is unaffected
 * because it never consults the auth manager at all). We cannot fix that from
 * our side without evicting the user's login, which cc-switch has dedicated
 * code to preserve — so we say it out loud instead.
 */
function chatgptAuthMode(codexHome: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    return isRecord(parsed) && parsed["auth_mode"] === "chatgpt";
  } catch {
    return false;
  }
}

/** Whether an entry's key is actually available right now. */
function keyAvailable(codexHome: string, entry: CodexProviderEntry): boolean {
  if (entry.auth.kind === "apiKey") {
    return entry.auth.value !== "" || authJsonHasKey(codexHome);
  }
  return nonEmpty(process.env[entry.auth.name]) !== undefined;
}

function project(codexHome: string, entry: CodexProviderEntry): CodexProviderView {
  return {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    protocol: entry.protocol,
    models: entry.models,
    authKind: entry.auth.kind,
    ...(entry.auth.kind === "env" ? { envName: entry.auth.name } : {}),
    hasKey: keyAvailable(codexHome, entry),
  };
}

/**
 * Build the store entry for whatever the user's own `config.toml` already runs,
 * so the panel opens on the truth instead of on an empty list.
 *
 * The key is deliberately NOT copied out of `auth.json`: an `apiKey` seed lands
 * with an empty value, which means "the runtime holds this one". Selecting such
 * an entry writes the provider table and leaves `auth.json` alone.
 *
 * @returns the entry, or `undefined` when the config names nothing we can
 * represent (no id, or no base URL / model to describe).
 */
export function seedFromNative(native: NativeSelection): CodexProviderEntry | undefined {
  if (native.providerId === undefined || !isProviderId(native.providerId)) return undefined;
  const baseUrl = nonEmpty(native.baseUrl);
  const model = nonEmpty(native.model);
  if (baseUrl === undefined || model === undefined) return undefined;
  const envName = native.auth?.kind === "env" ? native.auth.name : undefined;
  return {
    id: native.providerId,
    label: native.providerId,
    baseUrl,
    protocol: isWireProtocol(native.protocol) ? native.protocol : "responses",
    auth: envName === undefined ? { kind: "apiKey", value: "" } : { kind: "env", name: envName },
    models: [{ id: model }],
  };
}

/**
 * Read the store, seeding it once from the live config when Super D has no
 * providers of its own yet. Seeding is the only write a read performs, and it
 * touches nothing but the adapter's own store.
 */
function loadStore(worldHome: string, codexHome: string): { store: CodexProviderStore; note?: string } {
  const stored = readProviderStore(worldHome);
  if (stored.providers.length > 0) return { store: stored };

  const seed = seedFromNative(readNativeSelection(codexHome));
  if (seed === undefined) return { store: stored };

  const store = selectProvider(upsertProvider({ version: 1, providers: [] }, seed), seed.id);
  writeProviderStore(worldHome, store);
  return {
    store,
    note: `Imported "${seed.id}" from your Codex config.toml — Super D had no providers yet.`,
  };
}

/** The view for one (already loaded) store. */
function viewOf(worldHome: string, codexHome: string, store: CodexProviderStore, note?: string): CodexProvidersView {
  const native = readNativeSelection(codexHome);
  const effective = native.providerId === undefined && native.model === undefined
    ? null
    : {
      ...(native.providerId === undefined ? {} : { providerId: native.providerId }),
      ...(native.model === undefined ? {} : { model: native.model }),
    };

  // A provider configured outside Super D (by cc-switch, or by hand) is in force
  // but unlisted; saying so is the difference between a confusing panel and an
  // honest one.
  const unlisted = native.providerId !== undefined && !store.providers.some((entry) => entry.id === native.providerId)
    ? `Codex is running "${native.providerId}", which was configured outside Super D and is not in this list.`
    : undefined;
  // The measured footgun (2026-10-03): a keyed provider behind a ChatGPT login
  // looks configured and cannot run. Say so on the panel rather than let the
  // user discover it as a failed turn.
  const shadowed = native.auth?.kind === "apiKey" && chatgptAuthMode(codexHome)
    ? 'Codex is signed in with a ChatGPT account, which takes precedence over a saved API key — a keyed provider will not run until you sign out (`codex logout`) or switch this provider to an environment variable.'
    : undefined;
  const combined = [note, unlisted, shadowed].filter((part): part is string => part !== undefined).join(" ");

  return {
    providers: store.providers.map((entry) => project(codexHome, entry)),
    selected: store.selected ?? null,
    effective,
    protocols: PROTOCOL_OPTIONS,
    paths: {
      store: providerStorePath(worldHome),
      config: join(codexHome, "config.toml"),
      auth: join(codexHome, "auth.json"),
      catalog: join(codexHome, SUPERD_CATALOG_FILE),
    },
    ...(combined === "" ? {} : { note: combined }),
  };
}

/** Read the panel state (seeding the store from the live config when empty). */
export function readProvidersView(worldHome: string, codexHome: string): CodexProvidersView {
  const { store, note } = loadStore(worldHome, codexHome);
  return viewOf(worldHome, codexHome, store, note);
}

/**
 * Validate one `codexProviders/save` request.
 *
 * @param request - the wire payload's `request` argument.
 * @param existing - the entry this save replaces, so an edit that does not
 * re-type the key keeps the stored one.
 * @throws {TypeError} naming the offending field.
 */
export function normalizeSaveRequest(request: unknown, existing?: CodexProviderEntry): CodexProviderEntry {
  if (!isRecord(request) || !isRecord(request["provider"])) {
    throw new TypeError("codexProviders/save: provider must be an object");
  }
  const raw = request["provider"];

  const id = raw["id"];
  if (!isProviderId(id)) {
    throw new TypeError(`codexProviders/save: id must match /^[a-z0-9][a-z0-9-]*$/ (got ${JSON.stringify(id)})`);
  }
  const label = nonEmpty(raw["label"]);
  if (label === undefined) throw new TypeError("codexProviders/save: label must be a non-empty string");

  const baseUrl = nonEmpty(raw["baseUrl"]);
  if (baseUrl === undefined) throw new TypeError("codexProviders/save: baseUrl must be a non-empty string");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`codexProviders/save: baseUrl is not a URL (got ${JSON.stringify(baseUrl)})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`codexProviders/save: baseUrl must be http(s) (got ${parsed.protocol})`);
  }

  const protocol = raw["protocol"];
  if (!isWireProtocol(protocol)) {
    throw new TypeError(`codexProviders/save: protocol must be "responses" or "chat" (got ${JSON.stringify(protocol)})`);
  }
  if (protocol === "chat") {
    // Refused at the boundary rather than persisted and discovered by codex.
    throw new TypeError('codexProviders/save: protocol "chat" is refused by codex 0.154; use "responses"');
  }

  const rawModels = raw["models"];
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new TypeError("codexProviders/save: models must be a non-empty array");
  }
  const models: CodexProviderModel[] = rawModels.map((value) => {
    if (!isRecord(value)) throw new TypeError("codexProviders/save: every entry of models must be an object");
    const modelId = nonEmpty(value["id"]);
    if (modelId === undefined) throw new TypeError("codexProviders/save: every entry of models needs a non-empty id");
    const displayName = nonEmpty(value["displayName"]);
    const contextWindow = value["contextWindow"];
    return {
      id: modelId,
      ...(displayName === undefined ? {} : { displayName }),
      ...(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0
        ? { contextWindow }
        : {}),
    };
  });

  const rawAuth = raw["auth"];
  if (!isRecord(rawAuth)) throw new TypeError("codexProviders/save: auth must be an object");
  let auth: CodexProviderEntry["auth"];
  if (rawAuth["kind"] === "env") {
    const name = nonEmpty(rawAuth["name"]);
    if (name === undefined) throw new TypeError("codexProviders/save: auth.name must be a non-empty string");
    auth = { kind: "env", name };
  } else if (rawAuth["kind"] === "apiKey") {
    const value = rawAuth["value"];
    if (typeof value !== "string") throw new TypeError("codexProviders/save: auth.value must be a string");
    // An empty value on an edit means "keep the stored one" — the panel is
    // write-only for keys, so it cannot echo the existing value back.
    const kept = value === "" && existing?.auth.kind === "apiKey" ? existing.auth.value : value;
    auth = { kind: "apiKey", value: kept };
  } else {
    throw new TypeError(`codexProviders/save: auth.kind must be "apiKey" or "env" (got ${JSON.stringify(rawAuth["kind"])})`);
  }

  return { id, label, baseUrl, protocol, auth, models };
}

/** Insert or replace one provider. Saving never switches the runtime. */
export function saveProvider(worldHome: string, codexHome: string, request: unknown): CodexProvidersView {
  const { store } = loadStore(worldHome, codexHome);
  const id = isRecord(request) && isRecord(request["provider"]) ? request["provider"]["id"] : undefined;
  const existing = store.providers.find((entry) => entry.id === id);
  const entry = normalizeSaveRequest(request, existing);
  const next = upsertProvider(store, entry);
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, codexHome, next);
}

/** Drop one provider. The native config is left alone — removing from this list is not unconfiguring Codex. */
export function removeProviderEntry(worldHome: string, codexHome: string, request: unknown): CodexProvidersView {
  const id = isRecord(request) ? nonEmpty(request["id"]) : undefined;
  if (id === undefined) throw new TypeError("codexProviders/remove: id must be a non-empty string");
  const { store } = loadStore(worldHome, codexHome);
  const next = removeProvider(store, id);
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, codexHome, next);
}

/**
 * Put one provider in force: write the native files first, record the choice
 * second. A failed write therefore leaves no selection claiming something that
 * is not running.
 *
 * `null` clears the explicit choice without rewriting the runtime — clearing a
 * preference is not a request to unconfigure Codex.
 */
export function selectProviderEntry(worldHome: string, codexHome: string, request: unknown): CodexProvidersView {
  const raw = isRecord(request) ? request["id"] : null;
  let id: string | null;
  if (raw === null || raw === undefined) {
    id = null;
  } else {
    const value = nonEmpty(raw);
    if (value === undefined) throw new TypeError("codexProviders/select: id must be a non-empty string or null");
    id = value;
  }

  const { store } = loadStore(worldHome, codexHome);
  const next = selectProvider(store, id);
  if (id !== null) {
    const entry = store.providers.find((candidate) => candidate.id === id) as CodexProviderEntry;
    writeNativeSelection(codexHome, { provider: entry, model: entry.models[0].id });
  }
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, codexHome, next);
}

/**
 * The adapter's provider Remote. One instance per world context.
 */
export class CodexProvidersGateway extends TypertRemoteService {
  /**
   * @param ctx - the world context this service registers on (namespace `codexProviders`).
   * @param worldHome - the world's DSH home holding adapter state (`<dshHome>/agents/codex`).
   * @param codexHome - the USER's real codex home (native settings live there), resolved lazily so construction stays zero-IO.
   */
  constructor(
    ctx: Context,
    private readonly worldHome: string,
    private readonly codexHome: () => string,
  ) {
    super(ctx, "codexProviders");
  }

  /** Read the panel state. Seeds the adapter store on first read; never writes the native home. */
  @Remote("get")
  async get(): Promise<CodexProvidersView> {
    return readProvidersView(this.worldHome, this.codexHome());
  }

  /** Add or edit one provider. Does not switch the runtime. */
  @Remote("save")
  async save(request?: unknown): Promise<CodexProvidersView> {
    return saveProvider(this.worldHome, this.codexHome(), request);
  }

  /** Drop one provider from the list. Does not rewrite the native config. */
  @Remote("remove")
  async remove(request?: unknown): Promise<CodexProvidersView> {
    return removeProviderEntry(this.worldHome, this.codexHome(), request);
  }

  /** Put one provider in force in the user's real codex home (`null` clears the choice). */
  @Remote("select")
  async select(request?: unknown): Promise<CodexProvidersView> {
    return selectProviderEntry(this.worldHome, this.codexHome(), request);
  }
}
