# Machine Mesh & A2A — 设计规格（spec v1）

> 日期：2026-09-27 · 状态：brainstorming 收敛稿（user 已确认推进）
> 基线：super-dsh **0.1.6**（native-ui-only 时代：`/hub` 唯一入口、世界纯数据面、
> Hub UI 唯一切换面、`?agent=<label>` demux、fusion transport 页面态原子）。
> 本 spec 取代上一轮讨论中与 0.1.5+ 地基冲突的所有条目（per-agent UI 拷贝、
> CTX7+ 远端 UI world、`/<label>/` URL path 寻址——均随 path-separation 裁决退役）。
> 关联：ADR 0002（superD-to-superD only）、ADR 0007（token→cookie mint）、
> **ADR 0009（本 spec 落档）**、**ADR 0011（邮局形态，2026-09-28 pivot 改形）**、blueprint §3.6/§6、
> orchestra openspec（agent-listing 窗口/状态语义先例）、dashr better-dsh `src/remote/`（BYO-PTY 借用源）。

---

## 0. 一句话定位

把单 hub（0.1.6）扩展为 **Machine Mesh**：多台对等机器、各自运行 super-dsh，
经 add-machine 配对后，本机 hub 以 **wire 形态 GatewayFace** 把远端 agent 接进
同一个原生 UI、同一个 roster、同一个数据面；在此地基上提供 **A2A 消息通道**
（content/task/role agnostic 的 messaging 层）与 **remote execution**（one-shot API
+ PTY over WS），远期在其上构建编排层（orchestration layer）。

## 1. 决策记录（本轮 brainstorming 裁决，全部 user 拍板）

