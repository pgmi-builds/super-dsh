# 从 Multi-Agent 到 Multi-Context：多 Runtime Context 强隔离与 BFF 导流门架构蓝图

- **日期**: 2026-09-10
- **定位**: 架构设计文档（从 Multi-Agent 单槽修补演进至 Multi-Context 多容器强隔离）
- **路径**: `docs/superpowers/plans/2026-09-10-multi-context-design.md`
- **核心命题**: **“与其叫 Multi-Agent，不如叫 Multi-Context”** —— 不在单 Context 内修补多槽 Agent Loop，而是在 App 入口主动 Spawn 多个独立的 Cordis Context（`CTX 0..N`），以 `CTX 0` 作为 Native 完整体与 App Web UI 载体，跨 Context 构建 BFF 导流门。

---

## 〇、架构核心变迁

| 维度 | 旧构想 (Multi-Agent 修补) | 新蓝图 (Multi-Context 多容器) |
|---|---|---|
| **基本单位** | 单 Context (`ctx`) 下的 `AgentRegistry` 多槽分流 | 多独立 Context (`CTX 0`, `CTX 1`, `CTX 2`...) 平行共存 |
| **隔离级别** | 共享 Root DI 树，服务相互覆盖抢占 | Context 级别强隔离，各拥有独立 Service Tree 与 Fiber Timeline |
| **BFF 数据面** | 异构 Adapter 覆盖根 `sessionPersistence` 造成全局污染 | `CTX 0` BFF 导流门跨 Context 聚合/路由数据面 |
| **切换代价** | 容易误触 patch 热重载或 HMR，杀掉在飞任务 | 各 Context Fiber 常驻不卸载，Selector 仅翻转导流门指针（Zero HMR / Zero Drain） |

---

## 一、反面案例与避坑推演（Negative Examples & Pitfalls）

### 1. 陷阱一：仅在 `AgentRegistry` / `AgentLoop` 搞多槽，忽略根服务单例溢出

- **现象**: `MultiAgentRegistry` 实现了 `createAgent/resume` 的分流，但引入 `agent-omp-sdk` 后：
  1. Workspace 会话列表全部变成 OMP 的会话；
  2. Chat 的模型下拉菜单恒为 Native DSH 模型；
  3. 新建会话始终落入 Native Loop 接管。
- **根因分析**: Cordis 进程级 `Context` 是**单例服务树 (Root Singleton DI Tree)**。外来 Adapter（如 `agent-omp-sdk`）为了提供会话能力，在根 `ctx` 上 `provide('sessionPersistence', ompStore)`，直接覆盖了 Native DSH 的全局持久化服务。
- **结论**: `AgentRegistry` 位于链路末端（仅管 Agent 实例创建），**无法隔离上游 BFF 数据面 (`/api/sessions`, `/api/models`)**。在单一 Context 里强行揉入异构 Runtime 必然导致服务抢占与全局数据污染。

### 2. 陷阱二：运行期触碰 `cordis.patch.yml` 触发 HMR

- **现象**: 尝试在用户点击切换 Selector 时动态修改/翻转 `cordis.patch.yml`。
- **后果**: 触发 DSH 的 watcher 与 `cordis-plugin-hmr` ➔ 原地重载受影响 Fiber ➔ 执行 `effect` 清理 ➔ **强制 Drain 并 Kill 内存中正在运行的 Agent 任务与子进程**。
- **结论**: Cordis Patch / HMR 是**开发期/部署期安装机制**，绝不能暴露在用户运行期路径上。运行时切换必须是纯粹的指针/路由写入，零 HMR、零 Drain、零进程死亡。

### 3. 陷阱三：混淆 Cordis Context 与 DSH Scope (作用域)

- **现象**: 试图利用 `dsh-scope` (`createScope`) 来实现异构 Runtime 的隔离。
- **根因分析**:
  - `dsh-scope` 是 **单 Agent 实例级的指令/Preset 沙箱 (Per-Agent Execution Sandbox)**，生命周期始于 `createAgent` 之后。
  - BFF 数据面（如 Web UI 未选会话时拉取 `/api/sessions` 或 `/api/models`）发生在 **Agent 创建之前**。Scope 属于下游叶子节点，无法向上覆盖全局 HTTP/RPC 接口。

---

## 二、Multi-Context 核心蓝图（Core Blueprint）

