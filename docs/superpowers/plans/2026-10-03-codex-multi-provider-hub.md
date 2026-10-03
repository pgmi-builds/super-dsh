# Codex Multi-Provider Hub Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host cc-switch's multi-provider role inside the Super D Hub — the codex Agent Runtimes row expands into a provider list the user can add/edit/delete/select, and selecting one writes Codex's own native settings files exactly the way cc-switch does.

**Architecture:** The provider *list* is adapter-owned data in the codex world's DSH home (`$DSH_HOME/agents/codex/`). The *selection* is materialized into the foreign runtime's real home (`~/.codex/config.toml` + `auth.json` + model catalog) — no redirection, no copy-back valve, one write direction only (UI → native file), identical to what cc-switch's own switch does. The UI rides the existing P3 settings-panel mechanism: the hub client posts a `client-request` envelope at `/hub/api?agent=codex`, the carrier forwards `envelope.method` verbatim to the world's `typertGateway`, and a `TypertRemoteService` named `codexProviders` answers (`agyAuth` is the working precedent).

**Tech Stack:** TypeScript (strict, `tsc`), Node 22 `node --test` + `.mjs` tests importing `dist/`, Cordis 4 (`TypertRemoteService` / `@Remote`), React 18 via the hub's client bundle build (`superd-hub/scripts/build-client.mjs`).

**Spec:** This plan is the spec (no prior `docs/specs/` entry). Its upstream authority is the user's 2026-10-03 ruling, transcribed verbatim in §0 below.

---

## 0. The ruling this plan implements (2026-10-03, user)

> Codex 这类闭源 harness 默认只能配置一个 provider；换 provider 要靠 CC Switch，而 CC Switch 底层就是直接写 Codex 的配置文件。现在要把这个能力接进 Super D 的 Hub：用 Agent Runtimes 行的展开区承载 multi-selector，支持用户增删和配置（模型 ID / Base URL / API 协议）。用户配置好的 multi-provider 数据存到 Hub 的数据空间（`$DSH_HOME/agents/<label>/`）。在 UI 上切换 provider 就直接写 Codex 的 settings 文件；用户自己开 CC Switch 去切，改的是同一个文件，两边行为完全对齐。

### Measured facts this plan is built on (all re-verified 2026-10-03, this machine)

| Fact | Evidence |
|---|---|
| cc-switch is installed and is the behaviour reference | `/usr/bin/cc-switch`, `~/.cc-switch/cc-switch.db` |
| A cc-switch codex provider = `{auth:{OPENAI_API_KEY}, config:"<whole config.toml text>", modelCatalog:{models:[…]}}` | `providers` table, `app_type='codex'`, 3 rows dumped |
| cc-switch writes `config.toml` **wholesale** | that row's `config` is a complete file body, `[model_providers]` included |
| codex 0.154 **hard-rejects** `wire_api = "chat"` | binary string: `` `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"` `` |
| the model catalog is a JSON `{models:[…]}` read via the `model_catalog_json` config key, entries keyed `slug`/`display_name`/`context_window` (snake_case, 38 keys) | `~/.codex/cc-switch-model-catalog.json`; `agent-codex/src/models.ts` |
| the hub already has the settings-panel mechanism, one runtime wired | `superd-hub/src/client/agent-settings.ts` (`SETTINGS_PANELS`, `agy`) |
| the world reaches a Remote via `/hub/api?agent=<label>`; adapter registers a `TypertRemoteService` on the world ctx | `agent-agy/src/agy-auth-gateway.ts` + `superd-hub/src/hub-route.ts` |
| `~/.codex/auth.json` may hold a ChatGPT OAuth login that must survive | `~/.codex/auth.json` (3903 B), cc-switch log: 「live 持有官方 ChatGPT 登录凭据…保留登录」 |

---

## 1. Design decisions (recorded; deviations from cc-switch are deliberate and named)

### D1 — Provider list lives in the adapter's DSH home, not in cc-switch's DB
`$DSH_HOME/agents/codex/codex-providers.json`, mode `0600` (it carries API keys, exactly like the sibling `.credentials.yaml`).
This is the path dev-rules §5/§13 already assigns to the adapter ("`<dshHome>/agents/<label>` … 以及 adapter 自有 DSH 态"). We do **not** read or write `~/.cc-switch/cc-switch.db`: a sqlite dependency plus a foreign app's private schema is a coupling we do not want, and the user asked for *our* data space.

### D2 — Selection is written into the native home, surgically (deviation from cc-switch, deliberate)
Three files, one write direction (UI → native):