| # | 决策 | 要点 |
|---|---|---|
| D1 | 机器对等（peer） | add machine 贴远端 token URL → mint cookie → 截留 cookie；cookie 即全权 consumer（与其原生 consumer 同权），不建新凭证体系 |
| D2 | 单向添加先行 | 反向添加（A 加 B 时经 add-machine API 把 A 反向登记给 B）留待后续策略讨论；API 形态先就位 |
| D3 | 寻址 = `m4-a6` | machine 4 位随机字符、agent 6 位随机字符、`<m4>-<a6>` 两级寻址；查表路由：本机 → 本机 world，远端 → wire 转发 |
| D4 | ID owner 铸造 + 传播 | 各机器自铸 machineId 持久化；agent ID 由 agent 归属 hub 铸造；peer 经 roster 探测**采纳 owner 的 ID**（全网同义，不搞本地重编号） |
| D5 | 本地 agent 保留原生名 | label（codex/omp/…）继续作显示与 `?agent=` 兼容别名；canonical key = a6 |
| D6 | 会话短 ID = 护栏查重 | **2026-09-28 R4 修订（post-office）**：conversationId 由**发起方随机铸造**（发起方在对端会话存在前就要铸造，不再截取 session id）；6 位起步、registry 查重碰撞加长 6→8→10；对端 verbatim 收养；wire 上永远全长 id。D18 agent_status 呈现层的「截断 sessionId」是另一概念 = 对原生 session id 的显示派生，与本条无关 |
| D7 | A2A = 消息通道心智 | content/task/role agnostic、对等透明、无 spawn 层级语义；`new_conversation`（可指定 title）≈ 表面上的 spawn sub-agent，实质是沟通渠道 |
| D8 | receipt 语义 | `send` 在 inbox-acceptance 即返 receipt（outcome: `injected\|queued\|failed` + messageId + 目标会话），不等待对端答案；答案事后自动投递（不走 user prompt 渠道） |
| D9 | 结果回投 = DSH subagent 同构 | user-role message + 自有 source kind（`a2a-relay`/form relay、`a2a-notice`/form notice），经 `ctx.agents` 的 followup（默认，非打断）/ steer（显式 delivery）/ inject（teardown 兜底）路由；投递即离队、仅失败进有界缓冲；工具描述写死 NEVER poll |
| D10 | delivery 渠道参数 | send 可指定 `delivery: 'queue'\|'steer'`（打断型=steer；默认 queue） |
| D11 | `stop` 方法本期就加 | 硬停：turn 级 cancel / session 级关闭运行时会话；session log 在即 resumable（等价 harness 崩溃重启）；权限/可见性约束留给编排层配置 |
| D12 | remote exec 双模式 | one-shot 走 API（`POST /api/superd/exec`）；仅 persistent 才走 WS PTY；PTY 字符解析照抄 better-dsh **BYO-PTY**（nonce-framing + parser + 会话状态机），远端不用 node-pty（宿主侧 `script -qfec` 手法） |
| D13 | 工具面单一 | 一个工具 **SuperD Hub**（id `superd-hub`），子能力按 call-shape dispatch；未实现腿返回 "not yet implemented" 占位 |
| D14 | 注入分阶段 | DSH 原生先行（与 hub 服务层同步开发，DSH 即自举测试 agent）；OMP/Pi per-spawn 增量插件、Claude Code 盘注入、Codex 机制调研随后 |
| D15 | UI 寄生 CTX0 不变 | 后端功能挂 CTX0 hub host 半边；无独立 hub UI 页面；机器/agent 呈现进现有 HubPage 与 switch |
| D16 | 邮局形态（2026-09-28 user 裁决，ADR 0011） | hub-to-hub 线上只做 `<m4>-<a6>` 寻址 + 不透明流量（A2A 信封/回信/通知，将来 PTY 帧与呈现流）；session-plane 业务逻辑与 session 同居（谁的会话谁 handling——同机同版本，兼容白拿）；呈现车道豁免（UI 消费远端数据只做呈现，corids slot 自愈吸收漂移，永不反推业务）。0.1.6-g 的 federated 直打远端 session plane（跨线 session/follow 完成捕获）退役改造；版本耦合点从 O(机对×runtime 版本) 收缩到 1（hub-to-hub 信封协议） |
| D17 | conversation title 概念剥离 | Super D 层自有 title，与上游 runtime session title 永不 write-through（异构：Hermes 可指定、OMP 可 mutable，开发权在上游，下版即可能变）；首次指定后 **immutable**（寻址恒走短 ID，title 只是记忆标签；话题变了开新会话）；未指定存占位 `[undefined]`（显示层可美化）；镜像行 verbatim 收养、双侧 immutable |
| D18 | roster 瘦 + session 状态采集（5min） | roster probe 载荷只带 machine 状态 + agent 行（a6/label/ready）——session 列表不进 probe 载荷（3-4 机 × 6-7 agent 即臃肿）；**5min sweep 顺便采集**每 agent 的 DSH session list 入本地 information status 缓存（本地 = 进程内 session plane；远端 = 呈现车道直查——DSH session list 数据面全网 unified 且 title 非空（空则默认 workspace 名），调取成本低）；**per-agent 状态查询消费缓存**（alive-first ≤5、mtime 倒序，orchestra 窗口语义）：行 = `{conversationId?, sessionId(截断), title, status, mtime}`——`conversationId` 有则显示、无则留空（无论何因）；**title 解析**：registry 命中（全长 sessionId join）→ conversation title 替换原生 title 并附 `[hub A2A]` 标记，未命中 → 原生 title 原样；替换为纯呈现层 overlay（落盘 persistence 里 hub 发起与原生发起同构，D17）；sessionId 数据面握全长、照常可 resume；呈现面标明 5min cadence + last-fetch，即时按 machine 显式 live fetch——全单向 API |
| D19 | 双向拓扑 = mutual pairing | 双向由双侧各自 add-machine 贴 token 达成（manual，机制零新增）；auto-reverse-registration（A 加 B 时反向登记给 B）仍留后续；D2 开放问题据此关闭 |

## 2. 术语

