# 0.3.2-c 复测：remote PTY 与 Hub PTY 第一人称实测

日期：2026-10-26（Asia/Hong_Kong）。被测版本：`0.3.2-c`（root / better-dsh / super-dsh 同步）。
上下文：0.3.2-b 的 [interactive-stdin 报告](2026-10-25-remote-interactive-stdin.md)；本轮 c 的变更与自述见 [hub remote parity 报告](2026-10-25-hub-remote-parity.md) 与 [计划](../10_plans/2026-10-25-hub-remote-parity.md)。本轮**未 commit / tag / push，未 npm publish**。

**性质**：本报告由执行实测的 DSH agent 本人写。所有标为「我实测」的步骤，都是本会话通过 PC 4999 安装线的 `remote` 工具亲手调用、亲眼看回执；hub 侧的对端是既有 mesh pairing `hub:bfwu`（DEV3）。被测对象是已安装的 `0.3.2-c` 整包产物，另核验了「源码构建 == tarball == 安装态」的哈希链。

---

## 0. 结论

1. **remote PTY（ssh / docker）在 c 上通过，无回归**：交互主链路（提示 → `input` → 下一提示 → `input` → 完成）、超时 handoff 后继续 `input`、立即 `E_SESSION_BUSY`、`commandId` 守卫、状态持久、clean `job_kill`（`exit 130`、会话存活）、idle/closed 拒写、close/roster 都按 b 的语义工作。
2. **hub PTY 的「会话化」大体成立**：`hub:bfwu:pty:r2hub` 有 id/label/connection、提示可见后 `input` 可补输、`ACCEPTED` 后 `exit 0`、cwd/env 跨调用存活、busy 四出路、超时 handoff、`runner hub-lease` 披露、close/card/roster 都在。
3. **但 hub lane 的「控制字节」通道是坏的（本轮新发现，F4）**：本地 `script` 包装只做了 `stty -echo`，没有 raw；`^C` / `^D` 先被**本地**终端行规程消费（SIGINT 打死 pump / EOF 结束 pump stdin），于是 `input` 的 `^C`/`^D` 与 `job_kill` 都会把**整条会话**打死（`session died`），下一次 dispatch 只能重连到新 shell。因此 c 报告「与其他 transport 逐动作同形」的结论对中断/EOF 这条支线**不成立**。
4. **b 轮 F1/F2 在 c 上仍复现**：`pty-session.ts` 自 b 以来零改动（`git diff 878d338..2cae01c -- better-dsh/src/remote/pty-session.ts` 为空）；裸 `^C` 后 job 永久 running，随后 `job_kill` 吃 marker 首字节 → `Command 'rintf' not found` → `session died`。
5. **不建议以现状发布**。建议 `0.3.2-d`：先修 F4（一行 wrapper + 回归钉），同时决定 F1/F2/F3 是否一并处理；见 §4.5。

---

## 1. 现场与证据链

| 项 | 实测值 |
| --- | --- |
| 版本（root/better/super） | `0.3.2-c` 同步 |
| better-dsh tarball | `.scratch/superd-pack/better-dsh-0.3.2-c.tgz`，SHA-256 `f38db7c3e2cfb66eda4ede1343229cbfc9afaccfd8172df8d7258ab1fefe375d` |
| super-dsh tarball | `.scratch/superd-pack/super-dsh-0.3.2-c.tgz`，SHA-256 `61ed2a90dd247c44b5d4590e51a52f6978273c06600aca994d985b097d1a8bc4` |
| `pair.json` | 两包哈希与 tarball 一致，`builtAt=2026-10-25T16:36:50.131Z` |
| **哈希链** | 源码构建 `better-dsh/lib/remote/plugin.js` = tarball 内 `package/lib/remote/plugin.js` = 安装态 `.tests/superd/profiles/superd-pub/node_modules/better-dsh/lib/remote/plugin.js`，三处同为 `54e3908330fb3c77dfaddafad4269155b78a430824dac3da28fdb70bbe9641bf` |
| PC 4999 安装线 | `DSH_HOME=/home/u1/workspaces/superd/.tests/superd`，profile `superd-pub`，PID `3441071`（started 2026-10-26 00:38:16），`root=200` / 匿名 API `401`，URL `https://test.pc.internal.test/` |
| dev3 4998 安装线 | PID `2034060`（bin 为 `dsh-0.2.1-rc.1-install`，`--profile superd-pub --port 4998`）；better/super 均 `0.3.2-c`；安装态 `plugin.js` 同为 `54e3908…`；`root=200` / 匿名 `401` |
| hub 目标 | `hub machines: hub:bfwu (DEV3), hub:skc8 (homepc)`；本轮只拨 `hub:bfwu`（满足「有可达 peer」） |
| better-dsh 单测 | `vitest run test/remote`：**241 passed / 8 skipped / 0 failed**（30 文件过 + 1 环境门 skip，128.67s） |
| superd-hub 单测 | `node --test`（`npm test`）：**644 tests / 643 pass / 1 skip / 0 fail**（77.29s） |

