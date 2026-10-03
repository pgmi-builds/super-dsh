/**
 * claude-provider-gateway.ts — the adapter-owned Remote behind the Hub's Claude
 * settings panel (2026-10-04 multi-provider ruling).
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
 *   request   POST /hub/api?agent=claude
 *             { type:'client-request', rpcId, method:'claudeProviders/<op>',
 *               payload: { args: { request?: … } } }
 *   response  { type:'server-response', rpcId, result:{ ok:true, value:<view> } }
 *
 * There is no `select`: which provider a SESSION runs on is DSH's own
 * per-session `model/selection`, chosen from the harness's model selector. This
 * panel is a list editor — add, edit, remove — plus the reconcile with the
 * user's `settings.json` that {@link syncFromNative} performs.
 *
 * The class is a delegation shell on purpose: every operation is a plain
 * function over (worldHome, claudeHome), so the entire contract — the key
 * privacy rule, the validation, the sync, the view projection — is pinnable
 * under `node --test` with no Cordis Context and no real home.
 *
 * @module agent-claude/claude-provider-gateway
 */

import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import {
  isProviderId,
  providerStorePath,
  readProviderStore,
  removeProvider,
  syncNativeProviders,
  upsertProvider,
  writeProviderStore,
  type ClaudeProviderEntry,
  type ClaudeProviderModel,
  type ClaudeProviderStore,
  type NativeProviderImport,
} from "./claude-providers.js";
import {
  readNativeModel,
  readNativeProviders,
  type NativeProviderTable,
} from "./claude-native-config.js";
import { join } from "node:path";

/** One provider as the panel consumes it — never carries a key. */
export interface ClaudeProviderView {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /**
   * May be empty: a provider folded in from a settings env that names no
   * `ANTHROPIC_DEFAULT_*_MODEL` alias has no discoverable model list at all.
   */
  readonly models: readonly ClaudeProviderModel[];
  /**
   * How the child is keyed. The env VARIABLE follows mechanically at launch
   * (`ANTHROPIC_AUTH_TOKEN` for the Bearer shape, `ANTHROPIC_API_KEY` for the
   * `x-api-key` shape — `claude-launch.ts`), which is why the panel never has
   * to ask for one.
   */
  readonly authKind: "authToken" | "apiKey";
  /**
   * A key is stored. There is no other place it could be: claude has no
   * auth-manager file an entry could defer to, so an EMPTY value is the real
   * "keyed outside Super D" state and reports `false` honestly.
   */
  readonly hasKey: boolean;
}

