# Agent Adapter 开发规则（superd / agent-worlds 线）

> 状态：2026-09-15 user 裁定成文（对话记录于 `.scratch/aw-codex` AW-E 轮次）。
> 适用范围：所有 `@pgmi-builds/agent-adapter-*` 包（本线现役 `agent-codex`、`agent-omp`；曾用形态 `multi-agent-registry`（搁置）、`multi-agent-ctx`（冻结））。
> 用语：**adapter** = per-agent 适配包；**foreign runtime** = 上游原生 agent 运行时（codex / omp / …）；**DSH** = 上游 DeepSeek Harness；**superd** = dsh 之上的自研壳。

---

## 0. 定位（Position）

- 一个 **agent adapter 是 superd 壳下的一个自有包**，其**本身就是一个 dsh plugin**（带 `dsh.bundle.patch` 的 bundle patch 层 + 可选 `dsh.client` 呈现面）。
- superd 侧的路线史：`multi-agent-registry`（2026-09-10 搁置）→ `multi-agent-ctx`（冻结保留）→ **`agent-worlds`（现役）**。三条路线的**同一目标**：把 foreign agent runtime 引进 DSH native 面（会话/事件/模型/工作区都按 DSH 语义呈现）。
- **adapter 的核心职责**：把上游 foreign runtime **接线成一个完整、自洽的 dsh ctx**。接线完成度判据：**`dsh + 该 adapter` 自身就是一个 omp-web 式的可用 web app**（standalone 形态，见 §1-A）。
- agent-worlds 专属注入（`world-plugin` / `spawnWorld` / roster / hub 桥）只是**与 agent-worlds hub 对话的桥**，不是 adapter 的必要条件：adapter 不得把 hub、selector、spawn 机制当作自身存在前提。

## 1. 两种形态（两种都必须能跑）

| 形态 | 组成 | 用途 |
|---|---|---|
| **A. standalone app**（首选开发/测试形态） | `dsh(完整 composition: base + web-app + adapter bundle patch)`，单进程、自有 home、真实监听端口 | 开发、验收、单包测试；`dsh + adapter` ≈ omp-web |
| **B. world ctx**（agent-worlds 桥） | hub `spawnWorld()` 在 CTX0 进程内 `boot()` 出的 ctxN，adapter 挂在其中；roster/selector/委托由 hub 提供 | 多 runtime 并存、UI 内切换 |

- 差异**只允许**来自 patch 层注入（端口、home、注入行），**不允许**出现两份代码路径。
- 形态 B 的 client surface 也必须能在形态 A 正确交付（见 §4 客户端面交付层）。

## 2. 测试准则（Testing）

1. **每个 adapter 先按 standalone dsh web app 测**（真实例 + 真 runtime turn + 浏览器/curl 两者），直到该形态不再成立才引入形态 B。形态 B 的验收建立在形态 A 之上，不得反向。
2. 验收证据必须是**运行时行为**：
   - 真 runtime turn（**不得**以注入 fake factory 的 turn 作为验收证据；fake 仅限管道测试）；
   - HTTP wire（`POST /api/<ns>/<method>`，envelope `{type:"client-request",rpcId,method,payload}`）走一遍 create→prompt→readback；
   - 包自身测试套件在**该 app 的 home** 全绿（不是只在共享 home 绿）。
3. **专属 home**：adapter 单测/单跑时用自有 home（如 `AW_APP_HOME`），其 DSH 级状态（workspace 注册表、settings、session 日志）不与别条线共享；共享 home 里的残留（别线的 workspace、陈旧 settings）会污染结论。
4. adapter 自有 app 数据与 DSH 数据分账：见 §5。

## 3. 接线域（Wiring domains）—— 逐项，缺项必须显式记录为“未接/降级”

### 3.1 per-session
- **spawn / resume**（含 resume 的失败面：thread 不存在、rollout 损坏）
- **events**：foreign runtime 事件 → dsh 事件映射；至少覆盖
  - 系统提示、用户消息、助手消息（含 thinking/reasoning）、
  - 工具调用与结果（command/file change/mcp/web search…）、
  - **compaction**、**job list**、**subagent**、todo/plan 等结构化产物、
  - turn 生命周期（start/end、错误）
