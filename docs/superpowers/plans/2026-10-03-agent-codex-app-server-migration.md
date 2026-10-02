# agent-codex → `codex app-server` 迁移计划（2026-10-03）

> 依据：`dashr/docs/60_exploration-and-research/10-codex-app-server/hermes-codex-app-server-runtime-research.md`
> （Hermes × Codex App-Server 调研，2026-10-02）+ 本仓 live 实证（2026-10-03）。
> 工作树：`.worktrees/codex-app-server`，分支 `codex-app-server`。
> 规则基线：`super-dsh/agent-adapter-dev-rules.md`（§5 home、§6 纪律、§10 持久化、§14 lazy spawn）。

## 0. 动机

现役 `@pgmi-builds/agent-codex` 建在 `@openai/codex-sdk` 上（`Thread.runStreamed`，
底层是每轮 `codex exec --experimental-json`）。SDK 面**结构性缺失**能力，且这些缺失
在 adapter 里被登记为一整排降级（rules §7「已知 V1 降级」）：

| 能力 | SDK 线（现状） | app-server 线 |
|---|---|---|
| interrupt | 只有 AbortSignal（杀本轮 stream） | `turn/interrupt`（正向中断） |
| steer | **无** → 排队 followUp 近似 | `turn/steer`（真 steer，注入进行中的 turn） |
| 运行时换模型 | **无** → 下一轮 `resumeThread` 生效 | `turn/start.model`（本轮即生效） |
| 运行时审批 | **无** → launch-only 预设 | `turn/start.approvalPolicy` + `approval/policy` 事件折叠 |
| 运行时沙箱档 | **无** → launch-only | `turn/start.sandboxPolicy` |
| 审批请求（人机） | **无** → `sendRaw` 是 no-op | `*/requestApproval` server-request → DSH `ctx.approval` |
| 用户消息回显 | **无**（SDK item 无 `user_message`） | `item/started userMessage` |
| token usage | 只在本轮 `turn.completed`，滞后 | `thread/tokenUsage/updated`（含 modelContextWindow） |
| 压缩 / 会话清单 / skills / MCP | 无 | `thread/compact/start`、`thread/list`、`skills/list`、`mcpServerStatus/list` |

用户裁决（2026-10-03）：**把现役 codex adapter 直接改成 app-server**（不是新起
`agent-codex-gui`——rules §9.4-10 的 2026-09-15 建议被本次裁决压过，该节需同步修订）。

## 1. 可行性（live 实证，2026-10-03）

取证脚本：`.scratch/codex-appserver-probe/probe.mjs`（仓根 `.scratch/`，不随交付）。

1. **无依赖变更**：`@openai/codex@0.154.0`（本包已 exact-pin）自带 `app-server`；
   `codex app-server generate-ts --out DIR` 产出 **617 个类型文件**（v2 wire 类型全量）。
   本机 `~/.local/bin/codex` 同版本 0.154.0。
2. **wire 走通**：`initialize`（返回 `userAgent`/`codexHome`/`platformFamily`/`platformOs`）
   → `initialized` → `model/list`（真实模型目录，含 supportedReasoningEfforts）
   → `getAuthStatus` → `thread/start`（返回 thread/model/modelProvider/sandbox/approvalPolicy）
   → `turn/start` → 通知流 → `turn/completed` → `thread/items/list`。全程 stdio JSONL、
   无 `jsonrpc` 头（与调研一致）。
3. **错误面同构**：本轮 turn 因**本机既有** provider 配置问题失败
   （`~/.codex/config.toml` 的 custom provider `wire_api="responses"`，z.ai 对该 URL 返 404；
   `curl` 实证 `/responses`=404 / `/chat/completions`=429）。**同一失败在 `codex exec`
   （SDK 线）逐字重现** ⇒ 与本次迁移无关，是环境既有问题；错误投影面（`error` 通知
   `willRetry`、`turn/completed status=failed` + `turn.error`）已被完整采样。
