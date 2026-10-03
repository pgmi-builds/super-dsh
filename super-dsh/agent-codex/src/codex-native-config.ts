/**
 * codex-native-config.ts — the WRITE side of the Hub multi-provider panel: the
 * act of switching a provider, expressed as three mutations in the foreign
 * runtime's own home.
 *
 * Codex is a single-provider harness, so there is no "list" to edit natively —
 * only one active provider named by `config.toml`. This module materializes the
 * selection the way cc-switch does (same files, same keys), with two deliberate
 * deviations from cc-switch, both of them protections:
 *
 *  1. `config.toml` is edited SURGICALLY. cc-switch stores a whole config text
 *     per provider and writes it back wholesale, which silently destroys the
 *     user's `[projects."…"] trust_level` entries and every comment. We rewrite
 *     only the four regions we own and preserve every other byte.
 *  2. `auth.json` is MERGED, never rebuilt — it can hold the user's ChatGPT
 *     OAuth login (cc-switch has dedicated code to preserve it too) — and an
 *     `auth.json` we cannot parse is REFUSED rather than clobbered.
 *
 * The model catalog is ours (`superd-model-catalog.json`) but it ABSORBS the
 * entries of whatever catalog `model_catalog_json` currently names, so a later
 * cc-switch switch (which repoints that key at its own file) loses nothing, and
 * our next switch re-absorbs. New entries are cloned from a template rather
 * than synthesized: codex 0.154 requires a deep, partly nested field set
 * (measured in plan Task 2 — see docs/superpowers/plans/2026-10-03-*).
 *
 * Everything above the fs layer is a pure string→string function, which is
 * where the tests live.
 *
 * @module agent-codex/codex-native-config
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CodexProviderEntry, CodexProviderModel } from "./codex-providers.js";

/** The catalog file this adapter owns inside the codex home. */
export const SUPERD_CATALOG_FILE = "superd-model-catalog.json";

const CONFIG_FILE = "config.toml";
const AUTH_FILE = "auth.json";

/** Top-level config keys this adapter owns; every other key is the user's. */
const OWNED_KEYS = ["model_provider", "model", "model_catalog_json"] as const;

/**
 * One snapshot per target per PROCESS, not per call: a long-lived world rewrites
 * config.toml on every switch, and piling up a backup each time would bury the
 * one snapshot that matters (the user's state before Super D ever wrote).
 */
const PROCESS_STAMP = Date.now();
const CONSIDERED = new Map<string, Set<string>>();

