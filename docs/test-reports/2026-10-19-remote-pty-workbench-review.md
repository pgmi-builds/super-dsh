# remote PTY Workbench 第一人称复核（0.3.2-a）

> **R2 复核（0.3.2-b，2026-10-19 20:10）已发布**：P0-1（30s 必死）与 P0-2（死会话占配额）已修复；其余项状态见 [R2 报告](2026-10-19-remote-pty-workbench-review-r2.md)。

日期：2026-10-19 18:15–18:45 HKT
环境：本机 DSH 4999 实例（profile `superd-pub`，home `.tests/superd`），`better-dsh` / `super-dsh` **0.3.2-a**（18:12–18:14 安装）；目标 `dev4` = `137.131.54.174`（Ubuntu 24.04，`7.0.0-1013-oracle`，aarch64）；本地 `BYOP` 用 `spawn:"bash"`。
方法：**先只按模型可见的 surface 使用**，不看源码；出现异常后再查 `better-dsh/src/remote/`、并用 `bpftrace` 观察信号来源。未做 commit / publish。

对照基准：`docs/superpowers/plans/2026-10-19-pty-workbench.md`（v2，2026-10-19 第二轮裁决后）。

---

## 0. 结论

- **Surface 基本落地**：`<transport>:pty[:label]` 创建、`pty:<id|label>` 复用、自动 id、label 池与机器名同池、并行会话、`spawn`/`ssh` 入口、`close`、env delta（只名字）、commandId 账本、session card、busy 拒绝、timeout handoff——都在真实工具面上生效，错误文案质量高。
- **但有一个 P0 阻断**：**每个 PTY 会话在首次启动成功后约 30 秒必死**。第一次 dispatch 正常返回，~30s 后整组被 SIGTERM，state 变为 `died`；再次寻址会自动重连（cwd 重置），把问题伪装成“会话能用”。
  - 根因已定位到源码：`doStart()` 的 30s 初始化超时定时器**在成功路径没有被 `clearTimeout`**（只有“初始化前死亡”的 waiter 清），30s 后回调执行 `killTree()`，把 ssh/script 进程组杀掉。
- **P0 后果**：死会话不回收（`markDead` 会清掉 idle timer，池里却保留它等重连）→ 永久占 label、永久计入 10 会话上限。实测 10 条会话（其中 7 条 `died`）后再创建直接 `[E_SESSION_LIMIT]`，Agent 再也开不出新 PTY，直到手工逐条 close。
- **P1 surface 偏差**：`mode` 字段没有被拒绝（写了 `mode:"pty"` 仍按 oneshot 静默执行）；TTL 三处口径不一致（600s / 900s / 文案“15 min”）；`close` 回执只有文本、没有 `closed:false, reason:"not-found"`；`run_in_background` 首回执没有 session/connection；预热回执没有 ttlSec；hub PTY 回执与 oneshot 无法区分；计划里的 `script_path` 实际叫 `scriptPath`；id 形态是 `pty-xxxx` 而非计划的 `p-xxxx`。
- **判断**：设计方向（toolbox + workbench、one-shot 的 stateful 超集）成立，阅读面/教学面明显成熟；但“状态持久”这一核心承诺在真实消费面当前不成立。应**先修 P0 + 死会话回收**，再谈 4999 验收；否则任何 >30s 的验收都会被重连假象掩盖。

---

## 1. 第一人称时间线（按实际调用顺序，摘关键回执）

