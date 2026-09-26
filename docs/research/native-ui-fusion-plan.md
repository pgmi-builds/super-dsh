# Foreign Agent 原生 UI 融合 — 设计文档（v2）

- 日期：2026-09-26（v2，取代 2026-09-25 v1 的 URL query 方案）
- 状态：待 user 审阅（brainstorming architectural 路径 · 写档步；通过后转 writing-plans 出实施计划）
- 姊妹文档：[native-ui-fusion-survey.md](./native-ui-fusion-survey.md)（上游证据）、[native-ui-fusion-review.md](./native-ui-fusion-review.md)（评审，§3/§4 必改项已吃进本文）
- 修订摘要：v1 的 URL query / replaceState 状态承载方案**废弃**——active agent 改为 Hub 前端 state management（per-tab、不持久化）；后端分流改 parameter 优先、path 兜底；吃进评审全部必改项。

---

## 0. 已确认的设计裁决（user，2026-09-25/26，方案边界）

1. **单树收敛**：所有界面定制只在 ctx0 一棵树里做，user 的自定义对全部 runtime 生效。
2. **禁止新增 per-adapter client 模块**：ctx0 客户端模块图是唯一 UI 面；现存 `agent-omp/client` 按迁移规则退役（§6 R1）。
3. **HubPage = 自由发挥区**（`main` key `hub`）：foreign agent 的配置与扩展面都在这里，随便 patch；唯一约束是不破坏 DSH 原生 UI 组件。
4. **Active agent 是纯前端、per-tab 状态**：multi-tab / 多设备同开时后端不可能维护"哪个 tab 在看哪个 agent"，任何 server-side 记忆都是错的；状态只能随每个请求无状态携带。
5. **不持久化 hub state**：refresh 永远回 native，用户重选一次（测试上完全可接受）。
6. **URL 栏不动**：不 push/replace 任何 history；parameter 只作为 patch 点需要时的预留口子，不是状态载体。
7. **无感切换，不做 soft reload**：chat 区**不清空**、先停在原地等数据自愈；reconnect indicator 用原生自带行为，不自造。
8. **数据准确性优先**：请求能正确分流到后端是硬要求；UI 行为与 native 完全一致不强求——locate 不到 foreign agent 的 latest session/draft 就直接从 new chat 开始，不死磕最后一公里。
9. **世界页路线保留为 fallback**（feature flag）：flag 关闭时仍走 `/<label>/` 整页路线，两路并存、可退。

## 1. 问题与收益（措辞按评审 §5 修正）

现状（AW-B URL scheme）：每个 foreign agent 一套完整挂载 UI + 一份烘焙 shim；切换 = 整页导航。

融合收益（浏览器侧）：N 份烘焙 shim → 1 份参数化脚本；切换不再换文档；UI 状态一份。**后端仍是 multi-context，所有 world 照旧 spawn——本方案不动服务端拓扑，不省服务端资源。**

## 2. 上游事实基础（证据见 survey；本节只列设计依赖）

1. 客户端一文档一树（`__ModuleLoader__.create()` 二次 throw）→ 双树共存不可能。
2. boot graph 只含模块图；config/session/settings 全走 Connection RPC → 换 agent 只需换数据面。
3. 传输接缝 = `ClientTransportHooks`（page-owner 级）；**`fetch` 钩子在 connection apply 时捕获一次**（`connection/src/client/index.ts:209`）→ 只能一次装好、call-time 读可变状态，改字段是 no-op。
4. `connection.reconnect()` + `connection/reset` 是官方重拉语义，订阅面广（session-controller 等）。
5. **Auth 修正（评审 §3.1）**：cookie 名按 Host 派生、`Path=/`；superd 挂载全走 ctx0 认证域——**单 origin 单 cookie，融合零新增认证工作**。
6. **Refresh 恢复机制（本轮实测源码）**：`dsh.sessions.current`（`ui-workspace/src/client/navigation.ts:131`，恢复上次选中会话）与 `dsh.conversation.<sessionId>`（`ui-conversation/src/client/stores.ts:25`，**draft 持久化于此**）都是 localStorage 扁平 key，无后端判别。