- **model list 与切换**（列目录来源必须真实；切换语义 = 立即 or 下一轮，需记录）
- **cwd / workspace**（会话 cwd = 用户工作区；见 §5 红线）
- **slash commands 与可呈现能力**：cmd、skills、mcp 等要透出给用户
- **面向用户的请求事件**：审批（approval）、选项/交互（extension UI 类）
- **session metadata**（标题、preset、权限档、创建/更新时间…）
- **runtime metadata**：token usage、LLM context 上限、耗时等

### 3.2 app-wide（非 per-session）
- **settings / config**：上游原生配置的读、写、以及「哪些可写」的单向阀判定
- **agent-preset 类设施**（≈ 普通意义上的 agent profile）：coding agent profile = skills / mcp / env / 默认模型等组合；DSH 侧以 preset（roster/projection）呈现

### 3.3 foreign runtime 就绪性与会话管理
- **readiness**：runtime 是否安装、版本、可交互面（**cli / rpc / http / sdk**）——**SDK 优先**，SDK 未覆盖处手工补齐（cli/rpc 不被排除，只是其“活会话连接”能力通常已被 SDK 覆盖；仅当要集成 `xxx plugin add …` 这类**命令级能力**时才重新引入）
- **session management**：idle session TTL、lazy spawn（构造零 IO，首 prompt 才物化）、transcript replay 后再 lazy resume 等策略

## 4. 每档均可 **per-adapter 决策**

- 上表每一项都允许按 adapter 给出不同裁决，并在该 adapter 文档里写明。
- 例如 `codex-desktop` 有 app-server 路径、能力集更大 → 足以另起一个 adapter（如 `agent-codex-gui`），与 SDK 线 adapter 的各项裁决可以完全不同。
- 决策必须落档（adapter README / 计划文档），不允许“隐式默认”。

### 4.1 客户端面交付层（实测结论，易错）
- `window.__DSH_BOOT__.entries`（浏览器 client surface 清单）由**服务 HTML 的那个 composition**静态产出：**surface 行必须挂在服务 HTML 的一侧**（standalone 形态下即 adapter 自己；形态 B 下世界是 loopback-ephemeral 口，世界侧 surface 行**到不了浏览器**）。
- client 产物必须**构建过**才会进清单（`dsh.client` 声明 + 产物文件存在）二者缺一不可。
- 需要「应用内」能力（如目录选择器）时，pin 具体 face（如 `browse` 的 host+client 两面）并 unmount stock `*-auto` 行；**不要 `disabled: true` 掉 stock 行本身**（那会连入口一起消失）。

## 5. Home 语义（红线）

- **app home** = `<dshHome>/agents/<runtime>/`（例：codex → `<home>/agents/codex`）——它是**原生 app 自己存放 app 数据的地方**，等价于 `~/.codex`（config、auth、rollout、原生 state sqlite、skills、plugins…）。
- **绝不允许把 session cwd 指到 app home**（有 adapter 这么干过，后患无穷）。**session cwd = 用户打开的 workspace**；app home 只承载 runtime 自己的数据。
- 原生 home（`~/.codex`）**只读**：配置以单向阀拷入 app home，永不回写。
- DSH 级状态（workspace 注册表 `<home>/storages/workspace.json`、settings、session 日志）与 runtime 数据**分账**，各自有明确 owner。

## 6. 通用纪律（Discipline，违反即缺陷）

- 上游源码**零修改**；依赖 **exact-pin**；一切改动走 patch 层 / 自有插件。
- **单实例纪律**：`@deepseek-ai/*` 只能有一个模块实例（任何 install 后检查 `find <scope>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`）。
- **禁真私有 `#` 方法**：Cordis tracing-proxy 会让 `#` 成员抛 `Receiver must be an instance of class X`——一律用 TS-`private`（含箭头字段）。
- **home 解析**：插件内从世界自身 `dshHomePath` 取，不读 `process.env` 兜底；catalog/store 读取传 **runtime home**（`resolveCodexHome(home)` = `<home>/agents/<runtime>`），不要把 DSH home 传进期望 runtime home 的接口。
- **占位/降级值禁止外流**：fail-soft 的占位模型（如 `codex-default`）不得写进 settings、不得传给真实 runtime；降级必须显式 skip。
- **事件词汇**：映射到 DSH wire 词汇（`agent_start/turn_start/message_*/tool_execution_*/turn_end/agent_end`），保持与既有 adapter 一致，便于 agent.ts 平移。
- **fail-soft 与可观测**：readiness/目录/rollout 读取失败要降级且留痕（trace/logger），不得静默假成功。
- **测试 env 三件套**：`DSH_HOME=<专属 home>`、`SUPERD_DSH_ANCHOR=<install anchor package.json>`、必要时 `AW_BARE_BASE=<home>/profiles/node_modules/`。

