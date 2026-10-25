# Remote 交互式 stdin（PTY `input`）第一人称实测报告 — 0.3.2-b

日期：2026-10-25（Asia/Hong_Kong）。计划：[remote-interactive-stdin](../10_plans/2026-10-25-remote-interactive-stdin.md)（阶段 A Task 4）。前置提交 `3a54ed0`（0.3.2-a）。本轮**未 commit / tag / push，未 npm publish**。

> 后续：`0.3.2-c` 的独立复测见 [2026-10-26-remote-pty-c-retest.md](2026-10-26-remote-pty-c-retest.md)。结论：remote PTY 无回归；hub lane 暴露新缺陷 F4（控制字节打死会话）；本文的 F1/F2 在 c 上仍复现。

**性质**：本报告由**执行实测的 DSH agent 本人**写。所有标为「我实测」的步骤，都是本会话通过 4999 测试线的 `remote` 工具亲手调用、亲眼看回执，不是读单测或转述他人会话。被测对象是**已安装的 0.3.2-b 整包产物**，不是源码树直接跑；我另外核验了「源码构建 == tarball == 安装态」的哈希链。

**结论（先说不好听的）**：主链路（启动程序 → 看提示 → 先后补输两道凭据 → 完成 → shell 存活）在真实安装产物上通过，四类通道、busy、EOF、错误面也按设计工作。但第一人称用下去暴露 3 个问题，其中两个让「中断 / 取消」这条支线变得危险：**裸 `^C` 会把会话卡成永久 busy（shell 其实已回到提示符），随后唯一的官方出路 `job_kill` 有 3/3 次把整条会话打死**（注入的 130-marker 首字节被 SIGINT 的输入队列 flush 吃掉）。因此本轮**不建议把 0.3.2-b 直接当作发布候选**，先决定 §6 的 F1/F2 是否本轮修。

---

## 1. 被测物与证据链

| 项 | 实测值 |
| --- | --- |
| 版本（root/better/super） | `0.3.2-b` 同步 |
| better-dsh tarball | `.scratch/superd-pack/better-dsh-0.3.2-b.tgz`，SHA-256 `3aafa1d0957640946bf0536f707abd266f015ef370808cde892938f8d5fbf513` |
| super-dsh tarball | `.scratch/superd-pack/super-dsh-0.3.2-b.tgz`，SHA-256 `089d3b5f9bb7cb8caab82a20e072a87dcc35c1226cf3ea77201dc3a162289e1a` |
| `pair.json` | 两包哈希与 tarball 一致，`builtAt=2026-10-25T11:45:53.856Z` |
| **哈希链** | 源码构建 `better-dsh/lib/remote/plugin.js` = tarball 内 `package/lib/remote/plugin.js` = 安装态 `.tests/superd/profiles/superd-pub/node_modules/better-dsh/lib/remote/plugin.js`，三处同为 `cffa73d60e8c2f51158c7b4d4da850ec6c7c776b17804cf7f34df0fc1c7fd549`（即：我测的就是本轮构建产物，不是旧安装） |
| 双包契约 | 直接调用 `verifyPackagePair(两个 tarball, 源码根)` → `OK`（独立包、无 Better 依赖边/物理 payload、`remote/` 闭包含 provenance 且逐叶哈希核验） |
| 安装线 | `DSH_HOME=/home/u1/workspaces/superd/.tests/superd`，profile `superd-pub`，端口 4999，PID 3163659，`SUPERD_KEEP=1` |
| remote 单测 | `vitest run test/remote`：**236 passed / 8 skipped / 0 failed**（30 文件过 + 1 环境门 skip，126s） |
| typecheck | `npm run typecheck`（host + client）0 错 |
| 根测试 | 根 `npm test`：**42/42 pass**（含独立双包 pair 校验、版本同步、pack 默认源、文档副本） |
| dev3 第二现场 | better/super 均 `0.3.2-b`；`root=200`、匿名 API `401`；安装态 plugins 含新 surface（见 §7） |

> 与上一版（实现轮留下的草稿）的关系：本文是**实测后重写**，不再复述其「双现场验收通过」「resume 检查」等未由本轮独立复核的结论；上一版可核实的 artifact 事实保留并已重新验证。

---

## 2. 模型可见 Surface（我实际看到的那份）