| File | How | Why not cc-switch's way |
|---|---|---|
| `~/.codex/config.toml` | **surgical**: upsert only `model_provider`, `model`, `model_catalog_json` and the `[model_providers.<id>]` table; every other byte preserved | cc-switch rewrites the whole file from its stored string. That **silently destroys** the user's `[projects."…"] trust_level` entries and all comments. Surgical is strictly safer and still yields the same effective config. |
| `~/.codex/auth.json` | **merge**: set `OPENAI_API_KEY`, leave every other key (notably the ChatGPT OAuth tokens) untouched | cc-switch also preserves the login; wholesale write here would strand the user's own `codex` CLI login. |
| `~/.codex/superd-model-catalog.json` | **ours**; merge in the models of whatever catalog `model_catalog_json` currently names, then upsert the selected provider's models | Pointing at cc-switch's file would let cc-switch's next switch delete our entries; a private file that *absorbs* theirs survives both directions (see D5). |

Every write backs the target up once per run to `<name>.superd-bak-<epoch>` before the first mutation.

### D3 — API keys are write-only over the wire
`codexProviders/get` returns `hasKey: boolean`, never the value. The panel can set a key and can see that one is set; it can never read one back. Keys are stored in `codex-providers.json` (0600) and materialized into `auth.json` on select.

### D4 — Protocol: `responses` is the only usable value; `chat` is rendered disabled with the reason
The user asked for both options in the dropdown (cc-switch shows both). codex 0.154 rejects `chat` with a hard error at config load, so offering it unmarked would let a user brick their own runtime. The view advertises both, `chat` with `available:false` and the binary's own sentence as the hint — the same "rendered but not selectable, and it says why" rule `agent-settings.ts` already uses for the OAuth placeholder.

### D5 — Catalog entries are cloned from a template, then overridden

**MEASURED (Task 2, 2026-10-03) — clone it is; the minimal-entry path is dead.**
A catalog entry has 38 keys (`base_instructions`, `model_messages`, `experimental_supported_tools`, …). cc-switch stores only `{model, displayName, contextWindow}` and merges into a template — and now we know why. Driving the real binary against a hand-built catalog, codex 0.154 demands, in struct order: `slug`, `display_name`, `supported_reasoning_levels` (sequence), `shell_type` (enum `default|local|shell_command|unified_exec|disabled`), `visibility` (enum `list|hide|none`), `supported_in_api` (bool), `priority` (i32), `support_verbosity` (bool), `truncation_policy` (**nested struct** `TruncationPolicyConfig`, which then demands its own `mode`) — and the chain had not terminated when the probe was stopped. A "minimal" entry is not a thing.

The measured-good operation is therefore: take one entry from the catalog currently named by `model_catalog_json`, clone it, and override only the identity fields `slug` / `display_name` / `context_window` / `max_context_window` / `priority`. Verified with a real turn (`.scratch/codex-catalog-probe/clone`, 2026-10-03): cloned entry, mutated `display_name`+`priority`+context window, `codex exec` → `CLONE-OK`, 14,760 tokens, no "Model metadata not found" warning.

Consequence for the writer: `mergeModelCatalog` takes a `template` entry, and the panel's model rows only ever supply id / display name / context window — never the other 35 keys.


### D6 — Switching takes effect where Codex reads config: at child spawn
`codex app-server` reads `config.toml` when it starts. Children are spawned lazily on a session's first prompt (dev-rules §14-i), so a switch applies to every session whose child spawns afterwards; a session with a live child keeps the provider it started with. The panel states this rather than implying a hot swap.

### D7 — Zero-IO stays intact
Reading the native config happens inside `codexProviders/get`, never in the provider constructor. The lazy-spawn invariant (dev-rules §14-i) is untouched: the gateway is a passive service.

---

## 2. File structure

### New — `super-dsh/agent-codex/src/`

| File | Responsibility |
|---|---|
| `codex-providers.ts` | The store. Types + `readProviderStore` / `writeProviderStore` / `upsertProvider` / `removeProvider` / `selectProvider` / `seedFromNativeConfig`. Pure data, fs by explicit path, never throws (fail-soft with a typed reason). |
| `codex-native-config.ts` | The writer. Table-aware TOML scanner; `applyProviderToConfigToml(text, input)` is a **pure string→string** function (the heart of the test surface); plus `writeNativeSelection()` doing the three-file dance and `readNativeSelection()` for the `effective` field. |
| `codex-provider-gateway.ts` | `CodexProvidersGateway extends TypertRemoteService` (`codexProviders`), four `@Remote` methods, the view projection, and the input validators (`normalizeSaveRequest`, `normalizeIdRequest`). |
| `test/codex-providers.test.mjs` | Store round-trips, fail-soft, prod-home guard, seeding. |
| `test/codex-native-config.test.mjs` | The TOML surgery matrix + auth.json merge + catalog merge, all against tmpdirs. |
| `test/codex-provider-gateway.test.mjs` | View projection, key write-only, protocol advertisement, validation errors. |

