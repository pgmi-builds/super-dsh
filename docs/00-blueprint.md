# Super D (superD) 开发蓝图 v0.1

> 2026-09-06 · 由 grilling Q&A（4 轮）收敛而成。全程决策记录见 §9。
> 引用研究：`docs/research/`——剥离边界、后端数据盘点、wire 附录、异构运行时 SDK 调研（六家，
> 含 Codex/Hermes）、iOS bridge；
> 深层引用 dashr 仓 `docs/60_exploration-and-research/`（package map、slot system、composability）。

---

## 1. 定位与命名

- **是什么**：多 Agent 运行时的统一入口（桥接层 / UI-BFF）。Super D **不提供** Agent 运行时——它把
  本机与远端机器上已存在的各类 Agent 运行时，统一映射到 DSH Web UI 可消费的数据面。
- **不是什么**：不是 DSH 的 fork/profile，不 vendor 修改上游源码；不含自己的模型调用链。
- **命名**：App 名 **Super Dash**，品牌/简称 **Super D**，CLI 与代码标识 **superd**（无空格无连字符）。
  npm：顶层 unscoped `superD`（主发布名）+ 私有 scope（`@pgmi-builds/*`）用于 adapter 子包。
- **品牌原则**：只有自研代码用 Super D 品牌（App 标识、Machine 标识、自有 UI 组件）；
  上游包内的 DSH/Web UI 名称原样沿用；runtime 名称（DSH、OMP、Claude Code…）照实显示。
  brand 槽（`brand.mark`/`brand.name`）替换为 Super D。
- **形态**：独立 App。安装后即使机器上没有任何 Agent 运行时，服务器照常起、UI 照常访问（内容为空，
  可连 remote）。本地无 runtime 时它就是一个壳——这是特性不是缺陷。

## 2. 架构

```
浏览器（DSH Web UI，原样复用，零构建）
   │  4 条 wire 契约（剥离研究 §1.3）：①静态资产 ②boot graph ③/api unary ④WS mux
   ▼
superD 服务器（端口 3090，唯一 origin、唯一认证面）
   ├─ Cordis 核心（自举）：入口 CLI `superd`，第一个插件即 superd 主插件
   ├─ 载体插件（上游原样）：webserver / frontend-static / client-modules / connection / gateway
   │    （WS traffic 与 connection 全部交由上层/上游处理）
   ├─ superd 自有插件：
   │    · Provider Registry（RuntimeProvider 统一接口，见 §3）
   │    · Machine Manager（local/remote 清单、连接池、探测）
   │    · Session Pairing（配对表，见 §4）
   │    · Selector UI patch（multi-agent selector，见 §6）
   │    · AuthChain（预留中间件链，见 §7）
   │    · Consumers（TG 等 messaging channel，M2+，见 §8）
   └─ Adapter 插件 ×N（各自独立 npm 包，Provider 类别注册）
```

- **分界点**（剥离研究裁决）：浏览器半 + 4 条 wire 契约是保留层；**SessionController 及其下的
  TypertRemoteService 命名空间实现是替换层**——由 superd 的 Provider Registry + 各 adapter 接管。
- **骨架形态**：最小 cordis 宿主（研究 §2.4 变体升格为主线）。进程形态与 DASH 同构：入口起 cordis
  核心，自举 superd 插件，bundle 上游载体组件。理由：WS mux 帧格式无兼容承诺，复用 gateway 让
  wire 面 100% 原样、升级跟随 upstream；该层"无稳定性承诺"的风险被锁版策略对冲（§5）。

## 3. Adapter 体系（RuntimeProvider 统一接口）

- **一套标准、统一出口，不分 proxy/translate 类型**。所有 adapter 做的都是"桥接"：把上游 runtime
  能提供的字段/事件映射到 superD 标准字段（DSH SessionEvent 词汇）。DSH adapter 今天实现为
  wire 级转发，明天上游 breaking change 时在 adapter 层消化翻译——对下游消费层始终同一接口。
- **能力协商靠"两半"注册**：adapter 声明上游有什么数据字段（observable 字段注册），UI 侧按在场
  字段渲染；缺字段 = 空，不崩、对应 element 隐藏。DSH Web UI 的降级容错是设计内行为（事件子集
  可任意裁剪，`request/header` 缺失有显式占位；roster/patch 两级披露旋钮）。
