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

**app-server 线**取代了原 `@openai/codex-sdk` 线（SDK 依赖已从本包与主 pack 移除）。
SDK 线在 adapter 里登记的一整排降级被 app-server 协议面直接消掉：

| 能力 | SDK 线（已退役） | app-server 线（现役） |
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
| `CODEX_BIN` | 覆盖 codex 入口脚本（测试）；默认 = 本包 pin 的 `@openai/codex/bin/codex.js` |
| `CODEX_HOME` | Codex 原生 home 重定向（**测试专用**；生产路径零重定向） |
| `CODEX_APPROVAL_MODE` | 覆盖审批档（`never`/`on-request`/`on-failure`/`untrusted`；非法值忽略） |
| `CODEX_APPROVAL_TIMEOUT_MS` | 审批应答超时；`0` 关闭；默认 300000 |
| `CODEX_IDLE_EXIT_MS` | 会话空闲后拆客户端；`0` 关闭；默认 600000 |

## 测试

```bash
npm run build                                   # tsc strict
DSH_HOME=<repo>/.tests \
SUPERD_DSH_ANCHOR=<repo>/upstream/deepseek-harness/package.json \
node --test test/*.test.mjs
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
