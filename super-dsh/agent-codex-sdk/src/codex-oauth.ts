/** Native OAuth discovery. Tokens stay in Codex's own home; no network/spawn. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readNativeSelection } from './codex-native-config.js';
import { readProviderStore, type CodexProviderEntry, type CodexProviderModel, type CodexProviderStore } from './codex-providers.js';
export const OPENAI_OAUTH_ID = 'openai-oauth';
export function hasOpenAiOAuth(codexHome: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'));
    const tokens = value?.tokens;
    return value?.auth_mode === 'chatgpt' && tokens !== null && typeof tokens === 'object'
      && [tokens.access_token, tokens.refresh_token].some(token => typeof token === 'string' && token.trim() !== '');
  } catch { return false; }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value);
}
/**
 * The non-defaulted ModelInfo fields consumed by Codex, including its required
 * nested metadata. Keep unknown native fields untouched; never repair or
 * synthesize a catalog. Source: codex-rs/protocol/src/openai_models.rs (0.154 / 0.160).
 */
function usableModel(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !nonEmpty(value['slug']) || typeof value['display_name'] !== 'string') return false;
  const reasoning = value['supported_reasoning_levels'];
  const truncation = value['truncation_policy'];
  const messages = value['model_messages'];
  if (typeof value['base_instructions'] !== 'string' && !(isRecord(messages) && typeof messages['instructions_template'] === 'string')) return false;
  return Array.isArray(reasoning) && reasoning.every(level => isRecord(level) && nonEmpty(level['effort']) && typeof level['description'] === 'string')
    && oneOf(value['shell_type'], ['unified_exec', 'default', 'local', 'shell_command', 'disabled'])
    && oneOf(value['visibility'], ['list', 'hide', 'none'])
    && typeof value['supported_in_api'] === 'boolean'
    && Number.isSafeInteger(value['priority']) && Number(value['priority']) >= -2147483648 && Number(value['priority']) <= 2147483647
    && typeof value['support_verbosity'] === 'boolean'
    && isRecord(truncation) && oneOf(truncation['mode'], ['tokens', 'bytes']) && Number.isSafeInteger(truncation['limit'])
    && Array.isArray(value['experimental_supported_tools']) && value['experimental_supported_tools'].every(tool => typeof tool === 'string');
}
/** One bad entry invalidates the file: Codex deserializes the whole catalog. */
function officialCatalogModels(codexHome: string): readonly Record<string, unknown>[] | undefined {
  try {
    const cache: unknown = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8'));
    if (!isRecord(cache)) return undefined;
    const models = cache['models'];
    if (Array.isArray(models) && models.length > 0 && models.every(usableModel)) return models;
  } catch { /* Missing/stale cache must not become a forced catalog override. */ }
  return undefined;
}
/**
 * Conservatively detect configuration that would leak into an official child
 * without a cache override. Inspect all tables: a profile can supply a catalog
 * even when the root has none. Accept indentation, quoted and dotted keys. We
 * only need to know whether a conflicting override exists, not parse its value.
 */
