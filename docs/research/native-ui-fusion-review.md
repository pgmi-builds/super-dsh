# Foreign Agent 原生 UI 融合 — 评审意见（Review）

- 日期：2026-09-26
- 审阅对象：[native-ui-fusion-survey.md](./native-ui-fusion-survey.md)、[native-ui-fusion-plan.md](./native-ui-fusion-plan.md)
- 复核基线：`upstream/deepseek-harness/` @ `dsh-v0.1.7-rc.1`；super-dsh 工作区（仓根相对路径）
- 方法：不采信文档里的行号字面，把 survey 的关键断言逐条拿到源码里重新定位；核过的锚点在下文标注。上游锚点路径相对 checkout 根，本仓锚点相对仓根。
- 结论：**方向成立，可以推进**；但 plan 有 3 处措辞与事实不符、6 处方案缺口，建议在 P1 动手前先落到文档（§6 给文档级 diff 清单）。

---

## 0. 一句话结论

| 维度 | 判断 |
|---|---|
| survey 的证据链 | 成立（除 §5 auth 一节与少量行号漂移） |
| plan 的方向（单树 + 数据面重定向 + mount fallback） | 成立，是当前上游约束下最不坏的选择 |
| 可否开工 | 补齐 §3（必改）与 §4（缺口）后可以 |
| 明确不需要的东西 | iframe 方案；per-adapter client 模块；survey 要求的"额外获取 world token" |

---

## 1. 已确认的设计裁决（user，2026-09-26）

这几条不是"建议"，是方案边界，建议原文写进 plan 作为不变量：

1. **UI customization 单点收敛**：所有界面定制只在 ctx0 这一棵树里做。融合的目的就是让 user 的自定义在同一个 Web UI 内对**所有** runtime 生效——native 与 foreign 一视同仁。
2. **per-adapter client 模块无必要**：adapter 不该为了"让 foreign 世界页也有同样 UX"再出一份 client 半边。融合落地后此路线关闭，新增 adapter client 模块应被规则禁止。
3. **foreign agent 的配置与扩展面 = hub 页面**：`main` key `hub`（`superd-hub/src/client/HubPage.tsx`，经 `superd-hub/src/client/index.ts` 注册）就是自由发挥区——加配置页、加面板、加任何 surface 都可以，随便 patch；唯一约束是**不破坏 DSH 原生 UI 组件**（官方 slot 的既有 occupant 与官方控件语义不被替换）。这条同时回答了"foreign agent 自己的配置放哪"。
4. **世界页路线保留为 fallback**（plan §3.3）：与 1/2 不冲突——flag 关闭时仍走 `/<label>/` 整页路线，两路并存、可退。

---

## 2. 复核通过的论断（survey 的可靠部分，可继续引用）

| 论断 | 复核结果 | 锚点 |
|---|---|---|
| boot 一次性：`__ModuleLoader__.create` 二次调用 throw | 成立 | `packages/client/modules/src/index.ts:552-572`（guard 原文 `create called after module-system boot`）、`packages/client/web/src/boot.ts:75-78` |
| `AppWebEntry` 支持树级 dispose | 成立 | `packages/client/web/src/boot.ts:100-104` |
| boot graph 很薄，只有模块图 | 成立 | `packages/client/modules/src/client/manifest.ts:86-100` |
| 静态模块表是文档级单例 | 成立 | `packages/client/web/src/seed.ts:13-37` |
| mux URL 每次 connect 读 `streamBaseUrl` | 成立 | `packages/api/gateway/src/client/stream-client.ts:226,472-479` |
| connection 单 owner（第二次 start 抛错） | 成立（行号见 §3.3） | `packages/client/connection/src/client/index.ts:280` |
| `fetch` hook 在 apply 时固化一次 | 成立 | `packages/client/connection/src/client/index.ts:205,209` |
| `connection/reset` 是设计内的重拉信号，订阅面很广 | 成立 | `packages/api/gateway/src/client/index.ts:170`；`packages/api/session-controller/src/client/index.ts:133-139` |
| slot 面只能挂 widget，不能换 boot graph / 拦连接创建 | 成立 | `packages/client/ui-layout/src/client/index.ts:46-99`、`packages/client/ui-sidebar/src/client/contract/slots.ts:18-52` |
| `ui-agent-preset` 是新会话 composition 选择器，不是 runtime 切换器 | 成立 | `packages/client/ui-agent-preset/src/client/index.ts:9-11` |

**总体判断**：survey 的接缝分析（传输层是 page-owner 级接缝、connection generation reset 是官方重拉语义、sidebar seats 是公共附加面、boot-once 是内部硬单例）都站得住，足以支撑 plan 的架构选择。

