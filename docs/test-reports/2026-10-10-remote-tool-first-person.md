# Remote 工具增强 — 第一人称实测行程报告

2026-10-10（香港时间 16:33:31–16:38:45 主行程）。本报告由 **DSH 自身的模型会话**（不是脚本、不是另一个 Agent 的转述）亲手调用被测工具写成：全程 `remote` 调用、读取的输出、失败与self-correction 都在本会话内真实发生，随后独立复核清理。companion evidence report: [`docs/test-reports/2026-10-10-remote-tool-enhancement.md`](2026-10-10-remote-tool-enhancement.md)。

## 1. 被测交付物与运行环境

| 项 | 值 |
| --- | --- |
| 被测工具 | 原生 `remote`（BYO-SSH / script / stdin / PTY / jobs / copy / rsync / Hub transport） |
| 安装版本 | `better-dsh@0.3.0-o` + `super-dsh@0.3.0-o`（同一 profile 同时启用） |
| 包哈希 | Better `4bf132aca09f6142f409cf5f2709658288028e882436932ca07bcab3220ec65c`；Super `f07a3649d3a6e32635fcb0f370414fd39f90c771a7f629d77289772c99a66be8`（`.scratch/superd-pack/*-0.3.0-o.tgz`） |
| 会话 | `session-ef2a3445-680e-43d5-a025-19104083289d` |
| DSH_HOME / profile | `.scratch/worktrees/remote-enhancement/.tests/superd`，profile `superd-pub`（bundles 含 `super-dsh`、`better-dsh`） |
| Web 实测线 | https://test.pc.internal.test/ |
| 目标资源 | SSH `dev3`（Linux 7.0.0, bash 5.3.9, rsync, python3）；Docker `superd-task8-m-docker`（Debian 13）；Incus `superd-task8-m-incus`（Ubuntu 26.04）；Hub peer `hub:7nep`（即 dev3 的对端） |

关键点：被测代码是 **安装进 profile 的 O 整包**，不是源码树 —— 本会话加载的就是它，逐次调用都走交付路径。本次只做**工作区/测试环境**操作：无 `npm publish`、无 Git 定版、无生产（`~/.dsh`、3080/3081、live Caddy）改动。

## 2. 结论速览

| 状态 | 结论 |
| --- | --- |
| 实现 | 已完成（Task0–7 独立审阅通过；本报告不重复评审） |
| 自动验收 | 已通过（见 companion report：native 30 files/228 tests、hub 83/83、root 42/42，O 整包） |
| **本次第一人称实测** | **全部行程 lane GREEN**；发现并如实记录 4 个「我自己的操作错误/观察陷阱」与 1 个对端环境失败（`hub:bfwu` 404），均非产品缺陷 |
| 用户亲验 | **仍未完成** —— 本报告是 Agent 的第一人称验收，不能替代 user 亲手验收 |
| 发布 | **未获授权，未执行** |

## 3. 行程时间线（真实调用与真实回显）

### 3.1 roster（本地扫描 + Hub 目录）

调用 `remote {}`，原样回显：

```
hub machines: hub:b5rr (homepc), hub:7nep (desktop-pair-test-peer), hub:te01 (Desktop incoming diagnostic), hub:bfwu (DEV3)
ssh hosts (~/.ssh/config): github.com, dev2, dev3, mac, dev1, 137.131.54.174, dev4, ctr-1
byossh labels (this Agent, in memory): (none)
docker containers: superd-task8-m-docker (running), corti (running), corti-previous-d8ebd00cf436-2f116247 (exited)
incus containers: ctr-1 (RUNNING), superd-evidence-67783f03 (STOPPED), superd-evidence-bc71d0e7 (STOPPED), superd-task8-m-incus (RUNNING)
live pty sessions: none
```

目录对空/缺失资源是诚实的：byossh 为空、pty 为空、含 exited/STOPPED 容器。`remote {target:"dev3"}` → `probe: reachable in 720ms ... session: none — dials on first exec`；Hub 的 `{target:"hub:7nep"}` 返回 `not probed`（Hub 状态探测不拨号，未伪装成已探测）。

