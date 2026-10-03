# Codex: provider/model in the session log, and switching them across resume (probe, 2026-10-03)

**Question (user).** (1) Does the native Codex session log record the model provider and model ID?
(2) Can a session be resumed with a *different* provider and model — split into (A) hot-swap inside a
live process, and (B) the process died and a new prompt resumes it. And: if the conversation was
recorded under a third-party provider, would switching back to the OpenAI endpoint be refused?

**Method.** Read-only scan of the 68 real rollouts under `~/.codex/sessions/**`; the protocol surface
from `codex app-server generate-ts` (711 files, regenerated 0.154.0); then two live probes against the
real binary in throwaway `CODEX_HOME`s with the user's own two working providers (`deepseek` and
`zhipu-cn`, both `env_key`-shaped). Raw newline-delimited JSON-RPC on stdio, so the probes depend on
codex alone and not on our adapter. Scripts: `.scratch/provider-probe/{probe,probe2,scan_all}.py|mjs`.
**No product code was touched.**

---

## 1. Yes — the log records both, at different granularities

| Where | Field | Granularity |
|---|---|---|
| `session_meta` (line 1) | `model_provider` | **once, at thread creation** |
| `turn_context` | `model` | **every turn** |
| `turn_context` | `effort`, `sandbox_policy`, `approval_policy`, `cwd` | every turn |
| `event_msg` → `thread_settings` | `model`, `model_provider_id` | per settings application |

`session_meta` for the user's current thread: `model_provider = "zhipu-cn"`.
`ThreadSettings` (protocol type) carries both `model: string` and `modelProvider: string`, so the
provider is a *thread setting*, not a constant.

**The model being recorded per turn is the tell**: of the 68 rollouts, one really did change model
mid-session — `rollout-2026-09-18T03-06-34-…`, `session_meta.model_provider = custom`, turn 1
`glm-5.2`, turn 2 `glm-5.3-flash`. And the log's two halves already disagree in the wild:
`rollout-2026-10-03T13-05-36-…` recorded `model_provider = deepseek` while its turn ran `glm-5.2`.
**Codex does not enforce that the recorded provider matches the recorded model.**

## 2. Layer B — process death, resume with a different provider: **works**

```
PHASE 1  thread/start  modelProvider=deepseek  model=deepseek-flash   → TURN1-DEEPSEEK
         >>> SIGKILL the process group
PHASE 2  NEW app-server; config.toml STILL says provider=deepseek
         thread/resume {threadId, modelProvider:"zhipu-cn", model:"glm-5.3-flash"}
         → accepted: provider=zhipu-cn model=glm-5.3-flash              → TURN2-ZHIPU
         failures: []
```

Rollout written by that probe:

```
session_meta : model_provider=deepseek          <- NOT rewritten
turn_context : model=deepseek-flash
turn_context : model=glm-5.3-flash              <- the second provider's model, same thread
```

So the log is a **history, not a lock**: `session_meta` keeps how the thread was born, each
`turn_context` records what actually ran. Nothing refused the cross-provider resume, and the config on
disk said the *opposite* provider the whole time — the override is what counted.

**Why it works:** `ThreadResumeParams` and `ThreadStartParams` both carry
`model?: string | null, modelProvider?: string | null` under *"Configuration overrides for the resumed
thread, if any."* Our adapter does not pass them today (it relies on `config.toml`), which is why a
switch in the Hub currently needs the config rewrite — the protocol offers a per-resume override too.

## 3. Layer A — live process: model yes, provider no

| Change | Live process? | Evidence |
|---|---|---|
| **model** | **yes** | `TurnStartParams.model` — *"Override the model for this turn and subsequent turns"*; the real mid-session rollout above; and an in-process probe turn after an explicit override |
| **provider** | **no** | `TurnStartParams` has no provider field. `thread/resume` against a *loaded* thread is accepted but **ignored** — the probe asked for `zhipu-cn` on a live thread and codex answered `provider=deepseek model=deepseek-flash`. Per the type's own doc: *"If thread_id identifies a running thread, app-server **rejoins** that thread."* |

So a provider change requires the child to be gone (or a `thread/start`), which is exactly the shape
the Hub already has: children spawn lazily per session, so a switch lands on the next spawn.

## 4. The OpenAI worry

**No provider-consistency gate exists**, so the recorded third-party provider is not by itself a reason
for OpenAI to refuse (or vice versa). Two real risks remain, and they are not symmetric:

- **`reasoning.encrypted_content` is provider-opaque.** The probe rollout carries `response_item →
  reasoning` items with that field: turn 1 (deepseek) wrote an id-like blob `e21767eb-…-0`, turn 2
  (zhipu) wrote `None`, and the replay across them was accepted. So third-party → third-party is fine,
  and **third-party → OpenAI is the safe direction**: what those backends leave behind is `None` or an
  opaque id, with no OpenAI-specific structure to reject.
- **OpenAI → third party is the direction I could not test.** A genuine OpenAI blob is only decryptable
  by OpenAI; whether every third-party Responses endpoint tolerates it on replay is unverified here.
  Circuit-breaker if it ever bites: the switch is a config rewrite, so it is reversible.
- **Unrelated but already measured, and the likelier blocker for "back to OpenAI":** the account.
  `~/.codex/auth.json` has `auth_mode: "chatgpt"`, codex refreshes that OAuth token first and never
  falls through to `OPENAI_API_KEY` (403 `unsupported_country_region_territory` here). That is an auth
  failure, not a history failure.

## 5. Bonus finding: codex announces the switch itself

When the model changes mid-thread, codex injects a synthetic message into the transcript:

```
<model_switch>
The user was previously using a different model. Please continue the conversation according to
the following instructions:
<the new model's full base instructions>
```

So mid-thread model switching is not merely tolerated, it is a first-class path with a re-orientation
payload for the incoming model. That is a strong signal about how much the harness expects this.

## 6. What this means for the Hub surface

- The Hub's provider switch is honest: it rewrites the config the *next* child reads, and the resume
  path accepts the change. Layer B — the reported scenario — is the supported one.
- A model-only switch does **not** need the config rewrite at all; `turn/start.model` is the native
  mechanism, and it applies to "this turn and subsequent turns".
- For a **provider** switch on an already-live session, the honest options are (a) wait for the child to
  exit, or (b) pass `modelProvider` on the next `thread/resume`. Today the Hub does (a) implicitly.
- No session log needs migrating when a provider changes: `session_meta` is left alone and each
  `turn_context` tells the truth.