4. **协议关键形状**（实测 + `generate-ts` 互证）：
   - `ThreadItem`（v2）为 camelCase 联合：`userMessage | hookPrompt | agentMessage |
     functionCallOutput | plan | reasoning | commandExecution | fileChange | mcpToolCall |
     dynamicToolCall | collabAgentToolCall | subAgentActivity | webSearch | imageView |
     sleep | imageGeneration | enteredReviewMode | exitedReviewMode | contextCompaction`。
   - 通知名：`thread/started`、`turn/started`、`item/started|completed`、
     `item/agentMessage/delta`、`item/reasoning/textDelta|summaryTextDelta|summaryPartAdded`、
     `item/commandExecution/outputDelta|terminalInteraction`、`item/fileChange/patchUpdated`、
     `item/mcpToolCall/progress`、`item/plan/delta`、`turn/plan/updated`、
     `thread/tokenUsage/updated`、`thread/compacted`、`thread/status/changed`、`error`、
     `turn/completed`、`mcpServer/startupStatus/updated`、`remoteControl/status/changed`。
   - server-request：`item/commandExecution/requestApproval`、
     `item/fileChange/requestApproval`、`item/permissions/requestApproval`、
     `execCommandApproval`、`applyPatchApproval`、`item/tool/requestUserInput`、
     `mcpServer/elicitation/request`。
   - `Turn.startedAt/completedAt` 是**秒**；`Turn.startedAtMs`（item）是毫秒。

## 2. 目标形态与不变量

**取代**：`CodexSdkClient`（SDK 线）→ `CodexAppServerClient`（app-server 线）。
不新增并行代码路径（rules §1「差异只允许来自 patch 层」）；`@openai/codex-sdk`
依赖从本包移除。

必须保持的不变量：

1. **lazy spawn（rules §14-i，硬门）**：create/resume **不产生任何 native 进程**。
   子进程只在首个真实 prompt 时物化（`ensureStarted()`），到 agent dispose / idle-exit 为止。
   — 这是本次改动最大的行为风险：SDK 线天然满足（无子进程），app-server 线必须显式实现。
2. **native home 零重定向（rules §5）**：生产路径绝不设 `CODEX_HOME`；子进程继承
   `process.env`（测试经 ambient `CODEX_HOME` 重定向）。
3. **DSH-native 会话管理（rules §10）不变**：`sessionPersistence` 写通道、`interruptedTurnClosers`
   冷修复、`<worldHome>/dsh-sessions.json` mapping-only（不做 `thread/list` 会话清单、
   不解析 native rollout 做 replay）。
4. **事件词汇不变（rules §6）**：仍投影到 `agent_start/turn_start/message_*/tool_execution_*/turn_end/agent_end`
   + `todo_write`，使 `agent.ts` 的 switch 平移最小化。
5. **占位值禁外流（rules §6）**：`codex-default` 占位模型绝不传给 runtime。
6. **无真私有 `#` 反例**：跟随本包既有写法（`CodexAgent` 的 `#` 字段/方法已是现行且可用；
   跨 Cordis tracing-proxy 的成员用 TS-`private` 箭头字段）。

## 3. 模块设计

```
src/app-server-protocol.ts   协议窄类型（pin 0.154.0；generate-ts 派生，手写子集）
src/app-server-wire.ts       JSONL JSON-RPC 传输：spawn / 行分帧 / id 关联 / 分派 / 退出 / 进程组回收
src/app-server-client.ts     CodexAppServerClient：懒启动、thread start|resume、turn start|steer|interrupt、
                             模型与权限档覆盖、newSession、close；对外发 WireEvent
src/app-server-events.ts     通知 → wire 词汇投影器（水印 / 工具对去重 / todo 快照）
src/app-server-approvals.ts  server-request → DSH 审批服务桥（决策映射 + fail-closed）
```

删除：`src/codex-client.ts`、`src/codex-events.ts`。

### 3.1 `app-server-wire.ts`

`CodexAppServerTransport`：

- `spawn()`：`spawn(process.execPath, [codexBin, "app-server"], { stdio: ["pipe","pipe","pipe"], detached: true, env })`。
  `codexBin` 解析顺序：`CODEX_BIN` env（测试注入）→ `@openai/codex` 包内 `bin/codex.js`（`import.meta.resolve`）。
  用 `process.execPath` + `bin/codex.js` 而非 PATH 上的 `codex`，保证**版本与包 pin 一致**。
