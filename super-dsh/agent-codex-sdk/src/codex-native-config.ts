/**
 * codex-native-config.ts — reading the foreign runtime's own home, and the one
 * artifact we still put on disk (2026-10-04).
 *
 * Codex is a single-provider harness: its `config.toml` can name exactly ONE
 * `model_provider`, so the LIST of providers a user has configured has nowhere
 * to live natively and lives in the adapter's store instead
 * (`codex-providers.ts`). This module is the other half of that split — the
 * sole authority on what the user's own file actually says.
 *
 * The direction is one-way and stayed that way through the 2026-10-04 rework:
 * `config.toml` is a SOURCE. Nothing here writes it, and nothing writes
 * `auth.json`; a provider reaches a `codex app-server` child as process
 * arguments (see `codex-launch.ts`), which is also why the two protection
 * rules this module used to carry — surgical TOML edits, a merged `auth.json` —
 * are gone rather than kept as dead weight. cc-switch can still own the native
 * file; the sync in `codex-provider-gateway.ts` picks up whatever it leaves
 * there.
 *
 * Two reads live here:
 *
 *  - `readNativeSelection` — what the file puts IN FORCE right now (the panel's
 *    passive "your own codex runs this" line, and the app-wide default model);
 *  - `readNativeProviders` — every `[model_providers.<id>]` table, which is what
 *    the sync folds into the canonical store.
 *
 * Plus the per-provider model catalog we generate under the WORLD home. New
 * entries are cloned from a template rather than synthesized: codex 0.154
 * validates a deep, partly nested field set (`supported_reasoning_levels`,
 * `shell_type`, `visibility`, `priority`, `truncation_policy.…`) that only a
 * real catalog entry carries (measured in plan Task 2 — see
 * docs/superpowers/plans/2026-10-03-*).
 *
 * Everything above the fs layer is a pure string→string function, which is
 * where the tests live.
 *
 * @module agent-codex/codex-native-config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isWireProtocol, type CodexProviderAuth, type CodexProviderEntry, type CodexProviderModel, type CodexWireProtocol } from "./codex-providers.js";

/** The catalog file this adapter owns inside the codex home. */
export const SUPERD_CATALOG_FILE = "superd-model-catalog.json";

const CONFIG_FILE = "config.toml";


/** What `config.toml` says right now — the panel's "in force" read. */
export interface NativeSelection {
  readonly providerId?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly protocol?: string;
  /** How the in-force provider authenticates, as its own table declares it. */
  readonly auth?: { readonly kind: "apiKey" | "env"; readonly name?: string };
}

/** One classified config line: where it sits decides whether it is ours. */
interface Line {
  readonly text: string;
  /** The enclosing table, or `null` at top level. */
  readonly table: string | null;
  /** The key, for a `key = value` line. */
  readonly key?: string;
  /** For a `[table]` header line. */
  readonly header?: string;
}

/** Quote a TOML basic string. Provider ids are slug-validated, but URLs are free. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Classify every line, tracking the enclosing table. Tolerant: junk is `other`. */
function classify(text: string): Line[] {
  const out: Line[] = [];
  let table: string | null = null;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push({ text: raw, table });
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header !== null) {
      table = header[1].trim();
      out.push({ text: raw, table, header: table });
      continue;
    }
    const eq = trimmed.indexOf("=");
    out.push(eq > 0 ? { text: raw, table, key: trimmed.slice(0, eq).trim() } : { text: raw, table });
  }
  return out;
}

/** The `{models:[…]}` member of a catalog string, or `[]` for anything unusable. */
function catalogEntries(text: string | undefined): Array<Record<string, unknown>> {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object");
}

function slugOf(entry: Record<string, unknown>): string | undefined {
  const slug = entry["slug"];
  return typeof slug === "string" && slug !== "" ? slug : undefined;
}