### 3.2 BYO-SSH 注册、复用与冲突

```
remote {target:"byossh:journey-dev3", ssh:{host:"dev3"}, cmd:"printf 'BYOSSH-1 host=%s bash=%s\n' ..."}
→ BYOSSH-1 host=srv1637772 bash=5.3.9(1)-release   [exit 0 · 2.9s]

remote {target:"byossh:journey-dev3", cmd:"printf 'BYOSSH-REUSE cwd=%s\n' \"$PWD\"}     # 不带 ssh，复用
→ BYOSSH-REUSE cwd=/home/u1   [exit 0 · 2.9s]

remote {target:"byossh:journey-dev3", ssh:{host:"dev2"}, cmd:"printf 'should-not-run'"}
→ Error: [E_LABEL_CONFLICT] remote: byossh:journey-dev3 SSH identity conflict — nothing was run.
  Reuse the label without ssh, or choose another label; existing credentials were not replaced
```

同 label 换身份被拒且「什么都没跑」；原生 `~/.ssh/config` 的 host 别名（user/key/port）被沿用，没有另写配置。

### 3.3 script（>4096 字节、含 `$()`/反引号/heredoc/Unicode）

本地脚本 4705 字节，经 `script:"…/journey-script.sh"` 执行；脚本里的 `$HOME`/`$(hostname)`/反引号全是**字面量**：

```
SCRIPT host=srv1637772
literal a $HOME `id` $(hostname) "dq" 'sq'
heredoc $NOT_EXPANDED `not-run`
unicode 你好-é
[exit 0 · 3.0s]
```

一次执行、无 argv 展开、stdout 正确。

### 3.4 stdin（含我自己的第一次失败）

第一次我把两条读取命令串在一起：`cmd:"wc -c; sha256sum"` + 29 字节 stdin。结果 `wc -c` 先消费了整条流，`sha256sum` 读到 EOF：

```
29
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  -
```

`e3b0c442…` 是**空串**的 SHA-256，不是工具吞了字节。改为先落盘再各自独立读：

```
remote {cmd:"cat > /tmp/journey-stdin.bin && wc -c < … && sha256sum < …", stdin:"line1\nline2\nÜnïcode 你好\n"}
→ 29
  00995f6cc95aad896e2a5757844b280e95503aaf9aa7a4684c8a1948445033d2  -
```

与本地参考 `printf … | sha256sum` 完全一致。**教训**：这是被测工具的 stdin 语义（一条流给整个命令组合）的正确表现，不是缺陷；错的是我的测试写法。

随后 REPL 通道做了重载 lane（`>500KiB`、含 NUL 与 Unicode）：

```
payload = "START\n" + "A"*200000 + "\x00" + "KEEP\n" + "你好"*62500 + "\x00" + "STOP\n"
localBytes=575018  localSha=02062d82a1ae2be7da21b690baa19eb58bb4f3c165e8ed55b8b45f56204bd3d6
remoteSha=02062d82…d3d6   match=true   exit=0
```

字节级一致（含 NUL），证据 `.scratch/task-8/first-person/big-stdin.json`。

### 3.5 PTY 持久会话

```
remote {target:"byossh:journey-dev3", mode:"pty", cmd:"cd /tmp && export JOURNEY_MARK=held-$((6*7)) && printf 'PTY-1 pwd=%s mark=%s\n' \"$PWD\" \"$JOURNEY_MARK\""}
→ PTY-1 pwd=/tmp mark=held-42      [exit 0 · 0.8s · cwd /tmp]

remote {… mode:"pty", cmd:"printf 'PTY-2 pwd=%s mark=%s\n' \"$PWD\" \"${JOURNEY_MARK:-unset}\""}
→ PTY-2 pwd=/tmp mark=held-42      [exit 0 · 0.0s · cwd /tmp]

remote {target:"byossh:journey-dev3"}   # 状态探测
→ probe: reachable in 661ms (just now, on demand) / session: idle 1s (connected)
```

cwd 与 env 跨 dispatch 保留；Hub 侧同样通过（`HUBPTY-1/2` → `hub-held-42`，见 3.8）。

### 3.6 文件 copy（binary / 目录 / 三种 transport / 两个方向）