- **Machine**：一台运行 super-dsh（= DSH + super-dsh pack）的机器。`self` = 本机。对等关系，无中心。
- **machineId（m4）**：机器自铸并持久化的 4 位随机 ID（`[a-z0-9]`，36⁴≈168 万），全网唯一（owner 铸造 + 传播采纳）。
- **agentId（a6）**：agent 归属 hub 铸造的 6 位随机 ID（36⁶≈22 亿）。本地六 runtime + native 各一个，持久化。
- **地址**：`<m4>-<a6>`（如 `k3f9-q7m2xp`）。会话级寻址 = 地址 + 会话短 ID。
- **conversation**：A2A 的第二层 = 一个 agent runtime 的 session。统一用 DSH session id（所有 adapter 已映射为 DSH 会话；wire 永远全长）。**conversationId（短 ID）** = 发起方铸造的随机 6 位（registry 查重，碰撞 6→8→10 步进加长）——2026-09-28 两度修订：① 截首 8 位因 DSH id 固定前缀退化为常量（rig 实测 D2）；② post-office 改形后发起方在会话存在前铸造，不再派生自 session id（R4），存量行随重铸迁移。
- **wire gateway / RemoteGatewayFace**：实现 `GatewayFace {dispatchRpc, openWireStream}` 的 HTTP+WS 适配器，指向远端 `/hub` 家族；注册进现有 gateway 注册表后与本地 world 网关不可区分。
- **receipt**：send 的即时返回；`outcome: 'injected' | 'queued' | 'failed'`（沿 OMP hub 语义），failed 附"下一步调什么"的可执行错误文案。

## 3. 寻址与注册表

### 3.1 ID 铸造与传播

- **selfId**：首次需要时（探测应答 / 首次 add-machine）铸造，持久于
  `<dshHome>/superd/machines.json` 的 `self` 记录；此后永不变。
- **agent ID**：本地 agent 首次注册进 roster 时铸造，持久映射
  `<dshHome>/superd/agent-ids.json`（`label → a6`；含 `native`）。
- **远端 ID 采纳**：probe 远端 `/api/agent-runtime`（roster 响应含 `hub.machineId`
  与每个 agent 的 `id`），本地**原样采纳**写入机器行与路由表。碰撞处理：
  采纳时对 self + 已知远端查重，撞库（概率 ≈ 0.003% @10 台）fail-loud 报错，
  运维删除远端状态重铸（spec 接受此小规模粗糙度）。
- **alphabet**：`[a-z0-9]` 全集（不做易混淆字符剔除——ID 只做寻址键，辨识靠
  label/title；如后续人工抄录需求出现再收紧）。

### 3.2 路由表（单一查表，两级）

```
address m4 ──► machine table：self? ──► agent 表（a6 → 本地 world GatewayFace）
              └─ remote? ──► 该机器连接（cookie jar + RemoteGatewayFace）→ 远端 /hub
```

- 本地/远端**透明镜像**：UI、switch、A2A、exec 的消费面只认 gateway 注册表，
  不感知目标在哪台机器。
- `?agent=` demux 兼容双键：本地接受 label 别名（codex/omp/…）与 a6；
  远端 agent 一律 a6（label 仅显示）。switch 预检（C1 门）照常工作，
  额外叠加机器可达性。

### 3.3 持久化（全部 `<dshHome>/superd/`，0600，原子写）

| 文件 | 内容 |
|---|---|
| `machines.json` | `{self: {id, label}, remotes: [{id, name, label, origin, token, cookie?, enabled, addedAt}]}`（cookie 随 mint/re-mint 持久化——hub 自身重启不重贴 token，spec §4） |
| `agent-ids.json` | `{ [label]: a6 }`（本地 agent） |
| `a2a-conversations.json` | conversation 注册表（P3）：短 ID ↔ 全长 session id + {machine, agent, title, createdAt, lastActivityAt} |

token 存明文本地文件（0600、用户 home 内）——与 cookie 本身同敏感级；
升级到 credentials store 留作 open question。

## 4. 信任与认证模型

- **配对 = 全权 consumer**：add-machine 贴远端 token URL → hub 服务端
  `GET <origin>/?token=…`（303 + Set-Cookie `dsh-auth-*`，HMAC 签名密钥持久于
  远端 credentials store ⇒ cookie 默认 30 天跨远端重启有效）→ cookie 截留为
  该机器的请求凭证。此后一切 hub-to-hub 调用（roster 探测、envelope 转发、
  mux upgrade、exec、A2A relay）自动附带。