### Modified

| File | Change |
|---|---|
| `super-dsh/agent-codex/src/index.ts` | Construct `CodexProvidersGateway` on the world ctx (mirror `agent-agy/src/index.ts`), passing the world home + `resolveCodexHome()`. |
| `super-dsh/superd-hub/src/client/agent-settings.ts` | `SettingsPanelSpec` gains `kind: 'auth' \| 'providers'`; add `codex: { namespace: 'codexProviders', kind: 'providers' }`; add `parseProvidersView`. |
| `super-dsh/superd-hub/src/client/runtime-settings-api.ts` | `callRuntimeSettings` already generic; add `fetchProvidersView` / `saveProvider` / `removeProvider` / `selectProvider`. |
| `super-dsh/superd-hub/src/client/HubPage.tsx` | Branch `RuntimeSettingsPanel` on `panel.kind`; new `ProvidersPanel` + `ProviderForm`. |
| `super-dsh/superd-hub/test/client-agent-settings.test.mjs` | Pin the new spec table + `parseProvidersView`. |
| `super-dsh/superd-hub/test/client-runtime-settings.test.mjs` | Pin the four new envelopes. |
| `super-dsh/agent-codex/README.md`, `super-dsh/agent-adapter-dev-rules.md`, `super-dsh/AGENTS.md` | Record the surface + the D1–D7 decisions. |

---

## 3. Tasks

### Task 1 — The provider store

**Files:** create `super-dsh/agent-codex/src/codex-providers.ts`; test `test/codex-providers.test.mjs`

**Interfaces:**
```ts
export type CodexWireProtocol = 'responses' | 'chat'
export type CodexProviderAuth =
  | { readonly kind: 'apiKey'; readonly value: string }
  | { readonly kind: 'env'; readonly name: string }
export interface CodexProviderModel { readonly id: string; readonly displayName?: string; readonly contextWindow?: number }
export interface CodexProviderEntry {
  readonly id: string            // slug-able, matches /^[a-z0-9][a-z0-9-]*$/
  readonly label: string
  readonly baseUrl: string
  readonly protocol: CodexWireProtocol
  readonly auth: CodexProviderAuth
  readonly models: readonly CodexProviderModel[]
}
export interface CodexProviderStore { readonly version: 1; readonly providers: readonly CodexProviderEntry[]; readonly selected?: string }
export function providerStorePath(worldHome: string): string
export function readProviderStore(worldHome: string): CodexProviderStore   // fail-soft → empty
export function writeProviderStore(worldHome: string, store: CodexProviderStore): void  // 0600, tmp+rename
export function upsertProvider(store: CodexProviderStore, entry: CodexProviderEntry): CodexProviderStore
export function removeProvider(store: CodexProviderStore, id: string): CodexProviderStore // clears selected when it was the one removed
export function selectProvider(store: CodexProviderStore, id: string | null): CodexProviderStore // unknown id → throws TypeError
export function isProviderId(value: unknown): value is string
```

- [ ] Write the failing test: round-trip; `0600` mode asserted; unknown id to `selectProvider` throws; `removeProvider` clears a dangling `selected`; corrupt JSON → empty store, no throw; a store with a provider but no `selected` is valid.
- [ ] `npm run build && node --test test/codex-providers.test.mjs` → fails (module missing).
- [ ] Implement.
- [ ] `npm run build && node --test test/*.test.mjs` → 107 + new all green.
- [ ] Commit.

### Task 2 — Measure: does codex accept a minimal catalog entry?

**Files:** scratch only (`.scratch/`), no product code.

- [ ] Write a two-model catalog where one entry is minimal (`{slug, display_name, context_window}`) and one is a full clone, point a throwaway `CODEX_HOME` at it, and run the real binary once (`codex exec --model <minimal-slug> "say OK"`).
- [ ] Record the outcome in the plan's Decision log and in the test report: **accepted** → D5 simplifies to writing minimal entries; **rejected** → D5 keeps template cloning. Either way the writer takes a `template?: CodexCatalogEntry` input so the choice is data, not a branch.
- [ ] Commit the scratch script (gitignored dir) + the recorded finding.

### Task 3 — The native writer

**Files:** create `super-dsh/agent-codex/src/codex-native-config.ts`; test `test/codex-native-config.test.mjs`

