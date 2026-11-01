# remote default-PTY 独立第一人称复测（0.3.3-b，PC 4999）

日期：2026-11-01（Asia/Hong_Kong，20:09–20:39）。被测版本：`0.3.3-b`。测试线：`https://test.pc.internal.test/`（4999）。
追加复核：2026-11-01 22:39，修复轮 `0.3.3-d` 后的「字节 0 边界」重测见 §9。
规范：[docs/specs/remote-default-pty/spec.md](../specs/remote-default-pty/spec.md)；计划：[2026-11-01-remote-default-pty-plan](../10_plans/2026-11-01-remote-default-pty-plan/plan.md)。
既有交付报告：[2026-11-01-remote-default-pty.md](2026-11-01-remote-default-pty.md)（Task F 第一人称验收）。

> **本报告是同一交付上的独立复测，不是对既有报告的修订。** 复测由跑在 4999 真实 runtime 里的模型会话
> `session-6436b0e0-d503-4535-8f88-d504a3f740ce` 亲自用 `remote` 工具完成（不是回放既有报告的证据），
> 目标是核对 spec §8 的模型可见行为，并暴露既有验收未覆盖的组合。**本轮未 commit / tag / push / publish；
> 生产树（`~/.dsh`、`~/.superd`、3080/3081、live Caddyfile）未触碰。**

---

## 0. 结论

1. **主干行为全部通过**：默认 PTY 懒建与 cwd/env 复用、idle/fresh/busy 三态 handoff、机器默认
   `run_in_background` 同操作 handoff + 完成通知、`job_output` 从字节 0 首读、busy PTY exact-byte
   stdin-only 与 `commandId` 防 stale、oneshot 隔离、BYO PTY/SSH、`close` 语义（无 job 字段、忙保护、
   force、not-found）、配额 30（触顶教学 + 全量 roster + 释放恢复）、两 Agent roster/BYO 隔离、
   roster 无拨号与外部变更下次扫描可见、SSH oneshot MUX（宿主侧 socket/master/权限/每 Agent 隔离）、
   移除项教学（`input` action、`:pty` 创建、`close {job}`）。
2. **发现 4 个缺陷，全部集中在 `scriptPath` 与后台/PTY 的组合上**（主干路径无回归）：
   - **F1（高）**：`scriptPath` 在 PTY 中永不结束；超时/取消后残留交互式 `bash -s` 接管会话，
     后续 `exec` 实际跑在脚本 shell 里（cwd/env 被污染），原会话 shell 永久阻塞；重复执行会继续嵌套。
   - **F2（中高）**：`scriptPath` 的「脚本载体」与「业务 stdin」并未真正分离——两者被拼接进同一输入流；
     oneshot 中脚本里的 `read` 会吃掉自己的下一行脚本，业务 stdin 被当成 shell 命令执行（exit 127）；
     PTY 中业务 stdin 同样被当成命令文本。与 spec §1「载体与 stdin 分离」不符，且有「数据当命令执行」的风险。
   - **F3（中）**：`run_in_background:true` + `scriptPath` 在占位 lane 中丢失脚本载体：
     带 stdin 时先回 `Started …` 再以 `[E_STDIN_WITHOUT_CMD] stdin requires cmd` 失败；
     不带 stdin 时回 `Started …` 后以 `pty dispatch did not hand off a running job` 失败——脚本从未执行。
   - **F4（低）**：用 `exec stdin-only` 原样写 `"\u0003"` 后，被收养的 job 不会自行结算，
     会话卡在 `busy (a command is running)`（远端命令其实已结束），只有 `job_kill` 能收尾。
3. **与既有报告的关系**：既有报告只验证了 oneshot 下「脚本末行 `cat` 读 stdin」这一种形状；
   PTY `scriptPath`、后台 `scriptPath`、脚本中途读 stdin 三组组合没有第一人称证据。
   §6 给出对照。

---

## 1. 现场与证据链

| 项 | 实测值 |
| --- | --- |
| 宿主 | `homepc`（Home PC），当前会话 cwd `/home/u1/workspaces/base` |
| 测试线 | `superd-4999-test` / `superd-lan-4999-relay` / `superd-4999-pair-registry` 三 unit active；`/` 200、匿名 `/api` 401 |
| DSH_HOME | `/home/u1/workspaces/superd/.tests/superd`（profile `superd-pub`） |
| 版本 | root / `better-dsh` / `super-dsh` 均 `0.3.3-b`；安装态 `better-dsh 0.3.3-b`、`super-dsh 0.3.3-b` |
| 安装态叶哈希 | `better-dsh/lib/remote/plugin.js` = `323e74f1f7acc7d344ee0e490ba6c7963afc29f53545c0df5958e2f9c3072484`；`super-dsh/remote/plugin.js` = `cd209e749bed807d5098f21b58c4e6e07572fdb7aa08cf40a176a8c114d80c20`（与既有报告 tarball 叶一致，确系本轮新 surface） |
| 会话 | `session-6436b0e0-d503-4535-8f88-d504a3f740ce`，`DSH_WEB_URL=https://test.pc.internal.test/` |
| 目标 | `ssh:dev3`、`ssh:dev4`、`ssh:dev2`（真实 SSH）、BYO spawn（本机）、BYO ssh（`~/.ssh/id_key2`） |
| 方法 | 模型在会话内直接调用 `remote` / `remote_transfer` / 宿主 `job_output`、`job_kill`；宿主侧证据用本机 bash（`ls`/`stat`/`ps`/`ssh -O check`）核对 MUX 与进程树 |

