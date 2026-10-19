# PTY Workbench R2：复核意见处理记录（0.3.2-b）

日期：2026-10-19 19:05–19:25 HKT
输入：`docs/test-reports/2026-10-19-remote-pty-workbench-review.md`（0.3.2-a 第一人称复核）
计划：`docs/superpowers/plans/2026-10-19-pty-workbench.md` §12
范围：仅 `better-dsh/src/remote/`（+ 其测试）；super 侧只 copy 闭包。未 commit / 未 publish。

## 0. user 裁决

- **`mode` 字段不管**：从未 surface 过，是旧残留；不报错即无所谓。复核的 P1-1 按"不处理"结案（不引入 `additionalProperties:false`）。
- 其余意见逐项处理（本节即处理结果）。

## 1. P0-1：init 超时杀掉已就绪会话（真回归）

**复核证据成立**。`doStart()` 的 30s init 超时 timer 只在"初始化前死亡"的 waiter 里 `clearTimeout`；`onFrame` 成功分支没有清，30s 后回调 `killTree()` → 整组 SIGTERM → `markDead()`，模型面只看到下一次 dispatch 的 reconnect 提示。0.3.1-g 的同一函数本来有这一行，v2 重写时丢了。

修法：`onFrame` 首行 `clearTimeout(timer)`（成功分支与 dispose 竞态分支都撤）。

回归用例（`test/remote/pty-session.spec.ts`）：
- `R2 P0: the init timeout does not kill a session that already initialized`：`initTimeoutSec: 0.15` → dispatch → 等 600ms → 断言 `ready`，下一次 dispatch `reconnected === false`、输出正确。用短超时把"30s 自杀"压缩到亚秒级，避免测试跑 30s。

## 2. P0-2：死会话 / label / 配额三处泄漏

- `markDead()`（ready 过的会话）挂 **death reaper**：一段 idle TTL 后自动 `dispose()` → 出池 + 释放 label；`start()`/`dispose()` 清该 timer。留池语义（一次 reconnect）保留，但不再永久占位。
- `E_SESSION_LIMIT` **只统计非 dead 会话**：死会话没有进程，算进"live"会让 10 条死标签永久锁死 Agent（复核实测第 11 条被拒）。
- 文案：limit / `E_NO_SESSION` 的分钟数由 `ptyIdleTtlSec` 推出；dead 卡片不再显示 `idle-left`；`E_LABEL_IN_USE` 命中 pty 会话时补一行 `close` 出路。
- 回归用例：`R2 P0: a died session is reaped after one idle TTL ...`（kill -9 → state dead 且仍在池 → 1.6s 后 disposed、池空）。

## 3. 预热创建真正拨号

复核指出预热回执缺 `ttlSec`。根因更深：预热会话根本不拨号、也没有 idle timer，等于**永不回收**。现在创建形无 cmd 时 `await session.warm()`（拨号到 init 帧）再回执：
- `created: true` 代表真的 ready；
- 回执带整段 `ttlSec`（`idleMs === null` → 满 TTL）；
- 只有 ready 过才挂 idle 回收。
用例：`warm creation dials: ready state + idle timer` + driver 侧 `warm.ttlSec === 配置值`。

## 4. TTL 单一口径

`plugin.Config.idleTtlSec` 默认从 600 改为 `REMOTE_PTY_IDLE_TTL_SEC`（900s = 15 min）；错误文案、回执、描述全部由该值推出。复核的 600/900/"15 min"/"~10m" 四处不一致收敛为一处。

## 5. close 回执结构化

driver 返回 `{closed, reason: 'not-found' | 'already-closed-or-reaped', killed, message}`；tool output schema 暴露 `closed / reason / killed`，文本保留并区分两种 not-found。

## 6. background PTY 首回执可寻址

复核：`Started remote-…` 不告诉模型会话 id，创建型 background 必须再 roster 一次。

