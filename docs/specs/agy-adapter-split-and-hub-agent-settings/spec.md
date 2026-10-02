# Anti-Gravity adapter 拆分 + Hub agent 设置面 — 规格

- 日期：2026-10-02
- 状态：设计已获 user 批准（对话裁决），Phase 1 已实施，Phase 2/3 待实施
- 上游基准：`dsh-v0.2.0-rc.2`（prod 3080 实跑 `@deepseek-ai/dsh@0.2.0-rc.2`）
- 相关：`super-dsh/agent-adapter-dev-rules.md` §3.3 / §5 / §12 / §14 / §16 / §16a / §17

---

## 0. 范围

四项工作，分三个阶段实施：

| 阶段 | 内容 | 路径判定 |
|---|---|---|
| P1 | Hermes「create default workspace」toast 修复 | bounded |
| P2a | `agent-agy` 收敛为 **CLI-only** adapter，三形态探测 + fallback，**ADC 必须可用** | architectural |
| P2b | 原地 copy 出 **SDK adapter** 包，composite 新增默认 `disabled` 行 | architectural |
| P3 | Hub UI：Agent Runtimes 行**行内展开**配置；右侧既有 `switch` 锚点挂真 action | architectural |

---

## 1. 实证根因：Hermes「failed to create default workspace」

**结论：与 Hermes adapter、与 spawn cwd 完全无关。是 DSH 上游 0.2.0 的一次 API 漂移被 Super D 的 client 落位代码踩中。**

### 1.1 证据链

1. **toast 文案属上游**：`upstream/deepseek-harness/packages/client/ui-workspace/src/client/locales.ts:128`
   `'defaultWorkspace.failed': 'Unable to create default workspace. Use Choose workspace to select a folder.'`（zh 版 `:9`）；
   触发点 `packages/client/ui-workspace/src/client/navigation.ts:349-353`。
   Super D 自己那句是 `'Super D: unable to create the default workspace.'`（`superd-hub/src/client/switch.ts`），是**另一条**路径。

2. **接口签名漂移**：

   | 版本 | 签名 |
   |---|---|
   | 旧 `0.1.7-rc.1`（`.worktrees/dsh-browser-engine-fix/packages/api/workspace-controller/src/index.ts:97-112`） | `initializeDefault(request: {directoryName, title}, signal)` |
   | 现 `0.2.0-rc.2`（`.../src/index.ts:98-104`） | `initializeDefault(signal?)` —— README 原话 **"carries no names"** |

   新版的首次使用目录与标题**固定且语言中立**：`DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'`，落在 `<Documents>/deepseek-harness/` 下。

3. **失败机制**：Super D 0.1.9 传 `{directoryName, title}` 作第一实参 → Host 侧
   `AbortSignal.any([signal, timeout])`（`workspace-controller/src/index.ts:100-104`）收到普通对象 → 抛 → RPC reject → 浏览器 toast。

4. **为什么只有 Hermes**：该分支仅在 world 的 workspace + session **两个 list 都空**时走
   （`switch-core.ts` 的 `default-workspace` 落位分支）。prod `~/.dsh/agents/*/storages/workspace.json` 实测：

   | world | `defaultWorkspaceId` |
   |---|---|
   | agy / claude / codex / omp / pi | 有（2026-09-25/26 建，0.1.x 时代旧签名正确） |
   | **hermes** | **无**（registry 2026-10-02 17:15 才出现 = 0.2.0-rc.2 升级后第一片空白 world） |

5. **自愈路径吻合**：user 手动 add workspace + 建 session 后两 list 非空 → 落位走 recentWorkspace/pointer 分支 → 不再碰 `initializeDefault`。

### 1.2 回答「为什么 A2A 测试没暴露」

rig/A2A 测试全部经 `session/create` RPC 建会话（`docs/test-reports/2026-09-28-hub-tools-rig-test.md:76` 记录 hermes 的 session 面 ok）——**不经过浏览器落位**，结构上碰不到 `initializeDefault`。
且 adapter 对缺失 cwd **静默自愈**：`agent-hermes/src/index.ts:368` `const spawnCwd = validatedCwd(cwd) ?? process.cwd()`（agy/claude/codex/pi 同款）。所以 spawn 永远成功、永远无 toast。

⚠️ 由此暴露的真问题（**待处理，见 §7**）：prod `dsh.service` 的 `WorkingDirectory=/home/u1/.dsh`，故 `process.cwd()` = prod DSH home，
违反 dev-rules §5「绝不允许把 session cwd 指到任何 home」。