- token 仅在①首次配置②cookie 过期/换 authority 时需要；远端重启**不需要**重贴。
- 401 时自动以存量 token 重铸一次；重铸失败 → 机器行 `auth-expired`，
  UI 提示重贴 token URL。
- **单向添加**（D2）：本机持有远端 cookie ≠ 远端知道本机。反向添加留待讨论。
- 出站请求不带浏览器 Origin（服务端发起，Host 即远端 authority，天然过
  browser-trust 栅栏）。
- ~~前置代理 gate（可选 per-machine `gateUrl`）~~ → **撤回（2026-09-28 user 裁决）**：
  不为反代 gate 特殊情况做产品面——同种认证出现两次（hub token + 反代 gate）属
  部署错误而非产品需求，正确解法是拆掉多余的那层（dev3 Caddy gate 已删，
  `Caddyfile.bak.2026-09-28_gate-removal` 备份）。配对只走 token URL。
- exec 额外旋钮：per-machine `execEnabled`（默认 true）+ 审计事件（§9）。

## 5. 架构总览（全部挂 CTX0 hub host 半边，D15）

```
浏览器（唯一 UI = 原生 DSH UI + Hub 组件，单一认证域）
   │  /api（native）· /hub/api?agent=…（foreign，envelope + WS mux）· /api/superd/*（mesh 自有）
   ▼
CTX0 hub
 ├─ 机器注册表 + 持久化（machines.json / agent-ids.json）
 ├─ 连接管理（per-machine cookie jar + mint + probe + 健康状态）
 ├─ Gateway 注册表（现有）+= RemoteGatewayFace（per 远端 agent）
 ├─ Roster 聚合（本地 world + 各远端 roster → machines 分组 + a6）
 ├─ A2A 服务（信封协议：ingest / send / 回信路由 + receipt + conversation 注册表；session-plane 只碰本机——D16/ADR 0011）
 ├─ SuperD Hub 工具（ctx0 tools 服务注册，单工具 call-shape dispatch）
 └─ Exec 端点（POST /api/superd/exec one-shot；upgrade PTY WS）
        │ wire（cookie 随行）——只运不透明载荷：A2A 信封/回信、呈现流、（P4）PTY 帧
        ▼
远端 hub（同构 super-dsh）：/api/superd/a2a 信封 ingest；/hub 家族 envelope/mux（呈现车道）；/api/superd/* mesh 自有面
```

- **远端 agent 零本地容器**：不需要 CTX spawn、不需要 UI world——原生 UI 经
  `/hub?agent=<a6>` 直接消费远端数据面（0.1.6 地基的直接推论）。
- 世界（CTX1-6）保持纯数据面不变；本地 agent 与远端 agent 在注册表里同型。

## 6. Hub-to-hub 数据面（P2）

### 6.1 RemoteGatewayFace

- `dispatchRpc(endpoint, payload, signal)`：
  `POST <origin>/hub/api?agent=<label>`，body = 标准 client-request envelope
  （`envelope.ts` 现有形状），Cookie 随行；应答 envelope 原样返回。
- `openWireStream(endpoint, payload, …)`：
  WS 连 `<origin>/hub/api/remote.mux?agent=<label>`，帧协议 = `world-mux.ts`
  文档的 client 半边（`open/item/end/cancel` ↔ `item/end/error`，心跳 2s，
  uplink inbox 256KiB 语义对齐）。多逻辑流复用一条 per-(machine,agent) WS。
- 连接生命周期：懒建立（首个请求触发）、空闲回收（可配）、断线重建
  （in-flight 流以 wire error 结束；上层会话流 UI 自动重连语义照常）。
- 版本握手：roster 探测应答携带 `hub: {machineId, version}`；本机版本差异
  超兼容窗（super-dsh 不同 minor）→ 机器行标 `version-mismatch` 告警不阻断。

### 6.2 Roster 响应扩展（加性，双向同形）

`GET /api/agent-runtime` 应答在现有 `{available, agents}` 之上增加：