- **桥接范围**：能桥尽桥——会话列表/新建、消息流（含 WS streaming）、agent 状态 check、模型列表/
  选择器、settings 面（可自定义增页）、附件、slash 命令、技能（slash 调出）。以 OMP Web 经验为准，
  各 runtime 用户交互面共性远大于差异。
- **UI composition 随 selector 切换**：切换 runtime 时 UI element 组合可整体切换也可不换（字段
  在场制，机制天然支持）。
- **接入层选型**（依 `docs/research/research-heterogeneous-agent-runtimes.md`）：优先 SDK 或厂商
  官方协议面（app-server / stream-json / serve RPC），ACP/CLI spawn 作回退；A 档四家
  （Claude Code / Codex 等）SDK 自带引擎、独立 API key、可与用户全局安装完全隔离共存；Hermes
  无官方 SDK（B/C 档），只能协议桥或源码 import，与用户共享 `~/.hermes` 现场需 profile 隔离。
- **5 个 adapter 与排序**（第一期 OMP 打头）：
  1. **DSH**（参考实现，最薄：同 wire 协议逐帧转发 unary + WS mux 到目标 machine，附该 machine token）
  2. **OMP**（第一期主力：复用 `~/workspaces/dsh-omp/apps/omp-web` 现成桥接——`agent.ts` 事件映射表、
     `rpc.ts` spawn `omp --mode rpc` NDJSON/stdio、union persistence、`pairing.ts`；差异点：omp-web 是
     "替换原生"（disable agent-loop/llm-*），superD 需要**多 runtime 并存**）
  3. **Pi**（与 OMP 同系，源码大部分共用，独立注册）
  4. **Claude Code**（A 档：SDK 捆绑官方 core，stdio/JSON-RPC 子进程驱动；独立 API key，不碰用户登录态）
  5. **Codex**（A 档同型；SDK 形态见研究档）
  6. **Hermes**（无官方 SDK：JSON-RPC/OpenAI 兼容 HTTP 协议面或源码 import；注意现场隔离，排序最后）
- **发布粒度**：主包 bundle 全部 adapter（装完即用，selector 直接可见）；将来数量多了再走按需安装
  （cordis patch 线现成）。
- **法律边界提示**（研究档结论）：Claude/Codex 等厂商禁止借用用户订阅登录态做产品转售——
  adapter 必须用独立 API key 认证，这是 wrapper 的合规边界。
- **Provisioning 预留**：adapter 契约留可选方法位 `detect / install / locate-isolated-instance`，
  v1 全部 not-supported；**不留配置段**（避免"写了不生效"误导）。后续两路径：辅助安装（registry
  拉取）与实例隔离安装（独立版本、与现场实例完全隔离，仅供 superD 消费——A 档 SDK 的
  "自包含引擎 + 独立认证"特性使这条路径天然可行）。

## 4. Session Pairing（配对层）

- superD **不持久化任何原始会话**——全量对话数据都在上游 runtime。
- 但维护**单一统一配对表**：superD session id ↔ `{machine, runtime, upstreamId, locator?,
  consumerBindings?}`。存在 `~/.superd/pairings.json`（M1 起即此形态）。存在原因：DSH Web UI 的
  session id 格式与各上游不兼容，不可直传；配对即含寻址（如直接定位 OMP 物理文件做重放）。
- 生命周期：会话列表刷新时对上游已不存在的配对惰性 GC（标 dead 不立删，防误删）。
- Web UI 与 messaging channel 是同一会话的两条消费通道，查同一张表。

## 5. 依赖策略与构建（半构建 ready）

- **方案 B：精确锁版 + 构建期内嵌**，不提交上游源码进仓：
  - 依赖两系列：**cordis 系列**（核心，全量需要）+ **dsh-web-app 系列**（几十个 UI 组件包，
    各自带预构建 `lib/client.js`，零构建组合）。
  - exact-pin（无 `^`）；repo 本地 node_modules 是唯一依赖来源，**禁止解析机器全局包**（不设
    NODE_PATH、不 symlink 全局树）——开发测试与生产环境隔离，版本一致。
  - **vendor 保护**：`superd vendor verify`（tarball hash 比对检漂移）+ `superd vendor restore`
    （registry 强制重拉覆盖）——防 agent/人工误改 vendor 源码，GitHub/npm 覆盖一步复原。
  - 修改上游一律走 patch 机制 / 自有插件（cordis.patch.yml 层序），非必要不碰源码——上游升级
    随时跟进，patch 同步调整。