- `remote` 的 `action` 枚举 = `exec | add | status | close | input`（required）。
- 定位句：**"PTY IS A PERSISTENT, INTERACTIVE TERMINAL SESSION — default to it."**
- 交互主线原文：`Interactive flow (see a prompt → answer it → read the response): 1) start the program with exec + cmd ... 3) Send the answer: {action:"input", target:"pty:<id|label>", stdin:"the-answer\n"} — stdin passes through VERBATIM ... 4) Read the response with job_output on the SAME job — the input receipt only confirms N bytes were written; it never means the password was accepted ...`
- 边界句逐条在场：`"\u0003" = Ctrl-C`、`"\u0004" = Ctrl-D`、`"" writes zero bytes (not EOF)`、字面 `\x04` 不解码、stale `commandId` 拒写、`Ctrl-D is not a universal EOF`（两步语义）、`job_kill stays the explicit cancel`、one-shot stdin 仅启动时、heredoc 非强制、**Hub PTY lane has no session identity and no input lane**。
- 参数面：`commandId`（input 专用保护）、`writtenBytes`（回执字段），`input` 的 render 文本 = `wrote N byte(s) ... this confirms the write, not the program's response; read the response with job_output <handle>`。

结论：Task 3 要求的教学面不是只写到文档里，真实 catalog（本会话模型侧）逐字可见。

---

## 3. 主链路：两道提示一次命令内答完（BYOP 真终端）

| 步 | 我的调用 | 我看到的回执（关键原文） |
| --- | --- | --- |
| 1 | `add {target:"pty:login", spawn:"bash --noprofile --norc -i"}` | `registered — address it as pty:pty-le7y ...` / `[pty:pty-le7y (login) (byo-pty) · conn BYOP ...]` |
| 2 | `exec {target:"pty:login", run_in_background:true, cmd:<Password/OTP 夹具>}` | `Started remote-585bc68dcd12441e on pty:pty-le7y (login) (BYOP).` |
| 3 | `job_output remote-585bc68dcd12441e`（wait 2.5s） | `Password:` / `[status: running]` |
| 4 | 故意再发一条 `exec {cmd:"echo must-not-run"}` | `[E_SESSION_BUSY] remote: pty session 'pty-le7y' still runs a command (remote-585bc68dcd12441e) — send it more stdin with the input action, follow its output via job_output remote-585bc68dcd12441e (a synchronous exec hands its job off there on timeout), cancel with job_kill remote-585bc68dcd12441e, or address other work to another session / oneshot`（四条出路逐字在场） |
| 5 | `input {target:"pty:login", stdin:"demo\n", commandId:"remote-585bc68dcd12441e"}` | `wrote 5 bytes into pty:pty-le7y for command remote-585bc68dcd12441e — this confirms the write, not the program's response; read the response with job_output remote-585bc68dcd12441e`（**不回显 demo**） |
| 6 | `job_output` | `\nOTP:` / `[status: running]` |
| 7 | `input {stdin:"123456\n", commandId:同上}` | `wrote 7 bytes ...` |
| 8 | `job_output` | `\nACCEPTED` / `[status: completed, exit code: 0]` |
| 9 | `exec {cmd:"pwd && printf 'SHELL_MARK=%s\n' \"$((6*7))\""}` | `/home/u1/workspaces/superd` `SHELL_MARK=42`，同一会话 `pty:pty-le7y`，exit 0 |
| 10 | `status {target:"pty:login"}` | `ledger (last 2):` 只有两条命令，**两次 input 没有新增账本条目**；`idle 2s (connected)` |

凭据为自有假数据（`demo` / `123456`），夹具不回显输入（`stty -echo` 生效）：全流程输出里没有任何一处回显凭据。

---

## 4. 语义与错误面实测（同一安装产物）