```jsonc
{
  "hub": { "machineId": "k3f9", "version": "0.1.6" },   // 本机自述
  "agents": [ /* 现有字段 */ { "key": "codex", "label": "Codex", "id": "q7m2xp",
                "ready": true, "failed": false, "machine": "k3f9" } ]
}
```

旧客户端忽略新字段；新字段是 mesh 的全部"发现协议"。

### 6.3 健康与降级

- 探测时机：add-machine 时、手动 reprobe、switch 预检可触发轻探、周期兜底（默认 5min，可配）。
- 机器不可达 → 该机全部 agent 行降级 `unreachable`（roster 保留，orchestra
  reachability 语义）；switch 预检 toast 报机器错误。
- 远端 roster 变更（agent 增删）在下一次探测收敛；不做推送（open question：常驻 WS 控制通道）。
- 呈现契约（D18）：machines/roster 面明示「每 5 分钟自动刷新」+ last-fetch 时间戳；5min sweep 同时采集各 agent 的 DSH session list 入 information status 缓存（呈现车道，载荷不进 roster probe）；需要即时状态按 machine 显式 live fetch（现有手动 reprobe op 露出）——单向 API，无推送。

## 7. A2A 服务（P3）

### 7.1 思维模型

两层：**agent**（a6 寻址）→ **conversation**（= 一个 runtime session，短 ID 寻址）。
系统不关心 content/task/role/层级——只要有地址就投递；所有 agent 对等。
用户场景：PC agent 查 roster 发现 dev3 上正在跑的 conversation → 直接 send
介入/提醒/追问；这就是通用沟通平台（后续 DND、陌生人策略、编排层全部
在此地基上生长）。

### 7.2 方法集（SuperD Hub 工具的 a2a 部分）

- **`agents`**（无参或 `{machine?}`）：瘦 roster——machines → agents（a6/label/
  ready/status），不含 session 列表（D18）。
- **`agent_status`** `{agent: '<m4>-<a6>'}`（per-agent 状态查询，D18）：读 5min
  sweep 采集的 information status 缓存（可显式即时刷新）。窗口 alive-first、
  ≤5、mtime 倒序（orchestra 语义——不在窗口 ≠ 任何状态暗示）。行 =
  `{conversationId?, sessionId, title, status, mtime}`：`conversationId` 有则
  显示、无则留空（无论何因）；`sessionId` = DSH 原生 id 剥前缀截 uuid 头
  几位（呈现用；数据面握全长 id，照常可 resume）；**title** = registry 命中
  （全长 sessionId join）→ conversation title + `[hub A2A]` 标记（替换原生
  session title），未命中 → 原生 title 原样（DSH title 非空：空则默认
  workspace 名）。替换是**纯呈现层 overlay**——落盘 session persistence 里
  hub 发起与原生发起同构（D17 不 write-through）。数据源：本地 agent =
  进程内 session plane；远端 agent = 呈现车道直查对端 session list（unified
  数据面，零新信封——D16 呈现豁免内，与 Web UI 浏览远端会话同一车道）。
- **`new_conversation`** `{agent: '<m4>-<a6>', title}`：new-conversation 信封投给
  目标机器的 a2a ingest（本地 = 同一协议进程内短路；远端 = wire）→ **对端本机**
  建会话 + 注入教学信封 → 回执 `{conversationId (短 ID), sessionId, agent,
  machine}`。title 只写双方 registry 行（D17：immutable、`[undefined]` 占位，
  不 write-through 上游 session title）。
- **`send`** `{agent, conversationId?, title?, message, delivery?: 'queue'|'steer'}`：
  同一 ingest 通道投 message 信封 → 对端 resolve conversation（命中 → resume +
  注入；无 conversationId → 按新会话处理）→ inbox-acceptance 即返 receipt
  `{outcome: 'injected'|'queued'|'failed', messageId, conversationId, sessionId}`。
  发起方零 session-plane 调用（D16）。教学信封（E3 措辞）：正常作答即自动回投；
  对端也有 superd-hub 工具时可用 conversationId 续聊（镜像行兑得现）。