| 步骤 | 调用 | 实际结果 |
|---|---|---|
| 1 | `{target:"ssh:dev4:pty", cmd:"cd /opt && pwd && echo shell=$$ tty=$(tty)"}` | `pty:pty-mwx2`，cwd `/opt`，tty `/dev/pts/0`，`2.9s` |
| 2 | 同目标再建一条 | `pty:pty-ld87`，cwd `/tmp`，`3.1s` —— 同一 connection 并行 |
| 3 | `{target:"pty:pty-mwx2"}`（card） | `idle 13s (connected)`，ledger 列出 1 条 |
| 4 | `{target:"pty:pty-mwx2", cmd:"pwd && export FOO=bar && echo done"}` | cwd `/opt` 保持（state 生效），`env +FOO` |
| 5 | `{target:"ssh:dev4:pty:build", cmd:"pwd"}` | `pty:pty-nu8h (build)`，cwd `/home/u1` |
| 6 | 同名再建 | `[E_LABEL_IN_USE]`，明确“creation always claims a fresh name — spawn/ssh never adopt” |
| 7 | `{target:"pty:pty-mwx2", cmd:"unset FOO; pwd"}` | `env -FOO`，cwd `/opt` |
| 8 | `{target:"pty:pty-ld87", cmd:"sleep 3; echo late", timeout:1}` | 回执 `still running — poll job_output remote-5e65…`；`job_output` 约 3s 后 `late` / exit 0 |
| 9 | 约 45s 后 card `pty:pty-hf4q` | **`died`**（此前 26s 时还是 `idle 26s (connected)`） |
| 10 | `{target:"pty:pty-ld87", cmd:"sleep 30; echo bg-done", run_in_background:true}` | `Started remote-24a4…`；该 job 以 `30.0s`、`exit null`、`session died` 结束 |
| 11 | 对 busy 会话 dispatch | `[E_SESSION_BUSY]`，给出 `job_output` / `job_kill` / 另开会话三条出路 |
| 12 | `{action:"close", target:"pty:pty-ld87"}` | `[E_SESSION_BUSY]`，列出 pending job 与 `force:true` 一步形态 |
| 13 | `{action:"close", target:"pty:pty-849k", force:true}` | `closed pty:pty-849k (ssh:dev4) — killed running job remote-6617…` |
| 14 | 已关闭会话再寻址 | `[E_NO_SESSION]`，给 `{target:"ssh:dev4:pty"}` 重建形式 |
| 15 | 双击 label 建到上限 | 第 11 条 → `[E_SESSION_LIMIT]`，清单里 7 条 `died` 仍算 “live” |
| 16 | `{target:"ssh:byo4", ssh:{host:"137.131.54.174",user:"u1"}}` | `ssh:byo4 registered (byo-ssh, no dialing)`；roster 标 `byo4 (built on)` |
| 17 | `{target:"ssh:byo5:pty", ssh:{…}, cmd:"hostname"}` | `pty:pty-wvro`，`conn ssh:byo5` |
| 18 | `{target:"pty", spawn:"bash", cmd:"echo byo; pwd; tty"}` | `pty:pty-9mhn (byo-pty)`，`conn BYOP`，本地 `/dev/pts/1` |
| 19 | `{target:"hub:bfwu:pty", cmd:"hostname"}` | `srv1637772`，`0.6s`；回执无 session/conn 标记 |
| 20 | `{target:"hub:bfwu:pty:x", cmd:"true"}` | `[E_TARGET_FORMAT]`（计划想用 `E_PARAMS`） |
| 21 | `{target:"dev4", cmd:"true", mode:"pty"}` | **正常 oneshot 执行**（`runner superd-run…`），没有任何拒绝 |
| 22 | `{target:"dev4", scriptPath:"/tmp/remote-script-test.sh"}` | `[E_SCRIPT_READ] ENOENT` —— 是 bash 工具 bwrap 的私有 `/tmp`，**不是工具 bug**；改用 workspace 文件即成功 |
| 23 | `{target:"pty:pty"}` | `[E_NO_SESSION]`（label "pty"），非 `E_PARAMS` |
| 24 | `{target:"ssh:dev4:pty"}`（无 cmd 预热） | `[session created — address it as pty:pty-64np]`，无 ttlSec |
| 25 | 死会话仍占 label | 死后同名再建 → `[E_LABEL_IN_USE]`；close 后再建成功（label 释放） |

会话池最终一度累积 **9 条会话（其中 8 条 `died`）**（roster 全量列出），并且死会话的 `idle-left` 仍显示 `~9m`——这些死会话实际上没有 idle timer 在跑。

---

## 2. Surface 对照表（plan v2 → 实测）

