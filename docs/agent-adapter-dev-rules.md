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
