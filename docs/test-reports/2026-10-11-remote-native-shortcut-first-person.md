# Remote 原生 CLI 语法糖与双 SSH rsync — 第一人称实测报告

- 日期：2026-10-11（Asia/Hong_Kong）
- 规格：[docs/specs/remote-native-shortcut/spec.md](../specs/remote-native-shortcut/spec.md)；执行计划：[2026-10-11-remote-native-shortcut](../superpowers/plans/2026-10-11-remote-native-shortcut.md)
- 实施报告（fixture 级 + 独立评审，在 worktree）：`.worktrees/remote-native-shortcut/docs/test-reports/2026-10-11-remote-native-shortcut.md`
- 本报告定位：**以模型第一人称视角**，在真实 DSH 会话里直接调用 `remote` 工具并记录实际看到的 tool description、参数、回执与错误。补上了实施报告中被 DeepSeek 配额耗尽阻塞的「第一人称 DSH 会话验收」。

## 运行时环境（实测对象）

- 本会话 `DSH_HOME = /home/u1/workspaces/superd/.worktrees/remote-native-shortcut/.tests/superd-wt`，profile `superd-pub`。
- 安装态 better-dsh = **0.3.0-j**（`profiles/superd-pub/node_modules/better-dsh/package.json`），`lib/remote/plugin.js` 含 `pullArgv` 21 处、旧 `dry-run (default true)` 文案 0 处 —— 即本轮原生 CLI 实现。主体实测于 0.3.0-j；20:45 起 4999 线升级 **0.3.0-k**，复验见文末「0.3.0-k 复验附记」。
- 当前 4999 测试线（GUI `https://test.pc.internal.test/` 的会话来源）由 worktree 启动：`systemctl --user cat superd-4999-test.service` → ExecStart 指向 `.worktrees/remote-native-shortcut/upstream/deepseek-harness/apps/cli/lib/bin.js --profile superd-pub --port 4999`。这是实施报告写完后发生的重接线：**“主 checkout 的 4999 线未触碰”的旧说法已过时**，现在模型看到的就是新实现。

## 模型可见 Surface（我读到的工具说明）

`remote` 工具描述已切换为原生 CLI 语义，关键可见点（逐字核验）：

- rsync 形态 `{action:"rsync", src:"[target:]/absolute/path", dst, argv:["-a","--partial","--dry-run"]}`；copy 形态 `{action:"copy", src, dst, argv:["-p"]}`。
- `argv` 是「有序的原生选项及其值」，不经 shell 解析、无选项白名单、不强制 `-a/--timeout/--dry-run/--partial`；未知/不兼容选项由原生 CLI 报错。
- 两段 copy 用互斥的 `pullArgv`/`pushArgv`；`verify`/`mkdir` 仅 Hub↔local↔local 暂存通道，原生 CLI 路径不验证不建父目录；`scp -R` 被拒；`BYO-PTY` 不是文件端点。

## 第一人称测试方法

- 可控 loopback SSH fixture：两套独立 ed25519 key 的 `sshd` 各自监听 `127.0.0.1` 随机端口（fp1=38129、fp2=32941），经 `remote` 注册为 `byossh:fp1` / `byossh:fp2`（key 留本机）。测试后已 `ssh-keygen -R` 清 known_hosts 并停掉 sshd、删除 `/tmp/superd-fp-remote*` 与工作目录。
- 容器端点复用现役测试容器：docker `superd-task8-m-docker`、incus `ctr-1`。
- 每个用例我（模型）只发一次工具调用，下面回执均为实测原样（脱敏 key 路径外未改动）。

## 逐项实测与回执

### 1. local↔SSH rsync（argv 透传 + 原生默认）

调用 `{action:"rsync", src:"/tmp/.../small.txt", dst:"byossh:fp1:/tmp/fp-remote/small.txt", argv:["-a"]}`：

```json
{"exit":0,"stdout":"","stderr":"","outputTruncated":false,"action":"rsync","src":"/tmp/.../small.txt","dst":"byossh:fp1:/tmp/fp-remote/small.txt","argv":["-a"],"route":"local-ssh","command":"rsync -a"}
```

- `route:"local-ssh"`、`command:"rsync -a"`（argv 保序）；回执**无 `verified` 字段**（不冒充校验）。远端文件 diff 一致。

### 2. rsync --dry-run 不写盘