| 计划项 | 实测 | 判定 |
|---|---|---|
| `ssh:<name>:pty[:label]` 创建，每次新建（tab 语义） | `ssh:dev4:pty` / `ssh:dev4:pty:build` 均按新会话返回，id 自动 | ✅ |
| `pty:<id\|label>` 复用 | id 与 label（`pty:build`）都能寻址到同一会话；cwd、env 保留 | ✅ |
| 无 cmd 的预热创建 | 返回 `[session created — address it as pty:…]` | ⚠️ 缺 `ttlSec`（计划 §3 要 `{session, connection, created:true, ttlSec}`） |
| 并行 | 同 `ssh:dev4` 同时 3 条，dispatch A 不影响 B；roster 同时列出 | ✅（但全都在 ~30s 后死，见 §3） |
| label 池：机器名 / 认领 / 会话同名冲突 | `spawn` 用 label `dev4` → `E_LABEL_IN_USE`（被 ssh host 占）；`spawn`/`ssh` 重复同 label 同样 | ✅ |
| 创建/注册失败释放 label | 源码 `createSession` catch 里 `labels.release`；实测 close 后 label 可复用 | ✅（代码 + close 路径） |
| BYO：`spawn` 在场 = BYO | `conn BYOP`，`(byo-pty)` 标记 | ✅ |
| BYO：`ssh` 在场 = 注册身份 | 注册回执 `(byo-ssh)`；roster `(built on)`；`ssh:<label>:pty` 可注册后开 PTY | ✅ |
| 回执字段序：session → connection → commandId → cwd/envDelta/ttl/exit | `[pty:pty-xxxx (label) · conn ssh:dev4 · cmd remote-… · exit 0 · 2.8s · env +FOO · cwd /opt · idle-left ~10m]` | ⚠️ 顺序为 session→conn→cmd→exit→dur→env→cwd→ttl；可读，但与计划序不同 |
| `commandId` 账本、20 条上限 | card 显示 ledger；`LEDGER_MAX=20` 在源码；本次最多 3 条未触顶 | ✅（未触顶实测） |
| commandId = jobId（background/handoff） | `run_in_background`：busy 文案与 jobId 同一 id；**handoff**：`cmd remote-4250…` 与 `job remote-5e65…` 不同，ledger 用 `(job …)` 并列 | ⚠️ handoff 与计划“同一 id”不一致（源码注释也承认“registry id ≠ commandId”） |
| session card：connection/cwd/env/ttl/最近 20 条，不带输出尾 | 有 connection、idle、cwd、ledger；**无 env delta 摘要、无最近输出尾** | ✅（按计划不带输出尾；env 缺失属小偏差） |
| close：默认拒绝列杀法；force 杀组；幂等 not-found | busy 拒绝 ✓；force 回执披露 `killed running job …` ✓；二次 close 文本 `no live session (already closed or idle-reaped)` | ⚠️ 只有文本，没有 `closed:false / reason:"not-found"` 字段 |
| busy：拒绝不排队，三条出路 | 文案 `job_output … / job_kill … / another session / oneshot` | ⚠️ 把 detached job 称“foreground command”，措辞不准 |
| timeout：不杀，handoff | 成立；回执给 `job_output <id>`，会话幸存 | ✅ |
| env delta：只名字 + 标记 | `+OLDPWD ~PWD`、`+FOO`、`-FOO`；无值 | ✅ |
| 上限 10 / agent，跨 connection | 存在；但把 `died` 算进 “live”，10 条后无法再建 | ❌（语义） |
| hub lane：`hub:<m4>:pty` 无 id/不可并行；label → E_PARAMS | 能跑；无 session/conn 标记；label 报 `E_TARGET_FORMAT` | ⚠️ |
| `mode` 退休，写入即 schema 校验失败 | `mode:"pty"` 被忽略，正常 oneshot 执行 | ❌（关键） |
| `script` → `script_path` | 实际参数名是 `scriptPath` | ⚠️ 命名漂移 |
| id：`p-` + 4–6 位 | 实际 `pty-` + 4 位（`PTY_ID_RE=/^pty-[a-z0-9]{4}$/`） | ⚠️ 计划未回填 |
| `E_NO_SESSION` 重建提示 | 有；文案写 “reaped after 15 min” | ⚠️ TTL 口径错（见 §4） |

---

## 3. P0：每个 PTY 会话 ~30s 必死

### 3.1 现象