---

## 2. Phase 1：已实施的修复

**user 裁决（2026-10-02）**：peer range 保持不动，不写旧版本兼容代码，「整个 App 会自愈，之后统一再改」。

改动（`super-dsh/superd-hub/`）：

- `src/client/switch.ts`
  - `SwitchWorkspaces.initializeDefault` 收敛为 `initializeDefault(signal?: AbortSignal): Promise<{workspaceId: string} | undefined>`。
  - 新增导出 `openDefaultWorkspaceFor(deps, toast)`（从 `bindSwitchAgent` 里提取，使契约可单测而绕过模块级 single-bind 守卫）；调用时**不传任何 request 对象**。
  - 删除已无用的 `SwitchLocale` 面（0.2.0 起不再需要读 locale 推导标题）。
- `src/client/index.ts`：`ctx.inject` 去掉 `locale`；注释同步。
- `tsconfig.json`：`src/client/switch.ts` 移出 `exclude` → 双发射到 `dist/client/switch.js`（node-safe：无 react / 无 `@deepseek-ai` import / `localStorage` 惰性取用；`Storage` 类型改为结构面以免依赖 DOM lib）。
- `test/client-switch.test.mjs`：新增 3 个回归用例（**首个断言 `initializeDefault` 收 0 个实参**）。
- `super-dsh/client/index.js`：交付态 client bundle 重建（drift guard 要求 byte-fresh）。

**已完成的验证**：`superd-hub` `npm run build` 0 err · `typecheck:client` 0 err · `npm test` **489 pass / 0 fail** · drift guard byte-fresh 绿。
**红队验证**：把旧调用形状塞回 `dist/client/switch.js` 后该用例变红（`not ok 69`），恢复后回绿 —— 用例有牙。

**待做**：4999 整包线运行时验收（见 §6）。

---

## 3. Anti-Gravity 实证（本机，2026-10-02；**关键证据，勿丢**）

### 3.1 拓扑：一个 CLI、一个 IDE app，共享 `~/.gemini`

| 产品 | 路径 | 形态 |
|---|---|---|
| **Antigravity CLI** | `~/.local/bin/agy` | 220MB Go，v1.2.14 |
| **Antigravity IDE app** | `/opt/Antigravity-x64/antigravity` | 206MB Electron |

两者各自注册了一个 `agentapi` 包装器，指向**不同的 language server**：

```
~/.gemini/antigravity-cli/bin/agentapi → agy.<...>.old agentapi                    # CLI 的
~/.gemini/antigravity/bin/agentapi     → /opt/Antigravity-x64/resources/bin/language_server agentapi   # app 的
```

→ 我们**没有发错 binary**：adapter 用 `agyBin ?? "agy"`，命中的是 CLI。
→ 但「两个产品共享一个 `~/.gemini`」是真的，选面时必须显式走 `antigravity-cli` 面。

### 3.2 CLI 的四条 auth 通道（binary 字符串 + changelog + 实测）

| 通道 | 开关 | 端点 |
|---|---|---|
| 默认 = 账号登录 | 不设 `modelProvider` | `cloudcode-pa.googleapis.com`（prod）/ `daily-cloudcode-pa.googleapis.com`（daily）/ `preprod-daily-cloudcode-pa.sandbox.googleapis.com`；受**账号地区资格门** |
| **Gemini API key** | `modelProvider: "gemini"` + `GEMINI_API_KEY`（+ `GOOGLE_GEMINI_BASE_URL`） | AI Studio / 自定 base_url |
| **ADC** | **`AGY_ADC_AUTH=1`** | Vertex / ADC |
| BYO LLM gateway | `AGY_LLM_GATEWAY_URL` / `_API_KEY` / `_HEADERS` / `_CA_CERT` / `_MODELS` / `_PROXY_URLS` | 任意网关 |

binary 自述（关键三条）：

- changelog：*"Added support for `GEMINI_API_KEY`, so the CLI can run against the Gemini API directly without signing in. Set `modelProvider: "gemini"` in `settings.json`, export `GEMINI_API_KEY`, and point `GOOGLE_GEMINI_BASE_URL` at a custom endpoint if you need one."*
- *"To switch back to signing in, remove `modelProvider` from settings.json and restart the CLI."*
- ADC 家族：`adc_auth.go`、`"Already authenticated via Application Default Credentials (ADC)."`、`"You are logged in using Application Default Credentials (ADC)."`、`"To log out, please run \`unset AGY_ADC_AUTH\` in your terminal and restart the CLI."`、`"3. Or unset AGY_ADC_AUTH env var to use other sign in methods."`
- changelog：*"Improved sign-in with Application Default Credentials by resolving the quota project automatically…"*