## 7. agent-codex 现状（SDK-first 调查结论，2026-09-15）

**SDK 面（`@openai/codex-sdk@0.154.0` 类型声明全文）**：
```ts
class Codex  { constructor(options?); startThread(options?); resumeThread(id, options?) }
class Thread { get id(); runStreamed(input, turnOptions?); run(input, turnOptions?) }
ThreadOptions { model?, sandboxMode?, workingDirectory?, skipGitRepoCheck?,
                modelReasoningEffort?, networkAccessEnabled?, webSearchMode?,
                approvalPolicy?, additionalDirectories?, threadSource? }
events: thread.started / turn.started|completed|failed / item.started|updated|completed / error
```
**SDK 不提供任何 app-wide 设施**：无默认模型、无模型列表、无会话列表、无 workspace、无 fork/查询；唯一世界知识是 `resumeThread` 文档中的 “Threads are persisted in ~/.codex/sessions” ⇒ **rollout 扫描是会话清单唯一权威**。

| 接线域 | 供给方 | 实现要点 |
|---|---|---|
| spawn / resume | SDK | `startThread` / `resumeThread(id, opts)`；launch-only 的 approval/sandbox 经 ThreadOptions |
| events → dsh | SDK 事件 + adapter 投影 | `projectThreadEvent()` 水印去重 + 增量 |
| model list | **adapter** | 读 runtime home `config.toml` + `model_catalog_json` |
| 默认模型（app-wide） | **adapter** | 推 `agentDefaultModel.saveSelection()`（单向粘性；占位值禁推） |
| 会话清单 | **adapter** | rollout 扫描（`sessions/**/rollout-*.jsonl`） |
| workspace 归属 | 上游 `dsh-workspace` | adapter 只补：扫描结果 attach（上游仅首次 boot 自动分组） |
| slash cmd / skills / mcp | **adapter（补）** | 从 runtime home 的 skills/plugins 面读取并透出（**未接**） |
| 审批 / 交互请求 | 降级：launch-only preset | SDK 无运行时审批 ⇒ 映射到 3 档预设（`--approval-mode`） |
| token usage / ctx 上限 | SDK usage（滞后一轮）+ adapter 目录 | `contextWindow` 来自 catalog |
| compaction / subagent / job list | SDK item 词表 + adapter | 逐项核对投影（部分未接，需登记） |
| session mgmt | adapter | thread 由 runtime 持久化；Dash 侧 buffer-only + rollout 回放 |

**cli/rpc 的定位（codex）**：live session 连接已由 SDK 覆盖；仅在需要命令级集成（如 `codex plugin add …`）时才考虑补 cli/rpc 面。
**已知 V1 降级（登记在案）**：无 steer（仅排队 followUp）、模型切换下一轮生效、审批仅 launch-only、usage 滞后一轮、无 fork、无 supervisor（deliberate cut）。

---

## 8. 现行捕获策略：把 foreign agent **捕获进 DSH 服务**（2026-09-15 user 裁定；**falsifiable，随时间可变**）

> 标注为「现行」——这是一条**当前选定的开发取向**，不是永久不变量；当证据变化时可推翻并重述。

- **取向**：adapter 把 foreign agent runtime **捕获进 DSH 服务层**，其中**最重要的一项是 session persistence**；WebUI 消费的是 **DSH session 服务提供的**东西（会话、事件流、workspace 归属、preset/投影…），而不是去复刻 foreign runtime 的原生界面。
- **接受的代价（明知而为）**：
  - **会话存储重复**：一份在 DSH 侧（session log / 投影缓存），一份在 foreign runtime 侧（codex rollout、omp 原生 session）。两处都真实存在，**不是 bug**；DSH log 是 WebUI 的读取面，native log 是 runtime 的持久权威。
  - **新 spawn 的会话与原生 app 数据分离**：`.codex` / `.omp`（用户级原生 home）≠ `<dshHome>/agents/<runtime>`（adapter 的 app home）。二者是**不同集合**：原生 home 只读单向阀（配置拷入），adapter 的会话数据独立存在。
