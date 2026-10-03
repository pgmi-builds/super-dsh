/**
 * codex-provider-gateway.ts — the adapter-owned Remote behind the Hub's Codex
 * settings panel (2026-10-03 user ruling; reworked 2026-10-04).
 *
 * Why a Remote and not a hub route: the provider list is ADAPTER config
 * (dev-rules §12), so the adapter owns it and the hub only forwards.
 * `TypertRemoteService` + `@Remote` is the whole mechanism — standard (TC39)
 * method decorators recorded on the class prototype, read back at dispatch time
 * by the gateway's source-claim scan. No codegen, no compiler-injected metadata,
 * which is why a plain `tsc` adapter build can ship one.
 *
 * Wire contract (`superd-hub/src/client/runtime-settings-api.ts` builds each
 * envelope; the hub carrier forwards `envelope.method` verbatim):
 *
 *   request   POST /hub/api?agent=codex
 *             { type:'client-request', rpcId, method:'codexProviders/<op>',
 *               payload: { args: { request?: … } } }
 *   response  { type:'server-response', rpcId, result:{ ok:true, value:<view> } }
 *
 * There is no `select`: which provider a SESSION runs on is DSH's own
 * per-session `model/selection`, chosen from the harness's model selector. This
 * panel is a list editor — add, edit, remove — plus the reconcile with the
 * user's `config.toml` that {@link syncFromNative} performs.
 *
 * The class is a delegation shell on purpose: every operation is a plain
 * function over (worldHome, codexHome), so the entire contract — the key
 * privacy rule, the validation, the sync, the view projection — is pinnable
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
  syncNativeProviders,
  upsertProvider,
  writeProviderStore,
  type CodexProviderEntry,
  type CodexProviderModel,
  type CodexProviderStore,
  type CodexWireProtocol,
  type NativeProviderImport,
} from "./codex-providers.js";
import {
  providerCatalogDir,
  readNativeProviders,
  readNativeSelection,
  type NativeProviderTable,
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
  /** May be empty: an imported provider's models are only knowable once it is in force. */
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
  /**
   * What the user's OWN `config.toml` names right now. Informational: it is
   * what their `codex` CLI runs, not what any Super D session runs, and there
   * is deliberately no action attached to it.
   */
  readonly native: { readonly providerId?: string; readonly model?: string } | null;
  readonly protocols: readonly CodexProtocolOptionView[];
  /** The paths this adapter reads and owns — shown so their split is never a surprise. */
  readonly paths: {
    readonly store: string;
    /** Read only, since the on-the-fly rework: nothing here is written any more. */
    readonly config: string;
    readonly auth: string;
    /** The adapter's own per-provider model catalogs, under the world home. */
    readonly catalogs: string;
  };
  /** Epoch ms of the last reconcile against `config.toml`, when one has happened. */
  readonly syncedAt?: number;
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
 * `unsupported_country_region_territory`). The `env_key` shape is unaffected
 * because it never consults the auth manager at all, which is why the launch
 * path now hands a stored key to the child through its own environment
 * (`codex-launch.ts`). What remains exposed is only the SEEDED shape: an entry
 * that holds no key because the runtime's auth.json was supposed to.
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

/** Turn one parsed native table into the store's import shape. */
function toImport(table: NativeProviderTable): NativeProviderImport {
  return {
    ...(table.id === "" ? {} : { nativeId: table.id }),
    baseUrl: table.baseUrl,
    protocol: table.protocol,
    auth: table.auth,
    models: table.models,
  };
}

/**
 * Reconcile the canonical store against the user's `config.toml`.
 *
 * This is the sync the 2026-10-04 ruling asks for: the store is canonical, the
 * native file is a SOURCE, and the two are joined by endpoint URL (the only
 * identity a hand-written codex config reliably carries). It runs at adapter
 * startup and every ten minutes thereafter, and it is idempotent and silent —
 * the file is only rewritten when something actually moved.
 *
 * @param worldHome - the world's DSH home.
 * @param codexHome - the native codex home (read only).
 * @returns the effective store plus what the sync changed.
 */
export function syncFromNative(
  worldHome: string,
  codexHome: string,
): { store: CodexProviderStore; added: readonly string[]; updated: readonly string[] } {
  const store = readProviderStore(worldHome);
  const imported = readNativeProviders(codexHome).map(toImport);
  const result = syncNativeProviders(store, imported);
  if (result.added.length > 0 || result.updated.length > 0) {
    writeProviderStore(worldHome, result.store);
  }
  return result;
}