---

## 3. 必改（MUST FIX）

### 3.1 survey 的 auth 结论是错的，会误导实现

survey §5 写「Auth … cookie name is derived from authority … **Per-authority (per world origin/path)**」，并在 verdict"切 agent 需要什么"第 4 条要求「a fetch wrapper must also forward/obtain the world token」。事实相反：

- `packages/client/connection/src/browser-auth.ts:69,107`：authority = **Host 头（host:port），不含 path**；cookie 名 = `dsh-auth-` + sha256(host)；`Path=/`、`SameSite=Strict`。
- superd 的挂载**根本不走每个 world 自己的认证**：`superd-hub/src/world-web-server.ts:66-72,146-156` 明确「the SAME gate native uses, so one cookie opens everything under the origin … auth is decided HERE, in ctx0's auth domain — never by the world's own browser-auth gate」；`superd-hub/src/world-host.ts:26-33` 同源复述。
- 结论：**单 origin 单 cookie，融合不引入任何新认证工作**。plan §3 的「ctx0 cookie 认证域照旧」才是对的。

修订动作：
- 删掉 survey §5 的 cookie 行与 verdict 第 4 条；
- 删掉 survey 里带问号的句子（`(name derives from authority incl. path? — …)`）——带未决问号的句子被姊妹篇当证据引用，是这两份文档最危险的耦合；
- §0 表里"额外获取 world token"从"不需要"一侧保留。

### 3.2 plan R1 措辞重写，并补迁移期规则

plan §4 R1 写「**今天成立**（adapter 不带自定义 client UI）」，与事实不符：

- `agent-omp/package.json:22-27` 声明 `dsh.client`（inject `dsh-client-ui-layout`），实现 `agent-omp/src/client/index.ts` → `agent-omp/src/mobile/client/index.ts`（侧栏压缩 + 滑动手势），产物 `agent-omp/lib/client/`。
- world profile bundles = `[dsh-base, dsh-web-app, adapterPkg]`（`superd-hub/src/world-provision.ts:45,154`），adapter 自身 patch 的插入行是**裸名** `@pgmi-builds/agent-omp`；按 client-modules 的 `exactPackageSpecifier` 规则，这一行**就是** world 树里的 client 行。
- ⇒ **OMP world 的 boot graph 里有 `@pgmi-builds/agent-omp/client`，ctx0 的没有**（ctx0 那行是 `super-dsh/agents/omp` 子路径，composite patch 注释明确"subpath rows are permanently not client rows"）。

但按 §1.2 裁决，**这不构成融合的 blocker**：它存在的理由（让 foreign 世界页也有同样 UX）被"单树收敛"取代；迁移期 mount fallback 的 OMP 世界页还需要它。R1 应改写成：

- **不变量**（不是"现在没有"）：任何 adapter 不得**新增**自定义 client 模块；ctx0 那棵树的客户端图是唯一 UI 面。
- **迁移规则**：`agent-omp/client` 在 flag 默认关闭期间保留；flag 默认开启且通过一轮验收后退役，退役时一并处理它的 `mobile-boot` 注入（仅保留给非融合路径或整体删除）。
- **P0 验证**：起一个 world，抓其 index 里的 `__DSH_BOOT__`，grep `agent-omp/client`，把实测结论写进报告。本文的结论是**规则推导**（裸名行 → client 行），置信度高但未实测，不应以"已确认"引用。

### 3.3 行号漂移

抽检三处对不上（survey 字面 → 实际）：

| survey | 实际 |
|---|---|
| `start()` 二次 owner `connection/src/client/index.ts:163` | `:280`（`the stream loop is already owned by another consumer`） |
| `isLoopback` 计算 `:197` | `:248` |
| `connection/reset` Events 声明 `:44-50` | `:20-26` |

`manifest.ts:86-100`、`modules/src/index.ts:552-596`、`boot.ts:57-104`、layout/sidebar slots 等我核过是对的。建议：survey 头部加一句"行号 = `dsh-v0.1.7-rc.1` 快照，可能漂移"并全量复核一遍，或把行号降级为 `file` + 函数名——这份文档的卖点是"证据"，无关噪声会拖累它的可信度。

---

## 4. 方案缺口（SHOULD FIX，P1 动手前定稿）

### 4.1 rewrite 必须按**路由类**拆，不是"把死 labelPath 换成活选择值"

现有 shim 的规则是**同源 root-absolute 一律 re-root**，因为 world 页的 bundle 也在 `/<label>/` 下（`superd-hub/src/client-shim.ts:34-90`）。融合页的模块图是 **ctx0 的**，bundle/静态资源必须留在根；只有 API 面该打前缀。plan §3.1 现在的表述会让页面去 `/<label>/assets/...` 取模块——把 R1 的"同一张模块图"变成"两份同图字节"，并在 HMR/`rev` 语义上留暗坑。