本地产物树：8 MiB 随机 `binary.dat`、`nested/deep/empty.txt`（0 字节）、`ünïcode-你好.txt`、**文件名含换行**的 `line\nbreak.txt`、`extra.keep`。

```
local → byossh:journey-dev3:/tmp/journey-dst   （src 带尾斜杠）
→ {"verified":true,"bytes":8388646,"entries":8,"scope":"transferred entries",
   "sourceDigest":"3c8b84097b3e2f804a744ee3b4eecb840866e759b15dd1fff05ca3e33b1d6fe8",
   "destinationDigest":"3c8b8409…6fe8"}

dev3 → local:/tmp/journey-import（反向）
→ verified true，同样 8 entries / 3c8b8409…；导入后 sha256 = 482114a2…（与复制时的源一致）

local → hub:7nep:/tmp/journey-hub/binary.dat  （paired-only，不用任何 ssh alias）
local → docker:superd-task8-m-docker:/tmp/journey-docker/binary.dat
local → incus:superd-task8-m-incus:/tmp/journey-incus/binary.dat
→ 三者均 verified true，单文件 manifest digest c753f6f387ec4a7093cbdde25dfb4581d71337d255558cba3924212fa4fa80fa == destination

verify:false → {"verified":false,"bytes":8388608,"entries":1,"scope":"transferred entries"}
   （诚实回执：不给 source/destination digest，不假装校验过）
```

**独立复核**（不经被测工具）：dev3 上 `find` 目录与源逐一相同（含换行文件名、Unicode 名、0 字节文件）；`sha256sum binary.dat` = 本地 `482114a2…`；Docker/Incus 内 `sha256sum` 同为 `bbf6431e…`（此时本地已打过 16 字节补丁）；`/tmp/journey-hub/binary.dat` 经本地 ssh 得到同一 `bbf6431e…`。

回执里 `"scope":"transferred entries"` 明确写着 digest 是**传输条目 manifest**而非裸 `sha256sum`，这正是此前模型产生误会的点，现在 Surface 自解释。

### 3.7 rsync（dry-run 默认 / 实际 / 真 delta / excludes + delete 默认）

```
① 默认（不传 dryRun）
→ {"dryRun":true,"literalBytes":0,"matchedBytes":0,"sentBytes":258,…}  总大小 8,388,646
   独立复核：test -e /tmp/journey-rsync → DRYRUN-CLEAN（没有写任何东西）

② dryRun:false
→ {"dryRun":false,"literalBytes":8388646,"sentBytes":8391144,…}

③ 本地就地改 16 字节（尺寸不变 8388608，sha 482114a2→bbf6431e），再次 dryRun:false
→ literalBytes 2896 / matchedBytes 8385712 / sentBytes 14769；
  itemizedChanges 仅 ["<f..t...... binary.dat"]
  独立复核：dev3 上 sha256sum = bbf6431e…（与本地一致）→ 真增量，不是全量重传

④ excludes:["extra.keep"] + delete:false
→ "Number of files: 7"（排除生效），literalBytes 0，Number of deleted files: 0
  独立复核：远端 extra.keep 仍是旧内容 "keep"（本地已改成 CHANGED-EXCLUDED，未传播）；
  远端 untouched.own（源里没有）仍在 → delete:false 没有被偷偷升级成删除
```

### 3.8 jobs：running 增量 / 自然完成 / kill（SSH 与容器）

```
remote-1 = {target:"byossh:journey-dev3", cmd:"echo $$ > /tmp/journey-job.pid; printf 'JOB-FIRST\n'; sleep 90; printf 'JOB-SECOND\n'", run_in_background:true}
```

- 运行中第一次 `job_output` → `JOB-FIRST` + `[status: running]`；**没有**把完成当运行。
- 我中途怀疑它卡住，于是在 dev3 上独立取 PID：`1401679 bash -lc …` ELAPSED `01:14` —— 只是 90s 还没到，**不是缺陷**。
- 之后 `job_output(wait)` → `JOB-SECOND` + `[status: completed, exit code: 0]`（完成经官方 job 状态观测；本轮未单独截获 native completion notice，那部分沿用 M 相证据）。