- `pty-hf4q`：创建后 6s / 14s / 26s card 均 `connected`，约 45s 时 `died`。
- `pty-ld87`：`run_in_background` 的 `sleep 30; echo bg-done` 在 **30.0s** 以 `exit null`、`session died` 结束（命令本身没跑完）。
- BYOP 与 native 同样：`pty-9mhn`（本地 `spawn:"bash"`）、`pty-4dr1`（ssh）都死。
- 死后再 dispatch：`[remote: session reconnected to fresh shell; cwd reset to default]`，cwd 回 `/home/u1`——重连语义正常，但 cwd 丢失。

### 3.2 根因（源码）

`better-dsh/src/remote/pty-session.ts` `doStart()`（约 305–336 行）：

```ts
const timer = setTimeout(() => {
  this.killTree()
  reject(new Error(`[E_SESSION_START] … did not initialize in ${initTimeoutSec}s`))
}, initTimeoutSec * 1_000)          // 默认 30s

const waiter = (): void => {
  clearTimeout(timer)               // 只有“初始化前死亡”会清
  reject(new Error('[E_SESSION_DIED] … died before initializing'))
}
…
const parser = createNonceFrameParser(initNonce, {
  onFrame: () => {
    this.deathWaiters = this.deathWaiters.filter(w => w !== waiter)
    if (this.state === 'disposed') { reject(…); return }
    this.everReady = true
    this.state = 'ready'
    this.resetIdleTimer()
    resolve()                       // ← 成功路径没有 clearTimeout(timer)
  },
})
```

初始化成功后 `resolve()` 了，但 30s 的 timer 仍然挂着；到点执行 `killTree()`（`reapGroup(pid, grace=0)`）→ 对 ssh/script 进程组发 SIGTERM → 子进程 close → `markDead()` → 会话状态 `died`。`reject()` 因为 Promise 已 resolve 而静默，错误不会冒到模型面。

补充证据：0.3.1-g（HEAD `804f619`）的同一函数里本来有 `clearTimeout(timer)`；本轮 worktree 的 `git diff` 明确显示 `- clearTimeout(timer)`——即这是本轮重写引入的回归，不是历史遗留。

### 3.3 信号证据（bpftrace）

在 DSH 主进程（pid 3585258，`apps/cli/lib/bin.js --profile superd-pub --port 4999`）上挂 `sys_enter_kill`：

```
KILL from=3585258(node-MainThread) target=-3589099 sig=0
KILL from=3585258(node-MainThread) target=-3589099 sig=15
KILL from=3585258(node-MainThread) target=-3589099 sig=0
```

`target` 是 ssh 子进程自己的 pgid（detached leader）。`0 → 15 → 0` 正是 `reapGroup()` 的 checkGone → SIGTERM → close 后 checkGone 指纹；`dispose()` 的 SIGTERM 会在首个 probe 后约 1s，而 `killTree()` 的 grace=0，几乎立刻发 TERM。`markDead` 而池未删，说明走的是 `killTree()`（`twoStage` 的宽限兜底或 init 超时），不是 `dispose()`。

### 3.4 影响

1. **workbench 状态面失效**：任何“创建 → 过一会儿再用”都变成重连；cwd/env 丢失，只是被 `reconnected` 提示掩盖。
2. **后台命令被误杀**：`run_in_background` / handoff 在 30s 处被整组 SIGTERM，job 报 `session died`，exit null。
3. **死会话累积**（见 §4），最终把 label 和 10 会话配额锁死。
4. **本轮引入的回归**：0.3.1-g 的 `doStart()` 在 `onFrame` 里有 `clearTimeout(timer)`，本轮重写把它删了（`git diff` 中的 `- clearTimeout(timer)`）。因此这是 0.3.2-a 的回归，P4/P5 的既有验收不会覆盖到它。

### 3.5 修复建议

- `onFrame` 成功分支 `clearTimeout(timer)`；`disposed` 竞态分支同样先 clear。
- 加一条**时间推进**回归：初始化成功后推进 31s，断言进程仍活、`dispatch` 不产生 `reconnected`；再推进到 TTL 才允许回收。
- 顺带把 `reject` 与 `resolve` 的竞态收敛成幂等 settle，避免“已 resolve 的 reject 静默”。