/** Everything one switch needs to write. */
export interface CodexConfigWriteInput {
  readonly provider: CodexProviderEntry;
  /** The model this provider should run — one of `provider.models[].id`. */
  readonly model: string;
  /** Override the catalog filename (tests / future layouts). */
  readonly catalogFile?: string;
}

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
function tomlString(value: string): string {
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

/** The owned lines of one provider table, in the order Codex expects to read them. */
function providerTableLines(provider: CodexProviderEntry): string[] {
  return [
    `[model_providers.${provider.id}]`,
    `name = ${tomlString(provider.label)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    `wire_api = ${tomlString(provider.protocol)}`,
    // cc-switch's shape for a keyed provider; the value itself lives in auth.json.
    provider.auth.kind === "apiKey"
      ? "requires_openai_auth = true"
      : `env_key = ${tomlString(provider.auth.name)}`,
  ];
}

/**
 * Rewrite ONLY the four regions this adapter owns and return the new file text.
 *
 * Owned: the top-level keys `model_provider` / `model` / `model_catalog_json`,
 * and the whole `[model_providers.<id>]` table for the incoming provider. An
 * existing occurrence is replaced in place (so the diff is minimal and the file
 * does not churn); a missing one is inserted before the first table header,
 * because TOML requires top-level keys to precede every `[table]`.
 *
 * Everything else — comments, blank lines, other providers, `[projects.*]`,
 * nested `model = …` keys inside a provider table — is copied verbatim.
 *
 * @param text - the current config file (empty string for a fresh home).
 * @param input - the provider to activate and the model to pin.
 * @returns the complete new file text.
 */
export function applyProviderToConfigToml(text: string, input: CodexConfigWriteInput): string {
  const catalogFile = input.catalogFile ?? SUPERD_CATALOG_FILE;
  const wanted = new Map<string, string>([
    ["model_provider", tomlString(input.provider.id)],
    ["model", tomlString(input.model)],
    ["model_catalog_json", tomlString(catalogFile)],
  ]);
  const providerTable = `model_providers.${input.provider.id}`;
  const replacement = providerTableLines(input.provider);

  const out: string[] = [];
  let providerWritten = false;
  for (const line of classify(text)) {
    // The incoming provider's whole definition is ours to restate, including
    // any sub-table it may have grown.
    if (line.table === providerTable || (line.table?.startsWith(`${providerTable}.`) ?? false)) {
      if (!providerWritten) {
        out.push(...replacement);
        providerWritten = true;
      }
      continue;
    }
    if (line.table === null && line.key !== undefined && wanted.has(line.key)) {
      out.push(`${line.key} = ${wanted.get(line.key) as string}`);
      wanted.delete(line.key);
      continue;
    }
    out.push(line.text);
  }

  if (wanted.size > 0) {
    // Insert ahead of the first header. `wanted` keeps OWNED_KEYS order.
    const insertAt = out.findIndex((line) => line.trim().startsWith("["));
    const missing = OWNED_KEYS.filter((key) => wanted.has(key)).map((key) => `${key} = ${wanted.get(key) as string}`);
    if (insertAt === -1) out.push(...missing);
    else out.splice(insertAt, 0, ...missing);
  }

  if (!providerWritten) {
    // A trailing blank separator only when something precedes it.
    if (out.some((line) => line.trim() !== "")) out.push("");
    out.push(...replacement);
  }

  const joined = out.join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/**
 * Set the provider's key in `auth.json`, keeping every other member — notably
 * the ChatGPT OAuth `tokens` — intact.
 *
 * @throws {TypeError} when the file exists but is not a JSON object: refusing is
 * the only safe answer, because the alternative is destroying credentials we
 * could not read.
 */
export function mergeAuthJson(text: string | undefined, apiKey: string): string {
  if (text === undefined || text.trim() === "") {
    return `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`codexProviders: ${AUTH_FILE} is not valid JSON; refusing to overwrite it`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`codexProviders: ${AUTH_FILE} is not a JSON object; refusing to overwrite it`);
  }
  return `${JSON.stringify({ ...(parsed as Record<string, unknown>), OPENAI_API_KEY: apiKey }, null, 2)}\n`;
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
 * — with only the identity fields overridden. The other ~35 keys are Codex's
 * and are copied through untouched; see the plan's D5 for why we do not try to
 * synthesize them.
 */
export function mergeModelCatalog(
  existing: string | undefined,
  absorbed: string | undefined,
  models: readonly CodexProviderModel[],
  template?: Record<string, unknown>,
): string {
  const current = catalogEntries(existing);
  const foreign = catalogEntries(absorbed);

  const bySlug = new Map<string, Record<string, unknown>>();
  for (const entry of [...current, ...foreign]) {
    const slug = slugOf(entry);
    if (slug !== undefined && !bySlug.has(slug)) bySlug.set(slug, entry);
  }

  const fallback = template ?? current[0] ?? foreign[0];
  for (const model of models) {
    const base = bySlug.get(model.id) ?? fallback ?? {};
    const entry: Record<string, unknown> = {
      ...base,
      slug: model.id,
      display_name: model.displayName ?? model.id,
    };
    if (model.contextWindow !== undefined) {
      // Codex reads context_window and caps against max_context_window; a stale
      // template value must not silently cap a larger real window.
      entry["context_window"] = model.contextWindow;
      entry["max_context_window"] = model.contextWindow;
    }
    bySlug.set(model.id, entry);
  }

  return `${JSON.stringify({ models: [...bySlug.values()] }, null, 2)}\n`;
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

/** Snapshot one target once per stamp, before the first write that could lose it. */
function backupOnce(path: string, stamp: string): void {
  let considered = CONSIDERED.get(stamp);
  if (considered === undefined) {
    considered = new Set<string>();
    CONSIDERED.set(stamp, considered);
  }
  if (considered.has(path)) return;
  considered.add(path);
  if (!existsSync(path)) return;
  try {
    copyFileSync(path, `${path}.superd-bak-${stamp}`);
  } catch {
    // A failed snapshot must not block the switch; the write itself still backs
    // nothing up beyond this best effort.
  }
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
 * Materialize a selection into the runtime's real home: rewrite `config.toml`,
 * merge `auth.json` for a keyed provider, and write our model catalog.
 *
 * Ordering and scope are the contract: the native config lands first (it is
 * what actually switches Codex), `auth.json` is only touched by an `apiKey`
 * provider, and every target is snapshotted once per process before the first
 * write.
 *
 * @param codexHome - the NATIVE codex home (`~/.codex`); never redirected.
 * @param input - provider + model to put in force.
 * @param options.stamp - backup discriminator; tests pin it, production uses the process stamp.
 * @returns the absolute paths written, in write order.
 */
export function writeNativeSelection(
  codexHome: string,
  input: CodexConfigWriteInput,
  options?: { readonly stamp?: string | number },
): { readonly written: readonly string[] } {
  const stamp = String(options?.stamp ?? PROCESS_STAMP);
  const configPath = join(codexHome, CONFIG_FILE);
  const authPath = join(codexHome, AUTH_FILE);
  const catalogPath = join(codexHome, input.catalogFile ?? SUPERD_CATALOG_FILE);

  mkdirSync(codexHome, { recursive: true });

  const configText = readIfExists(configPath);
  const authText = readIfExists(authPath);
  const catalogText = readIfExists(catalogPath);

  const absorbedPath = currentCatalogPath(configText, codexHome);
  const absorbed = absorbedPath !== undefined && absorbedPath !== catalogPath ? readIfExists(absorbedPath) : undefined;

  for (const path of [configPath, authPath, catalogPath]) backupOnce(path, stamp);

  // Parse before any write: a refusal must not leave a half-applied switch.
  // An apiKey provider with an EMPTY stored value means "the key is already in
  // auth.json and Super D does not hold it" — the seeded shape. Writing then
  // would be a no-op at best and a wipe at worst, so auth.json is left alone and
  // the config still names `requires_openai_auth = true`.
  const key = input.provider.auth.kind === "apiKey" ? input.provider.auth.value : undefined;
  const nextAuth = key !== undefined && key !== "" ? mergeAuthJson(authText, key) : undefined;
  const nextConfig = applyProviderToConfigToml(configText ?? "", input);
  const nextCatalog = mergeModelCatalog(catalogText, absorbed, input.provider.models);

  const written: string[] = [];
  writeFileSync(configPath, nextConfig, { encoding: "utf8", mode: 0o600 });
  written.push(configPath);
  if (nextAuth !== undefined) {
    writeFileSync(authPath, nextAuth, { encoding: "utf8", mode: 0o600 });
    written.push(authPath);
  }
  writeFileSync(catalogPath, nextCatalog, { encoding: "utf8", mode: 0o644 });
  written.push(catalogPath);

  return { written };
}