function nativeAssignments(codexHome: string): readonly {key: string | undefined; value: string}[] {
  let text: string;
  try { text = readFileSync(join(codexHome, 'config.toml'), 'utf8'); } catch { return []; }
  const assignments: {key: string | undefined; value: string}[] = [];
  for (const line of text.split('\n')) {
    const assignment = /^\s*((?:[\w-]+|"[^"\n]+"|'[^'\n]+')(?:\s*\.\s*(?:[\w-]+|"[^"\n]+"|'[^'\n]+'))*)\s*=\s*(.*)$/.exec(line);
    if (assignment === null) continue;
    const key = assignment[1].split(/\s*\.\s*/).at(-1)?.replace(/^["']|["']$/g, '');
    assignments.push({key, value: assignment[2]});
  }
  return assignments;
}
function nativeCatalogConflict(codexHome: string): boolean {
  return nativeAssignments(codexHome).some(({key, value}) => key === 'model_catalog_json' || key === 'profile'
    || (key === 'model_provider' && !/^(?:"openai"|'openai')\s*(?:#.*)?$/.test(value)));
}
/** Official runtime cache only: never consume a third-party custom catalog. */
export function readOpenAiModels(codexHome: string): readonly CodexProviderModel[] {
  const models: CodexProviderModel[] = [];
  for (const raw of officialCatalogModels(codexHome) ?? []) {
    if (raw['visibility'] !== 'list') continue;
    const slug = raw['slug'] as string;
    if (models.some(model => model.id === slug)) continue;
    const displayName = raw['display_name'];
    const contextWindow = raw['context_window'];
    models.push({id: slug,
      ...(nonEmpty(displayName) ? {displayName} : {}),
      ...(Number.isSafeInteger(contextWindow) && Number(contextWindow) > 0 ? {contextWindow: Number(contextWindow)} : {}),
    });
  }
  // A different binary can leave a valid, older catalog in the shared home.
  // Preserve the user's official configured choice as an identity, without
  // inventing metadata or claiming that this cache/binary supports that model.
  if (!nativeCatalogConflict(codexHome)) {
    const native = readNativeSelection(codexHome);
    if ((native.providerId === undefined || native.providerId === 'openai') && nonEmpty(native.model)
      && !models.some(model => model.id === native.model)) models.push({id: native.model});
  }
  return models;
}
/** Internal catalog shape; disk serialization stores just its native identity. */
export function openAiOAuthEntry(codexHome: string): CodexProviderEntry {
  return {id: OPENAI_OAUTH_ID, label: 'OpenAI OAuth', kind: 'openai-oauth', origin: 'native',
    baseUrl: '', protocol: 'responses', auth: {kind: 'apiKey', value: ''}, models: readOpenAiModels(codexHome)};
}
export function readEffectiveProviderStore(worldHome: string, codexHome: string): CodexProviderStore {
  const store = readProviderStore(worldHome);
  const aliasEntries = store.providers.filter(entry => entry.id === OPENAI_OAUTH_ID);
  const ambiguous = aliasEntries.length > 1;
  const blocked = store.blockedNativeIds?.includes(OPENAI_OAUTH_ID) === true;
  return {...store, providers: store.providers.flatMap(entry => entry.id === OPENAI_OAUTH_ID && ambiguous ? [] : entry.kind === 'openai-oauth'
    ? !blocked && hasOpenAiOAuth(codexHome) ? [openAiOAuthEntry(codexHome)] : [] : [entry])};
}

/** A usable runtime-owned catalog path, excluding malformed/empty cache files. */
export function openAiCatalogPath(codexHome: string): string | undefined {
  return officialCatalogModels(codexHome) === undefined ? undefined : join(codexHome, 'models_cache.json');
}
/** Do not let an official child inherit a third-party model_catalog_json. */
export function officialCatalogForLaunch(codexHome: string): string | undefined {
  if (!hasOpenAiOAuth(codexHome)) throw new Error('OpenAI OAuth authentication is unavailable; sign in using Codex');
  if (nativeAssignments(codexHome).some(({key, value}) => key === 'forced_login_method' && !/^(?:"chatgpt"|'chatgpt')\s*(?:#.*)?$/.test(value))) {
    throw new Error('OpenAI OAuth cannot use a conflicting forced_login_method; choose ChatGPT login in your Codex configuration');
  }
  // A forced catalog is static in Codex and disables version/identity/TTL
  // refresh. Let the selected binary own discovery when native config is safe;
  // only override a conflicting native catalog with the validated official one.
  if (!nativeCatalogConflict(codexHome)) return undefined;
  const catalog = openAiCatalogPath(codexHome);
  if (catalog !== undefined) return catalog;
  const native = readNativeSelection(codexHome);
  if (nativeCatalogConflict(codexHome) || (native.providerId !== undefined && native.providerId !== 'openai')) throw new Error('OpenAI OAuth model cache unavailable; open Codex with the official provider to refresh its models');
  return undefined;
}
