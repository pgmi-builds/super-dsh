# @pgmi-builds/dsh-agent-loop-echo

第一个 ForeignAgent（echo Agent Loop，M1 Task 4）。`EchoAgentFactory` 经 M0 MultiAgentRegistry 的 **`appendFactory('echo', …)`** 侧槽注册——**绝不调用 `setFactory`**（原生 loop 保有 `native` 槽；registry 的 same-key throw 即组合守卫）。设计正本：`docs/02-dsh/multi-agent-registry.md` §三/§四；计划：`docs/superpowers/plans/2026-09-09-m1-routing-loop.md` Task 4。

## 构建引导（type wiring，沿 M0）

类型解析走**仓根 `node_modules`**（exact-pin `@deepseek-ai/dsh-agent@0.1.3-alpha.2`、`@deepseek-ai/dsh-session@0.1.3-alpha.2`、`@deepseek-ai/cordis@4.0.2`，含 `.d.ts`）：

```bash
npm install --cache .npm-cache        # 仓根（若 node_modules 已在则跳过）
npx tsc -p packages/agent-loop-echo
node --test packages/agent-loop-echo/test/*.test.mjs
```

## 设计（as-built）

### createAgent 链（对上游 agent-loop 的最小镜像）

```
sessions.prepare(sessionId, {seed?, meta?, inheritedEventCount?})   # 工厂铸 session
  → append permission/preset + sandbox/mode + approval/policy       # 开场最小集（M0 实测模板）
  → persistence.create(header) + suffix flush（如有 sessionPersistence）
  → new EchoAgent(ownerCtx, agentOptions, session)
  → await options.setup(agent.ctx)?.commit()                        # compose-only 契约
  → sessions.enter → agents.enter(agent, ownerCtx.agent)
  → sessions.announce → agents.announce → agent/session-start{startup|resume}
```

发布顺序、`enter`-先于-`announce` 的回滚序、`ownerCtx.effect` 包生命周期（teardown：agent.dispose → detachAgent → detachSession → handle.close）均镜像上游 `publish()` 的裁剪版。`resume` 走 `persistence.open('write') → coldRead → interruptedTurnClosers 修复 → prepare(seed=持久化事件)`，turn 编号从持久化 log 续起。

### echo 轮次（事件序列）

```
agent/status running
turn/start{turn} → user/message(surfaceOp:append) → step/start{turn,1}
  → (50ms 可取消延时)
assistant/message(surfaceOp:append, content=[echo] 前缀原文, source={kind:'model',provider:'echo'}) → step/end → turn/end{completed}
agent/status idle
```

`cancel`：中止挂起回声、不落 assistant、`turn/end{aborted, cause}`；排队未启动的 followup 丢弃（简化 keepInbox）。`whenIdle` 在 idle 且队列空时结算；`runMaintenance` 立即执行 task。`steer`/`inject`：类型化 no-op（echo 无在飞模型请求可改道——文档化裁决）。

## 已知边界（诚实记录，M2+ 真正 provider 时清账）

- **`agent.ctx` = create/resume 调用者的 context**，非全新 scoped world：setup 注册落在调用者 fiber 上（上游 mint unpublished Agent scope 依赖 cordis scope 深部机制，echo 未镜像）。
- **不写 `agent/inbox/spliced` 事件**：followup 直落 `user/message`；live `Inbox` 实例仅为 Agent 脸兼容存在（空置）。
- `options.signal` 只在边界点检查（create 开场 / setup 后），未对每个 await 全程 race。
- `permission/preset` 等开场事件类型由上游 preset 插件合并进 SessionEventMap；本包按基础 map 编译，append 处用窄 cast（运行时 append 只验 JSON+surface 契约）。
- `assistant/message` 的 `stream: []`（无真实 provider 流）；`request/header`/`request/context` 不落（无 LLM 调用）。

## 硬约束（继承 M0 教训）

- Service/类成员**禁止 `#` 真私有**（cordis proxy brand check）——本包全 TS-private 普通成员。
- `@deepseek-ai/dsh-session-persistence` 不在仓根 node_modules：persistence 面以**本地结构切片**（`EchoPersistence`/`EchoPersistenceHandle`）声明，接口漂移时只改一处。

## 测试

`node --test test/*.test.mjs`（fake-ctx + fake sessions/persistence 面，无 dsh boot）：注册/失败响亮、createAgent 链与发布顺序、followup 事件序列、排队串行、cancel/keepInbox 简化、whenIdle、runMaintenance、resume（持久化 seed + turn 续号 + 无 persistence 报错）、setup/commit 时序、echoContent。14/14。
