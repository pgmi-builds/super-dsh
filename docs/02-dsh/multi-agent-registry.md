# Multi-AgentRegistry —— Registry 继承方案实施文档

- 日期：2026-09-09
- 性质：**实施级方向文档**（源码行级论证 + 代码骨架；registry 介入路线的落地形态）
- 源码锚点：`upstream/deepseek-harness` @ `dsh-v0.1.3-alpha.2`
- 上游推导：`docs/02-dsh/agent-runtime-provider-seam.md` §五（键值路由中枢定案——本文是它的实施展开）
- 姊妹方案：`docs/02-dsh/agent-runtime-provider-plugin.md`（坐槽者路由，A/B 中的 B 线）
- 实物参照：`~/workspaces/dsh-omp`（omp-web Adapter 全套，在产）

---

## 〇、结论速览

**不改一行上游源码、不复制任何代码：`export default class MultiAgentRegistry extends AgentRegistry`，override 三个方法（`setFactory` 兼容腿 / `appendFactory` / `create`+`resume` 路由），随发包 patch 一行把 base bundle 的 `id: agent` 行 `name` 重指到我们的包——多槽 registry 就位。**

占位机制不需要任何特殊语法：cordis `Service` 基类构造函数里的 `reflect.provide(name, this)` 会在子类实例化时自动完成服务注册（§一）。原生 `agent-loop` 经 `setFactory` 兼容腿无感知注册为 `native` 槽；外来 Agent Loop（OMP、PI agent）经 `appendFactory(key, …)` 各自注册，各自拥有独立 fiber/effect/disposer 时间线。

---

## 一、Magic word：类即插件即服务（源码论证）

`vendor/cordis/src/service.ts`，`Service` 基类构造函数：

```ts
constructor(protected ctx: Context, name: string) {
  ...
  self.ctx.reflect.provide(name, self, this[Service.check])   // ← 服务注册发生在这里
}
```

`packages/core/agent/src/index.ts:250`，`AgentRegistry`：

```ts
export class AgentRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')     // ← 第一行
    ctx.inject(['typert'], …)     // typert lookups 注册
    ctx.accessor('agent', { get: () => undefined })
    ctx.on('internal/status', …)  // initiator 生命周期
    ctx.effect(…)                 // initiator drain 链
  }
}
```

完整占位链条：

```
patch 行 name → 我们的包 → loader 挂载 class plugin（export default Class）
→ cordis 实例化 → 构造函数链 super(ctx,'agents') → reflect.provide('agents', this)
→ 全进程 ctx.agents 解析到我们的实例
```

- **类即插件**：`AgentRegistry` 是 `export default`，cordis 的 class plugin 形态（loader 直接实例化，无需 `apply` 函数）。
- **类即服务**：`super(ctx, 'agents')` 在基类构造函数里完成 provide——**继承即占位**，不需要额外声明。
- **构造函数链原样跑**：typert lookups（`agent` lookup + context host）、`ctx.agent` DX accessor、initiator AsyncLocalStorage、`internal/status` 监听、drain effect——子类实例化时全部就位，上游 701 行零改动零复制。

### Object.create 的校准（设计推演记录）

提案原形：`NewAgentRegistry = Object.create(AgentRegistry)`。方向正确但对象需校准——

| | 空壳复用原型链 | 带状态的完整继承 |
|---|---|---|
| Context | ✅ `Object.create(ctx)`（ctx 无自有状态，设计如此） | — |
| Service 类 | ❌ 不跑构造函数：`store`/`initiators`/typert/effect 全在 constructor 初始化，空壳即崩；且继承的是类的静态侧 | ✅ `class X extends Y` |

cordis 官方确有 `Object.create(this)`——在 `Service[symbols.extend]`（"从已构造实例派生扩展实例"的官方用法）。结论：**`extends AgentRegistry` 就是 `Object.create(ctx)` 在 Service 类世界的同构物**：原型链复用全部方法 + 构造函数照跑 + provide 照发。

---

## 二、代码骨架