> 说明：c 报告称其真实模型验收已在 PC 4999 完成；本轮不转述其结论，而是重新跑一台安装线、重新拨 hub 对端，独立取回执。

---

## 2. remote PTY（`ssh:dev3`）：c 上逐项复测

### 2.1 交互主链路（background + 两次 input）

| 步 | 调用 | 回执（关键原文） |
| --- | --- | --- |
| 1 | `exec target:"ssh:dev3:pty:r2login"`，命令 `printf 'Password: '; read -r a; printf 'OTP: '; read -r b; printf 'ACCEPTED %s/%s\n' "$a" "$b"`，`run_in_background:true` | `Started remote-a8bc79955de84bc2 on pty:pty-4ja9 (r2login) (ssh:dev3).` |
| 2 | `job_output remote-a8bc79955de84bc2` | `Password:` / `[status: running]` |
| 3 | `input target:"pty:pty-4ja9" stdin:"demo\n"` | `wrote 5 bytes into pty:pty-4ja9 for command remote-a8bc79955de84bc2 — this confirms the write, not the program's response; read the response with job_output remote-a8bc79955de84bc2` |
| 4 | `job_output`（同 job） | `OTP:` / `[status: running]` |
| 5 | `input stdin:"123456\n"` | `wrote 7 bytes …` |
| 6 | `job_output`（同 job） | `ACCEPTED demo/123456` / `[status: completed, exit code: 0]` |

同会话继续执行 `cd /tmp && pwd && echo STATE-OK`：

```
/tmp
STATE-OK

[pty:pty-4ja9 (r2login) · conn ssh:dev3 · cmd remote-a5908bfde5c340ac · cwd /tmp · env +OLDPWD ~PWD · idle-left ~15m · exit 0 · 0.1s]
```

结论：文本交互、字节计数、不回显、同 job 读取、shell 与 cwd/env 持久，全部与 b 一致。

### 2.2 超时 handoff 后继续 input + `commandId` 守卫（ssh）

`exec` 同一夹具、`timeout:3` → handoff：

```
Password:
[pty:pty-k4nn (r2hand) · conn ssh:dev3 · cmd remote-bcf6b6a6577146e2 · idle-left ~15m · exit null · 3.8s · still running — poll job_output remote-a747875101094117]
```

- 错 `commandId` 先试：`[E_COMMAND_MISMATCH] remote: commandId "remote-0000000000000000" does not match the running command remote-bcf6b6a6577146e2 — input aimed at an earlier prompt is never written to the next command`
- 正确 `commandId` + `demo\n` → `wrote 5 bytes`，`job_output` → `Password: OTP:`；`123456\n` → `wrote 7 bytes`，`job_output` → `ACCEPTED demo/123456` / `[status: completed, exit code: 0]`。
- 完成后对同一会话 `input` → `[E_SESSION_NOT_RUNNING] remote: pty session 'pty:pty-k4nn' has no running command (state ready) — input writes into a command started by exec; it is never an implicit shell command`。

### 2.3 busy 与 clean `job_kill`（ssh）

- `sleep 25`（background）后立刻 `exec "echo SHOULD-NOT-RUN"`：

  `[E_SESSION_BUSY] remote: pty session 'pty-4ja9' still runs a command (remote-f9040170a8c8415e) — send it more stdin with the input action, follow its output via job_output remote-f9040170a8c8415e (a synchronous exec hands its job off there on timeout), cancel with job_kill remote-f9040170a8c8415e, or address other work to another session / oneshot`

- `job_kill` → `[status: killed, interrupted: exit 130; clear running sleep to continue PTY acceptance]`
- 再 `exec "echo ALIVE-AFTER-KILL"` → `ALIVE-AFTER-KILL`（cwd 仍 `/tmp`，会话存活）。

### 2.4 docker lane 回归（c 的改动不应影响非 hub 通道）

`docker:corti:pty:r2dock`，`printf 'Q: '; read -r x; printf 'A=%s\n' "$x"`（background）→ `Q:` → `input "ok\n"` → `wrote 3 bytes` → `A=ok` / `[status: completed, exit code: 0]`。close 正常。

结论：`ssh` / `docker` 两条通道在 c 上无回归。

---

