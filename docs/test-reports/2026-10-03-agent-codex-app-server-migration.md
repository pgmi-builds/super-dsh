# agent-codex → `codex app-server` 迁移：实现与实测报告

> 日期：2026-10-03 ｜ 工作树：`.worktrees/codex-app-server`（分支 `codex-app-server`）
> 计划正本：`docs/superpowers/plans/2026-10-03-agent-codex-app-server-migration.md`
> 调研依据：`dashr/docs/60_exploration-and-research/10-codex-app-server/hermes-codex-app-server-runtime-research.md`

## 一、结论摘要

1. **可行，且已实现**：现役 `@pgmi-builds/agent-codex` 已从 `@openai/codex-sdk` 线整体迁到
   `codex app-server` 线。SDK 依赖从 adapter 包与主 pack（`super-dsh/package.json`）双双移除。
2. **零依赖新增/升级**：`@openai/codex@0.154.0`（本包既有的 exact pin）自带 `app-server`；
   `codex app-server generate-ts` 在本机产出 617 个类型文件，wire 类型与二进制同版本。
3. **单测 107/107 绿**（11 个文件），**真二进制 live 实测通过**（见 §四），含**真实审批回路**。
4. **未做（下一道闸门）**：4999 整包 pack 线 + dev3 目标机实装（根 AGENTS §〇.0.a）。
   本报告只覆盖 adapter 级验收，**不构成发布放行**。

## 二、可行性取证（live，2026-10-03）

脚本：`.scratch/codex-appserver-probe/probe.mjs`（仓根 `.scratch/`，不入库）。

- `initialize` → `initialized` → `model/list` → `getAuthStatus` → `thread/start` → `turn/start`
  → 通知流 → `turn/completed` → `thread/items/list`，全程 stdio JSONL、**无 `jsonrpc` 头**，
  与调研文档一致。
- `thread/start` 返回 `{thread.id, model, modelProvider, cwd, approvalPolicy, sandbox}`；
  `Turn.startedAt/completedAt` 是**秒**。
- 错误面已采样：`error` 通知（`willRetry`）+ `turn/completed{status:"failed", error:{message}}`。

### 2.1 环境既有缺陷（与本次迁移无关，但值得登记）