说明：本轮的主证据是**模型自己收到的回执**（逐字摘录于 §2/§3）；宿主侧命令只用于 MUX、进程树、残留
socket 等模型面不可见的内部事实。

---

## 2. 通过项（第一人称回执，逐字摘录）

| # | 场景 | 模型实际回执（摘） |
| --- | --- | --- |
| P1 | 基线 roster（无 target，不拨号） | `hub machines: hub:bfwu (DEV3), hub:skc8 (homepc)` / `ssh hosts …: github.com, dev2, dev3, …` / `docker containers: corti (running), …` / `incus containers: …` / `pty sessions: none` |
| P2 | 默认 PTY 懒建 | `[pty:pty-e0fv · conn ssh:dev3 · cmd remote-1d922ddc2cf7440d · cwd /tmp · env +FP_MARK,+OLDPWD ~PWD · idle-left ~15m · exit 0 · 0.8s]` |
| P3 | 同机二次 exec 复用同一 shell | `pwd` → `/tmp`，`echo $FP_MARK` → `fp-ok`，`tty` → `/dev/pts/0`；`[pty:pty-e0fv · … · cwd /tmp · idle-left ~15m · exit 0 · 0.1s]` |
| P4 | machine card（按需探测） | `ssh:dev3 — ssh host` / `probe: reachable in 660ms (just now, on demand)` / `default PTY: pty-e0fv ssh:dev3 idle 2s` / `pty sessions on this connection: pty-e0fv ssh:dev3 idle 2s` |
| P5 | idle handoff | `handed off pty:pty-e0fv — ssh:dev3` / `detached` / `this machine's next exec opens a fresh default PTY`；随后 machine exec 得新 session `pty-tlet`、`cwd /home/u1`、`mark=<empty>`；`pty:e0fv` 仍 `cwd /tmp`、`mark=fp-ok`（同一会话引用被移动，输出/状态未复制） |
| P6 | busy handoff（同步超时把命令置忙后） | 超时回执：`TICK1 … TICK2 … [pty:pty-tlet · … · exit null · 2.0s · still running — poll job_output remote-d19baa03b4ef4521]`；handoff 回执：`handed off pty:pty-tlet — ssh:dev3` / `…` / `still running: command remote-a8b77f2989d84a9e — follow with job_output remote-d19baa03b4ef4521, cancel with job_kill` |
| P7 | 三路 job 首读语义（busy handoff 路） | 首次 `job_output remote-d19baa03b4ef4521` = `TICK1 … TICK6 [status: running]`（**从 0 起读**，重放已展示的 TICK1/TICK2 属 §4 三轮-1 已裁决冗余）；第二次 = `BUSY-DONE [status: completed, exit code: 0]`（增量无重复/缺口） |
| P8 | 机器默认 `run_in_background` = 同操作 handoff | `Started remote-39bdbd828faf4d84 on pty:pty-i9ad (ssh:dev3). Use job_output to read and job_kill to cancel; completion is reported by the host.`；下一次 machine exec 立即开出新默认 `pty-cklt`（证明 pty-i9ad 已在同一操作中移出默认槽） |
| P9 | went-async 的完成通知真实送达 | 宿主主动推来：`background job remote-39bdbd828faf4d84 (remote: pty:pty-i9ad: for i in 1 2 3; do echo "BG$i"; sleep 2; done; echo BG-END) finished [status: completed, exit code: 0]. Output: BG-END` |
| P10 | 后台 job 首读从 0 | 提交约 4s 后首次 `job_output` = `BG1` / `BG2` / `BG3` / `[status: running]`（无缺头，不需要偏移） |
| P11 | busy PTY stdin-only exact-byte | `wrote 6 bytes into pty:pty-i9ad for command remote-1de07f6702984640 — …`；`wrote 5 bytes …`；命令实际响应（完成通知）：`… GOT:alpha/beta` |
| P12 | stale-write guard | `[E_COMMAND_MISMATCH] remote: commandId "remote-deadbeefdeadbeef" does not match the running command remote-1c4aca1b84184456 — input aimed at an earlier prompt is never written to the next command` |
| P13 | 零字节写与 Ctrl-C 行规程 | `wrote 0 bytes into pty:pty-i9ad …`；`wrote 1 byte into pty:pty-i9ad …`（注：后者暴露 F4） |
| P14 | machine target 的 stdin-only 路由默认槽 | 超时命令留在默认槽后：`wrote 14 bytes into pty:pty-96qi for command remote-5d18940ed91b4a14 — …`；job 结算 `m? M:hello-machine` |
| P15 | oneshot 隔离 | `MARK=<empty>` / `/home/u1` / `srv1637772`，`[runner superd-run 0.3.1-d.b596 (x86_64-unknown-linux-musl) · exit 0 · 0.2s]`（无 `session` 字段、无 PTY 状态） |
| P16 | BYO PTY（`add {spawn}`） | `[session created — address it as pty:pty-7tm7]` + `[pty:pty-7tm7 (fpbyo) (byo-pty) · conn BYOP · idle-left ~15m · exit null · 0.0s]`；`exec pty:fpbyo` → `BYO-OK` / `homepc` / `/home/u1/workspaces/superd`；card `pty:pty-7tm7 (label fpbyo) — BYOP (byo-pty) · idle 3s (connected) · cwd …`；`close pty:fpbyo` → `closed pty:pty-7tm7 (BYOP)` |
| P17 | `close` 忙保护 / force / not-found | `[E_SESSION_BUSY] remote: pty session pty-cklt still runs a detached command (remote-60f91b77509646c6) — job_kill … first (or wait for it), then close again; force:true closes the tab and kills the group in one step` → `close {force:true}`：`closed pty:pty-cklt (ssh:dev3) — killed running job remote-60f91b77509646c6`；再 close 同机：`ssh:dev4: not closed (not-found) — no default PTY on ssh:dev4 — a machine's first exec opens one` |
| P18 | fresh handoff 结构化字段 | `handed off pty:pty-5bie — ssh:dev4` / `fresh idle shell created and detached`；结构化 = `{kind:'handoff', session:'pty:pty-5bie', connection:'ssh:dev4', created:true, ttlSec:900, …}`（符合 spec §5 的最小增量） |
| P19 | 配额 30 触顶 | 5 个既有会话 + 25 个 BYO spawn = 30；第 31 个：`[E_SESSION_LIMIT] remote: this Agent already holds 30 live PTY sessions — the per-Agent session global limit (30) is reached. Check the live sessions below (or {action:"status"} for the roster), then close one ({action:"close", target:"pty:<id>" or the machine name}), kill its running job (job_kill), reuse a session, or run {mode:"oneshot"} instead.` + 全部 30 条 live 明细 |
| P20 | 配额恢复 | `close pty:fq1` → `closed pty:pty-8bsr (BYOP)`；随即 `add {spawn:"bash -i", target:"fq26"}` 成功；随后逐一 close 25 个 spawn，roster 回到 5 条 |
| P21 | 两 Agent 隔离（B 的真实 roster） | B：`ROSTER-1 … pty sessions: none`（看不到 A 的 5 个会话与 `fpbyo`）；B 自建 `pty:pty-hjrj`（dev4 默认）、注册 `childbyo` 后 `ROSTER-2` 仅见 `pty:pty-hjrj ssh:dev4 [idle 3s; default on ssh:dev4]` 与 `ssh hosts … childbyo (built on)`；A 的 roster 同时不含 `pty-hjrj`/`childbyo` |
| P22 | roster 外部变更（下一次扫描可见） | 外部 `docker run -d --name fp-roster-probe alpine:3 sleep 120` 后，下一次 `status {}` 立即出现 `docker containers: fp-roster-probe (running), corti (running), …`；移除后下一次扫描消失 |
| P23 | MUX 宿主侧证据 | 本 Agent 的 `superd-mux-8862380b` 目录 `drwx------`（0700）；3 个 socket（dev3/dev4/dev2）均 `srw-------`；`ssh -O check` → `Master running (pid=…)` ×3；master 进程 `ssh: /tmp/superd-mux-8862380b/<hash> [mux]`，PPID=1530（init，已与客户端组脱钩） |
| P24 | MUX 每 Agent 隔离 | B 的 dev2 oneshot 在**自己的**目录 `superd-mux-f03b5c5c/f3cd0dedfe08ad27` 建 master（pid 140280）；A 的同身份 socket `superd-mux-8862380b/f3cd0dedfe08ad27` master pid 138901——同身份哈希、不同目录/不同 master |
| P25 | PTY 不带 MUX | 会话 ssh 进程 argv = `ssh -tt -o BatchMode=yes -o ServerAliveInterval=180 -o ServerAliveCountMax=2 -- dev3 bash`（无 `ControlMaster/ControlPath`）；`ssh -tt … -- dev4 bash` 同 |
| P26 | 移除项教学 | `exec target:"ssh:dev3:pty"` → `[E_TARGET_FORMAT] remote: "ssh:dev3:pty" — the :pty creation suffix is gone; a machine's exec opens its default PTY and handoff detaches it as pty:<id>`；`close {target:"ssh:dev4", job:"…"}` → `[E_PARAMS] remote: "job" does not belong to action "close" — close takes a target …; cancel jobs with job_kill`；`action:"input"` → 宿主 schema `invalid arguments: "action" must be one of ["exec","handoff","add","status","close"]` |
| P27 | `mode:"pty"` 显式与默认等价 | `exec {target:"ssh:dev4", mode:"pty", cmd:"echo EXPLICIT-PTY"}` → `EXPLICIT-PTY`，回到 `pty:pty-96qi` 默认槽 |
| P28 | BYO ssh `~/` key 展开 + 无拨号注册 | `add {ssh:{host:"dev3.internal.test", user:"u1", key:"~/.ssh/id_key2"}}` → `ssh:fpacc registered (byo-ssh, no dialing). Reuse the label anywhere ssh: aliases work; a new Agent registers again.`；`exec ssh:fpacc mode oneshot` → `BYO-OK` / `srv1637772` / `u1` |
| P29 | 跨机并行 | 同一消息内 4 路并发：dev3 oneshot、dev4 oneshot、dev2 oneshot、`pty:pty-i9ad` 同步命令全部成功（0.1s/0.4s/0.1s/0.1s），互不阻塞 |
| P30 | transfer 无回归 | 先 `mkdir -p /tmp/fp-acc`（rm 端），再 `copy /tmp/fp-acc/s1.sh → ssh:dev3:/tmp/fp-acc/`（`route scp · exits [0] · verification native-exit-only`）与回传；本地/远端 sha256 前缀均 `7086029dc8fa4446` |
| P31 | 15m TTL（常量 + 回执 + 真实回收） | `driver.ts:100 REMOTE_PTY_IDLE_TTL_SEC = 900`；回执含 `idle-left ~15m`、结构化 `ttlSec`；20:23:28 建纯闲置 BYO 会话，20:38:51 回查 → `[E_NO_SESSION] … idle sessions are reaped after 15 min`，roster `pty sessions: none` |
| P32 | MUX 到期自清 / Agent teardown | 最后使用 ≈20:25 后，`ControlPersist=600` 到期：20:35 socket 被 unlink、20:39 无任何 `[mux]` master；Agent B 结束后其目录 `superd-mux-f03b5c5c` 整体消失（dispose） |