- **`read`** `{conversationId?}`：未读清扫兜底（auto-delivery 为主通道，
  工具描述明示 NEVER poll）。
- **`stop`** `{agent, conversationId, scope: 'turn'|'session'}`：turn 级 = cancel
  当前 turn（等价 UI 停止按钮）；session 级 = 关闭/停掉运行时会话（硬停，
  log 在即 resumable——D11）。权限约束（谁能 kill 谁）留给编排层配置。

### 7.3 投递与回投

- **向目标投递（在对端机器上执行）**：对端 hub 的 a2a ingest 收信封 → 在它本机
  create-or-resume + 注入 user turn（A2A 会话天然出现在目标 agent 的正常会话
  列表里，用户可旁观）。路由规则不变、执行位置在对端：目标 session idle/busy
  → `followup`（非打断；peer 语义，steer 留给显式 delivery）；teardown →
  `inject`（落盘不唤醒）。
- **向发起方回投（D16 改形：对端完成捕获）**：对端 hub 订阅**它本机** session
  的完成事件（同机同版本，无跨线解析），抽取最终 assistant 文本 → **回信信封**
  发回发起方 hub → 发起方构造 user-role message，source kind 自有声明：
  - `a2a-relay` / form `relay`：对端 agent 的回复正文（前缀 "Agent <addr> replied:"）。
  - `a2a-notice` / form `notice`：投递状态类事件（失败通知、stop 确认等，
    summary ≤120 字符，UI 折叠行）。
  发起方路由（DSH subagent `notifySettlement` 同构）：发起 session idle →
  `followup`（新 turn）；busy → `followup`；teardown → `inject`（落盘不唤醒）。
  持久性白拿：inbox 事件 + session log。回信投递失败进**对端**有界待发缓冲，
  随下次接触重投（对称于发起方 unread buffer）。
- **registry 双侧**：发起方持行（发起 session 上下文 + shortId）；对端持镜像行
  （peer 地址 + 本机 session）。shortId 由发起方铸造、信封携带、对端原样收养
  ——信封的 conversationId 续聊条款处处兑得现。
- **`stop` 信封**：对端取消它本机 session 的 turn（session 级仍按 D11 降级语义：
  上游无 session-close RPC，如实报 scope）。
- **no-double-delivery**：投递成功即出队；只有 failed 进有界未读缓冲
  （计数供 `read`/徽标）。
- 发起方身份信封：`{machine: selfM4, agent: 发起 agent a6, session: 发起会话全长
  id（D6：wire 永远全长）, messageId}`——跨机时对端 hub 收到同一信封（续聊走
  conversationId，replyTo 退役）。

### 7.4 与上游参照的对应

DSH sub-agent 的 receipt（inbox-acceptance 即返）+ steer/followup/inject 路由
+ `agent-message`/`subagent-settled` 的 kind/form 二轴 = 本设计的回投骨架；
OMP hub 的 outcome 枚举 / no-double-delivery / auto-delivery+wait 哲学 /
incoming 信封教学 = receipt 与对端体验语义；orchestra agent-listing =
per-agent 状态查询的窗口/状态语义（D18）。experimental agent-team 的 durable mailbox 仅作远期参照。

## 8. Remote Execution（P4）

### 8.1 one-shot（API）

`POST /api/superd/exec`（fence + cookie 门）：

```jsonc
// req
{ "cmd": "git -C /srv/app pull", "cwd": "/tmp", "timeoutSec": 120 }
// res
{ "exit": 0, "stdout": "…(tail 30k)", "stderr": "…", "durationMs": 812,
  "truncated": false, "timedOut": false }
```

远端 `bash -lc <cmd>` 一次执行；输出尾窗 30k、硬上限 ring 4M（better-dash
教训）；超时 SIGTERM→SIGKILL 组杀。

### 8.2 PTY（WS）

`GET /api/superd/exec` upgrade → PTY WS（二进制帧 = stdio 字节；JSON 控制
帧 = start/resize/signal/exit）。

