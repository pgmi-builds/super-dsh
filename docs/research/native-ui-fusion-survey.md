# Native UI Fusion Survey — In-Page Active-Agent Switch Feasibility

Upstream baseline: `dsh-v0.1.7-rc.1` at `upstream/deepseek-harness/` (read-only survey; all paths below relative to that checkout root unless absolute).

Question under study: can the foreign agent "worlds" (full nested dsh cordis roots serving the stock Web UI under `/<label>/`) be fused into **ctx0's single native UI at `/`** with an in-page active-agent selector, instead of URL-path navigation to per-agent full UIs?

---

## 1. Client boot lifecycle

### Files
- `packages/client/web/src/boot.ts` (114 lines) — `AppWebEntry`
- `packages/client/web/src/boot-client.ts` — `bootClient()` (Loader composition)
- `packages/client/web/src/mount.ts` — `mountClient()` (uiRenderer fiber)
- `packages/client/web/src/seed.ts` / `platform.ts` — frozen static module table
- `packages/client/web/src/apply-injections.ts` — index-injection interpreter
- `apps/web/src/main.ts` — Vite entry; runs one `AppWebEntry` against `#root`

### Boot-once?
- `AppWebEntry.run()` (`boot.ts:57-104`) is a **one-shot kernel per instance**, but the class **does implement teardown**: `dispose()` (`boot.ts:100-104`) awaits `ctx.fiber.dispose()` and disposes the boot page. So teardown/remount *of the cordis tree* is supported at the entry-object level.
- However the **module system is document-singleton and one-shot**:
  - `window.__ModuleLoader__` is injected by an inline queue script produced by `bootInjections()` (`packages/client/modules/src/index.ts:552-596`). Its `create()` throws if `mode !== "queue"` — literally `"client-modules: window.__ModuleLoader__.create called after module-system boot"` (`index.ts:561`).
  - `boot.ts:75-78` hard-fails if `__ModuleLoader__` is missing.
  - The static module table (`seed.ts:24-37`, `platform.ts:9-19`) shares ONE instance each of react/react-dom/cordis/dsh-client-store/ui-slots/ui-primitives/ui-dockkit for the whole document — by design ("values stay shell-static imports so every bundle sees the same instance").
  - ⇒ **A second full client tree in the same document cannot go through the stock boot path.** `AppWebEntry` twice = second `create()` throws.
- `apps/web/src/main.ts` constructs exactly one `AppWebEntry` and only branches on the desktop (`dshDesktopBoot`) carrier, which installs `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }` before resolving `__DSH_BOOT_READY__`.

### What `window.__DSH_BOOT__` (WebBootGraph) contains
Defined at `packages/client/modules/src/client/manifest.ts:86-100`:

```ts
export interface WebBootGraph {
  rev: string            // consistency anchor
  entries: WebBootEntry[]  // id, url (document-relative combo), rev, inject?, immediately?, external?
  batches: WebBootBatch[]  // phase ('bootstrap'|'application'), url, rev, entries[]
}
```
Parsed into `BootManifest { rev, modules: BootModuleRow[], plugins: BootPluginRow[] }` (manifest.ts:104-118). That is **all it is: the client module/plugin graph**. It does NOT carry config, theme, session list, or auth.