### 3.3 实测（决定性）

```
$ agy -p "…"
error: Eligibility check failed: Your current account is not eligible for Antigravity …

$ AGY_ADC_AUTH=1 agy -p "…"
  printmode.go:403  Print mode: not authenticated, trying silent auth
  adc_auth.go:73    adcAuth: authenticated successfully with quota project , token is non-empty: true
  auth.go:157       ChainedAuth: authenticated via adc (effective: adc)
error: failed to construct executor: plan model not specified; you must specify a valid model
```

→ **资格门消失，ADC 认证成功**；剩下只差一个 model。
→ **「CLI 不能用 ADC」的旧结论（dev-rules §16a）是错的**：当年只注入通用 Google env（`GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_GENAI_USE_VERTEXAI`），而 CLI 只认它自己的专用开关 `AGY_ADC_AUTH`。

### 3.4 当年误判的三个混淆

同一台机器上有**三个 Google 账号**在打架：

| 来源 | 账号 | authMethod | 端点 | 结果 |
|---|---|---|---|---|
| user TUI（03:57，CLI 1.2.12） | `mespeaking@gmail.com` | **gcp** | `cloudcode-pa…` (prod) | ✅ |
| 无 env 的 headless 探针（19:48，CLI 1.2.14） | `mark1kwok@gmail.com` | consumer | `daily-cloudcode-pa…` (**daily**) | ❌ 资格门 |
| gcloud ADC 当前账号 | `mark2kwok@gmail.com` | authorized_user | 项目 `vertex-ai-489113` | — |

1. **注入方式错**：通用 Google env ≠ `AGY_ADC_AUTH`。
2. **channel 不同**：headless 走 daily/preprod，TUI 走 prod。
3. **账号不同**：`ChainedAuth` 在 TUI 取 `gcp`、在 headless 取 `keyring` → 「TUI 能用 / headless 不能用」很可能只是凭据选取差异。

### 3.5 其他必须处理的既有缺陷

- ✅ **不隔离 HOME（2026-10-02 定案）**：ADC 在 `~/.config/gcloud`、令牌在 keyring、settings 在 `$HOME/.gemini`——**一律用真实 HOME**。旧的 `cliHome` / `AGY_CLI_HOME` 旋钮已删除（它从来不是 CLI 的 env 变量）。
- ✅ **原生 settings 由 adapter 主动维护（基调反转，见 §4.1）**：初稿判定 `ensureCliKeyMode()` 写原生 home 是「违反 dev-rules §5」，user 2026-10-02 裁决**推翻**——本 adapter 故意做用户本地 Antigravity 的配置面。已重写为 `applyAgySettings()`（可 set 可 remove），并在 §12 per-adapter 定制权下取代 §5 默认。
- ⚠️ **auto-update 是复现性地雷**：binary 在 03:57→19:48 之间静默 1.2.12→1.2.14；有 `AGY_CLI_DISABLE_AUTO_UPDATE` 可关。
- ADC 模式下 `--model` **必填**（无账号 model catalog）。custom model 声明格式（binary 自述）：
  `gemini-api://<base_url>/models/<name>` / `blade:<base_url>/models/<name>` / `evergreen:<base_url>/models/<name>` / `beyond-api://<base_url>/<name>`。
- `agent-agy/package.json` 的 description 仍写 *"The agy CLI is never invoked"* —— 早已不成立，拆包后自然消解。
- `agent-agy/.venv`（**189M**）在源码树内，gitignored、不在 `files` → 不进 tarball，靠手工 `scripts/setup-venv.sh`。

---

## 4. 目标设计

### 4.1 P2a — `agent-agy` 收敛为 CLI-only

**三形态探测 + fallback（user 裁决：顺序 = Gemini API key → OAuth → ADC）**

| 层 | 存在性判据 | 生效方式 | 本轮状态 |
|---|---|---|---|
| 1. Gemini API key | `GEMINI_API_KEY`（env 或 adapter 存储）非空 | **写**原生 settings `modelProvider:"gemini"` + 子进程 env 带 key | 实施 |
| 2. OAuth | keyring（freedesktop Secret Service）条目 `service=gemini username=antigravity` | 原生 sign-in；**删除** settings 的 `modelProvider` | **placeholder**（UI 有形、探测层暂缓） |
| 3. ADC | `~/.config/gcloud/application_default_credentials.json` 存在 / `GOOGLE_APPLICATION_CREDENTIALS` / metadata server | **`AGY_ADC_AUTH=1`** + **删除** settings 的 `modelProvider` | **必须可用** |