- **本地侧**：better-dash `src/remote/` 的 `nonce-framing.ts`（`{\n…\n}` 复合
  包裹 + OSC-133;D nonce 帧 + 解析器 holdback/flush）、PtySession 状态机
  （两段式中断：`\x03` + 注入 130 帧 + 3s 宽限 + 组杀；init 30s；idle TTL
  600s；OUTPUT_HARD_CAP）**原样照抄**，通道接口 `{write, onData, kill}`
  的实现从子进程换成 WS。
- **远端侧**（哑执行器，~百行）：收到 start → `script -qfec bash /dev/null`
  （宿主侧 PTY，无 node-pty）或 pipes 模式 → 双向泵到 WS；exit 帧回传。
- 会话键 = `(发起 agent a6, machine m4)`；**per-agent 直连**，无中心分配
  （D12：哪个 agent 要 PTY 就给哪个接一条）。
- 审计：每次 start/stop 记 hub 侧事件（cmd、agent、machine、时长）。

## 9. SuperD Hub 工具面（单工具，D13/D14）

- 注册：ctx0 `ctx.inject(['tools'])` + `tools.register(...)`（better-dash
  `plugin.ts` 同款行模式；无 tools 服务时静默不挂）。
- 名称：`superd-hub`，显示 "SuperD Hub"。call-shape dispatch：
  `{}`/`{action:'agents'}` → roster+conversations；`{action:'new_conversation'…}`
  / `{action:'send'…}` / `{action:'read'…}` / `{action:'stop'…}` /
  `{action:'exec', mode:'oneshot'|'pty'…}`。未实现腿返回
  `"not yet implemented: <leg>"`（占位纪律）。
- 描述文案要点（写给模型）：地址格式与查表规则；NEVER poll（结果自动送达）；
  stop 的硬停语义与 resumable；exec 的 one-shot vs persistent 选择指引。

## 10. 注入分阶段（P5）

| runtime | 机制 | 状态 |
|---|---|---|
| DSH 原生 | ctx0 tools 服务注册 | P3 交付 |
| OMP / Pi | per-spawn 增量插件（hub 保留插件体，spawn 时动态挂载） | P5 spike（机制验证先行） |
| Claude Code | 盘注入：插件写入本地 `~/.claude` 插件 path 目录 | P5 |
| Codex | 机制调研（app-server 面 hooks/工具扩展点） | P5 调研 |
| Hermes / agy | 后排 | P5+ |

## 11. 错误与降级汇总

| 情形 | 行为 |
|---|---|
| 机器不可达 | roster 降级 `unreachable`；switch/tool 报机器级错误；不熔断注册表 |
| cookie 过期 | 自动重铸（存量 token）；失败 → `auth-expired` + UI 重贴提示 |
| 版本不匹配 | `version-mismatch` 告警，不阻断（数据面 envelope/mux 由 dsh pin 窗背书） |
| 远端 agent 消失 | 下轮探测收敛；A2A 寻址 fail-loud（`unknown-agent`，带地址） |
| conversation 碰撞（短 ID） | 插入时查重步进加长（6→8→10，2026-09-28 修订） |
| WS 断线 | in-flight 流 wire error 结束；UI 自动重连；A2A 回投 = 对端回信信封（D16）——断线期间对端回信入有界待发缓冲，重连即投 |
| exec 超时 | 两段式中断 + 组杀；结果标 `timedOut` |

## 12. 与核心不变量的关系

- S1（per-request 寻址）：保持——`?agent=` demux 本就 per-request；wire 转发不引入选择态。
- S2（roster = 插件投影）：扩展——本地仍插件投影 + a6；远端 = 探测采纳的镜像行（来源标注，非配置文件驱动）。
- S4（零端口/单认证域）：浏览器侧不变（唯一 origin = 本机 ctx0）；hub-to-hub 出站 wire = **ADR 0009 认可的例外**（targets.ts 既定预言："out-of-process target implements the same GatewayFace over the wire"）。
- S6（router 哑）：wire 转发层同为哑管道，零会话状态（除 conversation 注册表——属 hub 自有持久层，非 router 状态）。
- "hub 只提供机制"（dev-rules §12）：mesh/A2A/exec 是 hub 级机制（对等、跨 agent），不上提任何 per-agent 定制——合规。

