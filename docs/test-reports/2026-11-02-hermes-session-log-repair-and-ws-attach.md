# 2026-11-02 — pc 双线 hermes 会话档损坏修复（15 档）+ agent-hermes 写侧竞态修复 + WS-attach 桥（v1）

执行者：pc 生产 dsh 内 default agent（session-aa117ff65d85…），2026-11-02 02:32–04:55 +0800。
现场：**pc** prod dsh `@deepseek-ai/dsh@0.2.2-alpha.2`（3080，`~/.dsh`）+ test.pc 4999 pack 线（`.tests/superd`，profile `superd-pub`）；两线都挂 superd hub hermes。

---

## 0. 一句话结论

hermes（及其它 adapter）在两线「New session 失败」的直接原因是 **15 个 corrupt v4 会话档**（prod 9 + test 6），已全部按 2026-10-04 工艺修复并用**真实 reader 逐档验收**（备份保留）。写侧根因实锤：**agent-hermes 的 reserved-turn 竞态**——gateway 子进程在 `turn/start` 落档前死掉时，`client.onFailure → #fail → #closeTurn` 抢在冷启动 catch 之前关回合，写出**无 `turn/start` 的裸 `turn/end`**（v4 校验 fail-closed）。hermes 是八 adapter 家族里唯一没带 `turnCommitted` 守卫的，已补齐 + 回归测试（139/139 绿）。

hermes 当前提示词全灭的**触发器**是另一件事：本机常驻 hermes gateway（`hermes-gateway.service`，pid 256084，持有 `~/.hermes`），adapter 每次 stdio spawn 都被拒（`[gateway-exit] refused: … owned by a running gateway; attach to it instead`）。本次交付了 **WS-attach 桥**（ attaches 常驻 gateway 的 canonical WebSocket，或自起 idle-exit daemon）：连接、`gateway.ready`、`session.create` 已实测打通；**`prompt` → `prompt.submit` 等回合面映射未完成**，故默认传输仍是 stdio，桥随包下发但惰性——完成映射的会话再启用（见 §5）。

---

## 1. 损坏清单与修复（两 home 全 sweep：v4 174 档 → 174 OK）

修复工艺 = 2026-10-04 报告同款：真实 reader 驱动的迭代修复、最小帧编辑、seq 稠密重编号 + 引用修正（messageSeqs / surfaceOp / sourceEventSeqs / headerSeq）、multiframe zstd（每行一帧，首帧恰为 header 行）、候选先过**真实 validator**（`decodeStoredLog` 内存验收）再落盘、原档 `.corrupt-bak-20261102` 备份、原子 mv、落盘后 `readStoredLog` 复验。工作台：`pc` `~/workspaces/superd/.scratch/hermes-repair-20261102/`（sweep/repair/dump 脚本 + `sweep-result.txt`）。

| # | home | agent | session | 病灶 | 修法 |
|---|---|---|---|---|---|
| 1 | ~/.dsh | hermes | a77f1f3f（superd） | 裸 `turn/end{turn:1}`（gateway-exit） | 插 `turn/start` |
| 2 | ~/.dsh | hermes | 875b9bb2（superd） | 同上 | 插 `turn/start` |
| 3 | ~/.dsh | hermes | 50dea348（base） | 同上（turn 2） | 插 `turn/start` |
| 4 | ~/.dsh | hermes | 6b618484（base） | 同上（turn 2） | 插 `turn/start` |
| 5 | .tests | hermes | 6e51a710（base） | 同上（turn 2，追加在旧健康档尾） | 插 `turn/start` |
| 6 | .tests | hermes | e9436d52（base） | 同上（turn 1） | 插 `turn/start` |
| 7 | .tests | pi | 763ee69d（superd） | `turn/end` 带未关 step（reserved 窗口竞态变体） | 插 `step/end` |
| 8 | .tests | omp | 5030ee77（superd） | turn 1 未关就 `turn/start{turn:2}` | 插 `turn/end{turn:1}` |
| 9 | .tests | claude | 21a9d9ba（superd） | turn 关闭后 trailing `assistant/message` | 删孤儿帧 |
| 10 | .tests | agy | 6e04fae9（Energy-Intel） | 重试同 callId 双 call/双 result + 未决 call | 48 处：删重复帧 / 补 `tool/result`（含官方 TOOL_NOT_STARTED 形） |
| 11 | ~/.dsh | agy | 77f833a6（base） | 同族 | 9 处 |
| 12 | ~/.dsh | agy | 9ec8e1ac（superd） | 同族（221 帧） | 65 处 |
| 13 | ~/.dsh | codex | 4a0705dd（superd） | 双 `step/start`（缺 `step/end`） | 插 2 处 `step/end` |
| 14 | ~/.dsh | omp | 232368cc（base） | case A：`tool/call` args ≠ 广告 args | args := 广告原文 ×2 |
| 15 | ~/.dsh | omp | 48ab3568（superd） | case A ×84（诊断巨档，`i:` 字段被 runtime strip） | args := 广告原文 ×84 |