- `codex-cli 0.154.0` **已移除 `wire_api = "chat"`**：显式配置会得到
  `` `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"` ``
  （[openai/codex#7782](https://github.com/openai/codex/discussions/7782)）。
- 本机原生 `~/.codex/config.toml` 的 custom provider 用 `wire_api = "responses"` 指向 z.ai
  `https://api.z.ai/api/coding/paas/v4`，该端点对 `/responses` 返 **404**（`/chat/completions`
  返 429）。因此**今天本机的 `codex exec`（旧 SDK 线）与本迁移后的 app-server 线同样失败**，
  失败字节级一致 —— 这是 provider 配置/上游可用性问题，不是迁移引入的回归。
- 需要 live 面时，本报告用**独立测试 `CODEX_HOME`**（`.tests/codex-live-home/`，gitignored）
  指向 DeepSeek（`https://api.deepseek.com/v1` 的 `/responses` 实测 **200**）。
  **原生 `~/.codex` 未被写入**（红线 §5 单向阀）。

## 三、实现摘要

| 新增 | 职责 |
|---|---|
| `src/app-server-protocol.ts` | 协议窄类型（`generate-ts` @0.154.0 派生，手写子集；含 `ThreadItem` v2 全联合） |
| `src/app-server-wire.ts` | 真子进程 + JSONL JSON-RPC：id 关联 / 通知与 server-request 分派 / EOF / 进程组回收 |
| `src/app-server-client.ts` | `CodexAppServerClient`：**lazy spawn**、thread start\|resume、turn start\|steer\|interrupt、每轮 model/approval/sandbox 覆盖、usage 折叠 |
| `src/app-server-events.ts` | app-server 通知 → 既有 wire 词汇（27 条通知 + 19 种 item）投影 |
| `src/app-server-approvals.ts` | server-request → DSH `ctx.approval`，**全路径 fail-closed** |

| 删除 | 原因 |
|---|---|
| `src/codex-client.ts` / `src/codex-events.ts` | SDK 线整体退役（**不保留双代码路径**，rules §1） |
| `@openai/codex-sdk`（本包 + 主 pack） | 不再被 import |

| 关键改动 | 说明 |
|---|---|
| `src/agent.ts` | 审批桥装配（`makeApprovalHandler`，服务**惰性**解析）；`#syncTurnPolicy()` 每轮折叠；**取消 `/permission` shadow**（运行时切换已真实支持）；`/compact` 仍显式拒绝（backlog） |
| `src/permission.ts` | `turnPolicyFromEvents(events, fallbackPreset, cwd)`：`approval/policy` + `sandbox/mode` 独立折叠，env 只覆盖审批半边 |
| `src/index.ts` | create/resume 改用 `CodexAppServerClient.create()`（零 IO）；`followThreadId` 改用 `onThreadAttached`（线程 attach 时可持久化）；runtime info 增 `cwd()` |

**保持不变的不变量**：lazy spawn（rules §14-i，单测直接钉死）、原生 home 零重定向（§5）、
DSH-native 持久化与 `dsh-sessions.json` mapping-only（§10）、事件词汇不变（§6）、
占位模型不外流（§6）。

## 四、实测

### 4.1 单元（fake，不 spawn 真 codex）

```
cd super-dsh/agent-codex && npm run build && node --test test/*.test.mjs
# tests 107 / pass 107 / fail 0
```

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `app-server-wire.test.mjs` | 11 | 真子进程分帧、id 关联、通知、server-request 往返、非 JSON 行、超时、退出、close 幂等 |
| `app-server-client.test.mjs` | 19 | **lazy 不变量（factory 调用计数）**、thread/turn 参数、agent_start/turn_start 顺序、usage 同轮附着、失败轮、迟到 item 丢弃、steer/followUp/interrupt、newSession、close |
| `app-server-events.test.mjs` | 19 | 27 条通知 + item 全表、工具对去重、todo 快照、malformed fail-soft |
| `app-server-approvals.test.mjs` | 12 | 四种审批方法映射、决策表、**无 answerer/抛错/超时 → decline**、非审批方法 fail-closed |
| `permission.test.mjs` | 12 | 折叠表、半边独立、env 覆盖、preset 兜底 |
| 既有 6 个文件 | 34 | 未回归（`provider-resume` 的 observer 测试改钉 `onThreadAttached`） |

### 4.2 Live（真 codex 0.154.0 二进制 + 真模型）

脚本：`.scratch/codex-appserver-live/smoke.mjs`。命令：
`CODEX_HOME=<wt>/.tests/codex-live-home DEEPSEEK_API_KEY=… node smoke.mjs`

```
STEP 1 ok: create() is inert (no process, no thread)
STEP 2 ok: turn 1 settled in 1688ms
STEP 3 ok: assistant text crossed the wire            # 模型原文 "SUPERD-APPSERVER-OK"
STEP 4 ok: usage on the same turn_end: {"input_tokens":10371,"output_tokens":10,…}
  EVT agent_start / turn_start / message_start / message_update×41 / message_end
  EVT tool_execution_start
  APPROVAL REQUEST item/commandExecution/requestApproval: {"kind":"command","itemId":"call_00_Vwq…"}
  EVT tool_execution_end / message_end / turn_end / agent_end
STEP 5 ok: 1 approval(s); tool command_execution → command_execution
STEP 6 ok: state idle, stats {"tokens":{"input":10722,"output":5,"cacheRead":10496,"cacheWrite":0}}, closed cleanly

LIVE ACCEPTANCE PASSED — 67 wire events, 1 approvals
```

这条实测第一次在真运行时里走通了 SDK 线**结构性缺失**的两件事：真实的
`item/commandExecution/requestApproval` → 客户端 accept → 工具真的执行；以及
`thread/tokenUsage/updated` 的用量落在**同一轮**的 `turn_end` 上。

> 附注：`client.close()` 会经 `onFailure` 发一条 `codex app server client closed`，
> 与退役的 SDK client 行为一致；`CodexAgent.dispose()` 先置 `#disposed` 再 close，
> 所以生产路径不会把它当成失败轮。（可观测噪声，非缺陷，未改。）

## 五、未完成 / backlog（登记）

1. **交付形态验收**：4999 整包 pack 线（shell 200 + roster + world 挂载）+ dev3 目标机实装 ——
   根 AGENTS §〇.0.a 的闸门，**未做**，且**未请求发布放行**。
2. `thread/compact/start` → DSH 压缩事件未接（`/compact` 仍显式拒绝）。
3. `thread/list` 会话清单未接（遵守 mapping-only，DSH 日志仍是权威）。
4. `skills/list`、`mcpServerStatus/list`、`plugin/list` 面向用户的面板未接。
5. `requestUserInput` / `mcpServer/elicitation` / `permissions/requestApproval` 一律 fail-closed
   （当前无渲染面）。
6. collab / subagent 项（`collabAgentToolCall`、`subAgentActivity`）未投影 → `getSubagents()` 恒 `[]`。
7. 子进程孤儿残余风险：已做 `detached` + 进程组 SIGTERM→SIGKILL + `child.kill()` 兜底，
   但 stdio MCP 后代若自行 `setsid` 仍可能逃离（与 Hermes 研究的已知坑一致）。
8. 顺带：`super-dsh/superd-hub/package-lock.json` 的 peer 列表与 `package.json` 不同步
   （缺 `dsh-home-paths` / `dsh-tools`），本工作树的 `npm install` 顺带修正——单独一个 chore commit。
