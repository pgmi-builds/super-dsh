# @pgmi-builds/agent-codex

superd 外壳下的 **Codex adapter**（super-dsh 线）：把 Codex CLI 经由 **`codex app-server`**
接进 DSH —— 会话、事件、模型目录、审批、持久化全部按 DSH 语义呈现，WebUI 消费的是 DSH
服务提供的数据面。

> 通用规则（定位 / 两形态 / 测试准则 / 接线域 / per-agent 定制权 / home 与 profile 布局）
> 见上级目录的 `agent-adapter-dev-rules.md` —— 改本包前先读它。
> 迁移计划与实证：`docs/superpowers/plans/2026-10-03-agent-codex-app-server-migration.md`。

## 它是什么

- 一个**普通 dsh plugin bundle**：`package.json` 的 `dsh.bundle.patch` 指向本目录的
  `cordis.patch.yml`（挂 codex provider、关掉它替代的原生行、重写权限三档表、pin 应用内目录选择器）。
- 一个 **AgentFactory**：`src/index.ts` 里的 `CodexProvider` 在 `ctx.agents` 注册工厂，
  **每个会话一个 `codex app-server` 子进程**（`src/app-server-client.ts`）；
  `src/agent.ts` 把 app-server 通知流投影成 DSH 会话事件。
- **不包含** 任何 hub 耦合：世界挂载由 hub 侧驱动。本包自己就足以点亮一个完整的 web app。

## 线别（2026-10-03 迁移）

**app-server 线**是主路线（SDK 依赖已从本包与主 pack 移除）。SDK 另存为默认关闭的 `agent-codex-sdk`，拥有独立的按需 runtime 安装。
SDK 线在 adapter 里登记的一整排降级被 app-server 协议面直接消掉：

| 能力 | SDK 可选线 | app-server 主路线 |
|---|---|---|
| 打断 | 只有 AbortSignal（掐断本轮 stream） | **`turn/interrupt`** |
| steer | 无 → 排队 followUp 近似 | **`turn/steer`**（注入进行中的 turn） |
| 运行时换模型 | 无 → 下一轮 `resumeThread` | **`turn/start.model`**（下一轮起生效，线程不重建） |
| 运行时审批档 | 无 → launch-only 预设 | **`turn/start.approvalPolicy`**（折叠 `approval/policy`，`/permission` 可用） |
| 运行时沙箱档 | 无 → launch-only | **`turn/start.sandboxPolicy`**（折叠 `sandbox/mode`） |
| 审批人机回路 | 无（`sendRaw` 是 no-op） | **`*/requestApproval` → DSH `ctx.approval`**（Web UI ApprovalPanel） |
| 用户消息回显 | 无（SDK item 无 `user_message`） | `item/started userMessage` |
| token usage | 只在本轮 `turn/completed`，滞后 | `thread/tokenUsage/updated`（本轮 `turn_end` 附着） |

**未接（登记 backlog）**：`thread/compact/start`（`/compact` 仍显式拒绝）、
`thread/list` 会话清单（DSH 日志仍是权威）、`skills/list` / `mcpServerStatus/list` 面板、
`thread/fork`、`requestUserInput` / `mcpServer/elicitation`（fail-closed 应答）、
collab/subagent 项。

## 单独跑起来（首选开发/验收形态）

场景级验证唯一入口 = **整包 pack 线**（`super-dsh/test/start-4999.sh`）+ dev3 目标机实装
（2026-09-24「场景退役」裁决）；本包不再有 standalone 启动脚本。

## Home 与 profile 布局（user 裁定）

| 位置 | 内容 |
|---|---|
| `$DSH_HOME`（测试 = `<repo>/.tests`） | 测试 DSH home |
| 原生 `~/.codex`（`CODEX_HOME` 才重定向） | **Codex 原生 app home**：`config.toml` / `auth.json` / 模型 catalog / rollout / state。adapter **绝不重定向**（红线 §5），**从不写入**（单向阀） |
| `$DSH_HOME/agents/codex` | 该 world 的 **DSH home**：DSH 会话日志副本、storages、`dsh-sessions.json` 映射 |
| `$DSH_HOME/profiles/superd-pub` | 整包线的 dsh profile（tarball 物理安装） |