**Interfaces:**
```ts
export const SUPERD_CATALOG_FILE = 'superd-model-catalog.json'
export interface CodexConfigWriteInput {
  readonly provider: CodexProviderEntry
  readonly model: string
  readonly catalogFile?: string
}
/** Pure: rewrite ONLY the four touched regions, byte-preserving everything else. */
export function applyProviderToConfigToml(text: string, input: CodexConfigWriteInput): string
export function mergeAuthJson(text: string | undefined, apiKey: string): string
export function mergeModelCatalog(existing: string | undefined, absorbed: string | undefined,
                                  models: readonly CodexProviderModel[], template?: unknown): string
export interface NativeSelection { readonly providerId?: string; readonly model?: string; readonly baseUrl?: string; readonly protocol?: string }
export function readNativeSelection(codexHome: string): NativeSelection
export function writeNativeSelection(codexHome: string, input: CodexConfigWriteInput): { readonly written: readonly string[] }
```

- [ ] Write the failing test — the matrix, each case a separate `it`:
  - empty text → a complete config;
  - preserves unrelated top-level keys, `[projects."…"]` tables, comments and blank lines byte-for-byte;
  - a `model` key **inside** `[model_providers.x]` is not mistaken for the top-level `model`;
  - re-selecting the same provider is idempotent (no duplicate table headers);
  - switching to a second provider leaves the first provider's table intact and flips `model_provider` + `model`;
  - an `env`-auth provider emits `env_key` and no `requires_openai_auth`; an `apiKey` provider emits `requires_openai_auth = true` and no `env_key`;
  - `mergeAuthJson` keeps `tokens` / `last_refresh` and sets `OPENAI_API_KEY`;
  - `mergeModelCatalog` absorbs entries from the current catalog, upserts our model, never drops a foreign entry;
  - `writeNativeSelection` creates one `*.superd-bak-<ts>` backup per file and reports the paths written.
- [ ] `npm run build && node --test test/codex-native-config.test.mjs` → fails.
- [ ] Implement.
- [ ] `npm run build && node --test test/*.test.mjs` → green.
- [ ] Commit.

### Task 4 — The Remote gateway

**Files:** create `super-dsh/agent-codex/src/codex-provider-gateway.ts`; test `test/codex-provider-gateway.test.mjs`

**Interfaces:**
```ts
export interface CodexProviderView { /* id, label, baseUrl, protocol, models, hasKey */ }
export interface CodexProvidersView {
  readonly providers: readonly CodexProviderView[]
  readonly selected: string | null
  readonly effective: { readonly providerId?: string; readonly model?: string } | null
  readonly protocols: readonly { readonly value: CodexWireProtocol; readonly label: string; readonly available: boolean; readonly hint: string }[]
  readonly paths: { readonly store: string; readonly config: string; readonly auth: string; readonly catalog: string }
  readonly note?: string
}
export class CodexProvidersGateway extends TypertRemoteService {
  constructor(ctx: Context, worldHome: string, codexHome: () => string)
  @Remote('get')    async get(): Promise<CodexProvidersView>
  @Remote('save')   async save(request?: { provider?: unknown } | null): Promise<CodexProvidersView>
  @Remote('remove') async remove(request?: { id?: unknown } | null): Promise<CodexProvidersView>
  @Remote('select') async select(request?: { id?: unknown } | null): Promise<CodexProvidersView>
}
export function buildProvidersView(input: {…}): CodexProvidersView   // pure, the test surface
export function normalizeSaveRequest(request: unknown): CodexProviderEntry
```

- [ ] Write the failing test: the view never contains an API key value but reports `hasKey`; both protocols are advertised with `chat` unavailable and the binary's sentence as its hint; `normalizeSaveRequest` rejects a bad id / non-URL baseUrl / `chat` protocol / empty model list with a `TypeError` naming the field; `select(null)` clears back to the native config; an empty store seeds from the native config on first `get` (D6 seeding) and the seed is reported in `note`.
- [ ] `npm run build && node --test test/codex-provider-gateway.test.mjs` → fails.
- [ ] Implement. `select` writes natives **then** the store (native write failure must not record a selection that is not in force).
- [ ] `npm run build && node --test test/*.test.mjs` → green.
- [ ] Commit.

### Task 5 — Mount the gateway in the codex provider

**Files:** modify `super-dsh/agent-codex/src/index.ts`; test `test/codex-provider-gateway.test.mjs` (a construction smoke case)

- [ ] Write the failing test: constructing the provider does **not** touch the codex home (zero-IO gate, dev-rules §14-i) — assert with a `CODEX_HOME` pointing at an empty tmpdir that no file appears until the gateway's `get()` runs.
- [ ] Implement: construct `CodexProvidersGateway` next to where the provider registers its factory, passing `this.home` and `() => codexHome`.
- [ ] `npm run build && node --test test/*.test.mjs` → green.
- [ ] Commit.