- 行分帧：stdout 按 `\n` 切；非 JSON 行进 stderr 缓冲（不透传到协议层）。
- 请求：`request(method, params, {timeoutMs})` → `{id, method, params}`，per-id 单槽 pending。
- 通知：`{method}` 无 id → `onNotification` 监听器。
- server-request：`{id, method, params}` → `onServerRequest` 处理器；处理器返回 `{result}` 或 `{error}`。
- 退出/EOF：fail 全部 pending；通知 `onExit`。
- `close()`：先 `SIGTERM` 进程组，宽限期后 `SIGKILL`；再 `child.kill()` 兜底（研究 §5.8：stdio MCP 后代可能 setsid）。
- 背压：`-32001 Server overloaded` 错误原样上抛（客户端可退避）。

### 3.2 `app-server-client.ts`

对外表面（取代 `CodexSdkClient`）：

```ts
class CodexAppServerClient {
  static create(options: CodexAppServerOptions): CodexAppServerClient   // 零 IO，不 spawn
  ensureStarted(): Promise<void>          // 首次真实工作才 spawn + initialize + thread/start|resume
  on(listener): () => void                // WireEvent
  onFailure(listener): () => void
  prompt(message): Promise<WireResponse>
  followUp(message): Promise<WireResponse> // 忙 → 客户端队列（本轮结束后 turn/start）；闲 → turn/start
  steer(message): Promise<WireResponse>    // 忙 → turn/steer（真 steer）；闲 → turn/start
  setModel(provider, modelId): Promise<WireResponse>  // 记 pending，下一轮 turn/start.model 生效
  abort(): Promise<WireResponse>          // turn/interrupt
  newSession(): Promise<WireResponse>     // 丢弃 thread，下次 ensureStarted 重新 thread/start
  getState(): Promise<WireState>
  getMessages(): Promise<WireMessage[]>
  getSessionStats(): Promise<Record<string, unknown>>
  getSubagents(): Promise<unknown[]>      // app-server v1 未接 collab/subAgent → []
  get threadId(): string | null
  get spawned(): boolean
  close(): void
  setApprovalHandler(handler): void       // server-request 审批桥
  setServerRequestHandler(handler): void  // 其它 server-request 的统一入口
}
```

关键语义：

- **thread/start 参数**：`{ cwd, personality: "none", developerInstructions?: undefined, approvalPolicy, sandbox, serviceName: "superd-agent-codex" }`。
  人格走 codex 自己的 base instructions，不由 adapter 注入（与现状一致：现役也没有 developerInstructions）。
- **turn/start 参数**：`{ threadId, input: [{type:"text", text, text_elements: []}], ...(model ? {model} : {}), ...(approvalPolicy ? {approvalPolicy} : {}), ...(sandboxPolicy ? {sandboxPolicy} : {}) }`。
  审批档与沙箱档**每轮重算**（见 §3.4），实现运行时 `/permission`。
- **turn/steer**：`{ threadId, input, expectedTurnId }`；`expectedTurnId` = 当前活动 turn id（由 `turn/started` 记录）。
  活动 turn 未知 → 退化为 `turn/start`（诚实降级，不进 steer 分支）。
- **乱序/迟到保护**：`turn/started` 前收到的 item 通知挂在 threadId 上照常投影；`turn/completed`
  之后到达的 item 通知丢弃（避免污染已关闭的 Dash turn）。
- **usage**：`thread/tokenUsage/updated` 的最新 `tokenUsage.last` 存为 `#lastUsage`，在
  `turn_end` 事件上以 `{ data: { usage } }` 附着（保持 `agent.ts` 的 usage 契约：
  本轮 usage 落在本轮最终 assistant/message 上）。usage 映射到**现有** `convertUsage`
  的 snake_case 形状（`input_tokens` 等）——由 client 转换，`agent.ts` 不改。
- **错误**：`error` 通知 `willRetry !== true` → 记 `#pendingTurnError`；`turn/completed`
  `status: "failed"` → 合成 `message_end(role=assistant, stopReason:"error", errorMessage)`
  + `turn_end` + `agent_end`。`status: "interrupted"` → `turn_end` + `agent_end`（agent 侧
  `#cancelCause` 已置位 → `aborted`）。