```
remote-2 = {… cmd:"echo $$ > /tmp/journey-job2.pid; printf 'KILL-FIRST\n'; sleep 300", run_in_background:true}
运行中读到 KILL-FIRST → job_kill → [status: killed, exit code: 143]
独立复核（本地 ssh，不经工具）：PID 1405012 gone；无 sleep 300；/tmp/superd-rsync-native.* = none
```

```
remote-3 = 同样的 300s 任务，但在 docker:superd-task8-m-docker 内
运行中读到 DJOB-FIRST → job_kill → killed, exit 143
独立复核（本地 docker exec，读 /proc）：marker PID 6735 GONE，无存活 sleep 300（唯一命中是我自己的检查命令）
```

观察陷阱：容器里**没有 `ps`**。我第一次用 `ps -p` 判断存活，得到 `ps: command not found`，却因为 `|| echo "marker gone"` 打印了 "gone" —— 这是**假证据**；改用 `/proc/<pid>` 重新判定的才是结论。报告保留这次错误。

### 3.9 Hub paired-only 与自身拒绝

```
remote {target:"hub:egv8", cmd:"printf forbidden"}
→ Error: Select a remote machine from the Hub roster; local execution is not available through remote

remote {target:"hub:bfwu", cmd:"printf 'HUB-OK '; hostname"}
→ [exit null · 0.1s] [stderr] remote task: 404 not found          ← 对端环境失败，如实记录

remote {target:"hub:7nep", cmd:"printf 'HUB-OK '; hostname"} → HUB-OK srv1637772   [exit 0 · 0.0s]
```

`hub:7nep` 是 retained 测试对端：exec / PTY 持久 / 8 MiB copy 全绿，全程**不用 ssh alias 或 key**（paired-only）。`hub:bfwu` 的 404 不是本工具缺陷：该 peer 行是更早的配对残留，对端没有对应 route；这属于对端环境问题，未做任何配对表改动去「修绿」它。

### 3.10 REPL 通道（`eval` → `tool.remote`）与负面/恢复提示 Surface

REPL 与原生工具结果一致（`roster` 同文；oneshot `REPL-ONESHOT` exit 0），raw JSON 见 `.scratch/task-8/first-person/repl-parity.json`。同一批里我逐个敲了错误路径，模型实际看到的是：

| 调用 | 真实回显 |
| --- | --- |
| `copy` + `dryRun:true` | `copy cannot be combined with rsync options` |
| `rsync` → docker | `rsync supports SSH/byossh only (plus one local endpoint); no mixed-transport or copy fallback` |
| `rsync` 两端都本地 | `rsync requires at least one SSH endpoint; local-only is unsupported` |
| `copy` → `byop:` | `BYO-PTY has no binary file lane; select SSH/Docker/Incus/Hub` |
| `script` 不存在 | `[E_SCRIPT_READ] … cannot read local script "…" — ENOENT …` |
| `script` + `cmd` | `[E_SCRIPT_PARAMS] … script is oneshot-only and cannot be combined with cmd, stdin, spawn or BYO-PTY` |
| `mode:"pty"` + 后台 | `background requires oneshot; PTY and BYO-PTY are unsupported` |
| 未注册 byossh label | `[E_NO_SSH_TARGET] … is not registered in this Agent — supply ssh:{host,user?,port?,key?,proxyJump?} first; key must be an existing origin file path` |

八条全部是**具体、可恢复、不牺牲语义**的提示，没有一条把不支持悄悄降级成「看起来成功」。

### 3.11 BYO-PTY

`remote {target:"byop:journey-docker", spawn:"docker exec -it superd-task8-m-docker bash", cmd:"printf 'BYOP-OK '; pwd"}` → `BYOP-OK /`，`[exit 0 · 0.1s · cwd / · byop:journey-docker]`；该 label 下的 copy 被明确拒绝（上表）。

## 4. 清理与资源核对