| 面向 | 我实际做的 | 实测结果 |
| --- | --- | --- |
| 单字节 `^D` = EOF | `cat`（bg）→ input `"hello\n"` → `job_output` → input `"\u0004"` | `hello` + running → `wrote 1 byte` → `[status: completed, exit code: 0]` |
| 无末尾换行的两步 `^D` | `cat`（bg）→ input `"abc"`（无换行）→ `job_output`（无输出、running）→ `^D` → `job_output` → 再 `^D` | 第一个 `^D` 后出现 `abc` 且仍 `running`（只交付缓冲文字）；第二个 `^D` 后 `completed, exit 0` |
| 字面 `\x04` 不解码 | `cat > /tmp/pty-lit-x04.txt` → input `"\\x04\n"` → `^D` → `od -An -c` | 写入回执 `5 bytes`；文件内容 `\ x 0 4 \n`、`wc -c` = 5（四个字面字符 + 换行，不是控制字符） |
| 空串 = 零字节非 EOF | `cat`（bg）→ input `""`（带匹配 commandId） | `wrote 0 bytes ...`；job 仍 `running`；随后 `^D` 才 `completed` |
| UTF-8 字节数 | 裸 label 目标（`target:"killtest"`）→ input `"密码\n"` | `wrote 7 bytes`（6 字节中文 + 换行）；`job_output` 得 `密码` |
| commandId 保护 | 运行中把旧命令 id 传进去 | `[E_COMMAND_MISMATCH] ... input aimed at an earlier prompt is never written to the next command` |
| idle 时 input | 会话 ready、无运行命令 | `[E_SESSION_NOT_RUNNING] ... has no running command (state ready) — input writes into a command started by exec; it is never an implicit shell command` |
| dead 时 input，不重放 | 会话进程死亡后 input | `[E_SESSION_NOT_RUNNING] ... died — input never reconnects or replays ...`；我没有看到它自动重连或重发 |
| dead 后 exec | 同会话再 `exec echo FRESH-SHELL` | `[remote: session reconnected to fresh shell; cwd reset to default]` + 正常输出（重连语义保留） |
| 机器 / 创建形 / hub / 裸 label miss | 分别 input 到 `ssh:dev3`、`ssh:dev3:pty`、`hub:bfwu`、`hub:bfwu:pty`、`nosuchlabel` | 依次 `E_TARGET_FORMAT`（machine）、`E_TARGET_FORMAT`（creation form）、两条 Hub 例外、`E_NO_SESSION`（不触发发现/创建） |
| 参数白名单 | input 带 `cmd` / 缺 `stdin` / 空 `commandId` | 三条 `[E_PARAMS]`，文案分别指路 |
| exec 仅 stdin | `exec {target:"ssh:dev3", stdin:"x"}` | `[E_STDIN_WITHOUT_CMD] ... use {action:"input", target:"pty:<id|label>", stdin}` |
| exec 启动时 stdin 兼容 | `exec {cmd:"IFS= read -r line; printf 'GOT=[%s]\\n' \"$line\"", stdin:"startup-line\n"}` | `GOT=[startup-line]`，exit 0（既有能力未被误删） |
| 超时 handoff 携带输出 | `exec {cmd:"printf 'Password:'; sleep 30", timeout:2}` | 回执直接含 `Password:` + `still running — poll job_output remote-55c51241b4a24c80`；commandId=`remote-0ab08b2ca0554378` ≠ jobId，input 回执正确带出 jobId（`read the response with job_output remote-55c51241b4a24c80`） |
| close 语序 | 有 detached 命令时 `close` → `close force:true` → 再 input | `[E_SESSION_BUSY] ... job_kill ... first (or wait for it), then close again; force:true closes the tab and kills the group in one step` → `closed pty:pty-tquj (docker:corti) — killed running job remote-a48cfe84c7e64e72` → `E_NO_SESSION` |
| 跨 Agent 隔离 | 另起一个 subagent 探针，让它在自己的池里 input `pty:killtest` | `[E_NO_SESSION] remote: no live PTY under label "killtest" ...`；其 roster 显示 `pty sessions: none`（没有越权写入、没有隐式创建） |

短注：`job_kill` 之后 registry 把作业标 `killed`，两条路径的 detail 分别是 `interrupted: exit 130`（命令真的在跑，见 §6 F2 的对照）与 `interrupted: session died`（会话被杀，见 F2）。

---

## 5. 通道覆盖（按环境实际具备项，不伪造）

| 通道 | 方式 | 我实测的结果 |
| --- | --- | --- |
| BYO `spawn`（真 `script(1)` + `bash -i`） | §3/§4 全程 | ✅ 两提示 → ACCEPTED / exit 0；EOF、两步 ^D、字面字符等全部在此通道 |
| `ssh:dev3:pty:sshtest` | exec 提示 → input `demo\n` | ✅ `SSH-Password:` → `SSH-ACCEPTED` / exit 0 |
| `docker:corti:pty:dockertest` | exec 提示 → input `123456\n` | ✅ `DOCKER-OTP:` → `DOCKER-ACCEPTED` / exit 0 |
| `incus:ctr-1:pty:incustest` | exec 提示 → input `123456\n` | ✅ `INCUS-OTP:` → `INCUS-ACCEPTED` / exit 0 |
| `hub:bfwu:pty` | input | ✅ 按计划 fail-loud：`E_TARGET_FORMAT`（无会话身份/无 input 协议，指路可寻址通道）；未冒充可交互 |

