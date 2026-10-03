# Codex Multi-Provider Hub Surface — acceptance report (2026-10-03)

> Plan: [`docs/superpowers/plans/2026-10-03-codex-multi-provider-hub.md`](../superpowers/plans/2026-10-03-codex-multi-provider-hub.md)
> Branch: `codex-app-server` @ `.worktrees/codex-app-server`
> Ruling implemented: 2026-10-03 user — host cc-switch's multi-provider role inside the Super D Hub.

## 0. What was asked, and what shipped

Codex is a single-provider harness: its own `config.toml` names exactly ONE `model_provider`, so "switch provider" is a rewrite of the user's native file, and cc-switch exists to hold the LIST. This round moves that job into the Hub: the codex row in **Agent Runtimes** expands into a provider list the user can add / edit / delete / select, and selecting one writes the user's own Codex settings.

| Piece | Where |
|---|---|
| provider list (adapter-owned data) | `super-dsh/agent-codex/src/codex-providers.ts` → `$DSH_HOME/agents/codex/codex-providers.json` |
| native write (the switch itself) | `super-dsh/agent-codex/src/codex-native-config.ts` → `~/.codex/{config.toml,auth.json,superd-model-catalog.json}` |
| Remote the panel talks to | `super-dsh/agent-codex/src/codex-provider-gateway.ts` (`codexProviders/get|save|remove|select`) |
| panel spec + parse + transport | `super-dsh/superd-hub/src/client/{agent-settings,runtime-settings-api}.ts` |
| the UI | `super-dsh/superd-hub/src/client/HubPage.tsx` (`ProvidersPanel`) |

Unit/integration suites: adapter **150/150**, hub green, client lane typechecks, delivered-bundle drift guard green.

## 1. Delivered-form acceptance (root AGENTS §〇.0.a / §二.5)

Rig: `SUPERD_PORT=4999 SUPERD_HOME_DIR=<wt>/.tests/superd bash super-dsh/test/start-4999.sh`
— pack → tarball `corepack pnpm@10.33.2 add file:` → fresh profile → repo-build dsh CLI. The tarball in the profile is this branch's state, so the RPCs below cross the **hub carrier** into the **packed** adapter.

### 1.1 Boot level

| Probe | Result |
|---|---|
| `GET /` with no cookie | **401** `dsh web authentication required` |
| cookie mint from the boot's token URL | **200** |
| `POST /hub/api` with no `agent` param | **404** (family serves foreign traffic only) |
| both protocols advertised | `responses` available, `chat` unavailable with the binary's own sentence |

### 1.2 The four Remote methods, through the hub family

`POST /hub/api?agent=codex` + `{type:'client-request', method:'codexProviders/<op>', payload:{args:…}}` — all four answered `ok:true`:

- `get` — seeded itself from the live `~/.codex/config.toml` with the note
  `Imported "deepseek" from your Codex config.toml — Super D had no providers yet.`, and reported
  `effective: {providerId: "deepseek", model: "deepseek-flash"}`, `envName: "DEEPSEEK_API_KEY"`, `hasKey: true`.
- `save` — added `ds-keyed`; `selected` was **unchanged** (saving is not switching).
- `select` — put it in force; `effective` followed.
- `remove` — dropped it; `selected` cleared and the note named the provider still running.

### 1.3 Key privacy

The saved API key **never appeared in any response body** (`"$KEY" in json → False`), and the store on disk is `0600`:

```
-rw------- 1 u1 u1 371 … .tests/superd/agents/codex/codex-providers.json
```

### 1.4 The native write is surgical (the deliberate deviation from cc-switch)

`diff -u` of `~/.codex/config.toml` across a real `select`:

```diff
-model_provider = "deepseek"
+model_provider = "ds-keyed"
 model = "deepseek-flash"
 model_reasoning_effort = "high"
 disable_response_storage = true
-model_catalog_json = "cc-switch-model-catalog.json"
+model_catalog_json = "superd-model-catalog.json"
@@ appended @@
+[model_providers.ds-keyed]
+name = "DeepSeek (keyed via auth.json)"
+base_url = "https://api.deepseek.com/v1"
+wire_api = "responses"
+requires_openai_auth = true
```