`argv:["-a","--dry-run"]` → `exit:0`；目标路径 `/tmp/fp-remote/dryrun-small.txt` 实测**不存在**（未写盘）。

### 3. local↔SSH rsync 真 delta

8 MiB `big.bin` 先全量同步，改中间 12 字节后再 `argv:["-a","--stats"]`：

```
Literal data: 2,896 bytes
Matched data: 8,385,712 bytes
Total bytes sent: 14,583  received: 17,417   speedup 262.14
```

结构化字段：`literalBytes:2896, matchedBytes:8385712, sentBytes:14583, receivedBytes:17417`。远端 `big.bin` SHA-256 一致 —— 真增量，非整份重传。

### 4. local↔SSH copy（scp）

`{action:"copy", src:本地, dst:"byossh:fp1:...", argv:["-p"]}`：

```json
{"action":"copy","src":"...","dst":"byossh:fp1:/tmp/fp-remote/scp-small.txt","route":"scp",
 "argv":[["scp","-o","BatchMode=yes","-P","38129","-i","<key>","-p","/tmp/.../small.txt","u1@127.0.0.1:/tmp/fp-remote/scp-small.txt"]],
 "exits":[0],"stdout":[""],"stderr":[""],"outputTruncated":false,"verified":false,"cleanup":"none-required"}
```

- 身份选项（`-P/-i`）**在 caller argv（`-p`）之前**，caller 显式选项可覆盖 —— 与评审修复一致。反向 scp（SSH→local）同样 `exit:0`，往返内容 diff 一致。

### 5. SSH↔SSH copy（scp -3，双端不同 key）

`src:"byossh:fp1:/tmp/fp-remote/small.txt"` → `dst:"byossh:fp2:/tmp/fp-remote2/from-fp1.txt"`：

```json
{"route":"scp -3 (data through origin)",
 "argv":[["scp","-3","-F","/tmp/superd-scp3-2tNslx/config","superd-scp3-source:/tmp/fp-remote/small.txt","superd-scp3-destination:/tmp/fp-remote2/from-fp1.txt"]],
 "exits":[0],...,"verified":false,"cleanup":"released"}
```

- 两端不同 key 经发起机中转；临时 SSH config 用别名区分两端身份，用后 `cleanup:"released"`，实测 `/tmp/superd-scp3-*` 无残留。内容 SHA 一致。

### 6. local↔docker copy、local↔incus copy

- docker：`route:"docker cp"`，argv `["docker","cp",...]`；往返 diff 一致。
- incus：`route:"incus file push"` / `"incus file pull"`，push 的 stdout 含进度输出原样透出；往返 diff 一致。

### 7. SSH↔SSH rsync（转发路线，本规格“唯一新增数据连接设施”）

`src:"byossh:fp1:/tmp/fp-remote/srcdir/"` → `dst:"byossh:fp2:/tmp/fp-remote2/dstdir/"`，`argv:["-a","--stats"]`：

- 首次全量：`route:"ssh-ssh-forward"`、`cleanup:"released"`、`sshArgv` 三条会话（目标 `-L`+daemon、来源 `-R` hold、来源 rsync 客户端），身份 token 全在 origin，远端命令行不含 key 路径。`Matched data: 0 / Literal data: 8,388,624`。
- 改源端二进制中间 16 字节后复跑：`Matched data: 8,385,712 / Literal data: 2,896`，`sent 14,621 / received 17,417`（合计约 32 KB，远小于 8 MiB）——**同一次协议对话的跨端增量**，发起机只转发协议字节。目标 `binary` SHA-256 与修改后源一致。

### 8. 原生失败与拒绝面（模型实际看到的报错）

| 用例 | 模型看到的 |
| --- | --- |
| rsync 缺失源 | **Error**（throw）：`exit:23` + `stderr:"rsync: [sender] link_stat ... No such file or directory (2)\nrsync error: ... (code 23)"` |
| scp 缺失源 | 正常回执：`exits:[255]` + `stderr:["scp: stat local ... No such file or directory"]` |
| 原生 copy 带 `verify:true` | Error：`copy: verify/mkdir apply to the Hub/local staged lane only; native CLI routes do not verify or create parents...` |
| `argv` 与 `pullArgv`/`pushArgv` 混用 | Error：`argv cannot be combined with pullArgv/pushArgv...` |
| `pullArgv` 缺 `pushArgv` | Error：`pullArgv requires pushArgv (a two-segment copy has both halves)` |
| `argv` 非数组（字符串） | Error：`invalid arguments: "argv" must be an array` |
| 旧高层 `dryRun:true` | Error：`dryRun was removed: pass native options through argv instead (e.g. "--dry-run")` |
| scp `argv:["-R"]` | Error：`scp -R would authenticate to the destination from the source host; identities must stay on the origin (scp -3 through-origin is the supported route)` |