## 3. hub PTY（`hub:bfwu`，DEV3）：c 的会话化实测

### 3.1 创建、身份、提示 → input → 完成

| 步 | 调用 | 回执 |
| --- | --- | --- |
| 1 | `exec target:"hub:bfwu:pty:r2hub"`（同一夹具，`run_in_background:true`） | `Started remote-4465f93240c74e33 on pty:pty-vlpu (r2hub) (hub:bfwu).` |
| 2 | `job_output` | `Password:` / `[status: running]` |
| 3 | `input "demo\n"` | `wrote 5 bytes …` |
| 4 | `job_output` | `OTP:` / `[status: running]` |
| 5 | `input "123456\n"` | `wrote 7 bytes …` |
| 6 | `job_output` | `ACCEPTED demo/123456` / `[status: completed, exit code: 0]` |

状态持久（同一会话 foreground dispatch）：

```
/tmp
STATE-OK

[pty:pty-vlpu (r2hub) · conn hub:bfwu · cmd remote-276f4645a870480f · cwd /tmp · env +OLDPWD ~PWD · idle-left ~15m · exit 0 · 0.1s]
```

### 3.2 busy 与 handoff

- `sleep 20`（background）后 `exec "echo SHOULD-NOT-RUN"` → 与 ssh 同文的 `[E_SESSION_BUSY] … still runs a command (remote-f352edcaf7d34000) …`（四出路）。
- `sleep 30`、`timeout:2` → handoff：

  `[pty:pty-vlpu (r2hub) · conn hub:bfwu · cmd remote-c911b7b498904bd6 · idle-left ~14m · exit null · 2.0s · still running — poll job_output remote-f5f25563317149ac]`

### 3.3 runner 披露（c 的新 surface）

`exec target:"hub:bfwu" cmd:"uname -n; echo HUB-ONESHOT-OK"`：

```
srv1637772
HUB-ONESHOT-OK

[runner hub-lease (peer bash -lc, peer Node supervision) · exit 0 · 0.0s]
```

`timeout:1` 的 `sleep 8` 观察（非阻塞项，如实记录）：

```
[runner hub-lease (peer bash -lc, peer Node supervision) · interrupted · exit null · 3.1s]
```

即对端按 TERM→2s→KILL 结算，客户端在 ~3.1s 收到；c 报告 §2 的「1008ms 结算」是另一条（客户端租约/双钟）观察点，两者不矛盾，但也不要把 1008ms 当成这条例子的实测值。

### 3.4 close / card / roster

- 运行中 close（不带 force）：`[E_SESSION_BUSY] remote: pty session pty-l90k still runs a detached command (remote-8ed7d661440b4e4e) — job_kill remote-8ed7d661440b4e4e first (or wait for it), then close again; force:true closes the tab and kills the group in one step`
- `close force:true`：`closed pty:pty-l90k (hub:bfwu) — killed running job remote-8ed7d661440b4e4e`；该 job 随后报 `[status: failed, session died]`（见 §4.4 的观察）。
- 幂等：再次 close（已关的 `pty-vlpu`）→ `pty-vlpu: not closed (not-found) — no pty session is registered under "pty-vlpu"`。
- card 可见 connection/label/ledger；roster 结束后 `pty sessions: none`。

---

## 4. 缺陷 F4：hub lane 的控制字节打死会话

### 4.1 四条观测（全部可重复）

| # | 场景 | 我看到的 |
| --- | --- | --- |
| 1 | hub 会话跑 `sleep 60`（background），`input` 真 `0x03`（回执 `wrote 1 byte`） | job 约 1.6s 后 `{'status': 'failed', 'detail': 'session died'}`；下一次 `exec` 返回 `[remote: session reconnected to fresh shell; cwd reset to default]`，随后 `echo ALIVE-AFTER-CTRL-C` 在新 shell 成功 |
| 2 | hub 会话跑 `cat`（background），`input` 真 `0x04`（`wrote 1 byte`） | 同上，约 1.7s 后 `failed / session died` —— 远端 `cat` 根本没收到 EOF |
| 3 | hub 会话 `sleep 20`（background），`job_kill` | `[status: killed, interrupted: session died; hub pty busy-path cleanup]`；下一次 dispatch 走 reconnect（cwd 重置） |
| 4 | hub 会话 `sleep 30` handoff 后 `job_kill` | `[status: killed, interrupted: session died; hub handoff kill probe]` |

对照组（同一轮、同一工具）：ssh 的 clean `job_kill` 是 `interrupted: exit 130` 且会话存活（§2.3）；b 轮已验收 ssh/docker 的 `^C` 与两步 `^D`。可见这不是「job_kill 的通用语义」，而是 hub lane 特有。