```
[SuperD App / CLI 入口 (抢占控制权)]
  │
  ├─► CTX 0 (Native Context - 完整体 & 宿主载体)
  │     ├── WebServer (独占 HTTP/WS 端口: 4999 / 3090)
  │     ├── Native Web UI 静态 Bundle 挂载 & Auth 栅栏
  │     ├── Native DSH Service Tree (llm, sessions, agents, sessionQuery...)
  │     └── BFF Cross-Context Dispatcher (导流门中枢)
  │
  ├─► CTX 1 (Foreign Context - OMP)
  │     ├── WebServer Disabled (关闭重复端口与 UI 挂载)
  │     ├── OMP Agent Adapter & OMP Bridge-Store
  │     └── 独立 OMP Fiber Timeline (常驻运行)
  │
  └─► CTX N (Foreign Context - Claude / Codex...)
        ├── WebServer Disabled
        └── 独立 Runtime Adapter & Fiber Timeline
```

### 1. (a) 抢占入口 (Preempting the Entry Point)

- **机制**: SuperD App CLI 作为第一启动入口（不修改上游 `deepseek-harness` 源码）。
- **职责**: 在单个 Node.js 进程启动时，由 SuperD 主动实例化并管理多个平行 Cordis Context（`const ctx0 = new Context(); const ctx1 = new Context();`）。

### 2. (b) 独立 Spawn 多 Context (Multi-Context Spawning)

- 在同一进程内，显式拉起 `CTX 0`, `CTX 1`, `CTX 2` ... `CTX N`。
- 每个 Context 拥有自己**完全独立的 Service Tree 与 Fiber Timeline**。
- `CTX 1` 重写 `sessionPersistence` 仅对其自身子树可见，从物理上杜绝对 `CTX 0` 的服务污染。

### 3. (c) CTX 0 完整体 ↔ CTX 1..N 裁切定制体 (Asymmetric Context Roles)

- **CTX 0 (Native Primary Context)**:
  - 跑全量 Native DSH 服务树，所有原生组件默认全部 Active。
  - 作为基础生态底座，确保 Native 功能 100% 完备。
- **CTX 1..N (Foreign Custom Contexts)**:
  - 随意定制、裁切与 Patch。
  - **显式 Disable 掉 WebServer、重复的 HTTP 端口与 UI 挂载**。
  - 仅保留该异构 Runtime（如 OMP/Claude）所必需的 Adapter、进程 Broker 与持久化服务。

### 4. (d) App 载体与 BFF 导流门放在 CTX 0 上 (Carrier & Dispatcher)

- **App 载体**: `CTX 0` 是唯一向外暴露 Web Server (端口 4999)、Web UI 静态资源与 Typert RPC 栅栏的真实载体。
- **前端复用**: Web UI 完全复用 `CTX 0` 构建出来的原生界面，利用前端自身的自愈与宽容度展示数据。
- **BFF 导流门 (Cross-Context Dispatcher)**: 在 `CTX 0` 的 BFF 接入面（`session-controller` / Typert RPC）构建跨 Context 导流代理：

```ts
// BFF 导流门逻辑示意
class CrossContextBffDispatcher {
  // 1. Workspace 会话列表：跨 Context 聚合
  async listSessions(): Promise<SessionSummary[]> {
    const nativeSessions = await ctx0.get('sessionQuery').listSessions()
    const ompSessions = await ctx1.get('sessionQuery').listSessions()
    return [...nativeSessions, ...ompSessions]
  }

  // 2. Chat 模型清单：根据 Selector 当前 activeRuntime 路由
  async getModelCatalog(activeRuntime: string): Promise<ModelCatalog> {
    if (activeRuntime === 'omp') {
      return ctx1.get('ompProvider').listModels()
    }
    return buildModelCatalog(ctx0) // Native
  }

  // 3. 消息投递与 Agent 创建：根据 sessionId 路由键跨 Context 派发
  async createAgent(sessionId: string, options: CreateOptions): Promise<AgentHandle> {
    const targetCtx = resolveContextByRuntime(options.runtime) // ctx0 | ctx1
    return targetCtx.get('agents').create(options)
  }
}
```

---

## 三、架构优势与红线保证

1. **绝对服务隔离**: 异构 Runtime 无论如何重写 Service，均封印在各自的 `CTX N` 内，零污染 `CTX 0`。
2. **零 HMR ↔ 零 Drain 保证**: `CTX 0..N` 的 Fiber Timeline 在进程内常驻。切换 Selector 仅改变 `CTX 0` 导流门的指针方向，后台任何正在运行的 Agent 轮次与子进程均不受打扰（开灯/关灯比喻）。
3. **上游源码零修改**: `upstream/deepseek-harness` 保持 Exact-Pin 只读。所有 Context 衍生、裁切与跨 Context 导流逻辑均落于 `superd` 自有包内。