### Per-cordis-tree state that differs between ctx0 and a world
| State | Source | Per-tree? |
|---|---|---|
| Client module list / plugin rows | `__DSH_BOOT__.entries` (host: `ClientModuleRegistry.compose()`, `packages/client/modules/src/index.ts:758`) | **Yes** — each world composes its own graph from its own plugin table |
| Config | `configForms` service, fetched over the Connection RPC after boot | Yes (world's own config tree) |
| Theme | `ui-theme` client plugin, over RPC/config | Yes |
| Session list | `ctx.sessions` via gateway Remote event stream | Yes |
| Auth | NOT in boot graph: launch `?token=` → signed cookie per request authority (`packages/client/connection/src/browser-auth.ts:69,106-120`); cookie name is derived from authority | **Per-authority (per world origin/path), document-shared cookie jar** |
| Bundle URLs | `WebBootEntry.url` — "relative to the document, so the browser resolves it under whatever mount served the page" (manifest.ts:37-39) | Yes — document-relative, i.e. mount-path-affine |

Config/theme/sessions/auth all ride the Connection data plane; only the module graph is baked into the document at serve time.

---

## 2. Connection / data plane

### Endpoint derivation
- `packages/client/connection/src/api-path.ts`: `export const API_PATH = '/api'` — the single route prefix constant, "single source for both halves of the web transport".
- Browser RPC caller `packages/client/connection/src/client/rpc.ts:24-68` (`createWebConnectionRpc`): posts to `route = \`${channel}/${endpoint}\`.slice(1)` — i.e. the **document-relative string `"api/<endpoint>"`** — through `doFetch ?? globalThis.fetch`. The comment at rpc.ts:49-51: "The channel key is absolute; a page posts the document-relative form, and a carrier that resolves against the Host root accepts the same form." So same-origin relative `/api` is the default, but the fetch itself is a seam (`RpcFetch` type, rpc.ts:18).

### Single instance or per-scope?
- One `ConnectionHandle` service per client cordis tree, provided by the `client-connection` plugin's `apply()` (`packages/client/connection/src/client/index.ts:246-258`): reads `__DSH_TRANSPORT__` + `__DSH_CONNECTION_RECOVERY__` from the page **once at activation**, then `installConnection(ctx, {...})` (`client/index.ts:231-244`).
- `installConnection` (`client/index.ts:196-244`) is exported and **takes explicit composition inputs** (`transport`, `recovery`, `location`) — the test carrier and worker shells use it. So connection creation is interceptable only by *being the composer*, not from a normal plugin slot: `apply()` reads the page global; a plugin cannot re-provide `connection` (same-scope duplicate service = hard error; only ancestor/isolate shadowing per cordis rules).

### WebSocket mux URL
- `packages/api/gateway/src/client/stream-client.ts:473-479`:
```ts
// The mux route is registered absolute; a page resolves its document-relative
const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
```
`streamBaseUrl` is a documented `ClientTransportHooks` member (`connection/src/client/index.ts:105`): "HTTP origin of a shell-owned Host when its WebSocket uses a different page origin." **But it is read from `__DSH_TRANSPORT__` at connect time of each generation — a carrier that mutates the global between generations can retarget the mux.** Everything else on the page (base URI) makes it mount-path-affine.

### Multiple simultaneous connections?
- The architecture is **one Connection per client tree** (`connection` service; `start()` throws on a second owner — `client/index.ts:163`). No ui-* plugin opens a second connection: `ui-sidebar-browser` is an iframe/webview tab, not a transport; `ui-subagent`/`preview` ride the same gateway.
- However the seam exists compositionally: `ClientTransportHooks` (`client/index.ts:75-107`: `rpc`, `fetch`, `openStream`, `loadBundle`, `ownsHost`, `streamBaseUrl`) is precisely the plug point the desktop worker preview uses to carry the whole data plane over a different transport. A second cordis tree could `installConnection()` with its own hooks — but not via the stock boot (see §1).

---

## 3. Native selector surfaces

### `ui-agent-preset` (`packages/client/ui-agent-preset/src/client/index.ts`)
- **Not a runtime/agent switcher.** It is "three surfaces over one roster": a chip on the new-session hero (`conversation.hero.agentPreset` slot), a read-only label in the session header (`conversation.session.header.actions`, id `agent-preset`), and a settings section (`settings.section`, id `agent-presets`) (index.ts:163-187, 209-216).
- Crucially: "A running session keeps the composition it began with (the host refuses to adopt an existing session under a different preset)" (index.ts:9-11). Preset selection = choosing composition for a **new** session; roster comes from the host `agentPresets` registry service (0.1.7 `dsh-agent-preset-registry`; service key `agentPresets`, index.ts:214).
- Slot-extensible: yes, the whole surface is ordinary `ctx.slots.register` calls — a plugin can add seats/sections alongside. But it selects **presets within one backend tree**, not backends.

### Other global scope/agent/context switchers
- `ui-workspace` (`packages/client/ui-workspace/src/client/index.ts`): workspace picker — browses/creates **workspaces** (directories) within the same host via `@deepseek-ai/dsh-api-workspace-controller` (`ctx.workspaces`), occupying `sidebar.workspaces`. Again one-backend.
- Session switching (sidebar session list), model selection (`ui-model-selection`) — all intra-tree.
- **There is no existing "which backend/host am I talking to" switcher anywhere in the stock UI.**

---

## 4. Slots / composition surface on the client

### Slot system
- `packages/client/ui-slots/src/index.ts` — declaration-merged `SlotMap` registry; kinds `single|list|keyed|chain`, scopes `root|session-maybe|session`. Runtime service `ctx.slots` with `register`/`inject`/`provideRoot`.

### Root-level (frame) slots — `packages/client/ui-layout/src/client/index.ts:46-99`
- `sidebar` (single, OCCUPIED by ui-sidebar's SidebarRoot)
- `main` (keyed; reserved `conversation` key)
- `rightbar` (single, OCCUPIED)
- `shell.overlay` (list — "the additive seat for a frame-wide surface of your own")
- `shell.leading` (single, OCCUPIED, macOS collapse chrome)

### Sidebar inner seats — `packages/client/ui-sidebar/src/client/contract/slots.ts:18-52`
- `sidebar.toggle.badge`, `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.panellist`, **`sidebar.workspaces` (single — the whole browsing region; the natural home for an agent selector)**, `sidebar.settings`, `sidebar.footer.action`
- Plus conversation-level seats from other plugins (`conversation.hero.*`, `conversation.session.header.actions`, `settings.section`, etc. — see `ui-workspace/src/client/contract/slots.ts:99-148`, `ui-settings`, `ui-chat`, `ui-conversation` contract files).

### Can a client plugin replace the boot graph or intercept connection creation?
- **No.** Boot graph injection happens server-side in the served HTML (`bootInjections`, `modules/src/index.ts:552`); client plugins don't exist until after that graph is consumed. Connection creation is the `client-connection` plugin's `apply()` reading page globals — not a slot, not an event, not a service you can decorate (duplicate `connection` provider in the same scope = cordis hard error). The only sanctioned interception point is **being the page owner**: set `__DSH_TRANSPORT__` before boot (desktop worker preview precedent, `apps/web/src/main.ts:33-36`), or compose the tree yourself via `installConnection()` + `AppWebEntry` seams (`BootSeams` = `{ loadBundle }`, boot.ts:19).

---

## 5. Storage / state singletons assuming ONE backend tree per document

- **Page globals**: `__ModuleLoader__` (one-shot create), `__DSH_BOOT__` (one graph), `__DSH_TRANSPORT__` (one carrier), `__DSH_BOOT_READY__` (one gate), `__DSH_CONNECTION_RECOVERY__`. All document-singleton by construction.
- **Cookie jar**: auth cookie named per request authority (`browser-auth.ts:69,106`) — same-origin per-world paths share one jar; worlds under `/<label>/` each get their own cookie (name derives from authority incl. path? — name is per-authority; superd's existing per-world mount auth already handles this).
- **localStorage** keys are flat `dsh.*` with **no backend discriminator**:
  - `dsh.sidebar-right.v1.<sessionId>` (`ui-sidebar-right/src/client/persistence.ts:7`)
  - `dsh.conversation.<sessionId>` (`ui-conversation/src/client/stores.ts:7`)
  - `dsh-client-store` generic persistence (`packages/client/store/src/index.ts:139-165`) — "Whole-value JSON persistence to localStorage, keyed by name"; key uniqueness is the caller's business (`index.ts:190`).
  - SessionIds are host-side UUIDs, so cross-world key collision is unlikely but cross-world **state bleed** (a conversation draft store keyed by an id valid in another tree) is possible in principle.
- **In-memory**: `ctx.sessions`, `ctx.workspaces`, gateway stream tables (`api/gateway/src/client/stream-client.ts`), `ClientModuleRegistry` host-side caches — all per-cordis-tree, i.e. per document in the stock app.

---

## Verdict

### Stable/public vs internal seams
| Seam | Status |
|---|---|
| Slot registry (`ctx.slots.register/inject`, SlotMap declaration merging) | **Public plugin surface** (client half) |
| `sidebar.workspaces`, `shell.overlay`, `sidebar.footer.action` seats | **Public** additive seats; `sidebar`/`main`/`rightbar` root seats are occupiable-but-disruptive (replacing them kills inner seats) |
| `ui-agent-preset` roster/selection | Public surface, but semantically new-session composition only |
| `ClientTransportHooks` (`__DSH_TRANSPORT__`) | **Documented but page-owner-level** — set before boot by the shell, not by a plugin |
| `installConnection(ctx, options)` | Exported composition API — public to a custom shell, not reachable from inside a booted tree |
| `AppWebEntry` + `BootSeams` (`loadBundle`) | Exported, used by test carrier — semi-public shell API |
| `window.__ModuleLoader__` one-shot create, `__DSH_BOOT__` global, static module table | **Internal, hard singletons** |
| RPC route strings (document-relative `api/...`), mux URL from `document.baseURI` | Internal convention; interceptable only by wrapping `window.fetch` / transport hooks |
| localStorage `dsh.*` keys | Internal convention, unnamespaced per backend |

### What an in-page active-agent switch would concretely require
The viable architecture is **one client tree (ctx0's stock UI) whose data plane is retargeted per active agent**, not multiple co-mounted trees:

1. **Transport swap-in at boot**: a client plugin cannot do this; the page must install `__DSH_TRANSPORT__ = { fetch: <rewriting fetch that prefixes /<label> onto `api/...` routes>, streamBaseUrl: <origin>/<label> }` before `entry.run()` (desktop-preview precedent). Minimal viable version: wrap `window.fetch` to rewrite `/api/...` and bundle URLs — a client-side shim the hub page already knows how to write.
2. **Connection generation swap**: expose a tiny control (host service or transport-level) that, on agent switch, does `ctx.connection.reconnect()` after mutating the fetch/base target; the gateway then emits `connection/reset` (`api/gateway/src/client/index.ts:170`), which is the designed "wire-derived caches must repull" signal (`connection/src/client/index.ts:44-50`). Session/config/theme stores are built to re-derive on that event.
3. **Selector widget**: register into `sidebar.workspaces`-adjacent seats — most naturally a `sidebar.brand.*` / `sidebar.footer.action` / `shell.overlay` entry, or replace `sidebar.workspaces` content with an agent+workspace two-level picker (public slot surface; allowed since ui-workspace is a plugin row like any other).
4. **Auth**: each world's cookie is per-authority; a fetch wrapper must also forward/obtain the world token (hub already mints these — reuse).
5. **State hygiene**: clear or namespace per-agent UI state that would otherwise bleed (localStorage keys, selected session, right-sidebar tabs) on switch — client plugins persist per sessionId; a switch should at minimum drop current session selection.

### Showstoppers / hard risks
- **Boot-once module system** (`__ModuleLoader__.create` throws on second call; one `__DSH_BOOT__`; frozen static table): kills any "two full client trees in one document" design. Fusion must be single-tree + transport retarget. (Co-mounting would require forking the boot kernel — internal surface, high churn risk.)
- **Boot graph is per-tree**: if a world's client plugin list differs from ctx0's, the single fused page cannot load the world's extra client plugins without a new module-graph mechanism (HMR `graphListeners` exist host-side but the browser graph is boot-time). Constraint: fusion works cleanly only where all worlds run the **stock client surface** (which is the superd premise — worlds serve "the COMPLETE stock native Web UI").
- **`connection` service is single-owner per tree**; `start()` throws on second loop owner. Switching must go through generation reset, never a parallel second loop.
- **Session-id namespace mixing**: after a switch, `ctx.sessions` will repull the new tree's list, but any UI keyed by raw sessionId (localStorage persistence) can collide across trees; low probability, real.
- **`isLoopback`** is computed once from `transport.ownsHost` / page hostname (`client/index.ts:197`) — unchanged by retargeting; fine for same-origin worlds.
- **Bundle/HMR URLs are document-relative** — the fetch wrapper must also rewrite module-bundle requests, or the fused page must serve bundles from ctx0 only (safe if stock surface identical).

Bottom line: **the seams for a single-tree, transport-retargeted active-agent switch exist and are mostly sanctioned** (transport hooks, connection generation reset, public sidebar slots); the genuinely internal, non-extensible parts are the boot-time module graph and the one-Connection-per-tree rule, both of which the single-tree design sidesteps.