**⚠️ 基调裁决（2026-10-02，推翻本规格初稿的 §5 取向）：「拥抱用户自己的使用环境」。**

adapter 不再隔离 HOME、不再用 adapter 自有 settings，而是**直接读写用户真实的 `~/.gemini/antigravity-cli/settings.json`（硬编码、user-relative）**——它就是**用户本地 Antigravity 的配置面**。

| UI 选择 | 原生 settings.json | spawn env |
|---|---|---|
| Gemini API key | **写入** `modelProvider: "gemini"` | `GEMINI_API_KEY` |
| ADC | **删除** `modelProvider` | `AGY_ADC_AUTH=1` |
| OAuth | **删除** `modelProvider` | —（keyring 自行生效） |

删除而非"不设置"是关键：否则上一次 key 模式的 pin 会残留，用户回 TUI 会卡在 "Gemini API key" 却没有 `GEMINI_API_KEY`。

- **探测（detected）与选择（selected）分离**：探测驱动 UI 标注；选择由 user 显式指定并持久化（`agy-adapter.json` 的 `authMode`）；未选 = 按上述顺序自动回落。
- 子进程 env 恒带 `AGY_CLI_DISABLE_AUTO_UPDATE=1`。
- **HOME 一律不覆盖**：settings 在 `$HOME/.gemini`、ADC 在 `$HOME/.config/gcloud`、令牌在 keyring——隔离 HOME 三者全丢，正是 2026-10-02 误判「CLI 不能用 ADC」的机制。
- `AGY_CLI_HOME` / `cliHome` 旋钮**已删除**（它从来不是 CLI 的 env 变量，是 adapter 自造的隔离手段）。
- 新增纯逻辑模块（node 可测）：探测、回落、settings 变更、per-mode env 构造。

### 4.2 P2b — SDK adapter（原地 copy）

- 新包 `@pgmi-builds/agent-agy-sdk`：**原地 copy 现 `agent-agy` 的 SDK 半边**（`agy-client.ts` + `bridge/agy_bridge.py` + venv 脚本），之后再改。
- `agent-agy` 保留为 CLI-only，**不重命名**（roster key `agy`、world 目录 `agents/agy` 不动）。
- 交付：随 `super-dsh` pack 一起 deliver，composite patch 新增一行 `agent-agy-sdk`，**`disabled: true`** —— user 在 DSH plugin 页自己开（「行组合即开关」，`plugin-presence IS the roster`）。
- **不 declare 任何 SDK 依赖、无 postinstall**；首次使用（且该行 enabled）时自己 fetch 到 world home 下的 durable 位置，幂等 + 失败留痕。
- 源码树内 189M `.venv` 移除。

**已实施（2026-10-02）**：

