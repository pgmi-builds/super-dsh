# Machine Mesh P3（A2A 服务与 SuperD Hub 工具面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DSH 原生 agent 通过单一 **SuperD Hub** 工具完成：查 roster（含会话维度）、`new_conversation`、`send`（receipt 语义 + 答案自动回投）、`read`、`stop`——跨机目标（dev3 的 codex 等）与本地目标同一套调用。

**Architecture:** 服务层在 CTX0 hub host 半边（`a2a-service.ts`）：conversation 注册表（持久化）+ 经 GatewayFace（本地 in-process / 远端 wire，P2 已就位）的 create/resume/注入 + 完成订阅捕获最终回复 + 经 `ctx.agents` 的 followup/steer/inject 回投（自有 source kind `a2a-relay`/`a2a-notice`）。工具面 = ctx0 `tools` 服务注册单工具（better-dsh plugin.ts 模式）。**前置钉子**：会话面 wire 词汇（endpoint 常量，上游一手锚点）先拔。

**Tech Stack:** superd-hub TypeScript、node:test、ctx.agents/MessageSourceMap 声明合并、schemastery（工具 schema）。

**Spec:** `docs/specs/machine-mesh-a2a/spec.md` §7（方法集/回投/信封）、§9（工具面）、§2（receipt/outcome）。

## Global Constraints

- 沿用全部既有纪律（上游零修改、单实例、共享 home、字母版本、build 先于 test、交付形态验收）。
- 回投纪律（§7.3）：receipt 在 inbox-acceptance 即返；答案 = user-role message + `{kind:'a2a-relay', form:'relay', senderSessionId}` / `{kind:'a2a-notice', form:'notice', summary ≤120}`；路由 idle→followup / busy→followup（steer 仅显式 delivery）/ teardown→inject；投递即离队、仅失败进有界缓冲；工具描述写死 NEVER poll。
- 上游 `MessageSourceMap` 声明合并（`declare module`，无共享 plugin kind——0.1.7 规矩）。
- 停车搬运：I1(a) 5 分钟周期探测、I1(b) 预检轻探针、I2 version-mismatch 计算随本 phase 落（roster 会话维度需要新鲜度）。

---

### Task 1: wire 会话词汇（endpoint 常量，上游一手锚点）

**Files:**
- Create: `super-dsh/superd-hub/src/wire-endpoints.ts`
- Test: `super-dsh/superd-hub/test/wire-endpoints.test.mjs`

**Interfaces:**
- Produces: `export const WIRE = { sessionList, sessionCreate, sessionTitle, promptSubmit, streamOpen, turnCancel, sessionClose }` 形状的常量集（具体 endpoint 字符串从上游一手源码拔出：`packages/client/` 各 UI 包的调用点 + `packages/host/` 各 controller 的 Remote 声明——每个常量带 file:line 锚点注释；若某方法不存在（如 sessionClose），该键 = undefined + 注释说明，不得编造）。
- 测试：形状断言（存在的键匹配上游 segment pattern）+ 与 `envelope.ts` ENDPOINT_SEGMENT_PATTERN 兼容。
- 验证强化：用 P2 的 wire 桥对**本机 native 面**真发一次 `sessionList`（rig 或单测 fixture 内起最小 ctx 不可行则留 rig 层验证，单测只钉常量）。

### Task 2: conversation 服务（注册表 + create/resume/注入 + 完成捕获）

**Files:**
- Create: `super-dsh/superd-hub/src/a2a-service.ts`（纯服务核 + ctx 装配分离）
- Test: `super-dsh/superd-hub/test/a2a-service.test.mjs`