---

## 3. 缺陷详述

### F1（高）PTY `scriptPath` 永不结束，且超时/取消后接管会话

**复现（两条独立形状都复现）**

1. 本地脚本 `/tmp/fp-acc/script.sh`（`echo` + `cd /tmp` + `read` + `echo`）：
   `exec {target:"pty:pty-i9ad", scriptPath:"/tmp/fp-acc/script.sh", stdin:"hello-pty\n"}`
   → 输出脚本前三行后停在交互提示：
   `… SCRIPT:HOST=srv1637772 CWD=/home/u1 ARGS=[]` / `u1@srv1637772:/tmp$` …
   → 回执：`[pty:pty-i9ad · conn ssh:dev3 · cmd remote-c7cccd3083ea49c1 · idle-left ~13m · exit null · 120.0s · still running — poll job_output remote-a5da32e7f53a469e]`
2. 本地脚本 `/tmp/fp-acc/cd.sh`（`cd /tmp` / `echo` / `export` / `echo`，**不含 read**）：
   `exec {target:"pty:pty-i9ad", scriptPath:"/tmp/fp-acc/cd.sh"}`
   → `> > u1@srv1637772:~$ … IN-SCRIPT:/tmp … done` 后再次 `exit null · 120.0s · still running`。
   即：连「不需要 stdin 的普通脚本」在 PTY 里也永远不会结算。