- **包边界按「半边」真剪，不是留双份**：`agent-agy` 删 `src/agy-client.ts` + `bridge/`（含 `gemini_openai_server.mjs` BYO spike）+ `scripts/*`（venv 与 SDK 探针）+ `test/agy-client.test.mjs` + `fixtures/mock_bridge.mjs` + `.venv`；`agent-agy-sdk` 删 `src/agy-cli-client.ts` + `src/agy-auth.ts` + CLI 专属选项（`cliHome`/`skipPermissions`/`agyBin`/`proxy`）+ `agy-auth`/`agy-cli-client` 测试。两边各自 `LiveAgyClient` 收窄到自己的传输类型——**没有任何一边还能驱动另一种传输**。
- **roster key = `agy-sdk`**（user 裁决）：label `Antigravity (SDK)`、world home `agents/agy-sdk`。**必须独立 key**——hub 的 `registerAgent` 对重复 key 是 hard throw，两条行同处一个 composite，共用 `agy` 会让「用户把 SDK 行打开」直接炸 host boot。世界目录名由 key 派生（`world-provision.ts:143` 的 `agent-${key}`），故 key/dir/包名三者一致：`agy-sdk` / `agent-agy-sdk` / `@pgmi-builds/agent-agy-sdk`。
- **懒 fetch 落在 world home**（`src/sdk-venv.ts`，新模块）：`<worldHome>/sdk-venv/`；两步各自幂等（缺 interpreter → `python3 -m venv`；缺 marker → `pip install google-antigravity`），半步工程就地修复而非重下；`mkdir` 互斥锁 + 陈旧锁回收 + 「同伴已完成后等待者直接复用、且不释放不属于自己的锁」；失败写 `<worldHome>/sdk-venv.error.log` 并抛单条可行动错误。首次真实使用才触发（`ping`/`turn` 路径），create/resume 仍零 spawn（§14-i 不破）。`pythonBin` / `AGY_PYTHON` 优先级在 fetch 之前（测试与运维逃生口）。
- 交付接线：`pack.mjs` AGENTS += `agent-agy-sdk`；`super-dsh` exports `./agents/agy-sdk` + `files` 收录 dist/bridge/package.json/cordis.patch.yml（`agent-agy/bridge` 同时摘除）；composite 新增 `agent-agy-sdk` 行 `disabled: true`（insert 内 `disabled` 是上游正当方言，先例 `packages/bundle/web-app/presets/ptc.patch.yml:105`）。
- **测试**：`agent-agy` 47/47（SDK 用例随文件迁走）；`agent-agy-sdk` 40/40（含新 `test/sdk-venv.test.mjs` 8 例：新建顺序、幂等短路、半步修复、失败留痕且不写 marker、失败后重试清痕、陈旧锁回收、活锁等待后复用、活锁超时——并把「等待者不得释放同伴的锁」钉成断言，注入旧 bug 实测 `not ok 7`）；`superd-hub` 489/489；其余 5 adapter 未受影响。**合计 1022 pass / 0 fail（8 包）**。pack 产物 253 文件 / 611.2 kB，tarball 内 `agent-agy` 无 `bridge`、`agent-agy-sdk` 有 bridge+`sdk-venv`。
### 4.3 P3 — Hub UI

**交互改动（user 裁决）**：

- **行体点击 = 行内展开该 runtime 自己的设置**（手风琴，一次一行）。
- **右侧既有的 `switch` 字眼 = 挂上真正的切换 action**（现有 `HubPage.tsx` 每行右侧已有该锚点，只是没有锚定 action）。展开面板**不再**另设 switch。

**Anti-Gravity 展开面板内容**：三种登录方式 single-select，标注探测到的可用性与当前生效项；OAuth 项先做 placeholder（UI 形态先立起来）。

**数据面**：

- 配置归属 adapter（dev-rules §12）。adapter 注册自有 RPC（如 `agyAuth/get` / `agyAuth/set`），UI 经**既有** `/hub/api?agent=agy` 信封调用。
  *已 de-risk*：`superd-hub/src/carrier.ts:238` 把 `envelope.method` 原样转发给 world 的 `typertGateway`，故自有命名空间可达。
- 持久化落 world home，**绝不写原生 home**。
  *2026-10-02 基调裁决后的准确表述*：**选择**（`authMode`）落 world home 的 `agy-adapter.json`；**原生 settings.json 的 pin/去 pin** 是裁决明令的副作用（§3.5/§4.1），必须写——两件事都做，互不替代。
- ⚠️ 若新增 `/api/...` 路由，须加入 `superd-hub/src/fusion-transport.ts:104` 的 `CONTROL` 免改写名单，否则会被重写到当前 world 挂载点。
- client 半边沿用 lane 门：纯逻辑放可 node 单测的纯函数，UI 注入层只寻址官方表面。

**已实施（2026-10-02）**：