新增 `RemoteDriver.preparePtyLane()`：pty 创建/复用**先进池占位（不拨号）**，把 `pty:<id>` 交给官方 jobs registry；registry 拒绝时拆掉新建会话（复用形绝不拆）。首回执：
`Started remote-xxxx on pty:pty-abcd (label) (ssh:dev4). …`，字段带 `session / connection / label`。
副作用（正向）：创建失败（配额、label 占用、selector 不存在）现在是**同步**错误，不再埋进异步 job。

## 7. 其余 surface 对齐（复核 P1/P2）

| 复核项 | 处理 |
|---|---|
| hub PTY 回执与 oneshot 不可区分 | 回执首行 `[hub:<m4> pty — no session id, no parallel, no background]` |
| hub label 错误码 | `E_TARGET_FORMAT` 保留（比 `E_PARAMS` 更准），已回填计划 §12.7 |
| BYO ssh card 缺 `(built on)` | card 按 connection 判定标 `(built on)`（与 roster 同词） |
| busy/close 文案 "foreground command" | 改 "detached command" |
| 回执字段序 | session → conn → commandId → cwd → env → idle-left → exit → duration（对齐 §5.2） |
| `script_path` vs `scriptPath` | 维持 `scriptPath`（user 既定裁决），计划已回填 |
| `p-xxxx` vs `pty-xxxx` | 维持 `pty-` / `ssh-`（user 既定裁决），计划已回填 |
| `mode` 未拒绝 | **按 user 裁决不处理** |
| `pty:pty` 报 E_NO_SESSION | 语义可接受，不改 |

## 8. 验证

- `better-dsh` typecheck（host）：绿。
- `test/remote`：**29 files / 213 passed / 8 skipped**（含新增 3 条 R2 回归）。
- 全量 `better-dsh` 套件：**896 passed / 6 failed / 9 skipped**；6 个失败仍全部是 `test/surface-devices/browser-device.spec.ts` 的"本机无 Chrome"预存环境项（与上一轮一致）。
- 交付形态：`version:release 0.3.2-b` + `pack`
  - better-dsh 0.3.2-b sha256 `816e685c1e444af8a9c47553f58c5b34d5593b9229b9452cfc6d6a199921372d`
  - super-dsh 0.3.2-b sha256 `0b0f00fde8954e3226e9358abee0d1f74f0b44f464ddb2a1ff207632294d7a04`（独立同步包校验通过）
- 4999 装配：launcher 重启 → super 0.3.2-b；`DSH_HOME=.tests/superd dsh plugin --profile superd-pub install better-dsh@0.3.2-b --registry :14999` → better 0.3.2-b；unit restart → HTTP 200，两包均 0.3.2-b。
- 安装树闭包（`super-dsh/remote/plugin.js`，220,112 bytes）surface 矩阵：13 项新词汇全中（含 `armDeathReaper` / `preparePtyLane` / `built on` / `detached command`）；5 项死词汇（`byossh:`、`byop:`、`script_path`、`E_LABEL_CONFLICT`、`foreground command`）清零。

## 9. 现场验收（2026-10-19 20:10–20:40，0.3.2-b，第一人称）

复核方在 4999 上复测通过（`docs/test-reports/2026-10-19-remote-pty-workbench-review-r2.md`）：

- **30s 必死**：会话 **idle 54s** 后仍 `connected`，复用 dispatch 无 reconnect 提示、cwd 保持。
- **死会话配额**：上限只统计活会话；10 条 live 时第 11 条报 `E_SESSION_LIMIT`（清单全是 idle 活会话）；手工杀掉一条子进程后池里多一条 `died`，**新建仍成功**；dead 卡片无 `idle-left`；`E_LABEL_IN_USE` 出现 "To free it: close …"。
- P1 回执面收口：TTL 统一 15m、背景回执带 `on pty:… (conn)`、预热回执带 `idle-left ~15m`、hub PTY 独立标记、close 的 `closed/reason`、`(built on)`、`detached command`、字段序。
- 文档滞后（plan / specs / `docs/remote-tools.md`）由复核方按 0.3.2-b 实装面回填，本轮一并提交。
- user 裁决 `mode` / 未知根参数不处理，结案。

结论：本报告的修正项全部经真实交付面验收；0.3.2 正式发布。