- **Bun 单文件可执行**：交付期 `bun build --compile`，node_modules 整体嵌入 binary（静态锚定、
  环境完整）。dev 期建议统一 bun runtime，避免 node/bun 双漂移（待 PoC 验证 bun 对上游包兼容性，
  见 §11）。
- **半构建 ready 验收**：最终产物在本机 / DEV3 / Docker / LXD container 以普通 user 试安装——
  命令行能调出、SupervisorD/systemd 能拉起、服务器能跑——为测试终点。

## 6. Machine 概念与运行时发现

- **层级**：Local（DSH, OMP…）+ Remote（DEV3-DSH, DEV3-OMP…）。无 remote 时默认连 local DSH。
- **Remote 条目 v1 仅 superD-to-superD**：remote 机器上必须装 superD（它本身是服务器），本机连其
  URL。CLI 型 runtime（OMP 等）无网络服务概念，PC 上的 superD 无法向 DEV3 的 OMP 直接发起 RPC——
  必须由 DEV3 上的 superD 起 adapter、spawn 本地 OMP，再经 HTTP 暴露。裸 runtime endpoint 直连
  将来若有需求再加 `kind: raw` 档。
- **配置**：machines 列表 `{name, url, token}`，纯 manual；remote 不做任何自动扫描（不扫内网、
  无 mDNS）。
- **本地发现（自动扫描）**：可配置启动时扫 / 定时（如每小时）扫。
  1. `which dsh` 等探测 PATH 上的 CLI（装了什么）；
  2. DSH 服务探测三步：`which dsh` → 3080 握手探针（非 DSH 应答即放弃，**不盲扫端口**）→
     扫进程树找 dsh 进程并解析 `--port` 参数（prod/测试线均显式 --port 启动；`ps e` 还可取
     DSH_HOME 标识实例）；
  3. DSH 服务是否存活由 DSH adapter 内部消化；CLI 型（Claude Code/OMP）无守护进程，探测即探测
     binary 在不在。
  - 参考 Multica 的发现方式（路径待 user 提供，届时对照修正）。

## 7. Auth（预留）

- **入站**：所有 traffic（Web UI 对 3090、TG webhook）过同一 `authChain` 中间件序列。v1 只挂空壳
  whitelist 插件（Caddy 已做 IP 白名单，插件实际什么都不做）。未来加真实 auth = 往 chain 插
  provider，不动业务层。
- **出站**：machine 连接的 token 走 `machine.credentials` 独立配置段。入站/出站概念分离，v1 实现
  可暂保持一致。

## 8. Consumers（messaging channels，M2+）

- TG/Slack 与 Web UI 同级：都只是消费通道，不与特定 runtime 强绑定。
- **模型**：仿 DASH 方法论与 schema——类别 `consumer`，类型 `messaging channel`，实例 Telegram
  （后续 Slack、WhatsApp…）。
- **绑定**：用户添加 TG binding（提供 bot token）→ 平台具备该 channel facility → 在 UI 上把 channel
  自由配对给任意 runtime（local DSH 或 remote OMP 皆可）。
- **会话语义（A 方案）**：一个 TG chat 配对一个 runtime；无 session 时首条消息自动创建；用户可
  slash command 主动新建/切换（含 switch agent runtime）；**TTL 轮换**：新 prompt 距 session
  last-modified 超阈值（默认 24h，可按 channel 配置）则自动开新会话——借鉴 Hermes
  （`idle_minutes=1440`，`gateway/session.py::_is_session_expired`），但 superD 用**新 prompt 到达时
  惰性判定**，不用 Hermes 的后台 watcher（无常驻轮换进程，更省）。
- **TTL 归属 consumer 侧**（非 adapter/全局）：TTL 是消费通道的使用习惯；Web UI 通道永远显式新建，
  不自动轮换。
- **复用**：orchestra 的 telegram-consumer（`~/workspaces/orchestra/src/packages/consumer/
  telegram-consumer/`，grammy，long polling：`bot.start({drop_pending_updates})`；binding/deliver/
  media 分文件）搬运 + 改挂 superD pairing 层。设计参考 `~/workspaces/research/a2a-telegram/`。

## 9. 决策记录（grilling 全量裁决）