## 3. 架构：单树 + Hub state management + 请求级分流

```
页面级 state 原子 __SUPERD_UI_STATE__ = { activeAgent: 'native' | '<label>', … }   （不持久化，per-tab）
   │ 写                                            │ call-time 读
   ▼                                              ▼
RuntimeSeat/HubPage（React 树内）          transport 钩子（app boot 前装，一次装好）
                                            ├─ API fetch / 上传 / 下载锚 → 追加 ?agent=<label>
                                            ├─ WebSocket/EventSource/XHR → URL 追加 ?agent=
                                            └─ Storage.prototype → NS = '<label>:'
后端：hub 在 ctx0 树内对 /api（含 upgrade）demux：?agent= 非 native → 转发对应世界；无参数 → 透传原生
```

### 3.1 State 原子与 Hub client 插件

- 一个 baked global（`__SUPERD_UI_STATE__`）承载可变状态，transport 脚本与 Hub client 插件共享读写；Hub 侧包一层薄 API（get/set/subscribe + React hook）。
- transport 钩子**只能**在 call-time 读它（§2.3）；storage NS 同理——被 patch 的 `Storage.prototype` 方法 call-time 读可变 NS（评审 §4.1：现版 NS 是安装期闭包常量，必须改）。
- Selector 仍落 `sidebar.footer.action`（RuntimeSeat 既有座）。

### 3.2 分流：parameter 主案，path 兜底

| | Parameter 主案（`/api/...?agent=codex`） | Path 兜底（`/codex/api/...`） |
|---|---|---|
| 前端规则 | 窄规则：只对 `/api` 开头的请求**追加** `?agent=`；不碰 path | `/api/*` path 重写加前缀 + 豁免表 |
| 静态资源/模块 | **天然免疫**（`/assets`、`/plugins` 永远原样，评审 §4.1 整张豁免表 evaporate） | 需要"永不重写"类 |
| 控制面（roster） | **天然解决**：无参数 = ctx0 | 需显式豁免 `/api/agent-runtime` |
| 后端 | **新工作量**：hub 在 ctx0 树内 intercept `webServer`，对同一条 `/api`（含 WS upgrade）按参数 demux | 已完成且 battle-tested（carrier 前缀路由） |

裁决（**user 定稿 2026-09-26：`/hub` 单一家族**）：hub 在 ctx0 webServer 注册**一个** prefix 路由 `/hub` + **一个** upgrade 路由 `/hub/api/remote.mux`，全部 foreign 流量收进该家族，`?agent=<label>` 选世界——客户端一条规则（foreign 时 `/api…` → `/hub/api…` + `?agent=`；native 时零接触），原生 `/api` **完全不被碰**（waterfall 观察者不挂，降级为已探明备选接缝记档）。后端复用 carrier 现有 envelope/mux/dispatchRpc 转发机制，demux 依据从 path label 换成参数；`/hub` 路由套 ctx0 authorize gate（world mount 成熟模式）；未知/未 spawn 的 label 静默退化，不锁死页面。故障域天然隔离：`/hub` 族出 bug 只死 foreign，native 永远活着。备选记录：`connection/request` waterfall（`connection/src/index.ts:155`，公开 Events 声明，P0 探针 Q2/Q3 实测可观察 query、veto 独占响应）为 unary 面的官方备选接缝；WS upgrade 无参数接缝（gateway 直接 `registerUpgrade`，重复 throw，路由表私有）——此为 WS 不得不走 path 的根因。browser 导航/URL 栏/history 与 `/hub` 无关：它只存在于 XHR/WS 请求层。