- **期望的迁移方向**：用户**逐步改用 DSH WebUI 作为交互面**，而不是继续依赖 foreign agent 的原生界面（TUI 等）。这正是简化开发复杂度的关键：adapter 只需把 runtime 接进 DSH 服务与事件词汇，**不需要**为此再造一套原生交互面。
- **推论（写给未来的自己）**：
  - 不要因为「原生已有」就省掉 DSH 侧的必要投影（会话列表、事件、usage 等）——用户看的是 DSH 面。
  - 反过来，也不要为了像素级复刻原生 TUI 而过度投入；DSH 面达标即可。
  - 若某天决定改走「桥接原生界面」的取向（如把原生 TUI 直接嵌进 DSH），本节整体作废，需重写规则。
- **开放项（本条策略下的已知缝）**：foreign threadId ↔ DSH sessionId 的映射目前是**进程内**的（`threadIdIndex`），跨重启后同一 thread 会以 rollout 派生的 `session-codex-<threadId>` 形式重新出现，与重启前的 Dash id（普通 uuid）不同 ⇒ 同一 thread 在重启边界上可能出现两个 id。收敛方向（择一）：把 Dash session id 在创建时就锚定到 threadId，或把映射持久化。

## 9. codex 能力面 survey 与接线 backlog（2026-09-15，实证）

**证据来源**：真实 rollout JSONL（`<home>/agents/codex/sessions/**`）+ vendored CLI `--help` + `codex app-server generate-ts --out …`（**95 个协议类型**，含全部 method/notification 名）。

### 9.1 SDK 现状 vs 原生事件词汇（rollout 实测）
| rollout 行类型 / payload | 实测字段 | DSH 侧可落点 | 现状 |
|---|---|---|---|
| `session_meta` | **`base_instructions`（= 系统提示原文）**、`context_window`、`cli_version`、`git`、`cwd`、`history_mode`、`source`、`thread_source` | 系统提示/会话元数据/上下文上限 | **未接** |
| `turn_context` | `model`、`effort`、`sandbox_policy`、`file_system_sandbox_policy`、`approval_policy`、`permission_profile`、`workspace_roots`、`collaboration_mode`、`personality`、`multi_agent_version`、`summary`、`timezone` | **有效的**运行时元数据（模型/推理档/沙箱/审批/工作区根） | **未接** |
| `event_msg: token_count` | `info`（含用量）+ **`rate_limits`** | 实时 token 用量、配额面 | 部分（SDK usage 滞后一轮） |
| `event_msg: task_started` | `model_context_window`、`collaboration_mode_kind` | ctx 上限、协作模式 | **未接** |
| `event_msg: task_complete` | `duration_ms`、`time_to_first_token_ms`、`last_agent_message` | 轮次耗时 / TTFT / 最后一条助手消息 | **未接** |
| `event_msg: thread_settings_applied` | `thread_settings` | 会话设置生效确认 | **未接** |
| `item_completed.item` | `AgentMessage` / `UserMessage` / `Reasoning` / `McpToolCall`(server,tool,status,duration,result) | 消息/思考/工具调用 | 已接（部分） |
| `turn/…`（SDK） | thread.started / turn.started\|completed\|failed / item.* / error | 轮次生命周期 | 已接 |
| `token_usage_record` | `thread_token_usage`、`turn_token_usage`、`usage` | 线程/轮次用量 | **未接** |
| `world_state` | `full`、`state` | runtime 内部世界态（skills/plugins/goals 线索） | **未接** |