**超时/取消后的真实状态（宿主侧）**

`job_kill` 之后会话并没有恢复，而是被残留 shell 接管：

```
$ exec {target:"pty:pty-i9ad", cmd:"pwd; echo LEAK=${LEAK:-<unset>}; ps -o pid,ppid,args -p $$ -p $PPID"}
> > /tmp
LEAK=1
    PID    PPID COMMAND
3636410 3636266 bash -s
3637160 3636410 bash -s
[pty:pty-i9ad · … · cwd /tmp · env +LEAK ~OLDPWD,~PATH,~PWD,~SHLVL · exit 0 · 0.1s]
```

- 后续 exec 实际由**残留的交互式 `bash -s`** 执行（`$$`=3637160 为 `bash -s`，父 3636410 也是 `bash -s`），
  原会话 shell 3636266 被阻塞在 `{ bash -s ; }` 包装上；
- 脚本里的 `cd /tmp` 与 `export LEAK=1` 从此对外表现为「会话的」cwd/env（与 surface 承诺
  “cd/export never affect the parent shell” 的可观察结果相反）；
- 再次执行 `scriptPath` 会继续嵌套 `bash -s`（本次出现两层）；
- SIGTERM 无法结束残留（交互式 bash 忽略 SIGTERM），只能 SIGKILL 两个 shell 后才恢复：
  `PID=3636266 PPID=3636265 /home/u1 LEAK=<unset>`。

**根因（源码核对）**：`input.ts` 对 `scriptPath` 生成 `cmd:"bash -s"`、`stdin = 脚本全文 + 业务 stdin`；
PTY lane 先写 `wrapPtyCommand`（`{ bash -s ; } ; …`）再把整段作为 startup stdin 写入 tty
（`pty-session.ts:271-272`）。`bash -s` 在 tty 上会被 bash 判定为**交互式 shell**：脚本读完不会退出，
而是停在提示符继续读命令；包装命令因此永不完成、永不发 nonce 帧。`job_kill` 的 `\u0003` 只中断
交互式 bash 的当前输入行，shell 存活并继续充当 tty 的读取者。
机制旁证（宿主，独立于本工具）：`printf 'echo A\n' | bash -s` 非交互、读完即退出；同一输入经 `script -q -c 'bash -s' /dev/null` 置于 pty 上则出现 `u1@homepc:…$` 提示并持续读命令——差别只在 stdin 是否为 tty。

**影响**：spec §1 承诺的「PTY 中为子进程」用例实际不可用；一次调用即可让该 PTY 进入不可自恢复的
错位状态（会话状态被脚本污染），且模型面的 `status` 仍显示可用的 `idle`，属于静默状态失真。

**建议（未实施，供下一轮决策）**：把脚本落成目标端临时文件后执行（`bash /tmp/…`），或显式在脚本尾部
注入 `exit`/EOF 并让子进程不进入交互模式；并加回归：PTY 下任意 `scriptPath` 必须在无 stdin 时也结算。
在修复前，surface 应如实披露「PTY 下 scriptPath 不受支持/会挂起」而不是宣称 works alike。

---

### F2（中高）`scriptPath` 的脚本载体与业务 stdin 未真正分离

**复现（oneshot）**：`/tmp/fp-acc/read.sh` = `#!/bin/bash` + `read -r line` + `echo "READ:GOT:[$line]"`；
`exec {target:"ssh:dev3", mode:"oneshot", scriptPath:"/tmp/fp-acc/read.sh", stdin:"hello-oneshot\n"}`：