**Carrier 现位置备忘（2026-09-26 复核修正）**：当前 WebCarrier（`superd-hub/src/carrier.ts`）注册的是与原生 `/api` 同一张 ctx0 webServer 路由表上的兄弟路由族（`/<label>/api/*` + mux upgrade + open-in-app 桥接）。`/hub` 方案沿用同一模式，只是地址族收敛为单一前缀、demux 依据从 path 换参数。

### 3.3 五个 patch 点（一次装好、call-time 读 state）

| # | 点 | 行为 |
|---|---|---|
| 1 | API fetch（`/api/*` RPC 面） | foreign 时重写为 `/hub/api/*` + `?agent=`；native 零接触 |
| 2 | WebSocket / EventSource / XHR（mux 流） | foreign 时重写为 `/hub/api/remote.mux` + `?agent=`（Proxy 构造器拦截，沿用现 shim 形状） |
| 3 | 上传（`__DSH_FILE_UPLOAD__` 绕 blob worker 路径） | 随 API 面 |
| 4 | 下载锚（`<a download>` + 同源 `/api` href 的 click 拦截） | foreign 时 href 重写为 `/hub/api/…` + `?agent=`（沿用现窄规则） |
| 5 | storage NS（`Storage.prototype` get/set/remove） | call-time NS = `'<label>:'`，native 无前缀 |

注：全部 foreign 改写收敛为一条规则（`/api` → `/hub/api` + `?agent=`，call-time 读 activeAgent）；hub 控制面（`/api/agent-runtime`）不重写、恒打 ctx0——**活动 world 挂掉时 roster 仍可用，用户永远能切回 native**（评审 §4.4）。`/hub` prefix 优先于 frontend-static 的 SPA fallback（named route > fallback，`/omp` 挂载同次序已验证）。

### 3.4 web-trust 顺序（评审 §4.3，硬约束）

web-trust 注入脚本是 `if(!window.__DSH_TRANSPORT__){…ownsHost:true}`，**不合并**。fusion 脚本必须排在它**之后**（row 最后 push），否则 trusted 域（Caddy/LAN）上 `ownsHost` 被吃掉。先例注释：`superd-hub/src/world-web-server.ts:262-278`。

### 3.5 无感切换编排（按裁决 7/8）

1. 探活（可选）：roster 已有，不新增端点；
2. 写 state 原子：activeAgent、NS；
3. **会话落位（重走原生路径，§2.6 的免费推论）**：per-agent NS 下 `dsh.sessions.current` 即"该 agent 上次会话"——优先恢复它；store 是 boot 时读一次的内存快照，故 Hub 显式触发一次导航（`uiWorkspace` 面）；NS 下为空/读失败 → **落 new chat**（blank session）。chat 区不清空、不显 loading 骨架，让旧内容停在原地等数据自愈；
4. `connection.reconnect()` → 新树事件流 + `connection/reset` 订阅者重拉 → UI 自愈；左下角 reconnecting = 原生自带行为；
5. 失败兜底：切换后一致性校验不过 / 目标 world 不可达 / WS 超时 → 回退 native + 可见提示（评审 §4.8-2）。

> **勘误（2026-09-26，T-A 实证修订）**：步骤 3 的 new-chat 落位**不得在 reconnect 前执行**——上游 `startSession()` 从 wire 缓存解析 `currentWorkspaceId ?? recent`（navigation.ts:223-238），彼时缓存仍是上一个 agent 平面的数据 → `workspace/not-found` + 死会话钉屏（live 验收缺陷，用户第 1-3 轮）。修订：指针落位保持即时（session-targeted，不解析 workspace，第 4 轮行为不变）；new-chat 落位**推迟到 reconnect 后目标平面 baseline 落地**（`workspaces.list` items 引用替换 = 缓存已新），解析语义即该平面原生 new-chat 按钮。回退/新切换接管取消未落地的落位。chat 区不清空、无骨架（裁决 7）不变。

