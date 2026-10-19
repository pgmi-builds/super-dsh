# remote PTY Workbench 复核 R2（0.3.2-b）

日期：2026-10-19 20:10–20:25 HKT
环境：本机 DSH 4999（profile `superd-pub`，home `.tests/superd`），**`better-dsh` / `super-dsh` 0.3.2-b**（`node_modules` 内 bundle 时间 19:20；DSH 进程 pid 3646569，本轮已重启）；目标 `dev4` = `137.131.54.174`；本地 `BYOP`、`hub:bfwu`。
基准：`docs/test-reports/2026-10-19-remote-pty-workbench-review.md`（R1，0.3.2-a）。
方法：仍是**先按模型可见 surface 第一人称使用**；只对仍可疑处查源码。本轮未改任何代码。

追记（20:40）：user 裁决 `mode` 不处理（未知参数静默忽略可接受）；文档滞后已按 0.3.2-b 实装面回填（plan / specs / `docs/remote-tools.md`），本报告相应条目已标注结案。

---

## 0. 结论

- **P0 两项都已修复并实测通过**：
  - 30s 必死：会话在 **idle 54s** 后仍 `connected`，复用 dispatch 无 `reconnected` 提示、cwd 保持；`doStart` 成功路径已补 `clearTimeout(timer)`。
  - 死会话配额：上限只统计**活会话**；10 条 live 时第 11 条 `E_SESSION_LIMIT`（清单全是 idle 活会话）；手工杀掉一条子进程后，池里多一条 `died`，**新建仍成功**；死会话卡片不再显示 `idle-left`；`E_LABEL_IN_USE` 新增“To free it: close …”指引。
- **R1 的 P1 回执面基本收口**：TTL 统一 15m；背景任务回执带 `on pty:… (conn)`；预热回执带 `idle-left ~15m`；hub PTY 有独立标记；close 返回 `closed/reason`；BYO card 有 `(built on)`；busy 文案改为 “detached command”；回执顺序变为 session→conn→cmd→cwd→ttl→exit。
- **结论性状态（2026-10-19 20:40 追记）**：
  1. `mode` / 未知根参数：**user 裁决不处理**（不引入 `additionalProperties:false`，90% 可用即可）→ 结案。
  2. `scriptPath` 命名：实现定名，plan 与 `docs/remote-tools.md` 已回填 → 结案；`script_path` 仍会被忽略属已接受的未知参数行为。
  3. force close 后的 job 终态（`failed — session died`）→ 仍 OPEN（小）。
  4. 文档滞后（id、`mode`、`script_path`、`byossh:`/`byop:`）→ 已回填 plan/specs/remote-tools → 结案；`pty:pty` 维持 `E_NO_SESSION`（小，不改）。
  5. death reaper 15min：仍只有代码确认，未等实际时钟。
- 另一条只做了代码确认、未等实际时钟：死会话的 death reaper 是 `idleTtlSec`（900s）后才 `dispose`；本轮没有等 15 分钟验证。

---

## 1. R1 发现逐项状态

| R1 编号 | 项 | R2 结果 | 证据 |
|---|---|---|---|
| P0-1 | 30s 必死 | ✅ **FIXED** | `pty-7c71` 创建后 `idle 54s (connected)`，`pwd` 返回 `/home/u1` 且无 `reconnected`；`pty-session.ts:324/335` 两处 `clearTimeout(timer)`（waiter + onFrame） |
| P0-2 | 死会话占 label/上限 | ✅ **FIXED** | 10 条 live → `E_SESSION_LIMIT`（清单 10 条全 idle，无 died）；杀一条后 `pty-fb5j` 创建成功，roster 同时存在 `7c71 [died]`；`driver.ts:502-506` 过滤 `state !== 'dead'`；`armDeathReaper()` 900s 后 dispose；`E_LABEL_IN_USE` 现含 close 指引 |
| P1-1 | `mode` 未被拒绝 | 🟡 **CLOSED（user 裁决不处理）** | 未知根参数静默忽略被接受；plan §1/§12 已回填该裁决（不再声称 schema 校验失败） |
| P1-2 | TTL 600/900/15min 不一致 | ✅ **FIXED** | `plugin.ts:27` 默认 `REMOTE_PTY_IDLE_TTL_SEC`（900）；回执 `idle-left ~15m`；`E_SESSION_LIMIT`/`E_NO_SESSION` 文案用 `ttlMinutes()` = 15 |
| P1-3 | close 回执不结构化 | ✅ **FIXED** | 二次 close：`pty-dc5l: not closed (not-found) — no pty session is registered under "pty-dc5l"`；`closed/reason/killed` 已进 output schema |
| P1-4 | background 回执无 session | ✅ **FIXED** | `Started remote-07667a7976f34b4c on pty:pty-j3d0 (ssh:dev4). …`；job 5s 后 `bg-ok` |
| P1-5 | 预热回执无 ttlSec | ✅ **FIXED** | `[pty:pty-dc5l · conn ssh:dev4 · idle-left ~15m · exit null · 0.0s]`（`session created` 提示保留） |
| P1-6 | hub PTY 回执不可区分 | ✅ **FIXED** | `[hub:bfwu pty — no session id, no parallel, no background]\nsrv1637772` |
| P2-7 | `script_path` 命名 | ✅ **CLOSED（命名回填）** | 实现定名 `scriptPath`；plan / `docs/remote-tools.md` 已回填；`script_path` 被忽略属已接受的未知参数行为 |
| P2-8 | id `pty-xxxx` vs plan `p-` | ✅ **CLOSED（文档回填）** | plan §3/§8/§11 已改 `pty-`/`ssh-`（4 位） |
| P2-9 | busy 文案 “foreground” | ✅ **FIXED** | `still runs a detached command (remote-92b4…)` |
| P2-10 | BYO card 缺 `(built on)` | ✅ **FIXED** | `pty:pty-wonk — ssh:byo4 (built on) · idle 6s (connected)` |
| P2-11 | 回执字段顺序 | ✅ **FIXED** | `[pty:pty-7c71 · conn ssh:dev4 · cmd remote-… · cwd /home/u1 · idle-left ~15m · exit 0 · 3.1s]` |
| P2-12 | `pty:pty` 错误类型 | ⚠️ 未变（小） | 仍为 `E_NO_SESSION`（label "pty"） |
| 新增 | force close 的 job 终态 | ❌ **OPEN（小）** | close 说 `killed running job remote-92b4…`；随后 job 通知 `status: failed, session died` |