### 9.2 app-server 协议面（SDK 之外的完整能力，`generate-ts` 实证）
- **thread 生命周期**：`thread/start`、`thread/resume`、`thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/loaded/list`、`thread/fork`、`thread/name/set|updated`、`thread/metadata/update`、`thread/archive|unarchive|delete`、`thread/status/changed`、`thread/settings/updated`、`thread/shellCommand`、`thread/fork`、`thread/revert`、`thread/rollback`、`thread/inject_items`、`thread_unarchive`、`threadSection/{create,update,delete,list}` + `thread/section/move`（**会话分区/文件夹**）
- **轮次控制**：`turn/start`、**`turn/steer`（SDK 没有的 steer！）**、`turn/interrupt`、`turn/diff/updated`、`turn/plan/updated`、`turn/completed`、`turn/moderationMetadata`
- **压缩**：`thread/compact/start`、`thread/compacted`、`context_compaction`、`compaction_trigger`、`AutoCompactTokenLimitScope` ⇒ **DSH 压缩事件可接**
- **审批 / 交互（SDK 完全缺失）**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`ApplyPatchApproval`、`item/autoApprovalReview/*`、`thread/approveGuardianDeniedAction`、`mcpServer/elicitation/request` ⇒ **审批与选项事件可接**
- **流式增量**：`item/agentMessage/delta`、`item/reasoning/textDelta|summaryTextDelta|summaryPartAdded`、`item/commandExecution/outputDelta|terminalInteraction`、`item/fileChange/outputDelta|patchUpdated`、`item/mcpToolCall/progress`、`item/plan/delta`
- **模型 / 权限档**：`model/list`、`model/rerouted`、`modelProvider/*`、`permissionProfile/list`
- **技能 / 插件 / 钩子**：`skills/list`、`skills/changed`、`skills/config/write`、`skills/extraRoots/set`；`plugin/{list,read,install,installed}`；`hooks/list`、`hook/started|completed`
- **MCP**：`mcpServerStatus/list`、`mcpServer/oauth/login`、`mcpServer/resource/read`、`mcpServer/tool/call`、`mcpServer/event/stream/notification`、`mcpServer/startupStatus/updated`
- **用量 / 配额 / 账号**：`thread/tokenUsage/updated`、`account/usage/read`、`account/rateLimits/read|updated`、`usageLimitExceeded`、`account/{read,login/*,logout}`、`account/rateLimitResetCredit/consume`
- **文件系统 / 工作区 / git**：`fs/{readFile,writeFile,readDirectory,createDirectory,remove,copy,getMetadata,watch,unwatch}`、`fs/changed`、`gitDiffToRemote`
- **其它**：`thread_spawn`（子代理/线程派生）、`review/start`、`thread/environment/connected|disconnected`、`thread/project/updated`、`thread/realtime/*`（实时音频/转写）

### 9.3 CLI 子命令面（vendored 二进制 `--help` 实证）
`agents`（浏览共享 local app-server 守护进程上的所有会话）、`exec`、`review`、`login/logout`、`mcp {list,get,add,remove,login}`、`plugin`、`app-server {daemon,proxy,generate-ts,generate-json-schema}`、`remote-control`、`doctor`（安装/配置/认证/运行时健康）、`sandbox`、`debug`、`apply`、`resume`、`queue`（给已有会话排队消息）、`archive`、`delete`、`migrate-rollouts`、`completion`、`update`。

### 9.4 接线 backlog（建议优先级）
1. **P1 运行时元数据**：`session_meta.base_instructions`（系统提示）、`context_window`、`turn_context` 的有效 model/effort/sandbox/approval/workspace_roots → DSH session/runtime metadata（现状全缺，UI 只能靠猜）。
2. **P1 用量**：`token_count` + `token_usage_record`（含 `rate_limits`）→ DSH usage 事件（当前滞后一轮）。
3. **P1 轮次指标**：`task_complete` 的 `duration_ms`/`time_to_first_token_ms`。
4. **P2 压缩**：`context_compaction` / `thread/compacted` → DSH compaction 事件（长会话必需）。
5. **P2 会话清单与生命周期**：改用/对照 app-server `thread/list` + `agents`，并接 `archive/delete/name/metadata`；收敛 §8 的 id 映射缝。
6. **P2 skills / mcp / plugin 面**：`skills/list`、`mcpServerStatus/list`、`plugin/list` → 面向用户的 slash/能力面板（SDK 无）。
7. **P3 审批与交互**：`*/requestApproval`、`requestUserInput`、`mcpServer/elicitation` → DSH 审批/扩展 UI（当前 launch-only 降级）。
8. **P3 流式增量与 steer**：`*/delta`、`turn/steer`（SDK 不支持）→ 实时体验与打断插话。
9. **P4 其它**：`fs/*`、`gitDiffToRemote`、`review/start`、`thread/fork`、`threadSection/*`、`thread_spawn`（子代理）。
10. **形态判断**：以上 5–9 大量能力**不在 SDK**，属 app-server 面 ⇒ 按 §4 的 per-adapter 决策，**`agent-codex-gui`（app-server 线）** 是这些能力的自然归属；SDK 线（本包）保持 happy path + P1/P2 里可由 rollout/CLI 补的项。

---

## 10. DSH-native session 管理的机制事实（2026-09-15 实证，指导 agent-codex 重构）