> **勘误（2026-09-26，T-F 定稿，取代上一条勘误的「指针落位保持即时」，user 裁决「按原生的语义去理解…把这个 last visit session 也做一下」）**：落位整体重做为**原生 fresh-load restore 语义**（upstream `watchNavigation`/`restoreSelection`，navigation.ts:284-347）：
> 1. **闸门 = 双列表齐备**：reconnect 后等 `workspaces.list` 与 `sessions.list` **都**重新 ready（baseline 落地、items/ids 引用替换）才做任何落位决策——这正是 upstream `watchNavigation` 自己的 ready 闸（navigation.ts:292）。T-A 只盯 `workspaces.list` 是 live 缺陷根源：sessions 仍持旧平面数据时指针在 `byId` 里查空 → 掉进 new-chat，连 native 自己的 last-visited 恢复也被打断。
> 2. **决策 = 完整 restoreSelection 优先级**（对 NS 分区后的 `'<label>:dsh.sessions.current'`，经 Task-3 patch 的 Storage 读取）：`subagentAddress` → `openSession(address)`；`sessionId` 在**新** `sessions.byId` 里命中 → 非 blank 开该会话、blank 落其所在 workspace（`startSession(workspaceId)` 公开面精确覆盖私有的 `reuseBlank`/`connectWorkspace` 行为）；指针失效 → recent workspace（`updatedAt` 最新者，`recentWorkspace` 复刻）落新会话；两列表全空 → default workspace 镜像（`workspaces.initializeDefault` + `openWorkspace`，标题按 locale 语言分支）。**没有发明任何无条件 new-chat**：no-pointer 的 foreign 平面走 fresh-boot 等价路径。
> 3. **被接受的代价（取代裁决 7 的「chat 原地停留」）**：落位改到闸门后执行，旧视图会被落位结果整体换掉——视觉上等价一次 fresh load；user 确认可接受（「既然已经换了一个 new session…效果是一样的」）。取消机制不变（回退/新切换取消未落地的落位 + staleness watchdog）。

## 4. 模块图同构不变量（评审 §3.2 重写）

- **不变量**：任何 adapter 不得**新增**自定义 client 模块；ctx0 客户端图是唯一 UI 面（裁决 2）。
- **现状**：`agent-omp` 有 client 模块（侧栏压缩+手势，`agent-omp/src/client/`），世界 profile 裸名行即 client 行——**规则推导，P0 实测确认**（抓 world index 的 `__DSH_BOOT__`，grep `agent-omp/client`，结论落报告）。
- **迁移规则**：`agent-omp/client` 在 flag 默认关期间保留（fallback 路线还要用）；flag 默认开且过一轮验收后退役，退役时一并处理其 `mobile-boot` 注入。

## 5. Feature flag 双半边（评审 §4.6）

服务端 flag 只管脚本注入与 fallback 路由；client 半边行为分支（同一 `RuntimeSeat` 在融合页 = state 切换、在世界页 = 纯导航）靠 hub 注入的 baked global（如 `__SUPERD_UI_FUSION__`）。融合页的 seat 拦截 click 走编排；世界页的 seat 保持真超链接不动。

## 6. 风险记账

| # | 风险 / 缺口 | 处置 |
|---|---|---|
| R1 | adapter 新增 client 模块破坏同构前提 | §4 不变量写进 `agent-adapter-dev-rules.md`；P0 实测 OMP 现状 |
| R2 | `dsh.*` 扁平 key 跨树串扰（sessionId 可碰撞） | patch 点 5（call-time NS）；P3 串扰探针 |
| R3 | 切换瞬间内存缓存残留（session-controller 快照等） | `connection/reset` 订阅面重拉 + §3.5.3 显式导航复位；实测有脏读再加清单 |
| R4 | ~~ctx0 树内 `/api` 拦截~~ **已关闭（GO）**：`connection/request` waterfall 即官方接缝（P0 实测）；WS 无接缝走 path 前缀 | [P0 报告](../test-reports/2026-09-26-p0-native-ui-fusion-probes.md) |
| R5 | transport 钩子与上游 `ClientTransportHooks` 演进耦合 | 只依赖 survey §2 列出的公开成员；对齐轮加查其形状 |
| R6 | 活动 world 故障锁死页面 | 控制面恒打 ctx0（§3.3 注）+ 失败回退 native（§3.5.5） |