prod 修复**无需重启 dsh**（coldLogMemo 按 stat revision 失效，2026-10-04 结论复验）。sweep 脚本：真实 `JsonlSessionPersistence`（cordis `apply` 挂载，`ctx.sessionPersistence` 取服务，root = `<home>/agents/<agent>/sessions`，expectedId = 含 `session-` 前缀全名）。

## 2. 写侧根因（agent-hermes 竞态）与修复

`src/agent.ts`：`#deliverPrompt → #reserveTurn()` 只翻 `#turnOpen` 不落帧（注释声明「failed cold start leaves no orphan turn」），`turn/start + user/message` 在 `#startTurn` 里冷启动成功后才提交；但 `client.onFailure((e) => this.#fail(e))` 在构造时注册——gateway 子进程 pre-ready 死亡时 `#preReadyFailure` **同步**通知 failure listeners，`#fail → #closeTurn` 在 reserved 窗口内直接落 `turn/end`；随后 `ensureStarted()` reject，catch 的 `if (this.#turnOpen)` 已为 false，修理分支被跳过 → 裸 `turn/end`。

修复：新增 `#turnStarted`（`turn/start` 是否已落档）与 `#reservedMessage`（reserved 窗口持有 prompt）；`#closeTurn` 在 `#turnOpen && !#turnStarted` 时先提交开场对（turn/start + user/message）再落 turn/end——所有关合路径（onFailure / 冷启动 catch / wire terminal）归一。冷启动 catch 的手工开场对删除（单写者）。回归测试：`test/agent.test.mjs` 「gateway death in the reserved window commits turn/start before turn/end」（模拟 `preReadyFailure`：listeners 先同步触发、ready gate 后 reject）。全套 139/139 绿（build 后 `node --test`）。

**家族审计**：omp / pi / codex 早已带 `#turnCommitted` 同款守卫（hermes 是漏网者）；omp-sdk / codex-sdk 的 SDK 形同此窗口的审计未做（无实档病灶，遗留观察项）。claude / agy 无 `onFailure` 接线。

## 3. WS-attach 桥（v1，惰性交付）

协议实证（全部实锚）：
- 常驻 gateway（pid 256084，`hermes-gateway.service`，RPC 127.0.0.1:53595 / API 0.0.0.0:8642）令 stdio spawn 必拒；`tui_gateway/entry.py:324` 明示 attach 走 canonical WS（`ui-tui/scripts/gateway_bootstrap.py` → `hermes_cli/gateway_client.py`）。
- WS 帧协议 = JSON-RPC 2.0（`gateway/run_api.py` `/api/ws` + `tui_gateway/ws.py`「Wire-compatible with tui_gateway.entry」）；事件帧 `{'jsonrpc':'2.0','method':'event','params':{type,session_id,payload,…}}` 与 adapter 的 stdout 契约**逐字段一致**（`gateway/session_events.py:42`）。
- `GatewayClient._read` **丢弃无 method 的裸 reply**（`hermes_cli/gateway_client.py`）→ 桥的 stdin 泵必须走 `client.rpc()`（id 1:1 映射，`_timeout=inf`），不能裸转发。
- `connect_gateway()`：有 owner 则 attach，无则自起 idle-exit daemon——两种机器形态同一桥。