- **agent_start**：由 client 在本轮真正开始时发一次（`turn/started` 首见 / `turn/start` 发出后），
  与 SDK 线 `thread.started → agent_start` 的位置差异已核对：`thread/started` 只在 `ensureStarted()` 内
  出现（早于 turn/start 的日志追加），不能承担 `agent_start`（会提前触发 `#flushRemote`）。

### 3.3 `app-server-events.ts`（投影表）

| app-server | wire |
|---|---|
| `turn/started` | `turn_start` |
| `item/started` `userMessage` | `message_start{role:"user",content:[text]}` |
| `item/completed` `userMessage` | 忽略（`user/message` 已由 agent 本地追加或 `#bridgeRemoteUser` 处理） |
| `item/started` `agentMessage` | `message_start{role:"assistant",content:[]}`（+ 已带文本时补 text_delta） |
| `item/agentMessage/delta` | `message_update{assistantMessageEvent:{type:"text_delta",contentIndex:0,delta}}` |
| `item/started` `reasoning` | `message_start{role:"assistant",content:[{type:"thinking",thinking:""}]}` |
| `item/reasoning/textDelta` / `summaryTextDelta` | `message_update` thinking delta（折叠进最终块） |
| `item/completed` `agentMessage` | `message_end{role:"assistant",content:[{type:"text",text}]}` |
| `item/completed` `reasoning` | `message_end{role:"assistant",content:[{type:"thinking",thinking:summary+content}]}` |
| `item/started` 工具类 | `tool_execution_start`（toolName / args / argumentsJson） |
| `item/completed` 工具类 | `tool_execution_end`（result blocks + isError） |
| `item/*` `plan` / `turn/plan/updated` | 工具对（`update_plan`）+ `todo_write`（整表快照，latest-wins） |
| `turn/completed` | `turn_end`（+ usage） |
| `thread/tokenUsage/updated` | 不直接发事件；存 usage 供 `turn_end` 附着 |
| `error` | 不直接发事件（client 记录，turn 收尾时合成 `message_end`） |
| 其它 / 未知 / 畸形 | `null`（fail-soft，rules §6） |

工具类 item → toolName / argsJson：
- `commandExecution` → `command_execution`，args `{command, cwd?}`；end 带 `aggregatedOutput`/`exitCode`
- `fileChange` → `file_change`，args `{changes}`（`{path, kind, diff?}`）；end 文本 = 每 change 一行
- `mcpToolCall` → toolName = `item.tool`（`server` 附带），args = `item.arguments`（JSON 值 → 字符串化）
- `dynamicToolCall` → toolName = `item.tool`
- `webSearch` → `web_search`，args `{query}`
- `plan` → `update_plan`，args `{plan:[{step,status}]}`
- 未列出的（`imageView`/`sleep`/`imageGeneration`/`enteredReviewMode`/…）→ `null`（登记为未接）

### 3.4 审批桥（`app-server-approvals.ts`）

server-request → DSH `ctx.approval.request({ agent, toolName, callId?, reason?, signal })`：

| server-request | toolName | 参数来源 | 应答 |
|---|---|---|---|
| `item/commandExecution/requestApproval` | `command_execution` | `command` / `reason` | `{decision}` |
| `execCommandApproval`（legacy） | `command_execution` | 同上 | `{decision}` |
| `item/fileChange/requestApproval` | `file_change` | `reason` / `grantRoot` | `{decision}` |
| `applyPatchApproval`（legacy） | `file_change` | 同上 | `{decision}` |
| 其它（`requestUserInput` / `elicitation` / `permissions`） | — | — | `{decision:"cancel"}` / 错误应答（**fail-closed，绝不让 codex 挂死**） |

决策映射（`ApprovalOutcome` → codex decision）：
- `allowed-once` → `"accept"`
- 其它（`rejected`/`cancelled`/`unavailable`）→ `"decline"`
- 5 分钟超时（`CODEX_APPROVAL_TIMEOUT_MS`，`0` 关闭）→ abort 信号 + `"decline"`（fail-closed）
- `ctx.approval` 缺席 → `"decline"`，stderr 留痕