## 关键实现点

- **lazy spawn（硬门）**：`CodexAppServerClient.create()` 零 IO、零子进程；`ensureStarted()`
  在**首个真实 prompt** 才 spawn + `initialize` + `thread/start|resume`。查看/创建/resume
  一个会话不产生任何 native 进程。单测直接钉住这条不变量（transport factory 调用计数 = 0）。
- **进程回收**：子进程 `detached: true`（自有进程组），close 时先 `SIGTERM` 进程组、
  宽限后 `SIGKILL`，再 `child.kill()` 兜底——stdio MCP 后代 `setsid` 逃离时仍能被扫到。
- **session 身份 = 一对一映射**：DSH session id 是权威；Codex thread id 在**线程 attach**
  时经 `onThreadAttached` 写入 `<dshHome>/dsh-sessions.json`（`src/session-map.ts`）。
  resume 只经该映射重挂线程，查不到即 fail-closed。
- **DSH-native 持久化**：工厂按上游 agent-loop 的方式持有写通道（create `persistence.create` /
  resume `persistence.open(id,'write')` → `read` → `interruptedTurnClosers` → `prepare`），
  发布点刷未存后缀，dispose 时 `handle.close()` 排空。
- **每会话路由钉住**：create/resume 时同步钉住本会话路由（追加 `model/selection` +
  `installModelSelection`），**不依赖全局默认模型的落盘时序**。
- **每轮权限折叠**：`agent.ts` 在每次 `turn/start` 前把会话日志的
  `approval/policy` / `sandbox/mode`（无则由 preset 表兜底）折成 codex 覆盖
  （`permission.ts` 的 `turnPolicyFromEvents`）；`CODEX_APPROVAL_MODE` 只覆盖审批半边。
- **审批桥 fail-closed**：`app-server-approvals.ts` 把 server-request 映射到
  `ctx.approval.request()`；无 answerer / 抛错 / 超时（`CODEX_APPROVAL_TIMEOUT_MS`，默认 5 分钟）
  一律 **decline**，绝不让 codex 挂死。