/** The panel's whole state. */
export interface ClaudeProvidersView {
  readonly providers: readonly ClaudeProviderView[];
  /**
   * What the user's OWN `settings.json` env names right now — the endpoint in
   * force and the model their own Claude CLI runs. Informational: it is their
   * file (cc-switch may own it), not this adapter's, and there is deliberately
   * no action attached to it.
   */
  readonly native: { readonly baseUrl?: string; readonly model?: string } | null;
  /** The paths this adapter reads and owns — shown so their split is never a surprise. */
  readonly paths: {
    readonly store: string;
    /** Read only: the native settings file is a source, never a write target. */
    readonly settings: string;
  };
  /** Epoch ms of the last reconcile against `settings.json`, when one has happened. */
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

/**
 * Whether an entry's key is actually available right now.
 *
 * Claude has no auth-manager shadowing to work around (the codex face's
 * ChatGPT-login wrinkle has no analogue here): both kinds carry the literal
 * secret and reach the child through its own environment
 * (`claude-launch.ts`), so the store IS the whole truth — an empty value is the
 * real "keyed outside Super D" state and nothing else can supply the key.
 */
function keyAvailable(entry: ClaudeProviderEntry): boolean {
  return entry.auth.value !== "";
}

function project(entry: ClaudeProviderEntry): ClaudeProviderView {
  return {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    models: entry.models,
    authKind: entry.auth.kind,
    hasKey: keyAvailable(entry),
  };
}

/** Turn one parsed native table into the store's import shape. */
function toImport(table: NativeProviderTable): NativeProviderImport | undefined {
  // The native read emits a table only when a usable endpoint exists, and it
  // always classifies an auth shape by then; the optionals are the TYPE being
  // honest about a hand-edited file, so the fold keeps only tables that
  // actually carry the pair.
  if (table.baseUrl === undefined || table.auth === undefined) return undefined;
  return {
    baseUrl: table.baseUrl,
    auth: table.auth,
    models: table.models,
    ...(table.aliases === undefined ? {} : { aliases: table.aliases }),
  };
}

/**
 * Reconcile the canonical store against the user's `settings.json` env.
 *
 * This is the sync the 2026-10-04 ruling asks for: the store is canonical, the
 * native settings env is a SOURCE, and the two are joined by endpoint URL (the
 * only identity a hand-written settings env reliably carries — it names no
 * provider). It runs at adapter startup and every ten minutes thereafter, and
 * it is idempotent and silent — the store is only rewritten when something
 * actually moved.
 *
 * @param worldHome - the world's DSH home.
 * @param claudeHome - the native claude home (read only).
 * @returns the effective store plus what the sync changed.
 */
export function syncFromNative(
  worldHome: string,
  claudeHome: string,
): { store: ClaudeProviderStore; added: readonly string[]; updated: readonly string[] } {
  const store = readProviderStore(worldHome);
  const imported = readNativeProviders(claudeHome)
    .map(toImport)
    .filter((value): value is NativeProviderImport => value !== undefined);
  const result = syncNativeProviders(store, imported);
  if (result.added.length > 0 || result.updated.length > 0) {
    writeProviderStore(worldHome, result.store);
  }
  return result;
}

/** The view for one (already loaded) store. */
function viewOf(
  worldHome: string,
  claudeHome: string,
  store: ClaudeProviderStore,
  syncedAt?: number,
  note?: string,
): ClaudeProvidersView {
  // A settings env declares at most one endpoint, so the FIRST table is the
  // one in force. `readNativeModel` is read on its own because a native setup
  // on the default Anthropic endpoint carries a model but no base URL.
  const baseUrl = readNativeProviders(claudeHome)[0]?.baseUrl;
  const model = readNativeModel(claudeHome);
  const native = baseUrl === undefined && model === undefined
    ? null
    : {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(model === undefined ? {} : { model }),
    };

  return {
    providers: store.providers.map(project),
    native,
    paths: {
      store: providerStorePath(worldHome),
      settings: join(claudeHome, "settings.json"),
    },
    ...(syncedAt === undefined ? {} : { syncedAt }),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * Read the panel state, reconciling with the native `settings.json` env first.
 *
 * Reading never writes the native home; the only write this can perform is to
 * the adapter's own store, and only when the sync found something new.
 *
 * @param worldHome - the world's DSH home.
 * @param claudeHome - the native claude home.
 * @param syncedAt - epoch ms to report as the last reconcile.
 * @returns the panel's state.
 */
export function readProvidersView(worldHome: string, claudeHome: string, syncedAt?: number): ClaudeProvidersView {
  const { store, added, updated } = syncFromNative(worldHome, claudeHome);
  const note = added.length === 0 && updated.length === 0
    ? undefined
    : `Imported ${added.length} provider(s) from your Claude settings.json${updated.length === 0 ? "" : ` and refreshed ${updated.join(", ")}`}.`;
  // A read IS the reconcile, so the timestamp is the read's own unless the
  // caller has a better one — otherwise the panel would never have one to show.
  return viewOf(worldHome, claudeHome, store, syncedAt ?? Date.now(), note);
}

/**
 * Validate one `claudeProviders/save` request.
 *
 * @param request - the wire payload's `request` argument.
 * @param existing - the entry this save replaces, so an edit that does not
 * re-type the key keeps the stored one.
 * @throws {TypeError} naming the offending field.
 */
export function normalizeSaveRequest(request: unknown, existing?: ClaudeProviderEntry): ClaudeProviderEntry {
  if (!isRecord(request) || !isRecord(request["provider"])) {
    throw new TypeError("claudeProviders/save: provider must be an object");
  }
  const raw = request["provider"];

  const id = raw["id"];
  if (!isProviderId(id)) {
    throw new TypeError(`claudeProviders/save: id must match /^[a-z0-9][a-z0-9-]*$/ (got ${JSON.stringify(id)})`);
  }
  const label = nonEmpty(raw["label"]);
  if (label === undefined) throw new TypeError("claudeProviders/save: label must be a non-empty string");

  const baseUrl = nonEmpty(raw["baseUrl"]);
  if (baseUrl === undefined) throw new TypeError("claudeProviders/save: baseUrl must be a non-empty string");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`claudeProviders/save: baseUrl is not a URL (got ${JSON.stringify(baseUrl)})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`claudeProviders/save: baseUrl must be http(s) (got ${parsed.protocol})`);
  }

  const rawModels = raw["models"];
  // An empty list is legal: it is the state a provider folded in from a native
  // settings env that names no alias model arrives in, and the panel must be
  // able to save an edit without inventing models.
  if (!Array.isArray(rawModels)) {
    throw new TypeError("claudeProviders/save: models must be an array");
  }
  const models: ClaudeProviderModel[] = rawModels.map((value) => {
    if (!isRecord(value)) throw new TypeError("claudeProviders/save: every entry of models must be an object");
    const modelId = nonEmpty(value["id"]);
    if (modelId === undefined) throw new TypeError("claudeProviders/save: every entry of models needs a non-empty id");
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

  // `aliases` is deliberately NOT a save field: the DEFAULT_*_MODEL mapping is
  // derived by the native fold (spec §2.2), the panel never edits it, and a
  // save of a folded entry drops it — the next reconcile re-derives it from
  // the live settings env for as long as the endpoint still matches.

  const rawAuth = raw["auth"];
  if (!isRecord(rawAuth)) throw new TypeError("claudeProviders/save: auth must be an object");
  const kind = rawAuth["kind"];
  if (kind !== "authToken" && kind !== "apiKey") {
    throw new TypeError(`claudeProviders/save: auth.kind must be "authToken" or "apiKey" (got ${JSON.stringify(kind)})`);
  }
  const value = rawAuth["value"];
  if (typeof value !== "string") throw new TypeError("claudeProviders/save: auth.value must be a string");
  // An empty value on an edit means "keep the stored one" — the panel is
  // write-only for keys, so it cannot echo the existing value back. The keep
  // is per kind: a secret of the other shape is not this provider's key.
  const kept = value === "" && existing?.auth.kind === kind ? existing.auth.value : value;
  const auth: ClaudeProviderEntry["auth"] = { kind, value: kept };

  return { id, label, baseUrl, auth, models, origin: "user" };
}

/**
 * Insert or replace one provider.
 *
 * Nothing native is written, and nothing is "activated": the entry sits in the
 * list, and the next session that picks one of its models gets a child pinned
 * to it — `claude-launch.ts` builds the provider's environment at spawn.
 */
export function saveProvider(worldHome: string, claudeHome: string, request: unknown, syncedAt?: number): ClaudeProvidersView {
  const store = readProviderStore(worldHome);
  const id = isRecord(request) && isRecord(request["provider"]) ? request["provider"]["id"] : undefined;
  const existing = store.providers.find((entry) => entry.id === id);
  const entry = normalizeSaveRequest(request, existing);
  const next = upsertProvider(store, entry);
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, claudeHome, next, syncedAt);
}

/** Drop one provider. The native settings are left alone — removing from this list is not unconfiguring Claude Code. */
export function removeProviderEntry(worldHome: string, claudeHome: string, request: unknown, syncedAt?: number): ClaudeProvidersView {
  const id = isRecord(request) ? nonEmpty(request["id"]) : undefined;
  if (id === undefined) throw new TypeError("claudeProviders/remove: id must be a non-empty string");
  const store = readProviderStore(worldHome);
  const next = removeProvider(store, id);
  writeProviderStore(worldHome, next);
  return viewOf(worldHome, claudeHome, next, syncedAt);
}

/**
 * The adapter's provider Remote. One instance per world context.
 */
export class ClaudeProvidersGateway extends TypertRemoteService {
  /**
   * @param ctx - the world context this service registers on (namespace `claudeProviders`).
   * @param worldHome - the world's DSH home holding adapter state (`<dshHome>/agents/claude`).
   * @param claudeHome - the USER's real claude home (native settings live there), resolved lazily so construction stays zero-IO.
   * @param onChange - notified after any mutation, so the provider's `ctx.llm` routes can be re-registered.
   */
  constructor(
    ctx: Context,
    private readonly worldHome: string,
    private readonly claudeHome: () => string,
    private readonly onChange: () => void = () => { },
  ) {
    super(ctx, "claudeProviders");
  }

  /** Read the panel state, reconciling the store with the native settings env first. Never writes the native home. */
  @Remote("get")
  async get(): Promise<ClaudeProvidersView> {
    const view = readProvidersView(this.worldHome, this.claudeHome());
    this.onChange();
    return view;
  }

  /** Add or edit one provider. */
  @Remote("save")
  async save(request?: unknown): Promise<ClaudeProvidersView> {
    const view = saveProvider(this.worldHome, this.claudeHome(), request);
    this.onChange();
    return view;
  }

  /** Drop one provider from the list. */
  @Remote("remove")
  async remove(request?: unknown): Promise<ClaudeProvidersView> {
    const view = removeProviderEntry(this.worldHome, this.claudeHome(), request);
    this.onChange();
    return view;
  }
}
