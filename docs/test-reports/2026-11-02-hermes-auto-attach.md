# Hermes auto-attach（G5 边界收口）— 0.3.4-c 验收报告

**日期**：2026-11-02 23:0x–23:2x HKT · **版本**：super-dsh 0.3.4-c · **执行**：pc-deepseek-default

> **Publish（user 放行后执行）**：`better-dsh@0.3.4-c` + `super-dsh@0.3.4-c` 已发 npm registry `--tag latest`（2026-11-03 00:04 / 00:20 HKT 落库，npm 服务端 staging 处理各延迟 ~11/~27 分钟，期间重发探测得 E409 "previously staged version" 证实受理无丢失）；GitHub master = `4a40e1d` 已推。临时 npmrc 用后即删。

## 1. 背景与裁决

user 两点裁决（本轮对话）：① 事故期间的手动 lever（`SUPERD_HERMES_TRANSPORT=attach` 写进 `~/.hermes/.env` / systemd drop-in）不算走完最后一公里——adapter 必须自己吸收，「装完插件即用」；② notice 抑制走最省方案（0.3.4-b 已落的 CTX0 ack 行镜像即终案，代点顾虑由 user 明确豁免）。

## 2. 实现（agent-hermes）

`src/hermes-client.ts`：transport 增加第三模式 **`auto` = 新默认**。

- `resolveHermesTransportMode(dotEnv)`: `SUPERD_HERMES_TRANSPORT` 进程 env > 原生 `~/.hermes/.env` 同名键 > 默认 `auto`；`stdio`/`attach` 为**锁定值**（显式选择永不翻转），未知值回落 `auto`。
- auto 语义：首 spawn 走 stdio（无 gateway 机器零变化）；stderr 或 spawn 失败文本命中 hermes 自己的拒绝签名 `/owned by a running gateway/i` → **进程级粘性**翻转到 attach 桥（`bridge/hermes-ws-bridge.py`），后续 client 的首次 spawn 直接 attach，不再浪费失败尝试。翻转在 `HERMES_SPAWN_ATTEMPTS`(3) 预算内完成，用户不可见。
- 测试：新增 `test/auto-attach.test.mjs`（resolver 解析 / 拒绝翻转+粘性 / 显式 stdio 锁定不翻 / 显式 attach 零 stdio 尝试）；修正 `hermes-client.test.mjs` 两处依赖真实 `~/.hermes/.env` 的机器态断言（改为显式 env 钉死）。**suite 146/146 绿**（142 旧 + 4 新）。

## 3. 验收（真实 UI，browser-bridge；规则 docs/07 §4.2）

**4999 线**（drop-in 改 `SUPERD_HERMES_TRANSPORT=auto` + `SUPERD_HERMES_TRACE=1`，`start-4999.sh` 重部署 0.3.4-c）：
- 新会话 prompt「Reply … AUTO-ATTACH-UI-1」→ **逐字回复 `AUTO-ATTACH-UI-1`，Completed in 5s**，无 notice。
- 进程日志（`.scratch/superd-4999.log`）完整翻转轨迹：
  `spawn transport=stdio` → `stderr: [gateway-exit] refused: … owned by a running gateway` → `gateway ownership refusal on stderr — auto-attach engaged` → `spawn attempt 1/3 respawning` → `spawn transport=attach …hermes-ws-bridge.py`；第二个 client 首次 spawn 即 attach（粘性生效）。

**dev3 目标机**（tarball 实装 `dsh plugin --profile web add /home/u1/superd-0.3.4-c.tgz`；`~/.hermes/.env` 的 attach lever **注释退役**（备份 `.env.bak-transport-lever-20261102c`）；`systemctl --user restart dsh.service`，本报告即披露）：
- 纯默认路径（env 无 lever、常驻 `hermes-gateway.service` 在跑）：既有 hermes 会话 follow-up「Reply … DEV3-AUTO-ATTACH-OK」→ **逐字回复 `DEV3-AUTO-ATTACH-OK`，Completed in 2s**（resume 面与 create 面分别由 dev3/4999 两条腿覆盖）。

## 4. 边界状态（G5 收口后）

| 机器 | 状态 |
|---|---|
| 4999 | 0.3.4-c，drop-in=auto（显式选择 auto 走确定性路径），开箱即用 ✅ |
| dev3 | 0.3.4-c，**零 lever、零手动配置**，默认 auto 实测通过 ✅ |
| PC prod (3080) | 仍 0.3.4-a + 手动 lever（`.env` line 138，prod 无 auto 代码前不能摘）——升级 0.3.4-c 后 lever 可退役（保留亦无害：显式 attach 仍有效） |

## 5. 遗留

- npm publish（0.3.4-c 含 b 的 notice 镜像 + 本轮 auto-attach）待 user 放行；PC prod 升级 + dsh 重启待 user 放行。
- 4999 drop-in 的 `SUPERD_HERMES_TRACE=1` 保留（测试线排障用，无害）。
- G2 待办（writer 错误路径 closer 代码层验证）与 G5 通则推广（其余 runtime 无此形态，暂无对象）见 `agent-adapter-rules/30-hermes.md`。