`ctx.approval.request()` 要求**打开的 turn**（turn-enclosed 审计对）。app-server 的审批请求必然
发生在一个活动 turn 内，所以前置条件天然满足；但仍要在异常时 fail-closed（不抛到事件循环）。

### 3.5 运行时权限档（`permission.ts` 改版）

`permission.ts` 从「launch-only 映射」改为「每轮折叠」：

```ts
export function turnPolicyFromEvents(events): { approvalPolicy: "never"|"on-request", sandbox: SandboxMode }
```

折叠规则（`agent.ts` 在每轮 `turn/start` 前调用，源 = 会话日志）：

| DSH 事件 | codex turn 覆盖 |
|---|---|
| `approval/policy {policy:'ask'}` | `approvalPolicy: "on-request"` |
| `approval/policy {policy:'never'}` | `approvalPolicy: "never"` |
| `sandbox/mode {mode:'danger-full-access'}` | `sandboxPolicy: {type:"dangerFullAccess"}` |
| `sandbox/mode {mode:'workspace-write'}` | `sandboxPolicy: {type:"workspaceWrite", writableRoots:[cwd], networkAccess:false}` |
| `sandbox/mode {mode:'read-only'}` | `sandboxPolicy: {type:"readOnly"}` |
| 无事件 | 退回 `permission` 服务的默认预设（`defaultPermissionPreset`）∥ `CODEX_APPROVAL_MODE` env 覆盖 |

`/permission` 命令：**取消 agent 级 shadow**（现役注册同名命令直接报错）——app-server 线
支持运行时切换，全局命令的 `permission/preset` + `sandbox/mode` + `approval/policy` 三连
在下一轮 `turn/start` 生效。`agent.inject` 的 `user-approval` 叙述**仍丢弃**（codex 的模型
面不需要 DSH 自己的策略句子；转发会污染历史），注释改写。

`/compact` shadow 保留（`thread/compact/start` 未接，登记 backlog）。

### 3.6 `index.ts` / `agent.ts` 改动

- `CodexAppServerClient.spawn([...], cwd)` → `CodexAppServerClient.create({ cwd, resumeThreadId, model, approvalPolicy, sandbox })`。
- create 时不再 eager 生成 thread：`threadId` 初始 `null`；`followThreadId` 观察器保留
  （`agent_start`/事件时检查 `client.threadId` 变化并 upsert）。
- resume 的 rollout 预校验（`readRolloutHead`）保留（app-server 的 `thread/resume` 在 rollout
  缺失时也可能失败，前置校验给出稳定错误码；换成 `thread/resume` 的拒答也不改语义）。
- `agent.ts`：`#client` 类型换名；新增审批处理器装配（`ctx.get("approval")`）；
  `#syncModelSelection` 保留（pending 模型 → 下一轮 `turn/start.model`，语义从"下一轮 rebuild thread"
  变成"下一轮 turn 覆盖"，对用户可见行为一致且更强）；`#startTurn` 在 `client.prompt` 前
  把折叠出的 `approvalPolicy`/`sandboxPolicy` 交给 client。

### 3.7 交付面

- `package.json`：删 `@openai/codex-sdk`；`@openai/codex` 保留（exact-pin `0.154.0`；
  wire 类型与二进制同版本）。
- `README.md`：改写为 app-server 线；「已知边界」重写。
- `cordis.patch.yml`：注释同步（审批不再 launch-only）。
- `agent-adapter-dev-rules.md`：§7 表格 + §9.4-10 形态判断 + §4.1 增补本次裁决（改为 app-server 线）。

## 4. 测试计划（RED → GREEN；`node --test test/*.test.mjs`，导入 `dist/`）

单元（fake 子进程 / fake 传输，**不 spawn 真 codex**）：

1. `app-server-wire.test.mjs`：请求-应答关联、通知分派、server-request 分派与应答写回、
   非 JSON 行不透传、EOF fail 全部 pending、`-32001` 原样上抛、close 幂等。
