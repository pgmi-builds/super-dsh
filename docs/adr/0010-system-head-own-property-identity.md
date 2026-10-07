# system-head 会话共生写者：own-property 注入裁决（world 上下文 session 身份保真）

2026-09-28 accepted（P3 rig 实测 D1 根因修复，`33c1f74`；独立评审轮要求正式落档）

## 决策

`withSystemHead`（superd-hub `src/system-head.ts`，六个 bridge adapter 共享的
session-log 共写者）改为**在 session 对象本体上安装非枚举自有属性**
（`append` 遮蔽 + `stampSystemPrompt`），返回**同一对象**。放弃返回
`new Proxy(session)` 的旧实现。

## 背景（上游锚点）

- 上游 title 服务的存活判据是**对象同一性**：`session-title/src/index.ts:404`
  `this.ctx.sessions.get(session.id) !== session` → throw "not live in this
  store"；`session-controller/src/commands.ts:193` 的 `resolveAgent()` 把
  agent 句柄上的 `session` 递给它。
- adapter 在 `ctx.sessions` 注册的是**裸 session**（如 `agent-pi/src/index.ts:633`），
  而 `withSystemHead` 旧实现返回 Proxy → `raw !== Proxy` → 一切 world 上下文的
  `session/rename` 必炸（P3 rig 报告 D1：本地 Pi/Codex/OMP + dev3 双包复现；
  ctx0 无 wrapper 故健康）。
- 上游只读（ADR 0005 红线），无 co-writer 扩展面可用。

## 为什么是 own-property 而不是别的

- **注册 Proxy 替代裸对象**：被否——`attachments` 的 WeakMap 键与
  `session/event` 的身份语义会在别处裂开（身份问题搬家不消失）。
- **调用侧绕行**（找一条不做身份校验的 rename 路径）：被否——上游没有
  identity-free 的 RPC；绕行 = 每个消费面自担漂移。
- **own-property 注入**：对象同一性对 store/agent/事件三面全部保持；安装
  non-enumerable、幂等（重复安装守卫）、pass-through 有回归 pin。

## 代价与边界（清醒条款）

- 这是**比 Proxy 更重的猴补丁**：上游若对 session 做
  `getOwnPropertyNames` 遍历或序列化，泄漏面比 Proxy 大。它没有消除债务，
  只是把债务从"身份断裂"换成"隐形扩展点"。
- **identity 回归 pin（先红后绿那组）是本裁决的守卫，永不移除**；上游对齐轮
  diff 必查 `session-title` 与 `session/event` 身份语义。

## 正解出口（迁移方向）

上游提供一等 co-writer / log-扩展面之日，本模块退役为薄适配。在此之前：
- 任何新 adapter 必须走 `withSystemHead`（不得自造 wrapper）；
- 本模块改动须过 identity pin + 六 adapter 会话面冒烟。

## Consequences

- 六个 adapter 的 world 上下文一次全修（共享单模块），native ctx0 路径
  字节不动；A2A `new_conversation`/`send` 带 title 在 world 目标恢复可用。
- 上游服务经 store 拿到的 session，其 append 现在路由经过共写拦截——
  deliberate，pass-through 已 pin；每次上游对齐轮加跑 rename+resume 冒烟。