```ts
// packages/multi-agent-registry/src/index.ts（暂名 @pgmi-builds/dsh-multi-agent-registry）
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { getTraceable } from '@deepseek-ai/cordis'

export default class MultiAgentRegistry extends AgentRegistry {
  #factories = new Map<string, AgentFactory>()          // 多槽（原 #private factory 单槽弃用）

  /** 兼容腿：上游 agent-loop 构造函数硬编码调用，方法名不可改。 */
  setFactory(factory: AgentFactory): () => void {
    return this.#append('native', factory)
  }

  /** 多槽注册：外来 Agent Loop 的进入口。同 key fail-loud（保持 dsh 组合面纪律）。 */
  appendFactory(key: string, factory: AgentFactory): () => void {
    return this.#append(key, factory)
  }

  #append(key: string, factory: AgentFactory): () => void {
    if (this.#factories.has(key)) throw new Error(`an agent factory is already registered for "${key}"`)
    this.#factories.set(key, factory)
    // effect 语义照抄上游：注册 fiber 卸载时按 key 摘除
    return this.ctx.effect(() => {
      if (this.#factories.get(key) !== factory) return
      this.#factories.delete(key)   // （可选增强：连带 drain 该 key 的 AgentEntry，见 §五.3）
    }, `agents.append(${key})`)
  }

  /** 路由解析：投递时决策（delivery-time），永不触碰 fiber 生命周期。 */
  #resolve(sessionId: SessionId): AgentFactory {
    const key = routingKeyOf(sessionId) ?? 'native'     // 键值来源见 §四
    return this.#factories.get(key) ?? throwNoFactory(key)
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const { target } = { target: this.#resolve(options.sessionId) }
    const receiver = getTraceable(this.ctx, target)     // 上游委托形态原样照抄（index.ts:406-420）
    return Reflect.apply(target.createAgent, receiver, [this.ctx, options])
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const target = this.#resolve(options.resumeSessionId)
    const receiver = getTraceable(this.ctx, target)
    return Reflect.apply(target.resume, receiver, [this.ctx, options])
  }
}
```

```yaml
# cordis.patch.yml（随发包 dsh.bundle.patch 层；M0 as-built 修正 2026-09-09）
# cordis-plugin-include 0.1.3-alpha.2 把 patch 行的 name 作守卫专用、永不赋值
# ——"name 重指"在本版不存在，整插件替换 = 禁原行 + 插新行。
- id: agent
  name: '@deepseek-ai/dsh-agent'     # 守卫：上游行变了就 warn 跳过（防误 target）
  disabled: true
- insert:
    - id: agent-multi
      name: '@pgmi-builds/dsh-multi-agent-registry'
```

base bundle 现状：`packages/bundle/base/cordis.patch.yml:67-68`（`- id: agent` / `name: '@deepseek-ai/dsh-agent'`）。同 scope 重复 provide 的硬错不触发——原行被**禁用**、新行插入，`'agents'` 唯一提供者是我们。

> **勘误（2026-09-09，M0 实测）**：cordis-customization §3.3 与 plugin-development 决策树第 5 行的「patch 行 name 重指 = 整插件替换入口」对 0.1.3-alpha.2 **不成立**——`applyEntryPatches` 将 `name` 解构为守卫专用（vendor/include live 核实），永不赋值。可用的替换形态只有禁行+插行。§2.2 的守卫表述才是对的。

### 实施要点

1. **TS private 的规避是天然的**：上游 `store`/`factory` 是编译期 private；我们 override 的 `create/resume` 不读它们——多槽状态在自己的 `#factories`；`register/get/currentInitiator/withInitiator/…` 十几个方法经原型链原样工作（不依赖 factory 字段）。
2. **委托形态照抄**：`getTraceable(ownerCtx, target)` + `Reflect.apply(target.createAgent, receiver, …)`——receiver 追踪语义与上游一致，多态对 AgentLoop/OmpProvider/任何 AgentFactory 实现透明。
3. **同 key fail-loud**；disposer 按 key 摘除，fiber 卸载语义逐 factory 隔离。
4. **窄继承面纪律**：上游若改 `create/resume/setFactory` 签名或 constructor 加副作用 → typecheck 编译期暴露；对齐轮新增查表项见 §六。
5. **退路**：若上游封装化导致继承不可行，退化为源码级 fork（copy 701 行改名）——同一介入点，维护成本升一档。仅此情形才走 copy。