| # | 决策 | 裁决 |
|---|---|---|
| 1 | 进程形态 | 独立 App：superd CLI 起 cordis 核心，最小 cordis 宿主 + 自有插件；非 dsh profile |
| 2 | 命名 | superD / `superD`(npm unscoped 主发布) + `@pgmi-builds/*` scope；repo `~/workspaces/superd`（dashr 同级新仓） |
| 3 | 数据/端口 | 独立 `~/.superd/`（用户 dsh 数据不动）；默认 3090（避 3080/3081/4999） |
| 4 | 桥接范围 | 能桥尽桥，字段在场制 + UI 降级；"两半"注册一套统一标准 |
| 5 | remote 注册 | manual `{name,url,token}`；remote 无自动扫描；本地扫描 PATH+端口+进程树 |
| 6 | M1 形态 | 两条腿（DSH 透传 + OMP adapter）+ DEV3 remote；TG 为 M2 |
| 7 | 依赖 | 方案 B：exact-pin + bun compile 内嵌；repo 自包含；vendor verify/restore 保护 |
| 8 | 骨架 | 最小 cordis 宿主（webserver/frontend-static/client-modules/connection/gateway 原样） |
| 9 | Provider 接口 | 统一 RuntimeProvider，不分 passthrough/translate 类型 |
| 10 | 会话归属 | 不存原始会话；单一 pairing 表（~/.superd/pairings.json，惰性 GC） |
| 11 | adapter 发布 | 主包 bundle 全部 5+1 个 adapter |
| 12 | provisioning | 只留方法位（detect/install/locate-isolated），不留配置段 |
| 13 | 品牌原则 | 仅自研代码用 Super D；上游与 runtime 名原样 |
| 14 | TG 会话 | A 方案 + TTL（24h 默认，consumer 侧惰性判定） |
| 15 | auth | authChain 空壳中间件（Caddy 白名单先行）；入站/出站概念分离 |
| 16 | dev/test | 端口 4999（机器共用惯例，用完即停）；home `.superd-test`（user space 或仓内均可）；预配置 local-dsh(3080)/local-omp/dev3-superd 三 machine |
| 17 | 远程协议 | v1 仅 superD-to-superD；CLI 型 runtime 无网络面，必须由 remote superD 本地桥接 |

## 10. 里程碑

**M1（第一期）**：
- superD 源码仓 + 最小 cordis 宿主骨架，dev 实例 4999 + `.superd-test` home，UI 完整可访问；
- selector 显示 Local: DSH, OMP + Remote: DEV3；
- DSH adapter（透传 3080 全功能）；OMP adapter（复用 omp-web 桥接，多 runtime 并存改造）：
  新建会话、收发一轮含工具调用的消息；
- DEV3 部署 superD 并连入，其 local OMP 出现在列表（Caddy IP 白名单，无认证负担）；
- 交付验收按"半构建 ready"标准（本机/容器普通 user 试装拉起）。

**M2**：TG consumer 转正（binding 配对、slash 命令、TTL）；Pi adapter；auth 真实实现（若需要）。

**M3+**：Claude Code → Codex → Hermes adapter（接入层选型依 §3）；辅助安装/实例隔离 provisioner；
Multica 式发现对照；Electron 壳（借鉴 MIT 开源 DSH Desktop，Web UI 装壳即 GUI App）。

## 11. 开放问题

1. ~~Codex adapter 专项研究缺失~~ → 已由 `docs/research/research-heterogeneous-agent-runtimes.md`
   覆盖（A 档 SDK 形态、协议面、独立 API key 要求）；M3 动工前按其选型结论细化事件映射即可。
2. ~~Hermes 进程面勘测~~ → 同上文档已测绘（无官方 SDK，JSON-RPC/OpenAI 兼容 HTTP 协议面或源码
   import；现场隔离注意事项已记）。剩余：协议面事件词汇 → SessionEvent 的具体映射表，M3 前做。
3. **bun 兼容性 PoC**：上游包在 `bun build --compile` 下的行为（native addon、`import.meta.url`
   技巧、vendored 树）未实测。
4. **DSH 零认证探针端点**：握手探测需要一个可用的未鉴权版本/health 面——待源码核实。
5. **Multica 发现方式**：user 将提供路径，届时对照修正本地扫描设计。
6. **dsh-web-app 系列包清单定格**：bundle 哪几十个 ui-* 包（roster 裁剪基线）随 M1 骨架落地时定。