- dev3 / Docker / Incus / 本地四处 `journey*` 夹具全部删除；三处回显 `clean`。
- 本地与 dev3 均无可疑 `superd-rsync-native.*`、`remote-file-worker-*`、`superd-task8*` 残留；无遗留 helper 进程。
- 观察陷阱 2：**在 dev3 上用 `remote` 自己查 `ls -d /tmp/superd-rsync-native.*` 会看到它自己的接收 owner 目录**（自观测）。改用本地 ssh 复核后为 `none`，job kill / 完成后的 owner 清理是真实的。
- 结束时仍有 3 个持久 PTY/BYOP 会话处于 idle（`byossh:journey-dev3` idle 240s、`hub:7nep`、`byop:journey-docker`）。这是设计内的 idle TTL 行为，不是资源泄漏；未用「杀掉全部 ssh」之类手段去伪造零残留。

## 5. 我犯的错 / 本轮发现的观察陷阱（保留，不抹掉）

1. **stdin 共享流**：`wc -c; sha256sum` 串接导致第二条读到空流，`e3b0c442…` 一度看起来像「stdin 丢了」。是测试写法错。
2. **自观测 owner 目录**：用被测工具查被测工具的 `/tmp` 残留会看到自己。
3. **容器无 `ps` + `|| echo gone`**：把「命令不存在」误读成「进程已消失」，一次假阴性结论。
4. **bash 末命令 exec 优化**：`remote-2` 的 `$$` 写进 pid 文件后进程名已变成 `sleep 300`（bash 对最后一条简单命令做了 exec），不是 PID 记录错误。
5. **对端 404**：`hub:bfwu` 的 `remote task: 404 not found` 属于对端环境，未伪装成产品通过。

## 6. 未覆盖 / 未亲验项（诚实边界）

- **User 亲手验收仍未完成**：本报告是 Agent 的第一人称验收。测试线保持运行：https://test.pc.internal.test/ ，Better standalone http://192.0.2.130:4997/ ，dev3 http://192.0.2.130:4996/ 。
- 本轮**未**逐项重跑：foreign runtime（Codex/Claude/OMP/Pi/Hermes/Antigravity）冷 resume、Plugin Manager 启用顺序矩阵、native completion notice 的原始 inbox 行、SSH↔SSH 双跳 relay 的物理取消清点、dev3 作为默认 source 的 physical proxy（这些在 companion report 的 M/N/O 相已有证据，属继承而非本轮实测）。
- 本轮**未**触碰：发布、Git 定版、生产环境。
- `hub:bfwu` 404 未修复（对端环境）；Antigravity 的 403/QUOTA 属外部计费阻断（companion report）。

## 7. 复现命令（本次行程的最小集合）

```bash
# 前提：本 worktree 的测试 home 已装 O 整包，profile superd-pub，dev3 可免密 ssh
cd /home/u1/workspaces/superd/.scratch/worktrees/remote-enhancement

# 0) 环境核对
node -e "console.log(require('./.tests/superd/profiles/superd-pub/node_modules/better-dsh/package.json').version)"
sha256sum .scratch/superd-pack/better-dsh-0.3.0-o.tgz .scratch/superd-pack/super-dsh-0.3.0-o.tgz

# 1) 手工调用（本轮由模型在会话内真实执行；等价命令）
#    roster / byossh / script / stdin / pty / copy / rsync / jobs 见本文件 §3 每段调用原文
#    批量负面 Surface 与 REPL 证据生成：
#    .scratch/task-8/first-person/repl-parity.json（经 eval 内 tool.remote）
#    .scratch/task-8/first-person/big-stdin.json
#    .scratch/task-8/first-person/journey-script.sh（4705 字节 quoting/heredoc 夹具）

# 2) 独立复核（不经被测工具）
ssh dev3 'sha256sum /tmp/journey-rsync/binary.dat; ls -d /tmp/superd-rsync-native.* 2>/dev/null || echo none'
docker exec superd-task8-m-docker bash -c 'test -d /proc/<killed-pid> && echo ALIVE || echo GONE'
```

## 8. 一句话结论