/** The view for one (already loaded) store. */
function viewOf(
  worldHome: string,
  codexHome: string,
  store: CodexProviderStore,
  syncedAt?: number,
  note?: string,
): CodexProvidersView {
  const nativeSelection = readNativeSelection(codexHome);
  const native = nativeSelection.providerId === undefined && nativeSelection.model === undefined
    ? null
    : {
      ...(nativeSelection.providerId === undefined ? {} : { providerId: nativeSelection.providerId }),
      ...(nativeSelection.model === undefined ? {} : { model: nativeSelection.model }),
    };

  // Only a SEEDED keyed entry defers to auth.json, so only it can be shadowed
  // by a ChatGPT login. An entry holding its own key bypasses the auth manager
  // entirely through the launch's synthetic `env_key`.
  const deferred = store.providers.some((entry) => entry.auth.kind === "apiKey" && entry.auth.value === "");
  const shadowed = deferred && chatgptAuthMode(codexHome)
    ? 'Codex is signed in with a ChatGPT account, which takes precedence over a saved API key — a provider that relies on auth.json will not run until you sign out (`codex logout`) or give this provider its own key.'
    : undefined;
  const combined = [note, shadowed].filter((part): part is string => part !== undefined).join(" ");

  return {
    providers: store.providers.map((entry) => project(codexHome, entry)),
    native,
    protocols: PROTOCOL_OPTIONS,
    paths: {
      store: providerStorePath(worldHome),
      config: join(codexHome, "config.toml"),
      auth: join(codexHome, "auth.json"),
      catalogs: providerCatalogDir(worldHome),
    },
    ...(syncedAt === undefined ? {} : { syncedAt }),
    ...(combined === "" ? {} : { note: combined }),
  };
}

/**
 * Read the panel state, reconciling with `config.toml` first.
 *
 * Reading is a write-free act for the native home now (the old build seeded the
 * store from it once); the only write this can perform is to the adapter's own
 * store, and only when the sync found something new.
 *
 * @param worldHome - the world's DSH home.
 * @param codexHome - the native codex home.
 * @param syncedAt - epoch ms to report as the last reconcile.
 * @returns the panel's state.
 */
export function readProvidersView(worldHome: string, codexHome: string, syncedAt?: number): CodexProvidersView {
  const { store, added, updated } = syncFromNative(worldHome, codexHome);
  const note = added.length === 0 && updated.length === 0
    ? undefined
    : `Imported ${added.length} provider(s) from your Codex config.toml${updated.length === 0 ? "" : ` and refreshed ${updated.join(", ")}`}.`;
  // A read IS the reconcile, so the timestamp is the read's own unless the
  // caller has a better one — otherwise the panel would never have one to show.
  return viewOf(worldHome, codexHome, store, syncedAt ?? Date.now(), note);
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
  // An empty list is legal: it is the state a provider imported from a native
  // config arrives in (only the provider in force has a discoverable catalog),
  // and the panel must be able to save an edit without inventing models.
  if (!Array.isArray(rawModels)) {
    throw new TypeError("codexProviders/save: models must be an array");
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

  return { id, label, baseUrl, protocol, auth, models, origin: "user" };
}

/**
 * Insert or replace one provider.
 *
 * Nothing native is written, and nothing is "activated": the model catalog for
 * this provider is regenerated on the adapter's own tree (`codex-launch.ts`
 * does it at spawn), and the next session that picks one of these models gets a
 * child pinned to it.
 */
export function saveProvider(worldHome: string, codexHome: string, request: unknown, syncedAt?: number): CodexProvidersView {
  const store = readProviderStore(worldHome);
  const id = isRecord(request) && isRecord(request["provider"]) ? request["provider"]["id"] : undefined;
  const existing = store.providers.find((entry) => entry.id === id);
  const entry = normalizeSaveRequest(request, existing);
  const next = upsertProvider(store, entry);
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, codexHome, next, syncedAt);
}

/** Drop one provider. The native config is left alone — removing from this list is not unconfiguring Codex. */
export function removeProviderEntry(worldHome: string, codexHome: string, request: unknown, syncedAt?: number): CodexProvidersView {
  const id = isRecord(request) ? nonEmpty(request["id"]) : undefined;
  if (id === undefined) throw new TypeError("codexProviders/remove: id must be a non-empty string");
  const store = readProviderStore(worldHome);
  const next = removeProvider(store, id);
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, codexHome, next, syncedAt);
}

/**
 * The adapter's provider Remote. One instance per world context.
 */
export class CodexProvidersGateway extends TypertRemoteService {
  /**
   * @param ctx - the world context this service registers on (namespace `codexProviders`).
   * @param worldHome - the world's DSH home holding adapter state (`<dshHome>/agents/codex`).
   * @param codexHome - the USER's real codex home (native settings live there), resolved lazily so construction stays zero-IO.
   * @param onChange - notified after any mutation, so the provider's `ctx.llm` routes can be re-registered.
   */
  constructor(
    ctx: Context,
    private readonly worldHome: string,
    private readonly codexHome: () => string,
    private readonly onChange: () => void = () => { },
  ) {
    super(ctx, "codexProviders");
  }

  /** Read the panel state, reconciling the store with `config.toml` first. Never writes the native home. */
  @Remote("get")
  async get(): Promise<CodexProvidersView> {
    const view = readProvidersView(this.worldHome, this.codexHome());
    this.onChange();
    return view;
  }

  /** Add or edit one provider. */
  @Remote("save")
  async save(request?: unknown): Promise<CodexProvidersView> {
    const view = saveProvider(this.worldHome, this.codexHome(), request);
    this.onChange();
    return view;
  }

  /** Drop one provider from the list. */
  @Remote("remove")
  async remove(request?: unknown): Promise<CodexProvidersView> {
    const view = removeProviderEntry(this.worldHome, this.codexHome(), request);
    this.onChange();
    return view;
  }
}