```
[runner superd-run 0.3.1-d.b596 (x86_64-unknown-linux-musl) · exit 127 · 0.2s]
[stderr]
bash: line 3: hello-oneshot: command not found
```

即 `read` 吃掉了脚本自己的下一行（echo 行），业务 stdin 落到 bash 解析器里被当成命令执行。
PTY 下同样如此，且已直接观测到：`exec {target:"ssh:dev3", scriptPath:"/tmp/fp-acc/s1.sh", stdin:"echo FROM-BUSINESS-STDIN\n", timeout:3}` 的输出为
`S1-FROM-SCRIPT` / `S2-FROM-SCRIPT` / **`FROM-BUSINESS-STDIN`**——业务 stdin 被交互式 `bash -s` 当成命令执行（随后照例挂起，见 F1）。

**边界**：既有报告验证的形状是「脚本最后一行 `cat`」——那时脚本已被读完，`cat` 恰好读到剩下的业务 stdin，
所以看起来成功；任何在脚本中途消费 stdin 的程序（`read`、`while read`、`cat` 在中间）都会遇到上述问题。

**影响**：与 spec §1「可与业务 stdin 共用（载体与 stdin 分离）」不符。更值得警惕的是**数据被当成命令执行**：
如果业务 stdin 是外部数据（日志、用户输入），其中任意一行都会被目标 shell 执行。

**建议**：真正的分离应把脚本作为独立载体（目标端临时文件或 `bash -c` 的 argv 载体），业务 stdin 只接
该脚本进程的 fd0；并补「脚本中途 read」的回归（oneshot 与 PTY 各一）。

---

### F3（中）`run_in_background:true` + `scriptPath` 丢失脚本载体

**复现 A（带 stdin）**：

```
exec {target:"ssh:dev4", run_in_background:true, scriptPath:"/tmp/fp-acc/s1.sh", stdin:"echo FROM-BUSINESS-STDIN\n"}
→ Started remote-a7908196679f4ee2 on pty:pty-b0gw (ssh:dev4). …
→ background job remote-a7908196679f4ee2 (remote: pty:pty-b0gw: undefined) finished
  [status: failed, [E_STDIN_WITHOUT_CMD] remote: stdin requires cmd]. No new output.
```

**复现 B（不带 stdin）**：

```
exec {target:"ssh:dev4", run_in_background:true, scriptPath:"/tmp/fp-acc/s1.sh"}
→ Started remote-df6bd50b286c4fac on pty:pty-b0gw (ssh:dev4). …
→ background job remote-df6bd50b286c4fac (remote: pty:pty-b0gw: undefined) finished
  [status: failed, pty dispatch did not hand off a running job]. No new output.
```

**根因**：`driver.ts:767 preparePtyLane` 先 `prepareRemoteInput` 得到 `prepared.cmd='bash -s'` / `prepared.stdin=脚本+stdin`，
但随后用局部 `target(id)` 重建 lane 输入时取的是 `params.cmd`/`params.stdin`（这里是 **undefined / 业务 stdin**），
丢掉了 prepared 的载体。`jobs.ts:43-44` 再把这个 lane 输入交给 `driver.call`：
带 stdin 时在参数校验处抛 `E_STDIN_WITHOUT_CMD`；不带 stdin 时 `pty-selector` 无 cmd 走 `cardReceipt`，
`r.running` 不为真 → job 以 `pty dispatch did not hand off a running job` 收场。脚本从未执行。

**影响**：surface 明确允许 `exec with cmd/scriptPath` 使用 `run_in_background`；实际该组合要么报错、
要么「Started」之后失败，且首条回执会让模型以为任务已开始（后台路径不可回滚）。

**建议**：lane 输入应使用 `prepared`（或至少 `prepared.cmd`/`prepared.stdin`）；补两条回归（bg+script 带/不带 stdin）。

---

### F4（低）原始 `\u0003` 写入手工 Ctrl-C 后 job 卡在 running，直到 `job_kill`

**复现**：`exec {target:"pty:pty-i9ad", cmd:"cat", run_in_background:true}`
→ `Started remote-6e440049e3a549ee …`；随后
`exec {target:"pty:pty-i9ad", stdin:"\u0003", commandId:"remote-6e440049e3a549ee"}`
→ `wrote 1 byte …`。远端 `cat` 已被中断、shell 回到提示符（宿主 `ps` 可见 shell `TPGID`=自身、无 `cat`），
但 `job_output` 持续 `[status: running]`、`status {target:"pty:pty-i9ad"}` 持续
`busy (a command is running) … running: remote-6e440049e3a549ee`，直到
`job_kill` 的两段式中断才结算：`[status: killed]`、`text '^C\n'`、card 回 `idle 6s (connected)`。

**解释**：行规程把 `\x03` 送给前台 pgrp，交互式 bash 取消当前命令行（包装的帧尾因此未执行）；
ordinary `job_kill` 会在宽限期注入 130 帧，所以能收尾，而 raw 写入没有这条补偿。

**影响**：surface 把 `"\u0003"` 写成 Ctrl-C 字面字节；模型照做后可能长时间误以为命令仍在跑
（会话本身未损坏，`job_kill` 可恢复）。可在 surface 说明「raw Ctrl-C 之后用 job_kill 结算」，
或让 stdin-only 写入实现观察 `\x03` 并走两段式收尾。

---

## 4. 模型可见 surface 核对