- **事件映射**：`system/message`（rollout HEAD `base_instructions`）、`request/context`、
  `assistant/message`（reasoning 用 `{type:'reasoning',text}`）、
  `tool/call`（原始 JSON 串）/`tool/result`、`step/start|end`、`turn/start|end`、`todo/write`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CODEX_TRACE=1` | provider/agent/app-server 追踪（stderr） |
| `CODEX_BIN` | 显式覆盖 Codex 核心或 JS 入口；默认依序发现 desktop 核心、用户 CLI、包内 exact-pin fallback |
| `CODEX_HOME` | Codex 原生 home 重定向（**测试专用**；生产路径零重定向） |
| `CODEX_APPROVAL_MODE` | 覆盖审批档（`never`/`on-request`/`on-failure`/`untrusted`；非法值忽略） |
| `CODEX_APPROVAL_TIMEOUT_MS` | 审批应答超时；`0` 关闭；默认 300000 |
| `CODEX_IDLE_EXIT_MS` | 会话空闲后拆客户端；`0` 关闭；默认 600000 |

## Binary 与官方 OAuth

核心发现顺序是显式 `CODEX_BIN` → 已安装 desktop 核心 → 用户 CLI → 包内 `@openai/codex@0.160.0`。
发现和启动仅发生在真正 prompt 时。JS 入口经 Node 启动，原生核心直接执行；认证或生成失败不会静默换 provider。
desktop 优先选择核心版本，不代表复制 desktop 宿主：独立 app-server 使用 Super D 自有 clientInfo，
不借用父任务的 desktop 工具 pipe。browser/computer use 仍需要对应宿主服务与工具接线。

本地 `auth.json` 有 ChatGPT OAuth 时，模型选择器增加只读的 **OpenAI OAuth** provider。
adapter 正本仅存其 native 身份，token 留在 Codex home；选择该 route 时通过子进程配置覆盖 builtin `openai`，
不会改写用户的 config/auth。官方模型读取原生 `models_cache.json`，并保留原生配置的官方默认模型；第三方自定义目录不会当作官方目录。
没有原生目录冲突时不强制注入静态 catalog，让实际选中的 binary 按版本、身份与有效期维护 cache；有目录冲突时仅注入可消费的官方 cache，缺失时明确报错。原生默认模型的 ID 不代表当前 binary 的访问权限。OAuth logout 后显式选择必须失败，不能落到本地第三方默认配置。

## Provider 格式与会话兼容性

各 provider 自行定义消息、reasoning 与加密状态的格式。selector 支持选择端点，不保证同一会话的历史能在不同端点间延续、重放或 resume；实测成功只表示当时的 provider/模型/历史恰好兼容。
adapter 透明传递 provider 的错误。切换后若历史格式不兼容，请在目标 provider 新建会话；compact 不作为跨 provider 兼容性的补救建议或待实现机制。

## 测试

```bash
node super-dsh/scripts/pack.mjs                  # 仓根执行，唯一构建打包入口
DSH_HOME=<repo>/.tests \
SUPERD_DSH_ANCHOR=<repo>/upstream/deepseek-harness/apps/cli/package.json \
node --test super-dsh/agent-codex/test/*.test.mjs
```

单测全部是 fake：`test/fixtures/fake-app-server.mjs` 是一个**可编程的 app-server 替身**
（真 JSONL JSON-RPC 分帧、真子进程），wire / client 测试用真管道驱动它；投影器与审批桥是纯函数。
**不 spawn 真 codex、不打模型。**

## 已知边界（app-server 线 v1）

- `thread/compact/start` 未接 → `/compact` 仍以显式错误拒绝；
- 会话清单仍由 DSH 日志提供（不接 `thread/list`，遵守 mapping-only）；
- `requestUserInput` / `mcpServer/elicitation` / `permissions/requestApproval` 一律 fail-closed；
- collab / subagent / `thread/fork` / skills / MCP 面板未接；
- 内存镜像 `getMessages()` 仅供诊断，权威转录是 DSH 会话日志。

## 多 provider 面（Hub + DSH，2026-10-04 重做）

Codex 是**单 provider** harness：它自己的 `config.toml` 只能写一个 `model_provider`。provider 的**清单**
在 Codex 家里无处安放——那正是 cc-switch 存在的理由；而「这个会话现在跑在哪个 provider 上」在 DSH
里已有公认答案（`session/selectModel` + 持久的 `model/selection`）。所以本线**只做清单**，选择交给 DSH：

- adapter 的 store 是**正本**（canonical），原生 `config.toml` 是**来源**（source），单向读入；
- UI 不再有「active provider」概念——界面里切换 provider/model 就是 DSH 自带模型选择器，与本仓其它
  harness 完全一致；
- provider 由**进程参数**注入子进程（`-c model_providers.<id>.*`），**不写任何原生文件**。

### 分账

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/agents/codex/codex-providers.json`（0600） | **正本**：provider 清单 + 被显式删除的 endpoint 墓碑（含 API key） |
| `$DSH_HOME/agents/codex/codex-catalogs/<id>.json` | 本 adapter 自有的 per-provider 模型目录；经 `-c model_catalog_json=<绝对路径>` 注入 |
| `~/.codex/config.toml` | 用户原生：**只读**。启动时 + 每 10 分钟读一次，按 endpoint URL 去重折进正本 |
| `~/.codex/auth.json` | 用户原生：**只读**。`apiKey` 形态的 key 走子进程环境，不走这里 |

### 同步（2026-10-04 user 裁决）

`syncFromNative()`：启动时 + 每 10 分钟（`SYNC_INTERVAL_MS = 600_000`）读 `config.toml` 的**全部**
`[model_providers.<id>]` 表，按 endpoint URL 去重折进正本。新 endpoint 在库里没有名字，**就用 URL 端点
当名字**（`label = baseUrl`）——Codex 的 catalog 是「当前在役 provider」专用的，所以非在役 provider 的
模型清单**确实无从得知**，此时存 `models: []`（面板显示「no models yet」，该 provider 不注册路由），
而不是编一个。同步只**增/刷**、永不删；唯一的例外是用户显式删除留下的**墓碑**（endpoint key），
否则「删除」会在十分钟后自己撤销。

### 选择与切换

- **路由 = DSH 的**：每个有模型的 provider 注册一条 `ctx.llm` 路由，于是 `session/modelCatalog` 天然
  按 provider 分组，`session/selectModel` 天然持久（`model/selection` + `modelSelection` 投影）；
- **turn 边界判定 = DSH 的**：agent 每轮按 `pending ?? request/header ?? agentDefaultModel ?? options`
  解析路由（`codex-route.ts`），并回写 `request/header`——于是投影的 `lastUsed`/`next`、
  `consumeSelection`、以及「会话上次跑在哪个 provider」全部由上游自洽，UI 重放自然准确；
- **中途切换不用打断**：`turn/start` 的 `model` 覆盖「本轮及后续轮」，所以换**模型**是原生的；换
  **provider** 必须换子进程——`turn/start` 没有 provider 字段，而打给**已加载**线程的 `thread/resume`
  是「接受但忽略」（2026-10-03 实测：要 `zhipu-cn` 回 `deepseek`）。故 agent 在**下一轮冷启动**时
  kill 掉旧 child、用新 `-c` 起新 child、`thread/resume` **同一个 thread id**，历史与上下文完整保留。
  turn 中发起的切换落在下一轮（DSH 的 pending 语义），**不打断在跑的 turn**。

### 启动注入（零原生写入）

`codex-launch.ts` 生成 argv/env；三条实测约束写死在注释里：

1. hyphenated id 在 `-c` 点路径里合法（`model_providers.zhipu-cn.…`）⇒ 原生表名可原样作 provider id；
2. `model_catalog_json` 作为 override 时按**进程 cwd** 解析 ⇒ 路径必须绝对（相对路径实测 `ENOENT`）；
3. `env_key` 是唯一不经过 auth manager 的形态 ⇒ 库里的 key 以合成变量名（`SUPERD_CODEX_KEY_<ID>`）
   经**子进程环境**交给 codex，`auth.json` 完全不碰。**这也顺带解决了 ChatGPT 登录遮蔽 keyed provider
   的老问题**（`requires_openai_auth` 才会被 `auth_mode=chatgpt` 遮蔽）；只有「seeded」形态
   （`apiKey` 且 value 为空 = key 在 auth.json 里）才回落到 `requires_openai_auth`，面板仍会告警。

### RPC

`TypertRemoteService`，namespace `codexProviders`（hub 经 `/hub/api?agent=codex` 原样转发）：
`get` / `save` / `remove`。**API key 只写不读**——wire 上只有 `hasKey`，绝不回传值。
没有 `select`：选择是 DSH 的 per-session 状态。

### 模型目录必须克隆模板

codex 0.154 对 catalog 条目要求 `slug`/`display_name`/`supported_reasoning_levels`/`shell_type`/
`visibility`/`supported_in_api`/`priority`/`support_verbosity` 以及**嵌套 struct** `truncation_policy`…
字段链未终止，故只从既有条目克隆并覆盖身份字段。目录是**替换式**：一份目录只写它那个 provider 的模型
（2026-10-03 修正：早期「吸收且永不丢弃」让 Chat 模型清单只增不减）。

记录：`docs/superpowers/plans/2026-10-03-codex-multi-provider-hub.md` +
`docs/test-reports/2026-10-04-codex-multi-provider-onthefly.md`。