### Task 6 — Client spec + API

**Files:** modify `superd-hub/src/client/agent-settings.ts`, `superd-hub/src/client/runtime-settings-api.ts`; tests `test/client-agent-settings.test.mjs`, `test/client-runtime-settings.test.mjs`

- [ ] Write the failing test: `settingsPanelFor('codex')` → `{namespace:'codexProviders', kind:'providers'}`; `agy` gains `kind:'auth'` (existing assertions updated, not deleted); `parseProvidersView` rejects a shapeless answer and defaults missing optionals conservatively (same posture as `parseAuthView`); each of the four new helpers builds the exact `{type:'client-request', method:'codexProviders/<op>', payload:{args:{request:…}}}` envelope at `/hub/api?agent=codex`.
- [ ] Implement.
- [ ] `npm run build && npm run typecheck:client && node --test test/*.test.mjs` → green.
- [ ] Commit.

### Task 7 — The panel UI

**Files:** modify `superd-hub/src/client/HubPage.tsx`

- [ ] Implement `ProvidersPanel` (list → radio select, per-row Edit/Delete, `＋ Add provider`, inline form with label / base URL / protocol select / model-id rows / API key, busy + error states) and `ProviderForm`. Reuse `HoverRow`'s existing styles (`panelHeadStyle`, `optionStyle`, `chip`, `chipSelf`) — no new visual language.
- [ ] Protocol select renders both options; `chat` is `disabled` with the reason as its title/description.
- [ ] Footer shows the four paths written (`paths.config`, `paths.auth`, `paths.catalog`), plus the D6 line ("applies to sessions started after the switch").
- [ ] Rebuild the client bundle: `npm run build-client`.
- [ ] `node --test test/*.test.mjs` → green (incl. `hub-page-row-shape` and `client-bundle-drift`).
- [ ] Commit.

### Task 8 — Documentation

**Files:** `super-dsh/agent-codex/README.md`, `super-dsh/agent-adapter-dev-rules.md` (§4 per-adapter decision table + §12), `super-dsh/AGENTS.md`

- [ ] Record the surface, the D1–D7 decisions with their reasons, and the cc-switch alignment + the two deliberate deviations (surgical TOML, auth.json merge).
- [ ] Commit.

### Task 9 — Delivered-form acceptance (the gate, §0 red line 1a)

**Files:** `docs/test-reports/2026-10-03-codex-multi-provider-hub.md`

- [ ] Build the pack line and boot 4999 (`SUPERD_PORT=4999 SUPERD_HOME_DIR=<wt>/.tests/superd bash super-dsh/test/start-4999.sh`).
- [ ] `curl` the four RPCs through the **hub** route (`/hub/api?agent=codex`, cookie-authed) — not by calling the adapter directly.
- [ ] Add a provider through the RPC, select it, and assert `~/.codex/config.toml` changed in exactly the four regions while `[projects.*]` survived byte-for-byte.
- [ ] Run a **real turn** on the codex world against the newly selected provider and read the answer back (create + prompt + resume) — the §二.5 acceptance rule ("对齐验收含 per-runtime 会话面").
- [ ] Re-select the original provider and confirm the runtime still turns (proves the write is reversible, not one-way damage).
- [ ] Assert the API key never appears in any RPC response body.
- [ ] Hand the token URL to the user and leave the rig running (verification mode, §三).
- [ ] Write the test report and commit.

### Task 10 — Conditional: dev3 target-machine acceptance

Not authorized yet. Only after the user signs off on Task 9 do we tarball → `corepack pnpm@10.33.2 add file:` on dev3 → restart → `journalctl` `world failed` count + mount probes.

---

## 4. Decision log

| # | Decision | Status |
|---|---|---|
| D1 | provider list in `$DSH_HOME/agents/codex/codex-providers.json` (0600) | accepted |
| D2 | surgical `config.toml`; merged `auth.json`; private `superd-model-catalog.json` | accepted |
| D3 | API keys write-only over the wire | accepted |
| D4 | `chat` rendered, disabled, with the binary's reason | accepted |
| D5 | catalog template cloning vs minimal entry | **decided by measurement (Task 2): template cloning** |
| D6 | switch applies at next child spawn; panel says so | accepted |
| D7 | zero-IO preserved (no native read in the constructor) | accepted |
| — | do we import existing cc-switch providers from its sqlite DB? | **no** (D1) — we seed from the live `config.toml` instead |