建议在 plan 里直接落成这张表：

| 路由类 | 例子 | 融合行为 |
|---|---|---|
| API 面 | `/api/*`、`/api/remote.mux`、`/api/session.export`、`/open-in-app/*` | native 走根；foreign 打 `/<label>/` |
| 模块 / 静态资源 | boot graph 的 `/assets/*`、`/plugins/*` | **永不重写**（恒 ctx0） |
| 上传 | `__DSH_FILE_UPLOAD__`（绕 blob worker 的那条） | 随 active agent 切 |
| 存储 | `Storage.prototype` get/set/remove 的 NS 段 | 随 active agent 切 |
| 下载锚 | `<a download>` + 同源 `/api` href | 随 API 面 |
| 其他同源 root-absolute | 运行时选择器之类的锚 | 沿用现有窄规则 |

同时注意：现有 storage NS 是**安装期常量**（`client-shim.ts:228-252`，`NS` 由 `PREFIX` 闭包捕获），融合版必须让被 patch 的方法在 call-time 读可变 NS，而不是切一次重装（`__DSH_STORAGE_NS__` 守卫决定它只装一次）。

### 4.2 transport 两个成员的生效时机不同，plan 混着写了

- `fetch`：`installConnection` 在 apply 时**捕获一次**（`connection/src/client/index.ts:209`）。所以"切前缀"只能是**一次装好、call-time 读可变 activeAgent**；**改 `__DSH_TRANSPORT__.fetch` 字段本身是 no-op**。survey §2 说对了"once at activation"，但 verdict 第 1 条与 plan §3.2 读起来像在改字段，建议写成显式不变量。
- `streamBaseUrl`：相反，每次 `connect()` 读（`stream-client.ts:226,472-479`），**只有 reconnect 后才生效**。plan 把两者并列成"切前缀 + 切 streamBaseUrl 然后 reconnect"是错的：前者不靠、也不能靠重连生效。
- 另外：`streamBaseUrl` 上游语义是 **HTTP origin**（`apps/desktop/src/main.ts:585` 传 `new URL(hostUrl).origin`）。plan 要传 `origin + '/<label>/'` 属 off-label 用法（`new URL(path, base)` 能跑，但不是契约）。建议**融合不做 streamBaseUrl**，只做 WebSocket/XHR/EventSource 的参数化重写（现有 shim 的 Proxy 路径已具备）；若坚持用，写进 R4 并在对齐轮加查 `ClientTransportHooks` 形状。

### 4.3 web-trust 的执行顺序是硬约束

`superd-hub/src/web-trust.ts:105-107` 的注入脚本是 `if(!window.__DSH_TRANSPORT__){…ownsHost:true}`——**不合并**。所以 fusion 脚本必须排在 web-trust **之后**执行。先例与理由已经写在 `superd-hub/src/world-web-server.ts:262-278`（"rows FIRST, the client shim LAST … shim-first would create the object and silently eat the verdict"）。plan 里补一行"fusion row 最后 push"即可；否则 trusted 域名（Caddy / LAN）上 `ownsHost` 丢失 → `isLoopback` 退化为 false → Host 设置持久化降级。这是典型的"上线才发现"坑。

### 4.4 选择器自己的控制面必须固定打 ctx0

`fetchRoster()` 用相对 `'/api/agent-runtime'`（`superd-hub/src/client/roster.ts:73`）。今天在 world 页里它被 shim 重写到 `/<label>/api/agent-runtime`，由**那个 world** 的 hub 行应答（`superd-hub/src/rpc.ts:21,89`）。融合后若无条件重写：**活动 world 一挂，用户拿不到 roster、也回不到 native**（页面地址没变，没有"返回"可言）。做法：把该路径列入豁免（固定 ctx0 根），或用显式 ctx0 绝对地址。进 R 表，并在 P3 加回归（活动 world 挂掉时选择器仍可用）。

### 4.5 "UI ephemeral 状态复位"目前是空话，需要一个真机制

`replaceState` 不重建 React 树；`connection/reset` / generation 订阅只让 `session-controller` 之类**重拉数据**（`api/session-controller/src/client/index.ts:133-139`），**不解除"当前选中会话"**——切完 agent 很可能停在一个在新树里不存在的 sessionId 上。两条路二选一：

- **v1 用 soft reload**：同一个 URL 只换 query，`location` 重入。正确、代码少、视觉成本一次 boot；建议作为默认实现，`replaceState` 无感变体作为 P2 打磨；
- 或者给出显式复位 seam（先把视图退回列表/首页，再重拉），并把"切换时要清哪些 ephemeral 状态"列清单。