---

## 4. P0 后果：死会话 / label / 上限三处泄漏

- `markDead()`（`pty-session.ts` 约 345–360 行）只把 state 置 `dead`、清 `startPromise`、**清 idle timer**、结算 death waiters。池条目保留（这是为了 reconnect 语义），但**没有任何后续 dispose 定时器**；`onDead`（真正从池里删并释放 label）只在 `dispose()` 时触发。
- 因此死会话永久留在 `PtyPool`，并且：
  - roster 永远列它（`[died]`）；
  - label 永久被占：实测 `pty-3nd5 (label lblx)` 死后，`ssh:dev4:pty:lblx` 再建 → `[E_LABEL_IN_USE]`，提示 “use the name directly” 但没说必须 `close`；
  - **上限算它**：实测池里 10 条（7 条 `died`）后，第 11 条 → `[E_SESSION_LIMIT]`，清单头写 “live: … died … idle …”，语义错误；不 close 就再也开不出新会话。
  - dead 卡片仍显示 `idle-left ~9m`，但这个 timer 已不存在——误导。
- close 能释放：对死会话 `close` 成功（文本 `closed pty:… (ssh:dev4)`），随后同名重建成功（实测 `lblx` 复用）。
- 建议：`markDead` 后按 TTL（或较短 grace）自动 `dispose()`；或至少让 limit/roster 只统计/展示非 dead 会话，并在 `E_LABEL_IN_USE`/`E_SESSION_LIMIT` 文案里直接给出 `close` 形式。

---

## 5. P1 / P2 偏差清单

### P1

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | `mode` 未被拒绝，静默按 oneshot 执行 | `{target:"dev4", cmd:"true", mode:"pty"}` 正常返回 `[exit 0 … runner superd-run…]`；`tool.ts` 的 `KNOWN_PARAMS` 只在 copy/rsync 分支校验；root `parameters` 没有 `additionalProperties:false`（output schema 才有） | 根级 schema 加 `additionalProperties:false`，或所有路径统一 KNOWN_PARAMS 校验；未知字段报 `E_PARAMS` 并列出合法字段 |
| 2 | TTL 三处口径不一致 | `plugin.ts` 默认 `idleTtlSec: 600`；`driver.ts` 常量 900；`E_NO_SESSION` 文案“reaped after 15 min”；回执 `idle-left ~10m` | 以配置 600 为唯一事实源，常量/文案/回执统一；dead 会话不显示 idle-left |
| 3 | close 回执不结构化 | 只返回 `kind/text/session`；`closed:false` 时文本 `… no live session (already closed or idle-reaped)`，没有 `reason:"not-found"` | 在 output schema 暴露 `closed/reason/killed`（文本可保留），并区分 “already closed” 与 “idle-reaped” |
| 4 | `run_in_background` 首回执无 session/connection | 返回 `Started remote-…`，不告诉模型新会话 id；创建型 `ssh:dev4:pty` + background 必须再 roster 才能寻址 | 回执带 `session`/`connection`/`label`，与前面字段序一致 |
| 5 | 预热回执缺 ttlSec | `[session created — address it as pty:…]`，无 `ttlSec` | 补 `ttlSec`（计划 §3 的回执形状） |
| 6 | hub lane 回执不可区分；label 错误码不符 | `hub:bfwu:pty` 返回 `srv1637772`（0.6s），无 session/conn；`hub:…:pty:x` → `E_TARGET_FORMAT` | 至少标 `conn hub:bfwu` + `pty (no session)`；错误码对齐计划（`E_PARAMS`）或回填计划 |

### P2