在**安装态 O 整包**上，`remote` 的 roster / BYO-SSH / >4096 script / NUL+Unicode 大 stdin / PTY 持久 / binary copy（SSH、Docker、Incus、paired-only Hub、双向）/ rsync（默认 dry-run、实际、真 delta、excludes+delete 默认）/ 后台 job 的 running 增量、自然完成与 kill 后真实清理 / 自我执行拒绝 / 8 条负面提示，全部第一人称实测通过；所有完成后资源清理经独立（非被测工具）核对为零残留。**User 亲验与发布仍未进行。**

## 附录 A：环境兼容性政策（Bash / Python）—— user 2026-10-10 指示

**方向（本报告的记录义务）**：本工具是**桥接层**——只调用目标机原生的 Bash / SSH / rsync 能力，把大模型本来要花 10–20 步的动作收成 1 步，节省是指数级而非线性。因此兼容性按「覆盖约 90% 主流场景」取舍：**不为老破小、偏门或私有变体增加复杂度，不自研替代工具，也不为缺依赖的环境降级到更弱或不安全的通道**。缺依赖时的正确行为是**预检失败 + 明确文案 + 零副作用**。

**Bash：门槛 Bash 4.1+（2009）**。要的不是版本号，而是两个原语：

- `coproc` —— 承载接收方的单调时钟/控制协程（`ssh-relay.ts`）；
- 动态文件描述符 `exec {fd}<&` / `exec {fd}>&` —— 把控制管道与**字面 stdin（fd0）**分开，用户数据里不掺控制帧。

老于 4.1 的 Bash 在入口处被挡下：`exit 69` + `rsync requires Bash4.1+ coproc and dynamic file descriptors`，不会做一半。macOS 自带 bash 3.2 属**明确不支持**；用户自装原生 bash5 即可，本工具不做 3.2 兼容分支（该政策由 user 2026-10-10 指示确认）。

**Python：门槛 3.7+（macOS 共享单调时钟语义取 3.10+）**。范围界定很重要：

- **origin（本机）不需要 Python**；本地 lane 全部是 Node。
- Python 只出现在 **SSH 对端 / CLI 对端 / 容器对端**，作为「接收 owner + 时钟 + 文件 worker」，做 Bash 做不到或不可靠的四件事：
  1. 跨进程、**不可回调的单调时钟**（`time.monotonic_ns` + `get_clock_info`）——8s 入场栅栏与 2s 续租的判定基准；
  2. `fcntl.flock` **非阻塞独占锁**——保证同一时刻只有一个清理者接管 owner（Bash 没有 flock 原语，外部 `flock(1)` 不保证存在）；
  3. 进程组所有权 + `PR_SET_CHILD_SUBREAPER`（ctypes）——容器 PID1 不回收孤儿时自己收养、reap、按组清理；
  4. 远端 rsync 源端的 **loopback 字节代理**（selectors + socket 半关闭 + 背压）——避免要求远端 sshd 允许转发或开放 `/proc` 权限。
- 另有 CLI 端点的 stdlib `tarfile`/`hashlib` 二进制归档与摘要，避免依赖远端 `tar` / `sha256sum` 变体。

这些都是「主流发行版自带」的原语，不是自研工具。缺 Python 的目标机会在预检阶段拿到明确错误（实测文案 `native receiving recovery prerequisite failed: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock and shared monotonic clock required: …`），而不是静默降级。

**决策记录**：据此政策，**不**新增 Bash 3.2 / 无 Python 目标的兼容通道；若日后出现「90% 场景内确有硬缺口」的证据，再单独裁决。

## 附录 B：用户提问的两条补充观测（2026-10-10）

### B1. 两条 remote 子包行里，当前生效的是 Super Dash 的 `super-dsh/remote`

- 两个 bundle 的 `remote` 工具描述**逐字节相同**（20803 字符，sha256 `8c849e922546ebb9a5340c861494e1b645e83349e6e336e27c025906dfe79260`），因此**无法从 Surface 区分**，只能看组成顺序。
- 两个 row 都声明 `inject: []`（无依赖重排）。`Config.listConfigs` 的 live 树顺序：`include:superd-remote`（`super-dsh/remote`）在前，`include:dashr-remote`（`better-dsh/remote`）在后，与 `package.json` 的 bundle 顺序（`super-dsh` → `better-dsh`）一致。
- `agent/created` 是 **serial** 事件（监听器按注册顺序依次 await），注册顺序 = 插件加载顺序 → Super 行先注册成功；Better 行随后命中 `tool "remote" is already registered in this scope`，在确认占名后**静默返回**（`agent-registration.ts`），其 driver 被 dispose，完全不生效。
- 结论：用户「Super 先注册」的猜测成立，但机制不是**安装**顺序，而是**运行时组成的监听顺序**；若 profile 把 `better-dsh` 排在前面，胜者会反转。（本次只做只读监测，未切换任何 row 去「制造」胜者。）