- **action 枚举**：`["exec","handoff","add","status","close"]`——`input` 已不存在（宿主 schema 直接拒绝）。
- **exec 参数**：`target, cmd, stdin, scriptPath, timeout, run_in_background, mode, commandId`；
  `cmd`/`scriptPath` 互斥；PTY stdin-only 不接受 `run_in_background`（实测 `[E_PARAMS] remote: a raw stdin write cannot go background`）。
- **`run_in_background` 双层表述**（逐字来自真实 schema）：
  `the command went async (not bash &) — a running job returns immediately and a completion notification will follow, so no polling is required. Oneshot runs async; on a machine's default PTY the framed command starts and that PTY is handed off in the same operation; on an addressable PTY it keeps its identity. job_output reads the command's full stream from byte 0 (overlap with the pre-handoff receipt is expected); job_kill cancels.`
  → 与 spec §4 三轮-2 一致；本轮 P9 实测「完成通知真实送达」。
- **「字节 0」的边界（user 2026-11-01 复核）**：job registry 条目与输出源都是**当前这条命令**，不是整个 PTY 会话。
  每次 `dispatch` 命令作用域内新建 ring（`pty-session.ts:196`），job 的 `read(fromByte)` 绑该命令 ring（`jobs.ts:14` → `holder.job`）；
  首读的 0 = 本命令输出起点（**含** handoff 前已展示字节，属已裁决冗余），**不含**此前命令，也不存在会话累计缓冲。
  第一人称旁证：`pty-tlet` 上一条命令的 `pwd/mark=` 未在 TICK job 首读中重放；`pty-i9ad` 的 `READY`/交互输出未在 BG job 首读中重放。
  若单条命令输出超过 4M UTF-16 units/stream，0 退化为该命令 retained tail + 丢失披露，仍不跨命令。
- **配额不预先披露**：tool description 与参数 schema 中不含 30 上限（grep `30` 无命中）；触顶错误才逐字披露（P19）。
- **handoff 输出**：结构化含 `session/connection/cwd/created/ttlSec`（fresh）与 `running/commandId`（busy），
  与 spec §5 最小增量一致；渲染文本不显示 `exit/stdout/envDelta`（无命令执行），符合预期。
- **`close` 无 job 字段**：schema 只有 `target/force`；传 `job` 由 action 字段集校验明确拒绝并指向 `job_kill`（P26）。

---

## 5. Ensure 基线抽查（未修改且证据有效）

| 区域 | 本轮证据 |
| --- | --- |
| PTY 结果解析字段 | 回执保留 `cwd`、`envDelta`（仅变量名/标记：`+FP_MARK,+OLDPWD ~PWD`）、`idle-left`、`exit`、`durationMs`、`session`、`commandId`、`jobId`；stderr 合并与终端 echo 原样出现（F1 的脚本输出可见） |
| envDelta 只列名字 | `env +LEAK ~OLDPWD,~PATH,~PWD,~SHLVL` / `-LEAK,-OLDPWD`——只给名字与增删标记，无值 |
| busy 拒新 cmd / stdin-only | 被占用的会话上新 exec 会被拒（F4 的 card 引导）；stdin-only 成功写 exact bytes；空串 0 字节 |
| job 三路 | timeout 收养（P6）、显式 handoff（P6）、`run_in_background`（P8-P10）共用官方 job；`job_kill` 后 shell 存活（`SHELL-SURVIVED; pwd` 回执 `exit 0`） |
| 会话寻址 / BYO / close 幂等 | `pty:<id>` 与 label（`pty:fpbyo`）均可寻址；BYO spawn/ssh 可注册；close 已关闭对象给 `already-closed-or-reaped` 语义路径（代码 758/817） |
| oneshot | stdout/stderr 分流、exit verbatim、无 shell 状态、runner 监督披露、startup stdin 不上 PTY（P15） |
| roster 按需 | 无 target 的 roster 立即返回、只读本机（ssh config/docker/incus/hub），无拨号；外部 docker 变更下次扫描可见（P22）；`status {target}` 才探测（P4） |
| 15m TTL | 常量 900s；回执 `idle-left ~15m`；真实回收见 §7 |
| transfer | copy 往返、native-exit-only 回执、sha256 一致（P30） |
| runner/留存 | `superd-run 0.3.1-d.b596 (x86_64/aarch64-…)` 如实披露版本与 triple；未触发 retention 驱逐，未验证丢失披露（既有测试承载） |
| 移除项 | `input`、`:pty`、`close {job}` 三处教学正确（P26） |

---

## 6. 与既有报告的关系

| 既有报告结论 | 本轮对照 |
| --- | --- |
| 「spec §8 全部场景闭环」 | 主干（默认/handoff/后台/stdin/oneshot/BYO/close/配额/隔离/MUX）本轮独立复现通过 |
| 「script+stdin：oneshot `echo.sh` + `cat` → `SC:GOT:hello`」 | 同一形状的**边界**确认存在：脚本末行消费 stdin 才行；中途 `read` 会把脚本自己的下一行吃掉、业务 stdin 被当命令执行（F2）。既有证据不足以支撑「载体与 stdin 分离」的规格表述 |
| 「PTY 脚本为子进程由 wrapPtyCommand 既有机制承载」 | 实测不成立：`bash -s` 在 tty 上变为交互式，永不结算；超时后残留 shell 接管会话（F1） |
| （未覆盖）`run_in_background` + `scriptPath` | 实测脚本载体在占位 lane 中丢失，脚本从未执行（F3） |
| 「模型上报 4 处分歧均非回归」 | 其中 `handoff` 拒绝 `pty:` 目标、`exec` 无 payload 报 `E_PARAMS`、`spawn` 归 `add`、MUX 速度不可见——本轮同样观察且与设计一致，定性不变 |