**Interfaces:**
- Produces:
  - `interface ConversationRow { shortId: string; machine: string; agent: string; sessionId: string; title?: string; createdAt: number; lastActivityAt: number }`；持久化 `<dshHome>/superd/a2a-conversations.json`（0600 原子写，machines.ts 同款纪律）；shortId = DSH session id 截首 8 位、插入查重加长。
  - `createA2aService(deps: {home, gatewayFor(agent:{machine, id}): GatewayFace|undefined, now?}): A2aService`：
    - `newConversation(addr, title?) → {shortId, sessionId}`（经 gateway `WIRE.sessionCreate` + title；401/不可达 → typed error）
    - `send({to, conversationId?, title?, message, delivery}, initiator) → receipt {outcome:'injected'|'queued'|'failed', messageId, conversationId?, sessionId, error?}`——无 conversationId 等价 new；注入 = 经 gateway 的 prompt 面（新 turn 的 user message，信封自带回复语法教学 + replyTo + 发起方地址）。
    - `subscribeCompletion(conv, cb)`：经 gateway 事件流（WIRE.streamOpen）订阅该会话 turn 完成，捕获最终 assistant 文本 → cb；断流重订阅一次。
    - `stop(conv, scope:'turn'|'session')`：turn = WIRE.turnCancel；session = 会话关闭面（WIRE.sessionClose 若有，否则 adapter 语义记录在 JSDoc，P5 前按 turn 降级 + notice 说明）。
    - 未读缓冲：有界（32 条）Map<initiatorSessionId, Message[]>；`read(initiatorSessionId?)` 清扫。
- 测试：fake gateway（脚本化应答）钉全部分支 + 持久化/查重/降级。

### Task 3: 回投面（ctx.agents 路由 + source kinds）

**Files:**
- Modify: `super-dsh/superd-hub/src/a2a-service.ts`（装配层）+ `src/index.ts`
- Create: `super-dsh/superd-hub/src/a2a-delivery.ts`
- Test: `super-dsh/superd-hub/test/a2a-delivery.test.mjs`

**Interfaces:**
- Produces:
  - `declare module '@deepseek-ai/dsh-llm'`（或实际上游包名，实现者以上游 continuation-messages.ts 的合并点为准）`interface MessageSourceMap { 'a2a-relay': …; 'a2a-notice': … }`。
  - `deliverReply(ctx, initiatorSessionId, content, meta)`：构造 user-role message（relay 正文前缀 "Agent <addr> replied:"）→ `ctx.agents.get(initiator)` 状态路由（idle→followup / busy→followup / 无→缓冲+notice）；`deliverNotice(ctx, initiatorSessionId, summary)`（form notice，≤120 字符）。
  - 订阅-回投装配：Task 2 的 completion cb → deliverReply；失败 → 缓冲 + notice。
- 测试：fake ctx.agents（记录 followup/steer/inject 调用）钉三分支 + 源形状 + no-double-delivery。

### Task 4: SuperD Hub 工具面（单工具，DSH 原生注入）

**Files:**
- Create: `super-dsh/superd-hub/src/hub-tool.ts` + row 接线（`super-dsh/cordis.patch.yml` 或既有 hub 行 config——实现者按 better-dsh plugin.ts 模式接 ctx0 `tools` 服务）
- Test: `super-dsh/superd-hub/test/hub-tool.test.mjs`

**Interfaces:**
- Produces: 单工具 `superd-hub`（显示 "SuperD Hub"），call-shape dispatch：`{}`/`{action:'agents'}`（machines→agents→近期 conversations alive-first ≤5 带 title/短ID/status/mtime）；`new_conversation`；`send`（delivery 参数）；`read`；`stop`；`exec`（占位返回 "not yet implemented: exec (P4)"）。描述文案含地址格式、NEVER poll、stop 硬停语义。
- 测试：fake service 钉 schema 分派、receipt 形状、占位腿、描述关键句。

### Task 5: rig + dev3 E2E + 停车搬运

- 5a. I1(a) 周期探测（5min，user 裁决）+ I1(b) 预检轻探针 + I2 version-mismatch 计算与告警。
- 5b. E2E：本机 DSH agent（4999 会话内）第一人称调用工具 → `agents` 看到 dev3 → `new_conversation` on dev3-codex → `send` → **回复自动回投**到发起会话（新 turn，form relay）→ `stop` 生效。报告 + 交 user。

## Self-Review

- Spec 覆盖：§7.2 方法集（T2/T4）、§7.3 回投（T3）、§2 receipt（T2）、§9 工具面（T4）、停车搬运（T5a）、E2E（T5b）。附件投递/多 recipient 留 P4+（spec 未许诺）。
- 词汇任务（T1）是唯一新风险点——一切经 gateway 的会话调用依赖它；锚点注释 + rig 层验证双保险。