2. `app-server-events.test.mjs`：§3.3 全表逐行（含工具对去重、text 水印增量、未知名 fail-soft）。
3. `app-server-client.test.mjs`：
   - **lazy 不变量**：`create()` 后 transport spawn 计数 = 0；`ensureStarted()` 后 = 1；重复调用不重 spawn；
   - thread/start|resume 参数（personality none、cwd、approval/sandbox）；
   - turn/start 参数（model / approvalPolicy / sandboxPolicy 每轮覆盖）+ turn id 记录；
   - steer 走 `turn/steer`（带 expectedTurnId）；闲时退化 `turn/start`；
   - followUp 忙时排队、本轮 `turn/completed` 后自动 `turn/start`；
   - abort → `turn/interrupt`；`newSession()` 丢弃 thread 并重置；
   - usage 附着到 `turn_end`；`status:"failed"` → message_end(error)+turn_end+agent_end；
   - close 后所有操作拒绝。
4. `app-server-approvals.test.mjs`：四种 request 的 toolName/参数映射；`allowed-once→accept`、
   其余→`decline`；无 approval 服务→deny；超时→deny；非审批 request→fail-closed 应答。
5. `permission.test.mjs`（改）：`turnPolicyFromEvents` 折叠表 + `CODEX_APPROVAL_MODE` 覆盖。
6. `provider-resume.test.mjs`（改）：`setCodexFactory` → `setAppServerTransportFactory`；
   resume 的 fail-closed 路径不变（不 spawn 真进程）。

行为级（rules §2：整包线 + dev3，不在本 plan 内执行）：`.tests/superd` 4999 pack 线 create+prompt+resume。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 协议 experimental、字段漂移 | 二进制 exact-pin 0.154.0；类型从 `generate-ts` 手抄子集并注明版本；未知字段 fail-soft |
| 每个 live 会话一个 rust 进程 | lazy spawn + 现有 idle-exit（默认 10 分钟）回收；无法直接用进程（不 prompt）不 spawn |
| 子进程孤儿（stdio MCP 后代 setsid） | `detached: true` + 进程组 `SIGTERM`→`SIGKILL` + `child.kill()` 兜底；登记为残余风险 |
| 审批请求挂死 | 一律 fail-closed 应答；超时 abort 信号 |
| thread/resume 语义变化 | 保留 rollout 预校验 + 稳定错误码；native 拒答归一为 `NATIVE_REJECTED` |
| 本机 provider 404（既有） | 不在本 plan 修；live 验收用 `CODEX_HOME` 测试 home（不动 `~/.codex`） |

## 6. 任务序列（bite-size）

| # | 任务 | 状态 |
|---|---|---|
| T1 | 计划落盘 | ✅ 本文件 |
| T2 | `app-server-protocol.ts`（窄类型） | ✅ |
| T3 | `app-server-wire.ts` + 单测（11） | ✅ |
| T4 | `app-server-events.ts` + 单测（19） | ✅ |
| T5 | `app-server-approvals.ts` + 单测（12） | ✅ |
| T6 | `app-server-client.ts` + 单测（19，含 lazy 不变量） | ✅ |
| T7 | `permission.ts` 改版（`turnPolicyFromEvents`）+ 单测（12） | ✅ |
| T8 | `agent.ts` / `index.ts` 接线（审批装配、每轮策略、`onThreadAttached`、取消 `/permission` shadow） | ✅ |
| T9 | 删 `codex-client.ts` / `codex-events.ts`；改/删受影响测试；两个 `package.json` 去 SDK | ✅ |
| T10 | 文档（README / patch 注释 / rules §7 §9.4 / 主 pack description） | ✅ |
| T11 | build + 全测绿 | ✅ **107 pass / 0 fail** |
| T12 | live 验收（测试 `CODEX_HOME` + 真 codex 0.154.0 + 真模型 + 真审批回路） | ✅ 见 `docs/test-reports/2026-10-03-agent-codex-app-server-migration.md` |
| T13 | **交付形态验收**：pack 线（tarball → fresh profile → repo build 启动） | ✅ 通过（4988，含 codex 世界 create+prompt+resume 与内容级证据） |
| T14 | dev3 目标机实装 | ⏳ 未做（需 user 单独放行） |