## 13. 测试与验收

- **单元**（node --test，先 build 后测）：ID 铸造/查重、注册表持久化（原子写/损坏降级）、mint+probe（本地 http fixture 模拟远端 mint 303 + roster）、roster 扩展字段、A2A receipt/回投路由（fake agents）、exec 解析器（借 better-dash 用例）。
- **自环 rig**：4999 pack 线把**自己**当远端添加（token URL 指向本实例 origin）——全 wire 链路（mint → probe → 采纳自己 m4/a6 → 远端 agent 出现在 switch → 经 wire 建会话收发）无 dev3 可测。
- **dev3 实装**（§〇.0.a 红线）：tarball `add file:` → restart → journalctl `world failed` 0 + mesh 探针（add PC → roster 聚合 → 双向会话）。
- 验收 = 运行时行为（真实 create+prompt+回投往返），非进程活性；报告落 `docs/test-reports/`，user 放行后进入下一 phase。

## 14. 分阶段路线

| Phase | 交付 | 验收标志 |
|---|---|---|
| **P1 Machine Mesh 地基** | 机器注册表 + 持久化；add-machine API（mint+probe+采纳）；HubPage machines 接真 API；agent a6 + roster 扩展 | 自环：curl add self → probe reachable → roster 含 hub.machineId 与 a6 |
| **P2 Remote gateways** | RemoteGatewayFace（envelope+mux client）；gateway 注册表接入；roster 联邦 + 降级 | 自环：自己作为"远端" agent 经 wire 出现在 switch，建会话+收发一轮 |
| **P3 A2A + 工具面** | conversation 层、send/receipt/回投（信封协议，D16）、read、stop、per-agent 状态查询（D18）；SuperD Hub 工具（DSH 原生注入） | DSH agent 工具调用：agents → new_conversation → send → 答案自动回投；stop 生效且 resumable |
| **P4 Remote execution** | one-shot API + PTY WS + BYO-PTY 移植 | 自环 exec one-shot 与 PTY 会话（多行命令、超时中断）全绿 |
| **P5 注入扩展** | OMP/Pi per-spawn、Claude 盘注入、Codex 调研 | 各 runtime 内以第一人称调用工具完成一次 send |
| **P6+ 编排层** | A2A seam 之上：DAG、executor/reviewer 角色、可见性/kill 权限、审计评分 | 另立 spec |

每 Phase 独立 spec→plan→实现循环；本 spec 为总纲，P1 实现计划另见
`docs/superpowers/plans/2026-09-27-machine-mesh-p1.md`。

## 15. 开放问题

1. ~~反向添加策略（D2）~~ → **已裁决关闭（2026-09-28 user，D19）**：双向 = mutual pairing（双侧各自贴 token）；回投改形（D16）后亦不依赖发起方跨线订阅；auto-reverse-registration 留后续策略讨论。
2. ~~常驻 hub-to-hub WS 控制通道（roster 变更推送、A2A 事件推送）vs 现行轮询/订阅混合——P3 后评估~~ → **已裁决关闭（2026-09-27 user）**：状态更新走单向 API + 5 分钟周期轮询即可，不做 WebSocket 控制通道（太重）。（2026-09-28 D16 注：回投已改形为对端回信信封，更无跨线会话流订阅。）
3. token 迁移 credentials store。
4. `stop` session 级在 foreign runtime 上的确切语义映射（各 adapter 的 close/dispose 面）——P3 落地时按 adapter 记录。
5. alphabet 是否剔除易混淆字符（出现人工抄录需求再议）。
6. 编排层（P6）独立 brainstorming。
7. ~~per-agent 状态查询的 title 呈现~~ → **已裁决关闭（2026-09-28 user）**：title = registry 命中 → conversation title + `[hub A2A]` 标记替换原生 session title；未命中 → 原生 title（DSH title 非空，空则默认 workspace 名）。纯呈现层 overlay，落盘 persistence 同构（D17）；数据源 = unified session list 数据面（呈现车道直查，零新信封）。