/**
 * Build the catalog this adapter points `model_catalog_json` at.
 *
 * Starts from `existing` (our file, so previously absorbed templates survive),
 * absorbs anything in `absorbed` (the catalog currently named by the config)
 * that we do not already hold, then upserts `models` by slug. Each upserted
 * entry is a CLONE of `template` — an existing entry for the same slug if there
 * is one, else the caller's template, else the first entry either side supplied
 * — with identity and declared context window overridden. The other metadata
 * is copied through except `comp_hash`: this optional opaque compatibility
 * identifier belongs to the template's model, not an unrelated provider model.
 * See the plan's D5 for why we do not synthesize the remaining fields.
 */
export function mergeModelCatalog(
  existing: string | undefined,
  absorbed: string | undefined,
  models: readonly CodexProviderModel[],
  template?: Record<string, unknown>,
): string {
  // Both sides are a TEMPLATE POOL only — never output. What gets emitted is
  // exactly `models`, the models the provider we are switching to serves.
  //
  // Replacing rather than accumulating is a correction (2026-10-03, reported
  // from use): the earlier "absorb everything, drop nothing" rule kept every
  // model any previous provider had ever contributed, so the Chat model
  // selector grew without bound — GLM-5.2, then +DeepSeek Flash, then
  // +GLM-5.3 Flash, with a provider that served only the last two. The catalog
  // is Codex's metadata dictionary for the models it is ABOUT to run, and the
  // DSH selector reads it verbatim (`models.ts` → `LlmAdapter.listModels`), so
  // its contents are user-visible as "the models I can pick". cc-switch writes
  // only the active provider's catalog for the same reason; we now match it.
  const pool = [...catalogEntries(existing), ...catalogEntries(absorbed)];
  const bySlug = new Map<string, Record<string, unknown>>();
  for (const entry of pool) {
    const slug = slugOf(entry);
    if (slug !== undefined && !bySlug.has(slug)) bySlug.set(slug, entry);
  }

  const fallback = template ?? pool[0];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const base = bySlug.get(model.id) ?? fallback ?? {};
    const entry: Record<string, unknown> = {
      ...base,
      slug: model.id,
      display_name: model.displayName ?? model.id,
    };
    // A copied OpenAI hash falsely triggers previous-model compaction on
    // provider switches in Codex 0.160. Our provider model declarations do not
    // carry verified hashes; remove stale generated values too. Context-limit
    // compaction and its window/threshold metadata remain unchanged.
    delete entry["comp_hash"];
    if (model.contextWindow !== undefined) {
      // Codex reads context_window and caps against max_context_window; a stale
      // template value must not silently cap a larger real window.
      entry["context_window"] = model.contextWindow;
      entry["max_context_window"] = model.contextWindow;
    }
    out.push(entry);
  }

  return `${JSON.stringify({ models: out }, null, 2)}\n`;
}