## 关键发现（需跟进）

### F1 [major] 双 SSH rsync 转发路线泄漏远端资源，且 `cleanup:"released"` 名不符实

**可复现**（2/2 次调用）。每次 `route:"ssh-ssh-forward"` 成功后，目标端（fp2）残留：

1. 一个 `bash -c <daemon 脚本>` 进程（阻塞在 `wait "$daemon"`）；
2. 一个 `rsync --daemon --no-detach` 进程；
3. 一个 `/tmp/superd-rsync.XXXXXXXX/rsyncd.conf` 临时目录。

而回执一律报 `cleanup:"released"`（SIGKILL 才 `unknown`）。实测证据：

- 调用后 `ps`：`bash -c set -eu [ -d /tmp/fp-remote2/dstdir/ ] ...` 与 `rsync --daemon --no-detach ... --config=/tmp/superd-rsync.6thhKyeq/rsyncd.conf` 均在运行；`/tmp/superd-rsync.6thhKyeq/rsyncd.conf` 内容 `path = /tmp/fp-remote2/dstdir/`（确为本轮调用产物）。
- 同机还留有**更早**（16:41–17:59 开发/测试期间）的 63 个孤儿 `rsync --daemon` 与 55 个 `/tmp/superd-rsync.*` 目录 —— 说明这是系统性泄漏，不是单次偶发。

**根因判断**：`Held.stop()` 对**本地** ssh 进程组发 SIGTERM；`-T`（无 pty）下远端 shell 收不到能触发 `trap EXIT HUP INT TERM` 的信号，`wait "$daemon"` 不被打断，daemon 与临时目录成孤儿。即实施报告「安全复查第 5 项」声称的「daemon 后台启动 + trap → 优雅退出即释放」**实际未生效**。

**与规格对照**：spec §原生结果要求「工具自建远端临时配置/daemon 负责在正常退出尽力释放；无法确认时返回未知状态」。当前既未释放，又把 `released` 当已确认返回，两处都不符合。建议：远端 daemon 释放改为**显式远端命令**（如 rsync 结束后主动 `kill` + `rm -rf`，或经第二条 ssh 下发清理），而非依赖信号传播；在能确认释放前，回执应如实报 `unknown`。本报告只记录事实，不动代码（红线 §5 上游零修改、本轮未经 user 放行不改发布物）。

> 我本轮产生的 2 组（shell + daemon + 目录）已手工清理；更早的 63+55 处残留未动，留待处置。

### F2 [minor] rsync 与 copy 的失败面不对称

- `rsync` 非零 exit 由 `tool.ts` **throw**（模型看到 `Error: {...}`，含 exit/stderr）。
- `copy` 非零 exit **不 throw**，返回正常回执 `exits:[N]`（模型必须读 `exits` 才能发现失败）。

两路由都把 exit/stderr 如实透出，但信号强度不一致。模型若把 copy 回执当成功（只看不读 `exits`）可能漏判失败。属可跟进的一致性/易用性观察，非本轮阻塞项。

## 未覆盖 / 待办（诚实边界）

- 双 SSH rsync **拒绝转发**（stdio 路线不可用）未在第一人称重跑：该路线已在 fixture 测试按规格裁决为「当前 OpenSSH 10.2 + rsync 3.4.1 组合不可用、无整份拷贝冒充」，本轮未重复搭 deny-forward fixture（loopback sshd 需显式 `AllowTcpForwarding no` + 双端分别验证，成本高且已有 fixture 证据）。
- **dev3 目标机实装**、**git 定版/commit/tag/push** 仍按红线待 user 放行（实施报告 §未完成/待放行）。本轮未触碰生产 `~/.dsh`/`~/.superd`/3080/3081；dev3 未安装、未重启。
- 本轮临时资源清理：已停 2 套 loopback sshd、清 known_hosts、删 `/tmp/superd-fp-remote*`、`/tmp/fp-remote*`、`/tmp/fp-remote2*` 及我产生的 daemon 泄漏；docker/incus 容器内测试文件留在容器 `/tmp`（无害，容器属测试态）。