## 7. 验收（P3，含评审 §4.8 五条）

1. 每 runtime 至少 create + prompt (+ resume)（对齐轮纪律）；
2. 双向切换：native↔foreign、foreign↔foreign；往返幂等（前缀/NS/参数回到初值）；
3. 切换发生在流进行中：旧 generation 逻辑流被 failAll，无旧 agent 事件串入；
4. 失败回退：world 未 spawn / 401 / WS 不可达 → 超时回 native + 提示；
5. trusted 域回归：Caddy 域名下 `ownsHost` 仍生效（§3.4 探针）；
6. 控制面韧性：活动 world 掉线时 roster 仍可列、可切回 native；
7. localStorage 串扰探针：同名 sessionId 两树各写各读；
8. 会话落位：切到有历史的 agent 恢复其 recent session；无历史/读取失败落 new chat；native 侧 refresh 恢复（session + draft）不受融合影响。

报告落 `docs/test-reports/`；user 放行后 flag 默认开。

## 8. 落地顺序

- **P0 探针（已完成 2026-09-26）**：① world boot graph 同构实证（评审 §3.2 推导被推翻，`agent-omp/client` 不在世界图；新事实：ctx0 缺 hub client 半边，P1 补）；② `/api` 接缝实测（Q1 throw / Q2 query 可见 / Q3 veto 独占）。报告：`docs/test-reports/2026-09-26-p0-native-ui-fusion-probes.md`。
- **P1 transport + state 原子**：fusion 脚本（含五 patch 点 + web-trust 顺序 + `__SUPERD_UI_FUSION__`）；native 下行为等价（非"逐字节等价"，评审 §5）回归。
- **P2 切换编排**：RuntimeSeat 融合分支 + §3.5 五步 + 失败兜底；单测覆盖参数/NS 矩阵。
- **P3 验收**：§7 全项 + 报告 + 放行。
- **P4（v2 演进，另行设计）**：HubPage 跨 agent 会话浏览器（后端聚合全量集合 + 前端 filter；不动原生组件，风险圈在 Hub 面板内）；`agent-omp/client` 退役。

## 9. 明确不做（本轮）

- co-mount 双 client 树（上游 boot-once，硬不可能）；
- foreign preset 路线（adapter 进 ctx0 根，放弃世界隔离；长期选项，另行 ADR）；
- 新增 per-adapter client 模块（裁决 2）；
- 修改上游任何文件（红线 §〇.5）；
- hub state 持久化 / URL 状态承载（裁决 5/6）；
- soft reload 作为切换路径（裁决 7；仅留作失败兜底的一部分）。

---

## 附：v1 → v2 变更记录

| v1（2026-09-25） | v2（本文） | 依据 |
|---|---|---|
| URL query `/?agent=` + replaceState 承载状态 | 页面级 state 原子，URL 不动 | user 裁决 4/5/6；评审 §4.7（token 303 丢 query 使 query 方案本有洞） |
| path 前缀重写（沿用 shim 规则） | parameter 追加优先，path 兜底 | user 提议；豁免表/控制面问题天然消解 |
| 切换 = 复位会话视图 + 重拉 | 无感切换：chat 不清空、原生 reconnect indicator、per-agent NS 恢复 recent session / 落 new chat | user 裁决 7/8；§2.6 源码实测 |
| localStorage"上次 agent"未涉及 | 明确不做（refresh 回 native） | user 裁决 5 |
