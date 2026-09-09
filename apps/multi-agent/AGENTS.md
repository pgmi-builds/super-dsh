# apps/multi-agent — 局部规则（Multi-Agent App）

- 本文件管辖本目录及子目录；上层为仓根 `AGENTS.md`（最近者胜，中间无其他层）。
- 本目录是「Multi-Agent」方向（app）：DSH 原生运行时上的多 Agent Loop 路由。设计正本 `docs/02-dsh/multi-agent-registry.md`；实测报告 `docs/test-reports/`；推导正本 `docs/02-dsh/agent-runtime-provider-seam.md`。
- 方向纪律：本仓根下后续每个方向一个 `apps/<方向名>/` 子目录；不要把方向代码摊在仓根 `packages/`。

## ForeignAgent 集成契约（四硬点 + 一未愈，2026-09-09 M1 实证，对 agent-omp 及一切真外来 provider 同样成立）

来源：echo Agent Loop（首个 ForeignAgent 样本，现居 `echo-agent-loop` 分支 / `.scratch/echo-agent-loop` worktree；完整排查史见 `docs/test-reports/2026-09-09-m1-routing-loop.md`）。

1. **服务访问走自己声明 inject 的插件 ctx**（上游 `runtime.ctx` "Plain holder" 模式）；`ownerCtx`（调用方传入）是请求域且无我们的 inject，直接 `ownerCtx.sessions` 必炸 `cannot get property … without inject`。ownerCtx 只保留发布/归属语义。`Object.create(ctx)` 派生 ctx 合法（原型链继承 inject），坑是用**别人的 ctx** 做服务访问。
2. **生命周期归属插件 ctx**：session/agent 的 `enter` 与 lifecycle effect 注册在 `agent.ctx`/插件 ctx 下。挂 ownerCtx（请求域）会随请求解绑——轮次事件 append 到脱钩 session（内存可写、`session/event` 不派发、不落盘、下次 prompt 重复 resume）。症状特征：内存事件数恒等于 seed+N。
3. **scoped world 两件套**：`createScope(ctx, agent)`（dsh-scope；agent-presets 的 mount 要求 scope key）+ `scope.ctx.extend({ agent })`（controller setup 读 `agentCtx.agent`）。preset 跨 agent-loop 但**不能当 runtime selector**——它塑造不了"谁造 agent"，路由只认 runtime 键。
4. **dsh-scope 双实例 symbol 分裂**：`kScope = Symbol("dsh.scope")` 非全局——解析到第二份包副本则宿主看不见我们的 scope（自查 `scopeOf` 有值、宿主编排报 unscoped）。修法：运行时从宿主进程解析（`realpathSync(process.argv[1])` 锚定 `createRequire().resolve()` + 动态 import），失败回落本地（单测）。凡用 dsh-scope/scoped events/presets 的 provider 必须同样处理。cordis 系 symbol 全 `Symbol.for` 不受影响。
5. **JS 方法脱绑定**：`const f = obj.method` 后 `f()` 在 ESM 严格模式 `this === undefined`。桥接传方法引用用 `Reflect.apply(obj.method, obj, args)`。
6. **【未愈 M1.1】resume 路径持久化**：重启后已有会话首建 agent 的轮次事件不落盘（create 路径正常；事件有派发、writer 注册 buffered=0、无 warn、直写 handle 通道可用）。**影响面**：只阻塞"薄壳复用原生 jsonl"的 provider；omp-web 式自持 session 面（自己 provide sessionPersistence）不走此路径。agent-omp 适配选型（a 复用 jsonl / b 自持）决定此项修复优先级。
7. **绝不调用 `setFactory`**：外来 loop 只经 `appendFactory(key, …)` 注册；apply 时 fail-loud 检查 `ctx.agents` 为 MultiAgentRegistry。

## agent-omp 适配前置认知（从 omp-web 继承，适配时核对）

- omp-web 原仓：`~/workspaces/dsh-omp`（在产 3081；其 AGENTS.md 是运维契约正本）。本目录 `agent-omp/` 是其源码副本改名 `@pgmi-builds/agent-omp`，**尚未适配** multi-agent：它现在仍是独占式（cordis.patch.yml 禁 agent-loop + `setFactory` 独占）。
- 适配要点（届时落实）：`OmpProvider implements AgentFactory`（src/index.ts:111）从 `setFactory` 独占改为 `appendFactory('omp', …)`；其 sessionPersistence/supervisor/models/permission 部件按"自持 session 面"路线平移；`sim` 子进程经 broker/supervisor 托管。
- 依赖形态：`@deepseek-ai/*` 全 optional peers + host 自供；`.npmrc` `auto-install-peers=false`（嵌套 peer 副本破坏 scopeOf 身份）。