并行性：docker 与 incus 两条会话在同一时刻各自运行一条命令，互不干扰（两个后台 job 同时 `running`，各自 input 后分别完成）。会话上限（每 Agent 10 条）本轮未压测，属于既有单测范围。

---

## 6. 三个缺陷（第一人称实测发现）

### F1（本轮新增交互边界）裸 `^C` 后：shell 已在提示符，账本仍 `running`，会话永久 busy

复现（3/3，其中 1 次在 `pty:login`，2 次在 `pty:killtest`）：

1. `exec {cmd:"sleep 30", run_in_background:true}` → 拿到 job。
2. `input {stdin:"\u0003", commandId:<job>}` → `wrote 1 byte ...`。
3. `job_output` → 一直 `[status: running]`（3 秒后仍 running）；我再用 `input {stdin:"echo AFTER-INTERRUPT\n"}`，输出里出现 `AFTER-INTERRUPT` —— **shell 明显已经回到提示符并执行了新命令**，但作业仍记 running。
4. 此时发新 `exec` → `[E_SESSION_BUSY]`（与 sleep 真在跑时同样的文案），会话卡死；`status` 卡片显示 `busy (a command is running)`。

机理：包装命令是 `{ cmd } ; printf <nonce 帧>`（`nonce-framing.ts`），交互 bash 在前台作业被 SIGINT 中断后会**放弃当前命令行的剩余部分**，尾部帧不再打印；P8 的两段式补偿只在 `job_kill` 里做，`input` 的裸 `^C` 只是原样字节。影响：模型自然会用 `^C` 停程序，然后被一个「假 running」卡住——这时唯一出路是 `job_kill`，而它接着触发 F2。

### F2（既有 P8 竞态，被 F1 的恢复路径逼出来）提示符空闲态 `job_kill`：注入 marker 丢首字节 → 宽限杀组 → 会话死亡

复现（3/3，均在 F1 之后、shell 停在提示符时）：

```
job_kill remote-... → job_output:
^C
bash: rintf: command not found
[status: killed, interrupted: session died; ...]
```

`interrupt()` 写 `\x03` 后**立刻**写 `printf '\033]133;D;<nonce>;130;%s\007' "$PWD"\n`（P8 两段式，`pty-session.ts` 的 `twoStage`）。在提示符空闲态，SIGINT 的输入队列 flush 与 marker 抢跑，首字节 `p` 被吃掉，于是执行 `rintf`；帧永远不到，3s 宽限（`INTERRUPT_GRACE_MS = 3_000`）到期后 `killTree()` + `markDead()`，整组被杀 —— **`job_kill` 把会话打死了**，与工具描述「job_kill sends Ctrl-C and the session survives」相矛盾。

对照（2/2，命令确实在跑时）：`job_kill` 一个 `sleep 60` 与一个 timeout-handoff 作业，回执都是 `[status: killed, interrupted: exit 130]`，会话存活、`exec` 继续可用。所以触发条件是「`^C` 到达时 shell 已处在提示符读取态」——恰好是 F1 制造的现场。

证据补充（旁证，非本仓代码）：我用 `script(1)` 手工复现同一形态——`{ sleep 60 } ; printf ...` 被 `^C` 打断后，shell 放弃尾部 framing；无延迟注入的 marker 在该手工实验里能执行（说明 marker 内容本身没问题），300ms 延迟注入稳定执行；而经 remote 的两次 `proc.stdin.write` 在同一提示符状态下 3/3 丢首字节。建议最小修法：P8 在 `\x03` 与注入行之间加短延时（并让注入行以换行起始），或无帧时重试注入一次，改后用 remote 路径实测；不要用「杀整组」当默认兜底。

### F3（既有风险，本轮未复现但窗口更常被走到）stdin 无 `error` 监听：EPIPE 可变成进程级 uncaught

本机 4999 日志（`.scratch/superd-4999.log:4669`，2026-10-19 上下文）里有：

```
dsh: fatal uncaught exception: Error: write EPIPE
    at PtySession.write (.../remote/plugin.js)
    at PtySession.dispose (.../remote/plugin.js)
```