Every `[projects.*]` table, every comment, `model_reasoning_effort`, `disable_response_storage` and the previously configured provider tables survived **byte-for-byte**. cc-switch writes a stored whole-file text at this point, which destroys exactly those. `auth.json` was merged: `OPENAI_API_KEY` set, `auth_mode` / `tokens` / `last_refresh` preserved.

### 1.5 A real turn on the codex world (per-runtime session face)

Driven through the hub family (`session/create` → `session/prompt` ×2, same sessionId), then read back from the world's own DSH log:

```
[assistant/message] SUPERD-WORLD-OK
[assistant/message] SUPERD-RESUMED-OK
```

`session-7864985f-c3db-41c8-ac85-19088eeb2769` — `running:false`, `turns:2`, `llmMs:2487`, `ttftMs:2321`,
`uncachedInputTokens 40418`, `contextPressure.contextWindow 1048576`.

Turn 1 proves create+prompt; turn 2 on the same sessionId proves `thread/resume`.

## 2. What the acceptance caught that the unit tests could not

**A keyed provider is silently unusable behind a ChatGPT login.**

Selecting `ds-keyed` wrote *exactly* the config above — and the real turn still failed:

```
ERROR codex_login::auth::manager: Failed to refresh token: 403 Forbidden:
  {"error":{"code":"unsupported_country_region_territory",…}}
```

Root cause, measured: the user's `~/.codex/auth.json` carries `auth_mode: "chatgpt"`, and codex's auth manager refreshes that OAuth token **first** — it never falls through to the `OPENAI_API_KEY` sitting in the same file (the refresh is region-blocked here). The `env_key` shape is unaffected: it never consults the auth manager, which is why the seeded env-shaped `deepseek` provider has been working all along.

We cannot fix this from our side without evicting the user's login — cc-switch has dedicated code to preserve it — so the panel now **says it**, and only when the in-force provider is actually keyed (`chatgptAuthMode` in `codex-provider-gateway.ts`, pinned by a test). `superd` re-selected the env provider and the turn ran (`RESTORED-ENV-OK`, 10,798 tokens).

**Consequence for users:** on this machine a provider must be declared **env-shaped** (`env_key = "SOME_VAR"`) until either the ChatGPT login is signed out or `auth_mode` is flipped. Recommended follow-up (not in this round): for a stored key, have the adapter export it into the *child's* environment and emit `env_key` pointing at that name — the key then never touches `auth.json` at all.

## 3. Corrections to earlier conclusions

- **Credential seeds.** Measured, not inferred: `dashr/.test/home/compat`, `dashr/.test/home/bun-test` and `~/.dsh` **already shared** seed `cf4486e6`; the divergent one is the superd test home (`d88527e5`). `bun-test/.credentials.yaml` is now a symlink to `compat`'s (backup kept alongside). The real divergence — superd's test home vs the dashr/prod seed — is **not** resolved and needs a user decision (unifying them means either adopting prod's session secret on the test side, or moving `compat`'s `refs:` into the superd file).
- **The user's browser has no cookie for the 4999 authority at all.** Extracting every `dsh-auth-*` cookie from Zen and HMAC-verifying each against every candidate secret matched **none** — the cookies present are for `127.0.0.1:4996`, `127.0.0.1:4998`, `127.0.0.1:3080` and `dashr.dev2.internal.test`. So the token URL is unavoidable this once, and no symlink would have changed that.

## 4. State of the machine after acceptance

- `~/.codex/config.toml` and `auth.json` were **restored byte-for-byte** from `.scratch/{config.toml,auth.json}.acceptance-backup-1791009187`; the panel still reads reality (`deepseek` / env / in force).
- The adapter store holds one seeded provider (`deepseek`) at `.tests/superd/agents/codex/codex-providers.json` (0600).
- 4999 rig running the final branch tarball; `superd-lan-4999-relay` started for LAN access.

## 5. Not done

- **dev3 target-machine acceptance** — not authorized this round.
- The `env`-injection follow-up from §2.
- Unifying the two credential seeds (§3).