已交付：
- `super-dsh/agent-hermes/bridge/hermes-ws-bridge.py`（随包 `agent-hermes/bridge`，super-dsh `package.json` files 白名单已加行）。
- `src/hermes-client.ts`：`resolveHermesTransport()`（`SUPERD_HERMES_TRANSPORT`：process env → 原生 `~/.hermes/.env` 同名键（**热生效通道**，existing env wins）→ 默认 `stdio`）；attach 分支 spawn 桥脚本，ready 预算放宽 45s（发现 5s / daemon ensure 30s）。
- 单测：transport 选择优先级 + attach 分支命令形状 + 桥文件在包内存在（35/35）。
- Form A 实测（真 gateway）：ready ✓、`session.create` ✓（真 session id）。

**未完成（下会话）**：`prompt` → `prompt.submit`（CanonicalSubmitParams：text + session_id 注入 + admission-receipt 语义——receipt 即回、结算靠事件，与 stdio 的「reply=回合终」不同）、`steer` → `session.steer`（需 execution_generation）、`interrupt` → `prompt.cancel`（需 admission_id）、compress 无直映。事件词汇两态同名（message.start/delta/interim/complete、error、approval.*），projection 层预计零改动。完成后把 `.env` 键（备份在 `~/.hermes/.env.bak-superd-transport-20261102`，本次已撤）或进程 env 打开即全局生效（prod 免重启）。

## 4. Preview Notice「acknowledgement could not be saved」（未结）

已实锚：期望版本 `WELCOME_NOTICE_VERSION = "2026-09-28.1"`（`dsh-client-ui-settings-models` client.js:3168）**与两 home 已存档值逐字节相同**（`profiles/*/cordis.patch.yml` `- id: ui-settings-general` 行）；namespace 同名；host `writable` 硬编码 true；ack 流程 = `scope.set` → `settings.mutate`，成败以**写后恢复读**判定（client.js:3206-3224）。即：数据层全对，但对话框仍渲染 → 失败发生在**运行时投影**（describe 的 `entry.fiber.state !== 2` 门、volatileForm 投影、或 wire 层）之一。live 复现被卡在：4999 新客户端登录只收 scrypt hash（`dsh-test-credentials.yaml` 的 `dashr-web-password/passphrase` 无明文），browser-bridge 执行通道本次连接重置；prod 侧 cordis Config inspect 的 listConfigs 分页 input 序列化有 bug（无参可列 227 行目录，带 `name/limit` 即拒）。**下会话**：登录 4999（要密码或种 cookie）→ `settings.describe(ns=ui-settings-general)` + 试写 → 一步定位。恢复原状：prod `~/.dsh/profiles/web/cordis.patch.yml` 未动。

## 5. 本次未动的红线与部署态

- **prod 3080**：只做了会话档数据修复（§1，备份在档）与只读检查；进程零重启、零 config 写入。prod 的 super-dsh pack 更新（含写侧修复）与 attach 启用待 user 放行/下会话走 Plugin Manager。
- **4999**：`0.3.3-f` 双包经 `start-4999.sh` 全量重建并接管（unit `superd-4999-test` + `superd-lan-4999-relay`），shell 200；roster HTTP 需登录（正常）。hermes 默认仍 stdio → 行为同旧（gateway 拒绝 = 干净的回合错误，不再腐蚀档）。
- 版本：`0.3.3-f`（root/super-dsh/better-dsh 同步，`version:release`）。

## 6. 遗留清单

1. canonical 回合面映射（§3 未完成清单）→ attach 启用。
2. prod pack 更新 + hermes attach 启用（免重启，靠 .env 通道）。
3. Preview Notice 定位（§4）。
4. omp-sdk / codex-sdk 的 reserved 窗口审计。
5. corrupt-inspect Config provider 的 input 序列化 bug（本次绕过）。