- **交互**：行体点击 = 展开/收起该 runtime 的 settings（手风琴，`toggleExpanded` 一次只开一行，开着的行点击即收起、点别行一键搬家）；右侧 `switch` 由 `<a>` 改为真 `<button>`（`type="button"`、`disabled` 当已在此 runtime、`aria-label`），仍跑**同一张** `seatClickDecision` 表并 `stopPropagation`，所以行体展开与切换互不串扰——**一行一个 switch，面板内不再有第二个**。展开的行保持高亮（`HoverRow` 的 `expanded`），左侧加 ▶ 指示器。
- **面板**：`RuntimeSettingsPanel` 在展开时挂载（收起即卸载 ⇒ 每次展开都重新读机器，不replay陈旧首读）。有 settings 的 runtime 列三种登录方式为 single-select（●/○ + `in force`/`not detected`/`placeholder` 三个 chip + 每项一句 hint），并明示它**会写哪个文件**；无 settings 的 runtime（omp/codex/claude/pi/hermes/agy-sdk/native）走统一交互但显示明确的空状态，不是死控件。
- **数据面（adapter-owned Remote，已落地）**：`agent-agy/src/agy-auth-gateway.ts` = `TypertRemoteService` + `@Remote('get')`/`@Remote('set')`，命名空间 `agyAuth`。**关键 de-risk 结论**：`@Remote` 是**标准（TC39）方法装饰器**，标记只落在类原型上（`remoteMethods()` 运行时读回），**无需 codegen、无需 `experimentalDecorators`、无需 tsdown typert 插件**——所以纯 `tsc` 构建的 adapter 可以自带 Remote（实测 `agent-agy` 的 tsconfig 一路编译通过；反向红测：把 emit 里的 `[Remote("get")]` 抽掉 → `not ok 1`）。`agent-agy` 因此新增 peer `@deepseek-ai/dsh-typert-protocol`（`optional: true`，与 omp/codex/hermes/pi 同形）。
- **wire 契约**（两半都有测试钉死）：请求 `POST /hub/api?agent=agy`，body `{type:'client-request', rpcId, method:'agyAuth/get'|'agyAuth/set', payload:{args:{}}}`（set 为 `{args:{request:{mode}}}`；gateway 要求 `method` 恰好两段、payload 恰好一个 `args` 字段——本例在 SRC 模式下的 wire 字段名 = TS 参数名）。响应 `{type:'server-response', rpcId, result:{ok:true,value}}` / `{ok:false,error:{code,message}}`。
- **`CONTROL` 免改写名单：无需改动**——`fusion-transport` 的 retarget 只作用于同源 `/api...` 路径，`/hub/...` 本就不匹配（`isApiPath('/hub/api/...') === false` ⇒ 原样放行）。那条 ⚠️ 只对「在原生 `/api/<ns>/<method>` 暴露」的形态成立。
- **副作用语义**（`set`）：选择持久化进 world home 后，**立即**按**生效形态**（ladder 结果，非请求值）改写用户真实 `settings.json`——选 key 写 `modelProvider:"gemini"`，选 adc/oauth **删除**该键；「点了这台机器没有的形态」会照实记录选择、但 native 侧按 ladder 走，绝不把失效的 key pin 重新贴上。
- **测试**：`agent-agy` 60/60（+13 `agy-auth-gateway.test.mjs`：Remote 标记注册、wire 参数面、ladder/标注、真 fs 上 set/get 的 pin 与去 pin、未知 mode 拒绝且不落盘）；`superd-hub` 502/502（+7 `client-agent-settings`、+6 `client-runtime-settings`：信封逐字段、`args` 嵌套、业务错误透传 adapter 文案、传输/框架/空选项四类失败可区分）。client 纯逻辑全走 `dist/client` 双发射 lane。**全仓 1048 pass / 0 fail（8 包）**；client 漂移门在改完 client 源后先红（预期）→ pack 重建 → 绿。
---

## 5. 非目标 / 开放项

- **不做** TUI pty 解析方案：`--input-format stream-json` 已是结构化 headless 协议；真正的阻塞是没人设 `AGY_ADC_AUTH`。
- OAuth 层的原生字段与取值（存哪个文件、什么 key/value）——**待有合格账号后再补**。
- `AGY_LLM_GATEWAY_*`（BYO 网关）——登记为 per-adapter 开放项。
- 各 CLI adapter 的 `process.cwd()` 兜底落到 DSH home 的问题（§1.2）——独立议题，本轮不处理。
- peer range 统一调整——user 裁决后续整个 App 一起改，不在本轮。

---

## 6. 验收

**P1**：4999 整包线 + 浏览器，切到一个空 world（0 workspace / 0 session）→ `~/Documents/deepseek-harness/default-workspace` 被复用、**无 toast**、随后可直接建 session。

**P2a**：4999 线上把 auth 置为 ADC → 打真 turn 成功；并出一张**端点实证表**（`aiplatform` vs `generativelanguage` vs `cloudcode-pa`）。
取证手段：只记 `CONNECT host:port` 的转发代理即可区分（**无需 MITM / 装 CA**——SNI 主机名足够）；CLI 认 `HTTPS_PROXY`，Python SDK 的 httpx/requests 同样认。

**P2b**：全新 home + 默认 composition → roster **不含** SDK 行；plugin 页开启 → 首次使用触发 fetch → 第二次复用（幂等）。

**P3**：行体点击展开／再点收起；右侧 `switch` 完成切换；agy 面板三选项的探测标注与切换持久化在刷新后保持。

统一纪律：整包 pack 线（`super-dsh/test/start-4999.sh`）+ 目标机实装；报告落 `docs/test-reports/`。