### B2. BYO-SSH label 是 per-Agent（本会话）作用域，与 BYO-PTY 形态一致

- 代码：`RemoteDriver` 在每次 `agent/created` 新建一个实例（`agent-registration.ts`），`sshTargets` 与 PTY 池是它的实例字段（`driver.ts`）；label 只活在**该 Agent** 的 driver 里，`agent/disposed` 即 `sshTargets.clear()`。
- 实测：label `journey-dev3` 在我这个 Agent 下已注册 `{host:"dev3"}`；另起一个**新 Agent**（subagent）用**同一 label**注册 `{host:"dev3",port:22}` → `byossh:journey-dev3 registered (no dialing)` 成功；该子 Agent 再用 `{host:"dev3",port:2222}` → `[E_LABEL_CONFLICT]`。即冲突只发生在**同一个 Agent Session 内**，不存在跨 Agent 的全局去重。
- PTY 池键为 `${sessionKey}|t:<target>` / `${sessionKey}|p:<label>`，池本身又在 per-Agent driver 内 —— 双重作用域，与 BYO-PTY 的既定形态对齐。

### B3. Hub 通道确认（user 2026-10-10）

- 文件 copy 走**我们自建的 WS binary lane**（`superd-hub/src/remote-file-rpc.ts`：binary frame、ACK window、task lease），对端执行的是**我们的 Node worker**（`remote/file-worker.js`，由 `file://` 导入）。
- oneshot / PTY 走**对端 Node**（`exec.ts` 的 `bash -lc`、WS PTY channel），**不经过 Python / rsync / coproc / 动态 FD**。
- **不探测 SSH、不回落 SSH**：`remote-provider.ts` 只用 exec/pty/file 模块；roster 把 Hub 目录与 ssh 目录分列（Hub 只列不拨号），`hub:` 必须显式指定；Surface 明确 *Hub failures never fall back to SSH*。实测 8 MiB copy / PTY / oneshot 全程未使用任何 ssh alias。
- 唯一残留假设：对端有 `bash`（oneshot 即 `bash -lc`）——对端本身就是运行我们 DSH 的机器，该假设成立。
- 确认结论：**Hub-to-Hub 的 remote operation 完全在 Hub 自身（Node）内闭环，不需要 Python**，也不需要探测目标机是否存在其他 out-of-hub transport。

## 附录 C：待修项（user 2026-10-10 确认「之后一并修」）

1. **无 bash 目标机的预检诊断为空**。实测：把容器内 `/bin/bash`、`/usr/bin/bash` 删除（保留 python3）后，`remote {target:"docker:<c>", cmd:"printf PROBE-OK"}` 返回
   `` native receiving recovery prerequisite failed: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock and shared monotonic clock required: `` ——分类正确，但尾部原生诊断**为空**，大模型看不出具体缺 `bash`。
2. **oneshot 缺 `command -v bash` 预检**。目前只有 rsync 路径做了 `command -v bash && command -v rsync`（`ssh-relay.ts`）；普通 oneshot 由 Python 侧直接 `Popen(['bash','-lc',…])` 失败，才落到上面那条空诊断。修复方向：在既有 Python 预检（clock 角色）里顺带 `command -v bash`，把缺失项写进 stderr。
   - 对照：缺 python3 的情形诊断清楚且零副作用（`…: exec: python3: not found`；copy 同样失败，但回执带 `verified:false` + sourceDigest + 保留 scratch 供诊断）。
   - 本轮两个探针容器（`superd-probe-min` / `superd-probe-nobash`）与 retained scratch 已全部删除，未改动任何镜像。
