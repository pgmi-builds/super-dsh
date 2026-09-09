# packages/agent-loop-echo — AGENTS.md

本文件是 `packages/agent-loop-echo` 子目录的 AGENTS.md。上层为 Super D 根目录 `AGENTS.md`；其规则对本目录仍有效，冲突时以本文件为准。

本包是**第一个 ForeignAgent**（echo Agent Loop），也是 ForeignAgent 集成契约的活样本。以下疤全部 2026-09-09 M1 实证，对任何真外来 runtime provider（OMP、PI、Claude Code 线）同样成立：

1. **服务访问必须走自己声明 inject 的插件 ctx**（上游 `runtime.ctx` "Plain holder" 模式）：`ownerCtx`（调用方传入）是请求域且无我们的 inject 声明，直接 `ownerCtx.sessions` 必炸 `cannot get property … without inject`。ownerCtx 只保留发布/归属语义（`agents.enter(agent, ownerCtx.agent)` 的 owner 参数）。注意：`Object.create(ctx)` 派生 ctx 合法（原型链继承 inject），坑是**用别人的 ctx 做服务访问**。
2. **生命周期归属插件 ctx**：session/agent 的 `enter` 与 lifecycle effect 必须注册在 `agent.ctx`（scoped world）/ 插件 ctx 下。注册在 ownerCtx（请求域）会随请求结束解绑——轮次事件 append 到已脱钩 session（内存可写、`session/event` 不派发、持久化后端收不到、下次 prompt 重复 resume）。症状特征：内存事件数恒定 = seed+N（每次都在重建）。
3. **scoped world 两件套**：`createScope(ctx, agent)`（dsh-scope——agent-presets 的 `mount` 要求 scope key）+ `scope.ctx.extend({ agent })`（controller setup 读 `agentCtx.agent`，缺了 installSelection/presets 全炸）。preset 跨 agent-loop（echo agent 也被组了 standard preset），但它只能塑造 agent 内部组合，**不能当 runtime selector**（改变不了“谁造 agent”）。
4. **dsh-scope 双实例 symbol 分裂**：`kScope = Symbol("dsh.scope")` 非全局——插件解析到第二份包副本则 mint 不同 symbol、宿主看不见我们的 scope（报 "refusing to compose an unscoped context" 但 `scopeOf` 自查有值）。修法：运行时从宿主进程解析（`realpathSync(process.argv[1])` 锚定 `createRequire().resolve()` + 动态 import），失败回落本地 import（单测环境）。**任何用到 dsh-scope/scoped events/presets 的外来 provider 必须同样处理**；omp-web 没踩只因它从不碰 dsh-scope。
5. **JS 方法脱绑定**：`const f = obj.method` 后 `f()` 在 ESM 严格模式 `this === undefined`（`session.append` 报 "reading 'log'"）。桥接代码传方法引用时用 `Reflect.apply(obj.method, obj, args)`。
6. **【未愈】M1.1 — resume 路径持久化**：重启后已有会话首次 resume 建的 agent，轮次事件不落盘（内存正常、事件有派发、writer 注册且 buffered=0、无 warn、closers 直写 handle 成功；create 路径同代码完全正常）。排查记录见 `docs/test-reports/2026-09-09-m1-routing-loop.md`。**影响面**：只阻塞“薄壳复用原生 jsonl 持久化”的外来 provider；omp-web 式自持 session 面（自己 provide sessionPersistence）不走此路径。M2 OMP provider 选型 (a) 复用 jsonl / (b) 自持，直接决定本项修复优先级。
7. **绝不调用 `setFactory`**：外来 loop 只经 `appendFactory(key, …)` 注册；apply 时 fail-loud 检查 `ctx.agents` 是 MultiAgentRegistry。

测试纪律：fake-ctx 需含 `extend(props)`（`Object.assign(Object.create(this), props)`）与 `plugin()`（返回 `{ctx: Object.create(this), dispose}`）；echo 轮次 50ms 延时用真实 timer。构建/类型接线同 registry 包（仓根 node_modules）。