当前源码 `better-dsh/src/remote/pty-session.ts` 的 `private write()` 只有同步 `try/catch`（第 349–350 行），`doStart()` 没有 `proc.stdin.on('error')`；EPIPE 是**异步**流错误，会绕过 try/catch 成为未捕获异常。`input()` 让 stdin 写路径从「每次 dispatch 一次」变成「任意时刻多次」，撞上进程死亡的窗口更大。本轮没有复现（今天测试窗口内日志无新的 fatal / world failed），但代码面没有变化，建议顺手加一个 stdin 错误监听（把会话标 dead，让 death waiter 结算），避免一次 EPIPE 打死整个 4999 进程。

> 归属说明：F2/F3 不是本轮 `input` 引入的代码，但 F1 让 F2 变成「按教学流程操作的正常后果」，因此三条都算阶段 A 验收路径上的真实缺陷，而不是无关噪音。

---

## 7. dev3 第二现场

- 安装态（dev3 `~/workspaces/superd/.tests/foreign-substrate/profiles/superd-pub`）：`better-dsh@0.3.2-b`、`super-dsh@0.3.2-b`；安装的 `lib/remote/plugin.js` 含 `PERSISTENT, INTERACTIVE TERMINAL SESSION` 与 `writtenBytes`。
- 运行态：`127.0.0.1:4998` 一行在跑（`SUPERD_KEEP=1`），`root=200`、匿名 API `401`；relay 在 `187.127.111.29:4998`；token 在 dev3 的 `.scratch/superd-4998.log`（不写进本报告）。
- **真实模型 probe 的落点（重要更正，probe 已返回）**：我通过 Hub A2A 向 Hub 上「DEV3 → DSH」（`bfwu-0kdzjk`）开的 probe 跑完了，但它**不是 4998 测试线**：它是 dev3 上独立的个人 `dsh web`（`dsh.dev3.internal.test`，pid 1464862，cwd `/home/u1/.dsh`，其 `~/.dsh/profiles/web` 里 better-dsh = `0.3.2`，早于 action 轮），Hub 只是把这个 paired 实例列为 DEV3→DSH。它的 `remote` action 枚举只有 `["copy","rsync","close"]`，没有 `add` / `exec` / `input`、没有 `commandId`；PTY 创建与执行仍走旧式 `{spawn,target}` / `{target,cmd,run_in_background}`，stdin 只有 dispatch-time 一种（`written right after the command line`）。逐字回执（节选）：
  - 旧式创建：`[session created — address it as pty:pty-0r2v]`；dispatch：`Started remote-2ad938d33ec94afa on pty:pty-0r2v (dev3probe) (BYOP)`；`job_output` 得 `PW:` + `[status: running]`。
  - `add` / `exec` / `input` 三次尝试全部在 schema/发射层被拍回：`Error: copy cannot be combined with execution/PTY/job arguments`、`dev3probe: not closed (not-found)`、`Error: rsync cannot be combined with execution/PTY/job arguments`（没有到达后端，所以没有后端错误可引用）。
  - 它只能用 dispatch-time stdin 预缓冲后重派：`PW:OTP:GOT=demo/123456` / `[status: completed, exit code: 0]`；随后 `echo alive-after-probe` 正常、`closed pty:pty-0r2v (BYOP)`。
- **结论：我打错了 agent；4998 线本身不是旧版本。** 4998 测试线（pid 1952378，`--profile superd-pub`，`DSH_HOME=.tests/foreign-substrate`）安装态是 `0.3.2-b`，与 PC 4999 同一形态（agent 在宿主进程内、用同一 profile），不是上面那个 `~/.dsh` 的个人 DSH。因此：①这条 probe **不构成对 dev3 0.3.2-b 安装的验收**，我不拿它冒充；②若要让「经 Hub 桥接的个人 DSH」也具备交互 stdin，需要把对端 `~/.dsh` 的 better-dsh 升到 ≥0.3.2-b（单独决策，不属于本轮 tarball 验收）。

---

## 8. 未覆盖 / 诚实清单