---

## 三、多 Agent Loop 并存形态（安装后即得）

安装（`dsh plugin add`，一次性）之后，进程内同时存在三个带 fiber 的 Agent Loop，生命周期方法全套对等：

| Agent Loop | fiber | 注册方式 | 厚度 |
|---|---|---|---|
| 原生 DSH agent-loop | 原有行，零改动 | `setFactory(this)` → `native` 槽 | 厚（完整 loop：LLM、tools、systemPrompt…） |
| OMP Agent Loop | 新 patch 行 | `appendFactory('omp', this)` | 薄壳（omp-web Adapter 搬移） |
| PI agent Loop | 新 patch 行 | `appendFactory('pi', this)` | 薄壳（同 PI 核心，与 OMP 共享底座） |

- 各自独立 fiber/effect/disposer 时间线；卸载语义按 key 隔离（`#append` 的 disposer）。
- **切换 = 路由不是切断**（seam §5.3 全部继承）：路由是投递时决策，UI 键值切走只是无观察者，切回数据流继续；在飞轮次属于它自己的 agent 跑完，无人打断。无 HMR、无 fiber 卸载、无 drain、无进程死亡。
- 外来 runtime 真正 on-demand 的是**子进程**（`omp --mode rpc` / claude CLI）：首次有会话路由到该 runtime 才 spawn，broker/managed-range 托管。adapter 壳本身随 host 常驻，很薄。

### ForeignAgent 的义务面（上游实证划定的边界）

- **不受原生 agent 事件流约束**：上游 `subagent-claude-code` 实证——外来 runtime 只受进程控制（`ctx.subprocess.spawn` + managed-range 分级终止），不实现原生 loop 内部逻辑，不消费 llm/tools/systemPrompt。
- **保持最小 session 合规脸**：omp-web 实证——Web UI 渲染链是原生 `session-controller → sessionQuery.observeSession`（读 session log 投影），外来 loop 必须呈现至少 header 的 session 面（转录事件量是适配自由度）。omp-web 的 `session-persistence-omp.ts`（provide `sessionPersistence`，JSONL ∪ OMP store 扫描）+ `supervisor.ts`（冷/影/持状态机、内容级外来写者检测、影子投影）为现成实现。
- **自持会话真相**：OMP/PI 有自己的 session 管理与 Session ID，外来持久化不依赖原生 session storage 主管权。
- 上游 `subagent-claude-code` 的 `process.ts`（`ManagedClaudeCodeProcess` 分级终止）与 `run.ts`（Agent SDK officialQuery 驱动 + SDKMessage 流解析）是 claude-code 线 future provider 的部件来源（该包内 `persistSession: false`、one-shot 契约决定了它自己是 subagent 定位，但进程托管与流解析可回收）。

---

## 四、路由键（两案共有的最后一块）

- **resume 侧**：session header `config.runtime` 字段（seam §5.2 定案——与 `provider/model/reasoningEffort` 同构，`provider`（LLM 路由）与 `runtime`（loop 路由）正交）。header 持久化，resume 读它选 factory。前置验证：`request/header` 事件对 config 的校验严格度（seam §六.1）。
- **create 侧**：omp-web 在产已解决同型问题（控制会话创建路径，先定 provider 再建会话）。落法二选一，实施时照 omp-web 实际代码定：(a) UI 创建会话走我们的 RPC，携带 runtime 键；(b) RPC 先写 header config 再进 `agents.create`。
- **降级语义**：键 miss = `native`——卸载我们的包后一切回落原生行为。

---

## 五、与坐槽者路由（B 线）的对照

| | 本方案（A：registry 继承） | B：坐槽者路由（CompositeLoop extends AgentLoop） |
|---|---|---|
| 改的模块 | 槽的定义者（`dsh-agent`，经继承占位） | 槽的第一个使用者（`dsh-agent-loop`，经继承） |
| registry 语义 | 变了：单槽 → Map（`setFactory` 兼容腿保持等价） | 完全原装 |
| 对上游其余部分 | 兼容腿维持等价，但语义面扩大 | 世界与原生不可区分 |
| 生态性 | **真平级**：外来 loop 独立注册/卸载，路由是框架级事实 | 第三方向我们的插件注册 |
| 继承面 | `create/resume/setFactory` 三点 + constructor 副作用 | `createAgent/resume` 两点 |
| 与 seam §五定案的对应 | **即定案本身**（§5.2 的 `registerFactory` = 本文 `appendFactory`） | 定案的插件化变体 |