| # | 问题 | 证据/说明 |
|---|---|---|
| 7 | `script_path` vs `scriptPath` | 计划 §2 写 `script` → `script_path`；实际 schema 属性是 `scriptPath`（既有 camelCase 面）；建议回填计划或统一命名 |
| 8 | id 形态 `pty-xxxx` vs 计划 `p-xxxx` | `labels.ts:32 PTY_ID_RE=/^pty-[a-z0-9]{4}$/`；tool output schema 描述已是 `pty:pty-7k2m`；计划未回填 |
| 9 | busy 文案 “foreground command” | 实际可能是 detached/background job（`remote-24a4…`），语义上不是 foreground；建议改 “still runs a detached command” |
| 10 | BYO ssh 的 card 缺 `(built on)` | `pty:pty-dv56 — ssh:byo4 · idle 2s …`；roster 有 `(built on)`，card 没有（BYOP card 有 `(byo-pty)`）；计划 §5 要求 card 同标 |
| 11 | 回执字段顺序 | 实际 `exit`/duration 在 `env`/`cwd` 之前；计划序是 session→connection→commandId→state；可接受，但建议对齐 |
| 12 | `pty:pty` 的错误类型 | 返 `E_NO_SESSION`（label "pty"），而非 `E_PARAMS`；`pty` 单字才是 E_PARAMS；语义可接受，文案可更明确 |
| 13 | 创建失败释放 label 未实测 | 源码 catch 有 `labels.release`；本次只验证了 close 释放（成功） |

---

## 6. 做得好的地方

- 语法与教学面：`E_LABEL_IN_USE` 同时给 “address it / create new” 两条出路；`E_NO_SESSION` 给重建形式；`E_PARAMS`/`E_SCRIPT_PARAMS` 把互斥讲清楚。
- 池化命名：机器名、BYO 身份、PTY label 共用一个命名空间；“创建永不复用、复用只寻址”在实测中一致（同名创建报占用）。
- 并行第一性：一次消息内两条 `:pty` 调用同时成立；dispatch 到 A 不阻塞 B。
- env delta 只回名字：`+OLDPWD ~PWD` / `+FOO` / `-FOO`，无值泄漏。
- busy 拒绝、timeout handoff、force close 披露 killed id、自动 reconnect 提示——方向都对。
- card / roster / ledger 作为“工作台”的阅读面已经成形（connection、idle、cwd、ledger 摘要 72 字符）。

---

## 7. 未覆盖 / 受限

- TTL、20 条账本触顶、多 agent label 隔离、跨连接并发配额：被 30s 必死阻断，未做长时验收。
- pty 的 `stdin` REPL 语义未测（只测了 oneshot stdin）。
- copy / rsync 未回归（本轮未改；`E_SCRIPT_READ` 是 bwrap 私有 `/tmp` 的环境现象，不是工具 bug）。
- hub PTY 并行/close（设计上无 session id，不适用）。
- 10 条“活会话”上限未测（所有会话 30s 内死，等价于测了 dead 计数路径）。

---

## 8. 建议的收口顺序

1. **P0-1**：`doStart` 成功路径 `clearTimeout(timer)` + 31s 回归测试；重新跑 30s+ soak（创建 → 45s → 复用，应保持 cwd/env）。
2. **P0-2**：dead 会话回收（TTL/短 grace 自动 dispose，或 limit/roster 只算活会话）+ label/limit 文案带 `close`。
3. **P1**：未知根参数拒绝（`mode` 必须报错）；TTL 单一口径；close 结构化回执；background 回执带 session/connection；hub 回执标 connection。
4. 再走 4999 整包验收：30s+ soak、10 会话（含 dead 混排）、BYOP、hub、force close；报告落 `docs/test-reports/`。

---

## 附：关键复现命令

```text
# 1) 30s 必死
remote {target:"ssh:dev4:pty", cmd:"sleep 5"}    # 同步返回；等 35s 后再寻址
remote {target:"ssh:dev4:pty", cmd:"echo hi"}      # 然后等 35s
remote {target:"pty:pty-xxxx"}                     # state: died

# 2) background 被误杀
remote {target:"ssh:dev4:pty", cmd:"sleep 30; echo done", run_in_background:true}
# 30s 后 job: failed / session died / exit null

# 3) 死会话占 label + 上限
remote {target:"ssh:dev4:pty:lblx", cmd:"echo a"}  # 等 35s
remote {target:"ssh:dev4:pty:lblx", cmd:"echo b"}  # E_LABEL_IN_USE
# 累积 10 条 dead 后：
remote {target:"ssh:dev4:pty", cmd:"echo c"}       # E_SESSION_LIMIT，清单含 died
```