plan §5 以"等同一次导航，可接受"和"整页 reload ≈ 跳页面体验，否决"两句带过 reload 偏早：融合后换 agent 本来就**不换文档**，reload 是重进同一个壳，不是"跳页面"。

### 4.6 feature flag 缺"客户端半边"通道

client 半边不携带 loader config（先例：`agent-omp` 的 `__AGENT_OMP_MOBILE__`，见 `agent-omp/src/mobile-boot.ts`）。同一个 `RuntimeSeat` 组件在 ctx0（融合模式）与 world 页（URL 导航模式）都要挂，靠什么区分行为？需要一个 hub 注入的 baked global（如 `__SUPERD_UI_FUSION__`）。服务端 flag 只管脚本注入与 fallback 路由，管不到 seat 的分支。

顺带：seat 现在是**真超链接** `<a href="/omp/">`，注释明确其"middle-click / new tab / copy link"语义（`superd-hub/src/client/RuntimeSeat.tsx`）。融合后 href 语义要重设计（保留 `<a>` 但拦截 click + `replaceState`，或改按钮并另设分享入口），plan §3.2 未提。

### 4.7 `?token=` 深链会丢 agent

`packages/client/connection/src/browser-auth.ts:254-268`：token 校验通过后 `303 → './'`，**query 不保留**。首次打开 `/?token=…&agent=codex` 会静默落回 native。要么 303 保留 query，要么 bootstrap 回退到 localStorage（"上次选中的 agent"）。同时建议：**query 里未知/未 spawn 的 agent 必须静默退化 native 并改写 query**，否则一个坏 label 能把页面锁死。

### 4.8 P3 验收补充五条

现有 P3（每 runtime create+prompt+resume、双向切换、串扰探针、refresh 落位）是对的，补：

1. **切换发生在流进行中**：旧 generation 的逻辑流被 `failAll`（`stream-client` 的 `revision` 机制），且切换后不得有旧 agent 的事件串入；
2. **失败回退**：world 未 spawn / 401 / WS 不可达 → 超时回退 native + 可见提示；
3. **往返幂等**：native → omp → native 后，前缀、storage NS、streamBaseUrl（若用）回到初值；
4. **trusted 域回归**：Caddy 域名下 `ownsHost` 仍生效（§4.3 的探针）；
5. **控制面韧性**：活动 world 掉线时选择器仍能列出 roster 并切回 native（§4.4 的探针）。

---

## 5. 小 nit

- plan §6 P1「native 前缀下行为与无脚本**逐字节等价**」不可能（多一个 script 标签、多一层 fetch 间接）。应为"**行为等价**"。
- survey「fusion works cleanly only where all worlds run the stock client surface (**which is the superd premise**)」与 R1 反例（OMP）直接冲突，两句一起改；改写后即 §3.2 的版本。
- plan §1 的"运行时不经济"只对**浏览器侧**成立（后端仍是 multi-context，融合后所有 world 照旧 spawn）。把收益写准：省的是每 world 一份烘焙 shim、一次整页导航、N 份 UI 状态；不是服务端资源。
- plan §7「明确不做」建议补两条：**不新增 per-adapter client 模块**（§1.2）、**不碰 `streamBaseUrl`**（除非 §4.2 另有裁决）。

---

## 6. 行动清单（文档级 diff）

| 文件 | 动作 |
|---|---|
| survey | 删/改 §5 auth 行、verdict 第 4 条、带问号的句子；行号全量复核或加免责声明；"superd premise" 措辞对齐 R1 |
| plan | R1 重写为"不变量 + 迁移规则"（§3.2）；新增"已确认设计裁决"一节（本文 §1）；§3.1 换成路由类表（§4.1）；R3/R4 补 streamBaseUrl 与 web-trust 顺序；R 表加"控制面固定 ctx0""失败回退"；§5 增 reload 兜底；§6 P3 补 §4.8 五条；§7 补两条不做 |
| 新增 | P0 探针报告：world boot graph 抓取（验证 §3.2 的 OMP client 行），落 `docs/test-reports/` |

---

## 7. 评审结论

架构选择（单树 + 数据面重定向 + mount fallback）**通过**，survey 的接缝证据链**可用**。开工前的闸门只有两条：§3 的三处事实修正、§4 的六处方案缺口落文档。其中 **§4.1（路由类）与 §4.3（web-trust 顺序）是 P1 就会踩到的真坑**，不是文档洁癖； **§4.5（切换复位）决定 P2 的工作量量级**，建议先按 reload 兜底实现再谈无感化。