1. **同步前台窗口的并发 busy**：单会话内我无法在一条同步 `exec` 等待期间再发第二条（工具调用在本会话串行），因此这条只由单测覆盖，第一人称只覆盖了 background / detached / handoff 三种占用形态。
2. **`starting`（`E_SESSION_NOT_READY`）与「写入失败 `E_SESSION_WRITE_FAILED`」**：难以在真机上稳定制造，本轮未触发，属单测覆盖。
3. **每 runtime 的 create / prompt / resume**：本轮只在 `superd-pub`（DSH / standard preset）线做真实模型验收，没有逐个跑 Claude / Codex / Hermes / OMP / Pi / AGY 的 create-prompt-resume。
4. **resume-after-restart**：需要重启 4999（会打断本会话与 user 的浏览器会话），本轮未重跑；跨 Agent 隔离已用 subagent 探针实测（`E_NO_SESSION`，不重放、不创建）。上一轮记录的 resume 行为（旧 PTY 身份失效 → 如实报错）未在本轮独立复核。
5. **阶段 B（one-shot 等待窗口转后台）**：按计划递延，`process.ts` 计时器、Hub `timeoutSec` 语义与 one-shot timeout Surface 均未改动；one-shot 仍只有启动时 stdin，不承担补输。
6. **dev3 4998 第二线的真实模型交互未完成**：本会话没有可用的官方入口去驱动那条 web 线的 agent 会话（Hub 探针落到的是另一个 runtime，见 §7），我也没有为此另起服务或手搓旁路；因此 dev3 侧本轮只完成「安装 + 健康 + 字节核验」，真实模型验收留待 §10.3 的浏览器手验或 user 指定入口。
7. **GUI 亲手终验**：按惯例留给 user（PC 4999 线保持运行）。

---

## 9. 现场与清理

- 我创建的 PTY 会话已全部 `close`（`login` / `killtest` / `sshtest` / `incustest` / `dockertest`）；roster 收尾实测为 `pty sessions: none`。自建夹具 `/tmp/pty-lit-x04.txt` 已删除；dev3 上为 probe 新开的 Hub 会话（`g7kvol`）留在对端会话列表里，无进程残留。
- PC 4999 线仍在跑，供 user 手验：`https://test.pc.internal.test/`（`SUPERD_KEEP=1`，root 200）。
- dev3 4998 线仍在跑（`SUPERD_KEEP=1`），relay `187.127.111.29:4998`。
- 未触碰 `~/.dsh`、`~/.superd`、生产 3080 / 3081 或 live Caddyfile；未 `npm publish`；未 commit / tag / push。
- 工作树仍是本轮改动：14 个已修改文件（`better-dsh/src/remote/{pty-session,driver,tool}.ts`、对应 spec、`docs/remote-tools.md`、两个 `package.json`/lock、`super-dsh` 版本文件）+ 2 个未跟踪文件（`better-dsh/test/remote/pty-input.spec.ts`、本报告）。tarball 未重新打包（哈希保持 §1 值）。

---

## 10. 放行请求（需要 user 决策）

1. **F1/F2/F3 是否本轮修**：建议 `0.3.2-c`（新字母版本，重走 pack + 4999/dev3 实装），最小集 = F2 的 marker 延时/重试、F1 的 surface 与行为对齐（裸 `^C` 不结账时明确告诉模型用 `job_kill`，或让 `input` 对独占 `^C` 复用两段式）、F3 的 stdin error 监听。若不修，请明确按「已知边界」放行 0.3.2-b，并把 F1/F2 写进 release notes 的已知问题。
2. **版本与发布**：npm 发布仍需本次单独明确许可（红线 §〇.3）；Git 定版在验收 / 报告 / 放行之后。
3. **浏览器亲手验收**：PC `https://test.pc.internal.test/`；dev3 走 4998 relay（token 在 dev3 日志）。
4. **dev3 4998 第二线**：真实模型交互未验收（§8.6）；Hub 探针已返回但落到另一 runtime（§7），不能替代。可选路径 = user 在 dev3 GUI 手验，或指定一条官方入口让我在下一轮驱动；另外若要 Hub 桥接 agent 具备 `input`，需单独升级对端 `~/.dsh` 的 better-dsh（≥0.3.2-b）。

---

## 附：复现命令（可直接抄）

```text
# F1：裸 ^C 之后 shell 回提示符、作业仍 running、会话 busy
remote {action:"exec", target:"pty:<label>", run_in_background:true, cmd:"sleep 30"}
remote {action:"input", target:"pty:<label>", commandId:<job>, stdin:"\u0003"}
remote {action:"exec", target:"pty:<label>", cmd:"echo x"}         # → E_SESSION_BUSY

# F2：随后 job_kill → 首字节丢失 → 宽限杀组 → session died
job_kill <job>                                                     # → bash: rintf: command not found
```
