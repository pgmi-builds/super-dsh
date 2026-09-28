# Machine Mesh P3-Rework — Post-Office 形态改造（2026-09-28）

> 性质：executing plan（ADR 0011 + spec D16–D19 的实现序列）。
> 基线：worktree `mesh-p1` @ `412068d`（0.1.6-g 代码 + 本日 docs 提交）；suite 基线 **373/0/0**。
> 纪律：**严格串行**，R0→R7 一任务一 commit，每任务先测后码；R8 收尾验收。
> 每任务完成即更新本目录 `progress.md`（SDD ledger）。

## 不变量（违者即缺陷）

1. hub-to-hub 线上只跑 `<m4>-<a6>` 寻址 + 不透明载荷（信封/回信/通知）。
2. session-plane 业务逻辑与 session 同居：ingest 侧在本机 create/resume/注入/完成捕获。
3. 呈现车道豁免（session list 直查、UI 自愈）；永不反推业务逻辑。
4. 本地 = 同一协议的进程内短路；远端 = 同一协议上线（协议同形，local 测试即 wire 测形）。

## 契约要点（实现不得偏离）

- **信封（wire v1）**：外层 `{v: 1, envelope}`。请求向：
  - `{kind:'new-conversation', to:{machine,id}, conversationId(发起方铸造的 shortId), title('[undefined]' 占位), message, from:{machine, agent, sessionId(全长,D6)}, messageId, delivery?}`
  - `{kind:'message', to, conversationId, message, from, messageId, delivery?}`
  - `{kind:'stop', to, conversationId, scope:'turn'|'session'}`
  回信向（对端→发起方）：
  - `{kind:'reply', to:{machine,agent,sessionId(全长)}, conversation(shortId), text, messageId}`
  - `{kind:'notice', to, conversation, summary(≤120), messageId}`
- **端点**：`POST /api/superd/a2a`（fence + cookie 门）body=信封 → receipt（new/message：`{outcome,messageId,conversationId,sessionId}`；stop：`{stopped,scope,reason?}`）。
  `GET /api/superd/a2a/outbox?machine=<m4>` → 取走并清空发往该机的缓冲信封（信任模型内声明式认领，D1 全权 consumer）。
- **registry 双侧同形**：`ConversationRow` 不改结构——发起方行指向对端 `{machine:对端m4, agent:对端a6, sessionId:对端会话}`；镜像行指向发起方 `{machine:发起方m4, …, sessionId:本机会话}`。shortId 发起方铸造、信封携带、对端原样收养（撞库时对端 fail-loud 拒收）。
- **title（D17）**：registry-only，首次即 immutable；未指定存 `'[undefined]'`；**A2A 路径零 session/rename 调用**；镜像行 verbatim。
- **回投（D16）**：ingest 侧本机 subscribeCompletion → 完成 → `reply` 信封（abort 且无文本 → `notice`，D3 语义保留）。路由：`from.machine === self` → 进程内直达 a2a-delivery；machines.json 有行 → POST；否则入有界 outbox（≤32，持久 `a2a-outbox.json`），flush 时机 = 路由出现 / sweep 顺带 pull。
- **agent_status（D18 修订版）**：5min sweep 采集每 agent DSH session list 入 information-status 缓存（本地进程内 / 远端呈现车道直查）；查询消费缓存：行 `{conversationId?, sessionId(截断), title, status, mtime}`——registry 全长 join 命中 → conversationId=shortId、title=`{conversationTitle} [hub A2A]`；未命中 → conversationId 留空、title=原生（非空，空则已默认 workspace 名）；status 诚实 `unknown` 回退；alive-first ≤5、mtime 倒序。

## 任务板

### R0 — spawnWorld 扫描守卫（cosmetic）
`spawn-world.ts` 的 host-table 发布扫描对 `<profile>/node_modules/@pgmi-builds` 先 `existsSync`；dsh-base 无 farm 世界不再打 ENOENT 噪音。验收：spawn-world 测试绿且 stderr 无 "host table publishing failed"。

### R1 — `a2a-wire.ts` 信封协议模块（纯函数）
类型 + 守卫 + wire 收发 helpers（POST 封装、cookie 随行、错误映射到 A2aAddressError 分类）。测试：合法/非法形状穷举、notice ≤120、`'[undefined]'` 占位、v1 外层。

### R2 — title 语义进 service（D17）
create 路径：指定 → 存；未指定 → `'[undefined]'`；后续任何写路径拒绝改 title。**删除 A2A create 的 session/rename 写通**（fake gateway 断言零 rename 调用）。信封携带 title。

### R3 — ingest 处理器 + 端点（对端执行侧）
`a2a-ingest.ts` + mesh-rpc 挂 `POST /api/superd/a2a`、`GET .../outbox`。resolve 本地目标（a2a-host 本机腿）→ create-or-resume（镜像行收养）→ 注入教学信封（renderA2aEnvelope，initiator=from）→ 本机完成捕获 → 回信信封路由（self 直达 / 有行 POST / outbox）。测试：本机新会话+注入+镜像行；完成 → 进程内回投；outbox 入/取/清。

### R4 — 发起侧改道（send/new_conversation/stop 全走信封）
a2a-service：目标机 = self → 进程内调 ingest；否则 wire POST。删除 federated session-plane 直达与跨线 follow（subscribeCompletion 收缩为本机专用）。hub-tool 腿签名不动。测试：本地地址经统一 ingest 路径往返（协议同形证据）；http fixture 远端 → 信封可观察、receipt 映射；stop 信封。

### R5 — sweep 双职责（D18 采集 + outbox pull）
mesh-link sweep：每远端 probe 后 (a) `GET outbox?machine=self` 回信入本地投递；(b) 采集该机各 agent session list（呈现车道）入 `agent-status` 缓存；本地 agent 同步入缓存。缓存行 `{machine, agent, rows:[{sessionId,title,mtime,status}], collectedAt}`。测试：fake 远端 → 缓存/回投两腿。

### R6 — hub-tool：agents 剥离 + `agent_status` 腿
agentsListing 去 conversations；新增 `agent_status {agent}` 消费缓存，按契约要点塑行，响应带 collectedAt。工具描述/schema 同步（agents 文案去 conversations；agent_status 加腿）。

### R7 — client 半边（最小）
mesh-api：last-fetch 时间戳 + per-machine live fetch op 暴露（复用 reprobe）；UI 面标「每 5 分钟自动刷新」+ 时间戳。client lane 纪律照旧（纯逻辑 headless 可测）。

### R8 — Rig + dev3 mutual pairing 实证（§〇.0.a 红线）
4999 pack 线自环（self-add → 双向信封往返）→ dev3 ↔ PC 双贴 token → dev3 agent 向 `79he-<a6>` send → 回信回流 → stop；agent_status 带 `[hub A2A]` 标记核验。报告落 `docs/test-reports/`，user 放行前不合并。