结论：既有报告的**主干判定仍然成立**；但其「script+stdin / PTY 脚本」的覆盖结论过宽，
本轮把该区域的真实边界与 3 个缺陷（F1–F3）补齐，并另记 1 个 raw-Ctrl-C 观察（F4）。

---

## 7. 清理与当前状态

- 本轮创建的全部 PTY 会话已关闭；`status {}` 末态 `pty sessions: none`（TTL 探针已被回收，见下）。
- 本机 docker 探针容器 `fp-roster-probe` 已删除；`/tmp/fp-acc`（本机与 dev3）已清理；
  dev3 上无残留 `bash -s`/`cat`（原 hang 的两层 shell 已 SIGKILL 并验证会话恢复）。
- BYO ssh 标签（`fpacc`）与 Agent B 的 `childbyo` 属按 Agent 分区的注册项，保留不影响 roster 干净度。
- MUX 生命周期（收线复核）：20:39 时本 Agent 目录 `8862380b` 已**空**（socket 于 20:35 被 unlink）且 `ps` 无任何 `[mux]` master——最后使用约 20:25，`ControlPersist=600` 到期自退、socket 自动清理；Agent B 的目录 `f03b5c5c` 在其 agent 结束后整体删除（dispose `-O exit` + 删目录）。master 生效期间 PPID=init，与客户端组完全脱钩。
- **TTL 真实边界（实等，非推算）**：20:23:28 通过 `add {spawn:"bash -i", target:"ttlprobe"}` 建 1 个纯闲置会话
  （`pty:pty-5rcb`），期间不做任何调用；20:38:51（满 15m23s）回查 `status {target:"pty:ttlprobe"}` →
  `[E_NO_SESSION] remote: no live PTY under label "ttlprobe" — … idle sessions are reaped after 15 min`，
  `exec pty:ttlprobe` 同样 `E_NO_SESSION`，roster 末行 `pty sessions: none`——15 分钟闲置回收为真实边界。
- 生产红线：未触碰 `~/.dsh`、`~/.superd`、3080/3081、live Caddyfile；4999 三 unit 保持运行。

---

## 8. 建议下一步

1. **F1 优先**：先决定修实现还是收窄 surface。若保留 PTY `scriptPath`，建议目标端临时文件 + 非交互
   执行，并加「无 stdin 也必须结算」的回归；若本轮不修，至少在 description/示例中如实标注。
2. **F2**：把脚本载体与业务 stdin 真正分离（同一根因与 F1 一起修）；补「脚本中途 `read`」双 lane 回归。
3. **F3**：`preparePtyLane` 改用 `prepared.cmd/stdin`；补 bg+script 两用例（带/不带 stdin）。
4. **F4**：surface 补一句「raw Ctrl-C 后用 job_kill 结算」，或让 stdin-only 对 `\x03` 走两段式收尾。
5. 以上修复完成后，本轮 `docs/test-reports/` 的独立复测可作为回归基线（重点复跑 §3 的 4 条复现）。

---

## 附：本轮关键调用（可复跑）

```json
{"action":"exec","target":"ssh:dev3","cmd":"hostname; pwd; cd /tmp && export FP_MARK=fp-ok; echo mark=$FP_MARK"}
{"action":"handoff","target":"ssh:dev3"}
{"action":"exec","target":"ssh:dev3","cmd":"for i in 1 2 3 4 5 6; do echo TICK$i; sleep 1; done; echo BUSY-DONE","timeout":2}
{"action":"handoff","target":"ssh:dev3"}
{"action":"exec","target":"ssh:dev3","cmd":"for i in 1 2 3; do echo BG$i; sleep 2; done; echo BG-END","run_in_background":true}
{"action":"exec","target":"pty:pty-i9ad","cmd":"bash -c 'read -p \"x? \" x; read -p \"y? \" y; echo GOT:$x/$y'","run_in_background":true}
{"action":"exec","target":"pty:pty-i9ad","stdin":"alpha\n","commandId":"remote-1de07f6702984640"}
{"action":"exec","target":"ssh:dev4","mode":"oneshot","run_in_background":true,"cmd":"sleep 2; echo ONE-BG-DONE"}
{"action":"add","target":"pty:fpbyo","spawn":"bash -i"}
{"action":"add","target":"fpacc","ssh":{"host":"dev3.internal.test","user":"u1","key":"~/.ssh/id_key2"}}
{"action":"close","target":"pty:pty-cklt","force":true}
{"action":"close","target":"ssh:dev4","job":"remote-x"}
{"action":"exec","target":"ssh:dev4","scriptPath":"/tmp/fp-acc/s1.sh","run_in_background":true}
{"action":"exec","target":"ssh:dev3","mode":"oneshot","scriptPath":"/tmp/fp-acc/read.sh","stdin":"hello-oneshot\n"}
```

---

## 9. 追加复核（2026-11-01 22:39，0.3.3-d 修复轮后）：字节 0 边界重测

> 触发：修复轮（[2026-11-01-remote-default-pty-c-d-fix-round.md](2026-11-01-remote-default-pty-c-d-fix-round.md)）已把 `scriptPath` 载体改为 `bash -c`、修复 F1–F4；rig 于 22:33 重启为新构建。本问复核「PTY handoff 后首次 `job_output` 的字节 0 是否 = **当前命令**边界、而非 PTY 会话累计」。

