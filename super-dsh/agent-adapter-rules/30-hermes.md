# agent-hermes 沉淀（机制事实 · 事故链 · 已知缝）

## 版本基线

| 项 | 基线 |
|---|---|
| DSH peer | `>=0.2.0-0 <1.0.0-0` |
| hermes 部署形态 | 常驻 gateway（`hermes-gateway.service`）独占 `~/.hermes`（PC pid 256084 / dev3 同款 service） |
| adapter 传输 | **`auto`（0.3.4-c 起默认）**：首 spawn stdio，命中 gateway 所有权拒绝即进程级粘性翻 attach；`stdio`/`attach` 为锁定值。选择序 = 进程 env `SUPERD_HERMES_TRANSPORT` > 原生 `~/.hermes/.env` 同名键 > auto |
| 上次全绿 | 2026-11-02，0.3.4-c（4999 create 面 + dev3 resume 面，真实 UI；报告 `docs/test-reports/2026-11-02-hermes-auto-attach.md`） |

## 机制事实

- **上游进程所有权模型**：hermes 以 resident gateway 持有 `~/.hermes`；常驻 gateway 在跑时，任何独立 stdio spawn 被 hermes 自己拒绝：`[gateway-exit] refused: /home/u1/.hermes is owned by a running gateway; attach to it instead`。attach 是**上游自己支持的官方路径**（`hermes_cli.gateway_client.connect_gateway`：接到运行中的 owner，没有则自起一个 idle-exit 的）。
- **WS-attach bridge**（`agent-hermes/bridge/hermes-ws-bridge.py`）：对 adapter 保持 stdio ndjson JSON-RPC 契约不变，帧转译到 gateway canonical WebSocket。v2 转译：`session.create` 剥 `cols`；`prompt.submit` 注入 `submission_id` 并把 AdmissionStatus receipt 转成 `{"status":"streaming","receipt":…}`；`session.steer` / `session.interrupt` 注入 `execution_generation`（从 live event frame **顶层**字段追踪，不是 payload）；`approval.respond` 精确集合 `{session_id, execution_generation, prompt_id, choice}`。authority 参数模型 `extra="forbid"`（多余键 → 4001）。
- **auto-attach（0.3.4-c，G5 收口）**：拒绝签名 `/owned by a running gateway/i` 在 stderr 行与 spawn 失败文本两处探测；翻转后进程内所有后续 client 首次 spawn 直接 attach。翻转消耗在 `HERMES_SPAWN_ATTEMPTS`(3) 预算内，用户不可见。回归测试 `test/auto-attach.test.mjs`。
- **诚实降级面**：`session.usage/status/compress/close` 在 authority 路径 -32601 unknown。
- 会话日志修复工具与 sweep 在 `~/hermes-repair-20261102/`（PC 与 dev3 各一份；real-reader 驱动 clone+remap）。

## 事故记录

### 2026-11-02 回合全灭 + 坏 log 卡新会话 + notice 存不上（三层叠加）
- 触发：PC 与 dev3 都在跑常驻 hermes gateway；adapter 默认 stdio spawn。
- 签名：① 一切回合 GATEWAY_CRASH，新会话首回复被拒（E1）；② 回放 Session unavailable，新建会话流程被坏档卡死，每个 failed turn 再产新坏档（PC 6 档 + dev3 6 档，zstd v4：裸 `turn/end`、无生命周期 `tool/call`）；③ Preview Notice 弹出且 "acknowledgement could not be saved"（重试同样失败）。
- 根因：① G5——上游 gateway 独占 home，stdio spawn 被拒；② G2——被拒中断的 turn 留下违反 v4 不变量的日志；③ G3——world 组合缺 CTX0 `ui-settings-general` ack 行，值从 composition 投影、写永远无法回读反映（结构性，与浏览器 / 重试无关）。
- 修复：① 0.3.4-c auto-attach（见上）——事故期间的手动 lever 已全部退役（dev3 `.env` lever 注释、4999 drop-in 改 auto；PC prod lever 待其升级 0.3.4-c 后可退役）；② 12 档 clone+remap 修复，复扫全绿；③ 0.3.4-b `world-provision.ts` 镜像 CTX0 ack 行（`149add6`）。E2 误导报错同步修（resume 无 durable id 且无 content → 诚实报 gateway 失败前未建会）。
- 回归探针：`test/auto-attach.test.mjs` + `.scratch/hermes-bridge-v2/probe.mjs`（stdio 驱动 bridge 验证转译形状）；log sweep 复扫；真实 UI 新会话逐字回复 + reload 恢复。

## 已知开放缝（升级后优先重测）

1. **notice-ack 窗口**：world spawn 后若上游升 notice 版本，下次 respawn 前的世界会弹且存不上（重启 / 重新 apply 自愈）。
2. **writer 错误路径 closer（G2 待办）**：存量坏档已修，但 writer 在 turn 崩溃路径的 closer 补齐未在代码层验证。
3. bridge 诊断：`[bridge-ctl] <method> injected_gen=… tracked=…` stderr 行可作转译回归的快速观测点。