## 0.3.0-k 复验附记（同日 21:05 后）

**性质澄清（重要）**：F1 是**临时目录/进程残留（housekeeping）**，不是**凭据泄露（security）**。身份始终留发起机：三条 `sshArgv` 的 key token 全在 origin，`--` 之后的远端命令行不含任何 key 路径；残留的只有 rsync 模块配置（`path`、`hosts allow/deny`，权限 600）与一个 loopback-only daemon 进程，**无密钥/凭据**。

**0.3.0-k 修复内容**（本会话 20:45 重启后已生效：安装态 `package.json` = 0.3.0-k，plugin.js 含 `SUPERD-RSYNC-TMP`×2）：
- `daemonCommand` 末尾 `exec rsync --daemon ...` —— shell 被 daemon 取代，不再有后台 `&` + `wait` 的孤儿 shell。
- daemon 把 `mktemp` 路径以 `SUPERD-RSYNC-TMP <path>` 写到 held stderr；`settle()` 在 stop 后经独立清理 ssh 执行 `rm -rf <path>`（10s 上限），清理确认失败才报 `cleanup:"unknown"`。

**第一人称复验（2/2）**：重新搭 fp1/fp2 loopback sshd（fp1=53451、fp2=51381），跑两次 `route:"ssh-ssh-forward"`（全量 + delta，delta 仍 `Matched 8,385,712 / Literal 2,896`），每次后清点：

| 项 | 0.3.0-j（旧） | 0.3.0-k（复验） |
| --- | --- | --- |
| `/tmp/superd-rsync.*` 临时目录 | 每次 +1 残留 | **0，已归零** ✅ |
| `bash -c` daemon 脚本进程 | 每次 +1 残留 | **0 新增**（`exec` 消掉 shell）✅ |
| `rsync --daemon --no-detach` 进程 + loopback 端口 | 每次 +1 残留 | **每次 +1，仍残留** ❌ |

即 0.3.0-k **修好了目录残留与 shell 孤儿，但 daemon 进程 + 其 loopback 监听端口仍未释放**（两次各留一个：`rsync --daemon --no-detach --port=34897 / 41287`，其 config 目录已被 `rm -rf` 删除，而进程仍在跑、端口仍 `LISTENING`）。

**残余风险定性**：泄漏的 daemon 是 `hosts allow 127.0.0.1 / read only = no` 的 loopback rsync 模块，把目标目录写权限暴露给目标机**本地**进程——生产上若目标目录敏感，属**中等偏低的本地攻击面**（非凭据泄露、不可远程触达）。`cleanup:"released"` 现在对「目录已释放」是诚实的，但「daemon 进程/端口未释放」这一事实仍未被回执体现。

**建议**：把 daemon 进程也纳入清理——`removeRemoteTemp` 的清理 ssh 里对 daemon 补 `pkill -f '<config path>'`（或让 daemon 绑定会话生命周期）；在 daemon 能被确认回收前，回执应如实反映「daemon 未确认释放」（如 `cleanup:"dir-released,daemon-unknown"` 或单独字段）。我本轮产生的 2 个 daemon 已手工 kill，fixture 已拆除。

**0.3.0-l 收尾（21:19 后，已复验）**：daemon 进程泄漏也修了——`daemonCommand` 的 rsyncd.conf 加 `pid file = "$tmp"/rsyncd.pid`，`removeRemoteTemp` 清理脚本先按 pidfile `kill`（优雅，等 2s 后 `kill -9`）再 `rm -rf`。第一人称复验 2/2：全量 + delta 两次 `ssh-ssh-forward` 后 `/tmp/superd-rsync.*`=0、`rsync --daemon` 进程=0、`bash` 孤儿=0、loopback 端口已释放。**F1 至此完整关闭**（j 泄漏全部三项 → k 清目录/shell → l 清 daemon 进程）。

## 结论

新原生 CLI 语法糖在真实 DSH 会话第一人称下**行为面全部通过**：argv 透传/无强制默认、真 delta（local↔SSH 与 SSH↔SSH 转发路线均实测 `Matched >> Literal`）、scp -3 双身份中转、docker/incus 原生命令、原生失败与全部拒绝面如实可见。**F1 已在 0.3.0-l 完整关闭**（目录/shell/daemon 进程三项残留全部归零，2/2 复验）。遗留仅 F2（rsync/copy 失败面不对称）与 dev3 实装、git 定版两件待放行事项。