/** Read a file, or `undefined` when it is absent or unreadable. */
function readIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** What `config.toml` currently puts in force (fail-soft: `{}` when it says nothing). */
export function readNativeSelection(codexHome: string): NativeSelection {
  const text = readIfExists(join(codexHome, CONFIG_FILE));
  if (text === undefined) return {};
  const lines = classify(text);
  const top = new Map<string, string>();
  let providerId: string | undefined;
  for (const line of lines) {
    if (line.table !== null || line.key === undefined) continue;
    const value = line.text.slice(line.text.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1");
    if (line.key === "model_provider") providerId = value;
    else if (line.key === "model" || line.key === "model_catalog_json") top.set(line.key, value);
  }
  const model = top.get("model");
  if (providerId === undefined) {
    return model === undefined ? {} : { model };
  }
  let baseUrl: string | undefined;
  let protocol: string | undefined;
  let envKey: string | undefined;
  let openaiAuth = false;
  const wanted = `model_providers.${providerId}`;
  for (const line of lines) {
    if (line.table !== wanted || line.key === undefined) continue;
    const value = line.text.slice(line.text.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1");
    if (line.key === "base_url") baseUrl = value;
    else if (line.key === "wire_api") protocol = value;
    else if (line.key === "env_key") envKey = value;
    else if (line.key === "requires_openai_auth") openaiAuth = value === "true";
  }
  const auth: NativeSelection["auth"] = envKey !== undefined
    ? { kind: "env", name: envKey }
    : openaiAuth
      ? { kind: "apiKey" }
      : undefined;
  return {
    providerId,
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(auth === undefined ? {} : { auth }),
  };
}

/** The catalog file the current config points at, resolved against the home. */
function currentCatalogPath(configText: string | undefined, codexHome: string): string | undefined {
  const text = configText ?? "";
  const found = classify(text).find((line) => line.table === null && line.key === "model_catalog_json");
  if (found === undefined) return undefined;
  const raw = found.text.slice(found.text.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1");
  if (raw === "") return undefined;
  return join(codexHome, raw);
}

/**
 * One provider the native config declares, with the identity the store needs.
 *
 * Codex's `config.toml` carries no friendly name for a provider beyond its
 * `[model_providers.<id>]` table key and its `base_url`; `models` is knowable
 * ONLY for the table named by the top-level `model_provider`, because Codex's
 * catalog file is per-provider-in-force. Every other provider arrives with an
 * empty model list, which the store models as a real state.
 */
export interface NativeProviderTable {
  /** The TOML table key, verbatim (the caller decides whether it is a legal provider id). */
  readonly id: string;
  /** The table's own `name` key when it has one, else the id. */
  readonly label: string;
  readonly baseUrl: string;
  readonly protocol: CodexWireProtocol;
  readonly auth: CodexProviderAuth;
  /** Model ids visible natively; empty for every provider not currently in force. */
  readonly models: readonly string[];
  /** Whether the top-level `model_provider` names this table. */
  readonly active: boolean;
}

/** The unquoted value of a `key = value` line, tolerating a trailing comment. */
function lineValue(line: Line): string {
  const raw = line.text.slice(line.text.indexOf("=") + 1).trim();
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  if (quoted !== null) return quoted[1];
  const hash = raw.indexOf(" #");
  return hash >= 0 ? raw.slice(0, hash).trim() : raw;
}

/** The model slugs a catalog string advertises, in file order. */
function catalogSlugs(text: string | undefined): readonly string[] {
  return catalogEntries(text)
    .map((entry) => slugOf(entry))
    .filter((slug): slug is string => slug !== undefined);
}

/**
 * Parse every `[model_providers.<id>]` table out of the native config.
 *
 * This is the sync SOURCE (2026-10-04): the store is canonical, and the user's
 * own `config.toml` is folded into it by endpoint URL. Only one level of table
 * nesting is read — `model_providers.<id>` and anything under
 * `model_providers.<id>.…` belongs to `<id>` — and a table that declares no
 * usable `base_url` is skipped (there is nothing to dedupe it by).
 *
 * @param codexHome - the NATIVE codex home.
 * @returns every declarable provider, in file order; `[]` when the file is absent.
 */
export function readNativeProviders(codexHome: string): readonly NativeProviderTable[] {
  const text = readIfExists(join(codexHome, CONFIG_FILE));
  if (text === undefined) return [];
  const lines = classify(text);

  let activeId: string | undefined;
  let activeModel: string | undefined;
  let catalogFile: string | undefined;
  for (const line of lines) {
    if (line.table !== null || line.key === undefined) continue;
    if (line.key === "model_provider") activeId = lineValue(line);
    else if (line.key === "model") activeModel = lineValue(line);
    else if (line.key === "model_catalog_json") catalogFile = lineValue(line);
  }

  interface Draft { id: string; label?: string; baseUrl?: string; protocol?: string; envKey?: string; openaiAuth?: boolean }
  const drafts = new Map<string, Draft>();
  for (const line of lines) {
    const table = line.table;
    if (table === null || line.key === undefined) continue;
    if (table !== "model_providers" && !table.startsWith("model_providers.")) continue;
    const rest = table.slice("model_providers.".length);
    if (rest === "") continue;
    const id = rest.split(".")[0];
    if (id === "") continue;
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = { id };
      drafts.set(id, draft);
    }
    // A nested sub-table's keys are not the provider's own; only the top level counts.
    if (rest !== id) continue;
    const value = lineValue(line);
    if (line.key === "name") draft.label = value;
    else if (line.key === "base_url") draft.baseUrl = value;
    else if (line.key === "wire_api") draft.protocol = value;
    else if (line.key === "env_key") draft.envKey = value;
    else if (line.key === "requires_openai_auth") draft.openaiAuth = value === "true";
  }

  // The catalog the native home currently points at — the only model source,
  // and only for the provider in force.
  const activeSlugs = activeId !== undefined && catalogFile !== undefined && catalogFile !== ""
    ? catalogSlugs(readIfExists(join(codexHome, catalogFile)))
    : [];

  const out: NativeProviderTable[] = [];
  for (const draft of drafts.values()) {
    const baseUrl = nonEmpty(draft.baseUrl);
    if (baseUrl === undefined) continue;
    const active = draft.id === activeId;
    const models = active
      ? [...new Set([...(activeModel === undefined ? [] : [activeModel]), ...activeSlugs])]
      : [];
    out.push({
      id: draft.id,
      label: nonEmpty(draft.label) ?? draft.id,
      baseUrl,
      protocol: isWireProtocol(draft.protocol) ? draft.protocol : "responses",
      auth: draft.envKey !== undefined && draft.envKey !== ""
        ? { kind: "env", name: draft.envKey }
        : { kind: "apiKey", value: "" },
      models,
      active,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-provider model catalogs (adapter-owned; the native home is never written) */
/* -------------------------------------------------------------------------- */

/** The directory holding one catalog file per provider, under the world home. */
export function providerCatalogDir(worldHome: string): string {
  return join(worldHome, "codex-catalogs");
}

/** The catalog file this adapter points `model_catalog_json` at for one provider. */
export function providerCatalogPath(worldHome: string, providerId: string): string {
  return join(providerCatalogDir(worldHome), `${providerId}.json`);
}

/**
 * The template every generated entry is cloned from.
 *
 * Codex 0.154 refuses a synthesized catalog entry: it validates a deep, partly
 * nested field set (`supported_reasoning_levels`, `shell_type`, `visibility`,
 * `priority`, `truncation_policy.…`) that only a REAL catalog entry carries.
 * So the first entry of any catalog we can read — ours, or the one the user's
 * own config points at — is the source of the ~35 fields we do not own.
 *
 * @param codexHome - the native home, to find the config-named catalog.
 * @param worldHome - the world home, holding our previously generated catalogs.
 * @returns a template entry, or `undefined` when nothing readable exists yet.
 */
export function catalogTemplate(codexHome: string, worldHome: string): Record<string, unknown> | undefined {
  const configText = readIfExists(join(codexHome, CONFIG_FILE));
  const absorbedPath = currentCatalogPath(configText, codexHome);
  const sources = [
    readIfExists(providerCatalogPath(worldHome, "superd-model-catalog")),
    absorbedPath === undefined ? undefined : readIfExists(absorbedPath),
    readIfExists(join(codexHome, SUPERD_CATALOG_FILE)),
  ];
  for (const text of sources) {
    const first = catalogEntries(text)[0];
    if (first !== undefined) return first;
  }
  return undefined;
}

/**
 * Materialize one provider's model catalog into the ADAPTER's own tree.
 *
 * Nothing is written into `~/.codex` any more (2026-10-04 on-the-fly rework):
 * the file lives at `<worldHome>/codex-catalogs/<id>.json` and reaches the child
 * through `-c model_catalog_json="<absolute path>"`. Codex resolves that key
 * against the process cwd when it arrives as an override, so the path is
 * absolute on purpose (measured: a relative path fails `ENOENT`).
 *
 * @param worldHome - the world's DSH home (adapter state root).
 * @param codexHome - the native home, only read (template material).
 * @param provider - the provider whose models the catalog must advertise.
 * @returns the absolute catalog path, or `undefined` when the provider has no models.
 */
export function writeProviderCatalog(
  worldHome: string,
  codexHome: string,
  provider: CodexProviderEntry,
): string | undefined {
  if (provider.models.length === 0) return undefined;
  const path = providerCatalogPath(worldHome, provider.id);
  const next = mergeModelCatalog(readIfExists(path), undefined, provider.models, catalogTemplate(codexHome, worldHome));
  if (readIfExists(path) !== next) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, { encoding: "utf8", mode: 0o644 });
  }
  return path;
}

/** A trimmed non-empty string, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