两案共享：seam §5.3 全部行为保证、不碰 session-controller、路由键缺口（§四）、外来 Adapter 部件（omp-web 搬移）。**取舍一句话**：A 换生态性与显式性，付 registry 语义面；B 换最小扰动，付生态中心。用户裁决（2026-09-09）：先走 A。

---

## 六、待验证项（动手前）

1. **继承面运行验证**（M0 即验）：子类实例化后 typert lookups / accessor / initiator scope 正常；`agent-loop` 经兼容腿注册后原生会话全功能；`getTraceable` receiver 追踪在多 factory 间不串。
2. **`routingKeyOf` 的落点**：header `config.runtime` 的 schema 校验严格度；create 侧 RPC 携带方案与原生 session-controller 创建链的衔接（omp-web 先例核对）。
3. **AgentEntry 归属增强**（可选）：原 `register()` 的 disposer 绑在调用 fiber 上；若要"factory fiber 卸载只 drain 自己的 entries"（seam §5.2 第三条），需要在 `#append` 的 disposer 里连带 drain 该 key 的 entries——核对 `FactoryOwnership`（agent-loop 侧）与本侧职责边界，避免双重 drain。
4. **对齐轮查表项**：`AgentRegistry` constructor 副作用清单（typert/accessor/internal-status/effect）+ `create/resume/setFactory` 签名——上游变更时 typecheck 暴露后逐项评估。
5. **OMP Adapter 搬移面**：omp-web `OmpProvider implements AgentFactory`（`src/index.ts:111`）从"独占槽 setFactory"改为"appendFactory('omp')"的 diff 清单；`agent-preset-omp`/permission/models 的 provider 行随迁。

## 七、里程碑

1. **M0 registry 继承 PoC**：✅ 已完成（2026-09-09，报告 `docs/test-reports/2026-09-09-m0-multi-agent-registry.md`；装载形态 as-built 为禁行+插行，见 §二勘误）。
2. **M1 echo + 路由闭环**：`appendFactory('echo', …)` 回声 provider + 路由键（header/RPC）+ UI chip。验收：运行期切 echo/切回 native，无重启无重载无任务死亡（seam §六.6 实验的接口级扩大）。
3. **M2 OMP Agent Loop**：omp-web Adapter 搬进 `appendFactory('omp')` 形态。验收：OMP 会话在原生 DSH Web UI 全交互、与原生并存互切、宿主重启断档续播。
4. **M3 PI agent**：第二外来 loop（同 PI 核心），验证 ForeignAgent 底座泛化。

## 八、源码锚点索引

| 事实 | 位置 |
|---|---|
| `Service` 基类构造函数 `reflect.provide`（占位 magic） | `vendor/cordis/src/service.ts:54-70` |
| `Service[symbols.extend]` 的官方 `Object.create(this)` | 同上 `:83-92` |
| `AgentRegistry extends Service` + `super(ctx,'agents')` | `packages/core/agent/src/index.ts:250-256` |
| 单槽 `setFactory` / disposer / 双注册 throw | 同上 `:367-382` |
| `create/resume` 委托（getTraceable + Reflect.apply） | 同上 `:400-420` |
| `AgentFactory` 两方法契约 | 同上 `:176-210` |
| `agent-loop` 硬编码调用 `ctx.agents.setFactory(this)` | `packages/core/agent-loop/src/index.ts:420` |
| base bundle `id: agent` 行 | `packages/bundle/base/cordis.patch.yml:67-68` |
| patch 行 name 重指 = 官方整插件替换入口 | `vendor/loader/src/config/entry.ts:172-287`（cordis-customization §2.3） |
| 上游外来 runtime 只受进程控制的实证 | `packages/subagent/subagent-claude-code/src/{index,process,run}.ts` |
| omp-web Adapter/持久化/supervisor 现成实现 | `~/workspaces/dsh-omp/apps/omp-web/src/*.ts` |