---

## 2. 关键原始回执

```text
# 存活（54s 后复用）
pty:pty-7c71 — ssh:dev4 · idle 54s (connected) · cwd /home/u1
[pty:pty-7c71 · conn ssh:dev4 · cwd /home/u1 · idle-left ~14m · exit null · 0.0s]
/home/u1
[pty:pty-7c71 · conn ssh:dev4 · cmd remote-a36b70ac9b824ea3 · cwd /home/u1 · idle-left ~15m · exit 0 · 0.2s]

# 10 live 上限（只计活会话，文案 15 min）
Error: [E_SESSION_LIMIT] remote: this Agent already holds 10 live PTY sessions (limit 10) — close one ({action:"close", target:"pty:<id>"}); idle sessions are reaped after 15 min.
  live: pty-7c71 ssh:dev4 idle 58s · … · pty-4u19 ssh:dev4 idle 3s

# 杀一条后仍能新建（dead 不占配额）
[pty:pty-fb5j · conn ssh:dev4 · cmd remote-b6b352d9bced4f8a · cwd /home/u1 · idle-left ~15m · exit 0 · 3.1s]
pty sessions: pty:pty-7c71 ssh:dev4 [died] · … · pty:pty-fb5j ssh:dev4 [idle 0s]

# 背景任务回执 / 完成
Started remote-07667a7976f34b4c on pty:pty-j3d0 (ssh:dev4). …
bg-ok [status: completed, exit code: 0]

# close 幂等 + force
pty-dc5l: not closed (not-found) — no pty session is registered under "pty-dc5l"
closed pty:pty-sxci (ssh:dev4) — killed running job remote-92b40ffb69bc432a

# 死会话 label 指引
[E_LABEL_IN_USE] … To free it: close pty-tf9o ({action:"close", target:"pty:pty-tf9o"}) — a session that died still holds its label until it is closed or reaped

# hub / BYO / 预热 / busy
[hub:bfwu pty — no session id, no parallel, no background]
[pty:pty-wonk — ssh:byo4 (built on) · idle 6s (connected) · cwd /home/u1]
[pty:pty-dc5l · conn ssh:dev4 · idle-left ~15m · exit null · 0.0s]
Error: [E_SESSION_BUSY] … still runs a detached command …
```

---

## 3. 仍建议修（按顺序）

## 3. 结案与遗留

- **已结案（user 裁决）**：未知根参数 / `mode` 不修——不引入 `additionalProperties:false`，模型正常不会凭空造字段，90% 可用即可。`scriptPath` 为实现定名，plan 与 `docs/remote-tools.md` 已回填。
- **已结案（文档）**：plan 的 id 形态、`script_path`、`mode` 硬失败、`p-`/`s-` 前缀已按 0.3.2-b 实装回填；`docs/specs/remote-pty-label`、`remote-tool-enhancement`、`remote-native-shortcut` 加 superseded/对齐注记。
- **遗留（小）**：force close 的 registry job 终态应区分 `killed by close(force)` 与 `session died`。
- **遗留（验证）**：death reaper 的 900s 时钟用假定时器/短配置测一次。

---

## 4. 覆盖与限制

- 已测：54s 存活 + 复用、10 live 上限、强制死亡后新建、close 幂等/force、预热、background、hub PTY、BYO ssh PTY、env delta、ledger、并发 10 会话。
- 未测：15min death reaper 实际等待、20 条账本触顶、多 agent label 隔离、`stdin` REPL、copy/rsync 回归。
- 测试产生的会话已全部 close，roster 现为空。