**上游机制**（`packages/core/agent-loop/src/index.ts`、`packages/session/session-persistence-jsonl/src/storage.ts`）：
- 工厂必须**自己持有会话的持久化写通道**：create 用 `ctx.sessionPersistence.create(session.header, {inheritedEventCount})`，resume 用 `open(id,'write')` + `handle.read()`；jsonl 后端通过 `ctx.on('session/event', …)` 把已提交事件写入该 handle 的 writer，`handle.close()` 排空。
- 上游原话：**在 agent 生命周期之外发布的 session 不持久化任何东西**（`core/session/src/index.ts:885-891`）。
- resume 的标准动作：`handle.read(0,undefined,{signal})` → `interruptedTurnClosers(events)` 追加修补 → `sessions.prepare(id, { seed:[...events,...closers], meta: structuredClone(handle.header), inheritedEventCount, eventState })`。
- jsonl 落盘：`<home>/sessions/--<normalized-cwd>--/<encoded-id>/session.v<N>.jsonl[.zstd]`（默认 zstd；首行是 header，其后每行一个持久事件）。

**OMP 线现状（对照，反面教材的一半）**：它自带 `SessionPersistence` 子类 + 自己的 SQLite 索引（`bridge-store.sqlite`：omp id ↔ dsh id ↔ transcript 文件），`list` 走索引、`open('read')` 由 OMP transcript 重新派生 DSH 事件，**DSH 侧日志只在内存**（无 `session/event` 监听）——即「DSH 服务只做呈现层，数据权威仍在原生 transcript」。这带来大量维护：id 索引表、增量摄入、派生 replay 缓存、影子 session、viewer 触发等。

**本线（agent-codex）改为 DSH-native（2026-09-15 user 裁定）**：
- 启用上游 `session-persistence-jsonl`（不再 disable），工厂持写通道 ⇒ **list / replay / 冷读全部由 DSH 服务提供**，adapter 不再扫描、不再解析原生 JSONL 做会话列表或 replay。
- adapter 只保留**一张极小的映射**（`<codexHome>/dsh-sessions.json`）：`dshSessionId → { threadId, cwd, createdAt, preset }`。因为 Codex 的 threadId 仅在该线程首个 turn 后才成立，而 resume 需要它——这是「只做 mapping」的全部内容。
- 原生 rollout 仍由 Codex 自己写（runtime 侧权威，S3/S7 单向阀），但 adapter 对它的唯一读取是**system prompt 的头部元数据**（`session_meta.base_instructions`），不是 transcript replay。
- **待验（本轮验收）**：真 turn 后 DSH 日志落盘 → 重启 → list/replay 由 DSH 提供 → resume 经映射重挂 codex 线程。

## 11. DSH 会话事件词汇（上游实证，接线对照表）

- 事件总数 55（`packages/core/session/src/known-event-types.ts`）；信封 `{type, seq, time, data, ignorable?}`，仅 4 个 surface 事件带 `surfaceOp`/`sourceEventSeqs`：`system/message`、`user/message`、`assistant/message`、`tool/result`。
- **system prompt** = `system/message {turn, step, message}`，`message = createSystemMessage(text, plugin)`（空文本 ⇒ `content: []`）；上游 loop 每会话恒写一条（surface 节点 0），**不是** header 字段。
- **reasoning/thinking** = `assistant/message.message.content` 里的 `{type:'reasoning', text}`（**不是 `thinking`**）；原始增量另存于 `assistant/message.stream` / `assistant/attempt.stream`。
- **tool call/result** = `tool/call {turn,step,callId,name,arguments: string(原始 JSON 串)}` + `tool/result {turn,step,message: ToolResultMessage, error?, meta?}`（`createToolResultMessage({callId,content,isError})`，按 `callId` 配对）。
- **system 类（log-only，非 surface）**：`approval/asked|decided|policy`、`permission/preset`、`sandbox/mode`、`plan/mode`、`model/selection`、`agent-preset/selected`、`session/title`、`request/header|context`、`compaction/*`、`todo/write`、`goal/change`、`subagent/*`…（无 `system/notice`/`system/error`；错误经 `turn/end{reason:{kind:'error'}}`）。
- **context injection**：**没有** `context/*` 事件；注入 = `user/message` 且 `source.kind==='plugin'`（`ContextFormed.form`: `instructions|catalog|snapshot|notice|relay|recall`）；文件/图片是 content block（`file`/`image` + attachment ref），不是事件。
- 关系不变量（`invariant.ts`）：turn 从 1 起、step 每 turn 从 1 起；step-scoped 事件（system/assistant/tool call|result/attempt）必须落在**已开**的 turn+step 内；`user/message` 不受限；`turn/end` 必须闭合当前 turn。