### 9.1 构建身份（确为修复后运行时）

| 项 | 实测值 |
| --- | --- |
| 安装态 | `better-dsh 0.3.3-d`、`super-dsh 0.3.3-d` |
| 叶哈希 | better `lib/remote/plugin.js` = `1363f808f41d83eee25718e93731e709b9a5f5c9212724715409c5fdf7943472`；super `remote/plugin.js` = `24d8b37cf95f25a1c9cfda1713e4a09f7cee12882b4961f93fdebfd2e2cafa47` |
| surface 标记 | 安装叶含新增披露 `Known defect: startup stdin is NOT reliably delivered to a background command`（1 处） |
| 行为自证 | PTY `scriptPath: /tmp/fp2/read.sh` + `stdin:"hello-d2\n"` → `'D2-GOT:[hello-d2]\n' · exit 0 · pty:pty-ylaf`（旧 0.3.3-b 会 120s 挂起）；oneshot 同脚本 → `D2-GOT:[hello-d2-oneshot]`、exit 0 |

### 9.2 代码复核（修复未改变输出作用域）

- `pty-session.ts:196`：`const ring = new Utf16TailRing(OUTPUT_HARD_CAP)` 仍在**每次 `dispatch` 的命令作用域内**新建；`:209` 的 `PtyRunningJob.read = (fromByte) => ring.read(fromByte)` 绑定的就是该命令 ring。
- `jobs.ts:12-14`：PTY job 输出源 `holder.job?.read(fromByte)`；`jobs.ts:45` 在启动时 `holder.job = r.ptyJob`（本次 dispatch 的命令 job）。
- `driver.ts:831 attachPtyJob` / `jobs.ts:84 adoptRunningPtyJob` 只做「commandId ↔ registry jobId」映射与接管，不改变输出源。
- 修复轮的两处改动与本问无关：`input.ts` 的 `bash -c` 载体只换命令注入方式；`pty-session.ts` 的「framed cmd + startup stdin 单次 write」只改到达时序。ring 的创建/绑定/读取路径未动。

### 9.3 第一人称重测证据（真实模型调用，逐字）

**路径 A：同步超时置忙 → 显式 busy handoff → 首读**

```text
A（同 PTY 的前一条命令）: pty:pty-63jy  →  A1-PRIOR\nA2-PRIOR
B（同 PTY，timeout:1）: session=pty:pty-63jy commandId=remote-54cd1a8dd68e4e6a jobId=remote-d6161ef404e64bfd running=true
HANDOFF: handed off pty:pty-63jy — ssh:dev3 / detached / this machine's next exec opens a fresh default PTY /
         still running: command remote-54cd1a8dd68e4e6a — follow with job_output remote-d6161ef404e64bfd, cancel with job_kill
J1-FIRST: 'B1-CMD\n' [running]        ← 只到 B 的起点；A 的 4 行未重放
J2-SECOND: 'B2-CMD\n' [completed]     ← 增量游标
C（新默认会话）: pty:pty-tf0n → C1-NEXT-COMMAND
J3-AFTER-NEXT-CMD: '' [completed]      ← B 的 job 仍只含 B 自己的字节
```

**路径 B：`run_in_background:true`（同操作 handoff）→ 首读 → 同会话后续命令**

```text
P（背景 job 之前的同 PTY 命令）: pty:pty-tf0n → P1-PRIOR\nP2-PRIOR
K: session=pty:pty-tf0n commandId=jobId=remote-9fe063aeee4b47e7
   Started remote-9fe063aeee4b47e7 on pty:pty-tf0n (ssh:dev3). … completion is reported by the host.
R（新默认）: pty:pty-ylaf → R1-NEW-DEFAULT
K-FIRST: 'Q1-BG\n' [running]          ← 只到 K 的起点；P 未重放
K-SECOND: 'Q2-BG\n' [completed, exit code: 0]
S（在被 handoff 的 pty:pty-tf0n 上再跑命令）: → S1-AFTER-BG-ON-SAME-SESSION
K-AFTER-S: '' [completed]              ← 后续命令的字节没有进入 K 的 job
```

### 9.4 结论（修复轮后不变）

1. **字节 0 = 当前命令输出起点**，不是 PTY 会话累计；本会话先前的 `A1/A2`、`P1/P2` 均未在后续 job 首读中出现。
2. 「0」**包含同一命令在 handoff 之前已产生的字节**（如 `B1-CMD`、`Q1-BG`）——已裁决冗余，不是会话历史。
3. 已完成的 job 在后续新命令执行后仍只暴露自己的 ring（`J3=''`、`K-AFTER-S=''`），不会把新命令输出并入旧 job。
4. 输出上限仍是**每条命令** ring 的 4M UTF-16 units；超限时 0 退化为该命令 retained tail + 丢失披露，不跨命令。
5. 工具值只暴露 `{text, job}`（无 `nextOffset` 字段）；重复 `job_output` 的增量行为（`B2`/`Q2` 单独出现、settled 后为 `''`）证明宿主 registry 的内部 byte cursor 在同一命令 ring 上连续推进。
6. 收线：本轮 3 个会话（pty-63jy / pty-tf0n / pty-ylaf）已关闭，`status {}` 末态 `pty sessions: none`；本机与 dev3 的 `/tmp/fp2`、`/tmp/fp-acc` 已清理；dev3 无残留 `bash -s`。本复核**未改源码**，只新增本节与文首指引。