### 4.2 根因

- 本地包装（[transports.ts:78](../../better-dsh/src/remote/transports.ts#L78)）：

  ```
  ['script','-qfec', `stty -echo 2>/dev/null ; ${exportsVars} ; exec ${node} ${pump}`, '/dev/null']
  ```

  只有 `-echo`，**没有 raw / -icanon / -isig**。pump 的 stdin 是 `script` 的 pty slave，仍处于 canonical + ISIG。
- pump（[hub-pty-pump.mjs](../../better-dsh/src/remote/hub-pty-pump.mjs)）没有 SIGINT 处理器；stdin `'end'` 时直接 `socket.close()`，socket 关闭 → 对端组杀。
- 于是：`0x03` 在**本地**行规程就变成 SIGINT 打死 node pump；`0x04` 在空行变成 `read()==0`（EOF），pump 关 WS。两者都表现为「会话死亡」，而不是把字节原样送过 WS。
- 为什么 ssh/docker 没这个问题：`ssh -tt` 与 `docker exec -it` 作为 foreground 子进程会自己把本地 tty 置 raw（它们要透传控制序列）；pump 不做这件事，所以同一个 wrapper 模板在 hub lane 上语义不同。c 的注释「与 docker exec 的嵌套 PTY 同形」只在「本地 PTY 套远端 PTY」的结构上成立，漏了 raw 这一步。

### 4.3 实验室对照（只用于钉根因，不替代交付线验收）

用与产品相同的包装形状跑一个最小「pump」探针（`/tmp/hubpty-probe/pump-probe.mjs`），从管道送 `abc\n`、`0x03`、`0x04`：

```
=== raw wrapper: stty raw -echo ===
GOT "abc\n"
GOT "\u0003"
GOT "\u0004"
ALIVE-AFTER-3S
raw exit:0

=== canonical wrapper: stty -echo ===
GOT "abc\n"
SIGINT
canon-03 exit:3

=== canonical wrapper, ^D only ===
GOT "abc\n"
EOF
canon-04 exit:0
```

与线上行为一一对应：raw 时控制字节按字节到达 pump stdin；canonical 时 `^C` → SIGINT、`^D` → EOF。

### 4.4 影响与旁证

- `input` 的 `\u0003` / `\u0004` 语义在 hub lane 不可用：模型按 surface 发 `^C` 取消，实际是把 shell 一起弄死。
- `job_kill` 在 hub lane 不满足 surface 的「cancel … the session survives」；后续对话上下文（cwd/env/REPL/激活的 venv）全部丢失，只能 reconnect。
- 单键 REPL / 无换行的交互同样被 canonical 缓冲，直到换行才到对端（机制同一，本轮未单独计时）。
- 旁证（不单列为缺陷，但值得记录）：`close force:true` 杀组后，被杀的 job 报 `failed / session died`，而不是 `killed`。这来自 `ptyOutcome(aborted=false, exit=null)` 的通用路径，是否要在 `dispose` 时把 job 标成 killed 是另一个语义决定。

### 4.5 修复方向（建议 `0.3.2-d`）

1. `buildHubPtyArgv` 把 `stty -echo` 改为 `stty raw -echo`（或 pump 在首次读之前 `process.stdin.setRawMode(true)`；两者选一，需覆盖非 tty 的兜底）。
2. 对端保持 canonical（`^C`/`^D` 在**对端**产生 SIGINT/EOF 正是我们要的语义），只把本地包装变 raw。
3. 回归钉：本地包装 raw 后 `0x03`/`0x04` 原样到达 pump stdin；hub 会话 `^C` 后命令 `exit 130` 且会话存活；`^D` 两步 EOF；`job_kill` 后 session 仍 ready。
4. 修完重跑：本报告 §3 全表 + §4.1 四条 + b 报告的 F1/F2 场景。

---

## 5. b 轮 F1/F2 在 c 上的复现（未修）

`pty-session.ts` 自 b 零改动；c 只删了 `jobs.ts` 的 hub-pty background 拒绝。实测：

- **F1（裸 `^C` 卡死）**：ssh 会话跑 `sleep 60`（background），`input` 真 `0x03`（`wrote 1 byte`）→ `job_output` 只有 `(no new output)` / `[status: running]`；`exec "echo AFTER-INTERRUPT-SHOULD-RUN"` → `[E_SESSION_BUSY] remote: pty session 'pty-iiop' still runs a command (remote-568ccd6f96cb4ecf) …`。
- **F2（随后 `job_kill` 打死会话）**：`job_kill` → 输出 `^C` + `Command 'rintf' not found, did you mean: …`（注入 marker 的首字节被 SIGINT 的输入队列 flush 吃掉），job 结算为 `[status: killed, interrupted: session died; F2 dirty-path probe]`。与 b 报告 §6 的 3/3 复现同形。
- **F3（EPIPE）**：本轮未复现；`pty-session.ts` 的私有 `write()` 仍无 `stdin.on('error')`，b 的判读（异步 EPIPE 可绕过 try/catch 成为进程级 uncaught）仍适用，属未修的理论风险。

---

## 6. 未测 / 限制 / 披露

- dev3 4998 只做了**安装/健康/哈希**核验（版本、`plugin.js`、`root=200`/匿名 `401`、进程）；没有在其上再跑模型会话——该机 4998 的 dsh 是 `0.2.1-rc.1` 锚，RPC 面没有新版 `session/prompt` 网关形状（与 c 报告 §6 的判断一致）。
- `hub:skc8`（homepc）未拨测；`hub:bfwu` 已满足「有可达 peer」。
- 对端只执行了 `uname` / `echo` / `sleep` / `read` 等无害命令；PTY 会话全部 `close`；未改对端配置、文件、服务。
- §4.3 的 raw 修复只在实验室探针上验证了「raw 后控制字节到达 pump stdin」；产品侧修复需要 0.3.2-d 构建 + 重装 + 按 §4.5 重测。
- 生产环境零触碰：未动 `~/.dsh`、`~/.superd`、3080/3081、Caddyfile；4999/4998 都是既有测试线。
- 本轮未 `npm publish`、未 commit/tag/push。

---

## 7. 清理

- `remote status` 结束时：`pty sessions: none`（本轮创建的 `pty-4ja9` / `pty-k4nn` / `pty-vlpu` / `pty-2w1m` / `pty-eel4` / `pty-xk6v` / `pty-l90k` 均已 close 或自然死亡）。
- 本地临时证据目录 `/tmp/hubpty-probe/`（pump 探针与原始输出）保留，可删。
- 未在仓库留下构建产物；工作树只有本报告（以及待提交的文档改动）。

---

## 附录 A：本轮关键复现命令（模型面形状）

```text
remote {action:"exec", target:"ssh:dev3:pty:r2login", cmd:"printf 'Password: '; read -r a; printf 'OTP: '; read -r b; printf 'ACCEPTED %s/%s\\n' \"$a\" \"$b\"", run_in_background:true}
remote {action:"input", target:"pty:pty-4ja9", stdin:"demo\n"}
remote {action:"input", target:"pty:pty-4ja9", stdin:"123456\n"}
remote {action:"input", target:"pty:pty-4ja9", stdin:"\u0003"}      # 由脚本面板发送真 0x03，见下
remote {action:"exec", target:"pty:pty-4ja9", cmd:"echo ALIVE"}
remote {action:"exec", target:"hub:bfwu:pty:r2hub", cmd:"…", run_in_background:true}
remote {action:"exec", target:"hub:bfwu", cmd:"uname -n; echo HUB-ONESHOT-OK"}
remote {action:"status", target:"pty:pty-vlpu"}
remote {action:"close", target:"pty:pty-vlpu", force:true}
```

**方法说明（重要）**：直接把工具参数写成 `"\u0003"` 时，`input` 会收到 6 个**字面字符**（我实测回执是 `wrote 6 bytes`），不会变成控制字节——surface 文档说的「`\u0003` = Ctrl-C」需要调用方交出真正的 U+0003 字符。为发真字节，我通过本会话的脚本面板调用**同一个** `remote` 工具（`stdin="\x03"`），回执 `wrote 1 byte`；其余所有步骤都是直接工具调用。两种调用的工具实现、进程、会话完全相同，只是绕开了 JSON 文本层的二次转义。

## 附录 B：观察到的 verbatim 片段

```text
Started remote-a8bc79955de84bc2 on pty:pty-4ja9 (r2login) (ssh:dev3). Use job_output to read and job_kill to cancel; completion is reported by the host.
Password:
OTP:
ACCEPTED demo/123456
[status: completed, exit code: 0]

Started remote-4465f93240c74e33 on pty:pty-vlpu (r2hub) (hub:bfwu).
ACCEPTED demo/123456
[status: completed, exit code: 0]

[runner hub-lease (peer bash -lc, peer Node supervision) · exit 0 · 0.0s]

^C
Command 'rintf' not found, did you mean:
  command 'printf' from deb coreutils-from-gnu (0.0.0~ubuntu25)
  …
[status: killed, interrupted: session died; F2 dirty-path probe]
```
