# Remote 原生 CLI 语法糖与双 SSH rsync — 0.3.0-q 测试轮报告

- 日期：2026-10-11（Asia/Hong_Kong）
- 分支/工作树：`feat/remote-native-shortcut` @ `.worktrees/remote-native-shortcut`（基于 master `458e488`，未 commit——按计划红线，验收与放行前不定版）
- 规格：[docs/specs/remote-native-shortcut/spec.md](../specs/remote-native-shortcut/spec.md)；计划：[2026-10-11-remote-native-shortcut](../superpowers/plans/2026-10-11-remote-native-shortcut.md)
- 版本：双包同步 `0.3.0-q`（`npm run version:release -- 0.3.0-q`；h–p 为同日中间轮）

## 交付形态

- 双 tarball：`.scratch/superd-pack/better-dsh-0.3.0-q.tgz`（sha256 `c5d00ac4…10557`）+ `super-dsh-0.3.0-q.tgz`（`8ba8b68d…857f2`）；`[pack] verified independent synchronized packages`。（j 轮 tarball 曾因 launcher 复打包字节级 sha 漂移，已随后续轮作废。）0.3.0-h/i/j 为同日中间轮（i 不含评审批修复；j 不含对端 daemon 残留修复），已被本轮取代。
- Super `remote/` 闭包由 `pack.mjs` 从本分支 `better-dsh/src/remote` 再生成（provenance 由 pack 校验），未手改。
- 4999 测试线（2026-10-11 user 指令迁移：停主 checkout 的 4999 家族，本 worktree 线上 4999；早前临时 4995 线同批停用）：worktree 独立 home `.tests/superd-wt`，super-dsh 0.3.0-q 整包 pnpm 安装，companion 经原生 Plugin Manager 安装 better-dsh 0.3.0-q。
  - local: http://127.0.0.1:4999/ ；wan: https://test.pc.internal.test/ ；lan: http://192.0.2.130:4999/（relay `superd-lan-4999-relay`）
  - unit：`superd-4999-test`（停止：`systemctl --user stop superd-4999-test superd-lan-4999-relay`）；pair registry 指向本 worktree tarball
- 安装产物 Surface 核验：`profiles/superd-pub/node_modules/better-dsh/lib/remote/plugin.js` 含 `argv is ordered native rsync options…` 与 `pullArgv`（21 处），旧 `dry-run (default true)` 文案 0 处。

## 行为验证（本地 SSH fixture，`test/remote/`）

全目录（0.3.0-h 时点）：**184 passed / 8 skipped（docker/incus env-gated）/ 26 文件通过**；终版 0.3.0-j 定向复跑 copy 11、rsync 11、container 3。better-dsh 全套件 0.3.0-j：800 passed；仅 `test/surface-devices/browser-device.spec.ts` 6 项失败（`BROWSER_NO_CHROME`，主 checkout 基线同样失败——环境缺 Chrome，与本次改动无关）。

### Task 1 — 参数与回执契约
- `argv` 逐 token 保序透传；省略 argv 时无任何强制 `-a/--dry-run/--timeout`（目录需递归是原生语义，由调用方传 `-r`）。
- 旧高层字段（`dryRun/delete/excludes/preserve`）从模型 Schema 移除并在 tool/driver 两层显式拒绝（参数根是开放对象，拒绝在 execute 层执行）。
- `argv` 非数组/空串/NUL 元素、与 `pullArgv/pushArgv` 混用、`pullArgv` 无 `pushArgv`（及反向）均在拨号前报错。
- Hub/纯本地通道拒绝 CLI 选项字段；`verify/mkdir` 仅该通道消费；原生路径 `verified:false`，从不冒充校验。

### Task 2 — 原生 copy 路由
- local↔SSH `scp`（默认 SFTP；`-p` 透传；空白/引号/换行路径往返一致）。
- SSH↔SSH 两个不同 BYO key：`scp -3` 经发起机 + 仅本机的临时 SSH config（用后整目录删除，`cleanup:"released"`；无 `/tmp/superd-scp3-*` 残留）；`scp -R` 启动前拒绝（实测 OpenSSH 10.2 scp(1)：`-R` 从源端再认证目标）。
- local↔Docker `docker cp`、local↔Incus `incus file push/pull`：真实容器往返（含 190KB 二进制、`雪\nfile` 文件名）；原生 CLIs 不建父目录——fixture 预建目录体现了该语义；缺失路径的 exit/stderr 原样入回执。
- SSH↔Docker 跨端点：两条原生命令 + 发起机 staging，`pullArgv:['-r']`/`pushArgv:['-a']` 分别落入两段 argv，`cleanup:"released"`；`argv`+pull/push 混用拒绝。

### Task 3 — local↔SSH 原生 rsync
- `RSYNC_RSH` 携带端点 SSH 身份（rsync 自身引号语法 `''`；占位 host 在发起机被 shift 消耗，IPv6 `::1` 不被 rsync 误解析）。
- 显式 `-e/--rsh` 按调用方命令执行（命令须自携端口/key/config），回执 argv 原样。
- `--dry-run` 不写盘；`--delete/--exclude` 调用方选择；8MiB 大文件 12 字节改动实测 `Matched data 8385712 / Literal data 2896`（真 delta）；无 `--stats` 时 `literalBytes/matchedBytes` 等字段不存在（回执只解析 CLI 实际输出；undefined 字段条件展开以满足工具输出 JSON 无损校验）。
- 尾随斜杠语义（`src/` 拷内容 vs `src` 拷目录本身）、symlink 经 `-a` 保留、缺失源报原生 `No such file`。

### Task 4 — 双 SSH 转发路线
- 拓扑：目标端临时 loopback-only rsync daemon（`use chroot=no/read only=no/munge symlinks=yes`，mktemp 配置随会话）→ 目标 `ssh -L` → 来源 `ssh -R` → 来源原生 rsync 客户端 `rsync://127.0.0.1:<port>/task/`。三端口互异（同机 fixture 下也不冲突；发现并修复了 freePort 释放-复用竞态）。
- 增量实证：8MiB 已存在目标 + 小改动，`matchedBytes > 8e6`、`literalBytes < 2e6`，SHA-256 一致；origin 只转发协议字节。
- 身份：全部 ssh argv 携带 origin 本地 key 路径；`--` 之后的远端命令行不含任何 key 路径。
- 目标目录不存在（两路线均失败）：组合事实报错、零拷贝、无完整暂存（`.scratch` 无 `remote-native-copy-*`）。

### Task 5 — 标准流路线（实证裁决：当前组合不可用）
- 设计在**本地进程桥**（无 SSH）完整验证通过：fd-dup 适配（`exec 9<&0 8>&1` + `-e "bash -c 'cat <&0 >&8 & cat <&9 >&1; wait' --"`）+ rsync 自身生成的接收命令（`rsync --server --daemon .`，daemon-over-remote-shell，模块配置于临时 cwd）——4MiB 单次协议对话传输成功，stats 显示真实增量。
- 真实 OpenSSH 会话下失败：源端组合（exec 会话内的 rsync 客户端 + fd-dup 适配器）使 ssh 在协议开始前拆除会话 stdin 通道（`ssh -vvv`：`channel 0: read failed rfd 4 … Broken pipe` → `send eof`），独立探针证实 41 字节 daemon greeting 无法到达会话 fd 9。已排除/尝试：fd 0 关闭（`0<&-`）、去 `-T`、去 keepalive、`/dev/fd/9` 变体——OpenSSH 10.2 + rsync 3.4.1 组合下均无效。
- 按规格 §「第二路线」的裁决路径：`stdioRoute` 如实抛出“该组合不可用”错误（`ssh-rsync-native-relay.ts` 内注释记录证据链）；转发被拒时用户看到的是组合事实，而非误报“rsync 不可用”；**无 Python 回退、无完整拷贝冒充**。
- 后续可选方向（未承诺）：OpenSSH 新版本行为复核；或经用户裁决引入已文档化的其他通道形态。

### 模型可见 Surface
- `tool.ts` 描述重写：文件操作段落不再要求远端 Python（exec oneshot 段落保留其真实 Python receiving-owner 前提，测试断言文件段与 exec 段分离）；`argv/pullArgv/pushArgv` 语义、双 SSH 两条路线、`-R` 拒绝、`verified:false` 含义均已写入。
- `docs/remote-tools.md` 同步重写（copy/rsync 路由表、先决条件、无强制默认的说明）。
- 真实 scoped tool（real-harness）：schema 接受 `argv`，回执 `{action:'rsync',exit:0,argv:['-a']}`，`verified` 不存在；原生失败以 CLI stderr 透出。

## 清理（旧链路拆除）

- 删除：`ssh-source-proxy.ts`（源端 Python 代理）、`archive-python.ts`（FILE_PYTHON）、`endpoints.ts` 的 `cliFileEndpoint/fileArgv`、`ssh-relay.ts` 的 `withSshRelay/preflightRsync/preflightRelaySource/nativeRsyncPath/withNativeRsyncOwner 别名`、`plugin.ts` 的 `withSshRelay` 再导出；测试侧删除 `ssh-relay.spec.ts`、`ssh-source-proxy.spec.ts`、`cli-copy-owner.spec.ts`，`endpoints.spec.ts` 收窄为纯解析。
- 保留（oneshot 仍在用，未误删）：`ssh-relay.ts` 的 `Command/withNativeCommandOwner/RELAY_SSH_OPTIONS`、`ssh-lease.ts`、`ssh-process.ts`、`file-worker.ts`（Hub 接收端 Node worker，superd-hub 侧消费）。

## 事后独立安全复查（同日补充）

独立 reviewer 子 Agent 两次尝试均因其模型后端 402（deepseek 余额不足）失败，改由实现 Agent 以注入审计视角自查（发现即修，附回归测试）：

1. **scp -3 临时 SSH config 换行注入**（`native-copy.ts` `tempSshConfig`）：`ssh:<alias>` 目标的别名经 `target.ts` 的 `(.+)` 正则无字符校验直达 `HostName`/`User`/`IdentityFile`/`ProxyJump` 行 —— 模型可控换行可注入任意 config 指令（如 ProxyCommand）。byossh 注册路径本身已被 `normalizeSshConnection` 的 HOST/USER/JUMP 正则封死，仅 `ssh:` 别名漏入。修复：`tempSshConfig` 写文件前对四个字段拒绝 `[\r\n]`。回归：`copy.spec.ts`「refuses newline-bearing ssh: aliases before writing the scp -3 temp config」（含无残留 temp dir 断言）。
2. **rsyncd.conf path 行注入**（`ssh-rsync-native-relay.ts` `daemonCommand`）：`checkAbsolute` 拒绝 NUL/`..` 但不拒绝换行，destination path 含 `\n` 可写入额外 daemon 指令（pre-xfer exec 等）。非提权（模型对该端点本有完整 cmd 权），但为纵深防御与转义正确性：`daemonCommand` 入口拒绝 `[\r\n]`。
3. 复核确认安全面：`RSYNC_RSH` 全 token 工具构造 + rsync 自身引号语法（`''` 双写）；`scpSpec`/`identityArgv` 走 argv 数组无 config 生成；argv 元素经 spawn 直传无 shell。

修复后复跑：`rsync.spec.ts` 11/11 + `copy.spec.ts` 9/9、typecheck 0 错误。修复发生在 0.3.0-h 打包之后，按字母迭代规则换 `0.3.0-i` 重打包（该轮 sha 已被 0.3.0-j 取代）。

## 独立评审与修复（同日晚，0.3.0-j）

评审子 Agent（换用通用 task agent 绕开 reviewer 后端 402）完成只读独立评审：确认 argv 契约主体正确、旧字段显式拒绝到位、双 SSH rsync 转发路线真实、无冒充、死代码清理干净、两个注入点修复完备、未发现其它注入面。另发现并已全部修复：

1. **[major] local↔SSH scp 身份选项顺序**：工具身份（`-P/-i/-J`）排在 caller argv 之后，scp last-wins 使 caller 显式 `-i/-P` 无法覆盖注册身份（违反 spec「调用方显式选项按原生执行」）。修复：两条 local↔SSH 路由改为身份在前、caller argv 在后（与 ssh↔ssh `-3` 路由一致）；修正 identityArgv 注释方向。测试：`caller -i in argv overrides the registered scp identity`（断言 caller -i 位于注册 -i 之后且传输成功）。
2. **[major] 原生 copy 路由静默忽略 verify/mkdir**：spec 要求原生路径「不接受」，与 copyTree 拒绝 argv 不对称。修复：`driver.ts` 原生分支显式抛错。测试：`native scp routes refuse verify/mkdir and reject -R inside option clusters`。
3. **[minor] caller -e/--rsh 检测不完备**：短选项簇（`-avze`）漏检。修复：按 rsync 选项语法匹配簇末位 e。
4. **[minor] IPv6 hostSpec 丢 user@**：`rsync.ts` IPv6 分支未拼 user；`native-copy.ts` `scpSpec` IPv6 字面量不加括号（`user@::1:path` 会被误解析）。两处修复：IPv6 host 加 `[]` 且保留 user@。
5. **[minor] 远端 rsyncd.conf 残留**：`daemonCommand` 用 `exec` 替换 shell，SIGTERM 后远端临时目录永久残留。修复：daemon 后台启动 + `trap 'kill; rm -rf' EXIT HUP INT TERM`（优雅退出即释放）；`forwardRoute` cleanup 状态由死分支改为基于 SIGKILL 如实计算（SIGKILL 会话 → `unknown`）。
6. **[nit]** `checkArgv` 拒绝裸 `--`（防 operand 注入）；`rsyncSshArgv` 测试缝改名 `nativeSshArgv`（现仅 oneshot 使用）；`process.ts` 缩进漂移。

定向复跑：copy 11/11、rsync 11/11、container 3/3、typecheck 0。0.3.0-i 打包先于此批修复，按字母迭代规则换 **0.3.0-j** 重打包。全量回归（子 Agent 复跑）：**800/818 passed**（新增 3 测试后总数增长），仅 browser-device 6 个 BROWSER_NO_CHROME 环境失败（与基线一致），双 typecheck 0，零真实回归。4999 线（时为 4995 后迁）安装 0.3.0-j 双包，live plugin.js 中 trap 清理与 verify/mkdir 拒绝文案核验在场。

## 对端 daemon 残留 — 4999 自测会话报告核实与修复（0.3.0-k）

4999 线自测会话报告「daemon 在对端泄露」。核实结论：**部分属实，已修复**。

- **属实部分**：双 SSH 转发路线的目标端 daemon 临时目录（`/tmp/superd-rsync.*/rsyncd.conf`）在 0.3.0-j 及以前**每次运行都残留**（本机 fixture 实测一次全量 rsync.spec +2 个；历史累计 59 个）。0.3.0-j 的 trap 方案无效：本机 SIGTERM 杀 ssh 客户端后连接断开，远端 sshd 直接终止会话，EXIT/HUP trap 从不执行。
- **非凭据泄露**：残留内容为 rsync 模块配置（`path = <目标路径>`、hosts allow/deny），无密钥/凭据；身份留发起机不变（既有测试断言 `--` 后远端命令行无 key 路径）。
- **修复（0.3.0-k）**：daemon 会话把 mktemp 路径以 `SUPERD-RSYNC-TMP <path>` 标记写到 held stderr；`forwardRoute` 在成功/失败/取消全部路径 stop 后经**独立清理 ssh** 执行 `rm -rf`（10s 上限，身份仍发起机持有；清理确认失败时回执 `cleanup:'unknown'`）。
- **验证**：rsync.spec 全量 11/11 + copy.spec 11/11，`/tmp/superd-rsync.*` 前后清点 **delta=0**；新增防回归断言（forward 成功测试断言远端零残留）。历史残留（本机 59 个 + 开发实验 FIFO）已清理；dev3 实测 `/tmp` 无 `superd-rsync.*`/`superd-scp3-*`。

## daemon 进程残留 — 第一人称报告复验跟进（0.3.0-l）

4999 线自测会话的第一人称报告（`docs/test-reports/2026-10-11-remote-native-shortcut-first-person.md`，主 checkout）在 0.3.0-k 复验中指出：目录残留与 shell 孤儿已归零，但 **daemon 进程 + loopback 端口仍每次 +1**（`removeRemoteTemp` 只 rm 目录）。跟进核实：属实。

- **根因链（实验实证）**：rsync daemon **忽略 SIGHUP**（daemon 常规行为）→ held ssh 本地 SIGTERM 断连后远端 sshd 杀不掉它；0.3.0-k 的 pidfile `kill` 未生效原因待查期间实证 SIGTERM 后 0.5s 仍在（且手动实验显示 kill -0 对僵尸态恒真）。
- **修复（0.3.0-l）**：清理 ssh 改为「SIGTERM → 最多 2s 轮询 `kill -0` → `kill -9` 兜底 → `rm -rf`」；`rsyncd.conf` 增 `pid file = $tmp/rsyncd.pid`（daemon 自写 pid，清理按 pid 精确杀）。
- **验证**：清空起点（含 68 个历史 daemon 孤儿 pkill 清理 + 实验垃圾目录）后全量 `rsync.spec` 11/11 + `copy.spec` 11/11，`/tmp/superd-rsync.*` 目录 **0**、`pgrep rsync --daemon.*superd-rsync` 进程 **0**。防回归断言已在 k 轮加入（目录维度）。
- 第一人称报告的「daemon 进程未释放 ❌」条目自本 resolving 轮起由 0.3.0-l 取代；其「性质澄清（housekeeping 非凭据泄露）」结论与本报告一致。

## oneshot Python 链拔除（0.3.0-m，user 裁决）

用户裁定：oneshot exec 残留的 Python owner/lease/clock/flock 守护协议属 over-engineering 与边缘防御（单调时钟防 NTP 跳表、flock 恢复门、8s lease 三段握手等），按 PTY 路线已验证的「对端薄 wrapper + 本地 killpg」模式移除。

- **实现**：`buildOneShotArgv`（ssh/docker/incus）改为 `bash -c` + POSIX wrapper（`trap 'kill -TERM 0' TERM HUP INT` + 前台 `bash -lc <cmd>`）—— 会话收到组信号时清整个进程组，正常完成 exit 码原样透传（实证 `exit 42`→42、stdin 逐字到达；`& wait` 形态因 bash 异步 stdin 语义被否）。`ssh-process.ts` 收缩为纯 CLI 转发（startOneShot 生命周期：timeout/cancel/killpg）。
- **删除**：`ssh-lease.ts`（Python helper 全部）、`ssh-relay.ts`（owner/supervisor/lease 机制）、`startOwnedSshProcess`/`startOwnedBinaryProcess`（零调用尸体）、driver 的 `nativeSshArgv` 死配置。
- **语义对齐（如实）**：取消/超时立即停本地传输；远端回收尽力而为 —— 实证 sshd 断连不向无 PTY 会话发信号，wrapper trap 只在信号真到达时生效（测试以对端组 TERM 验证 trap 清组）。tool 描述与 `docs/remote-tools.md` 同步改写：「无 Python、无 owner/lease 协议、无额外会话」。
- **验证**：`ssh-process.spec.ts` 重写 4/4（stdin/exit 透传、组 TERM 清场、超时、argv 零 Python）；`transports.spec.ts` 形状断言更新 9/9；`ssh-jobs-cleanup.spec.ts` 对齐 best-effort 语义 1/1；`copy.spec.ts` 描述断言更新。remote 目录 **184/184**；全量 **797 passed**（仅 6 个 BROWSER_NO_CHROME 环境失败，基线一致）；双 typecheck 0。

## oneshot 远端回收回归 — 第一人称复验跟进（0.3.0-n）

4999 自测会话（GLM 5.3 Flash）复验 0.3.0-m：Python 清干净 ✅，但「远端进程回收」被连带删除 ❌（两条回归：超时/取消后远端孤儿；正常完成后台子存活 + 攥住 stdout 卡 120s）。跟进修复（全部纯 shell，无 Python/lease/clock）：

- **回归 2（正常完成）**：wrapper 增加 `EXIT trap`（自免疫后 `kill -TERM 0`）—— 命令结束即清全组（后台子不存活、不攥 stdout）；退出码原样透传（`exit 42`→42 实测）。
- **关键结构修正**：wrapper 跑在 `setsid --wait` 的**私有会话**里 —— 实证 sshd 会话进程与远端命令**共享进程组**，不隔离则 `kill 0` 每次把连接一起带走（exit 255/11）；两个 trap 均先 `trap "" TERM HUP INT` 自免疫，避免排队的信号覆盖退出码（setsid 报 "did not exit normally"）。
- **回归 1（超时/取消）**：实证 sshd 对无 PTY 会话断连不发信号、stdin EOF watchdog 方案在 fixture 下误杀（EOF 早于命令完成），改用**与 rsync daemon 远端清理同构的显式清理**：wrapper 把自己的 pgid 写 pidfile（`/tmp/superd-oneshot-<tag>.pgid`），本地取消/超时后经独立清理会话 `kill -TERM → kill -KILL` 该组。
- **验证**：`ssh-process.spec.ts` 6/6（stdin/exit 逐字透传、对端组 TERM 清场、**超时后远端树零孤儿**、**后台子回收 + 秒回**、argv 零 python3）；transports 9/9；copy 11/11；remote 目录 **186/186**。测试探测改用字符类模式（`pgrep -f 'sleep 30[0]'`）避免查询会话自匹配假阳性。
- 工具描述与 `docs/remote-tools.md` 同步为准确的回收语义（EXIT trap / pidfile 清理会话）。
- **0.3.0-o 补充（第一人称复验再发现）**：正常完成路径的 pidfile 本身残留（每次 oneshot +1，homepc 实测累计 171 个）—— wrapper 写 pidfile 但 EXIT trap 只 kill 不 rm。修复：EXIT trap 末尾补 `rm -f <pidfile>`（cancel/timeout 的 killer rm 保留，兜底 SIGKILL 时 trap 不触发的场景）。回归断言：verbatim 测试前后清点 `superd-oneshot-*.pgid` 数量不增长（相对断言避开跨测试异步 killer 竞态）；全 remote 套件跑完后实测 `/tmp` 残留 0。历史残留（本机 171 个）已清理；dev3 实测 0。

## tool description 精化与工程化（0.3.0-p，user 反馈）

用户裁定当前描述像旧版之前一样臃肿、且嵌在 TS 字符串拼接里编辑困难（撇号转义）。两项改造：

- **结构**：description 抽为模块级模板字面量 `REMOTE_TOOL_DESCRIPTION`（tool.ts 顶部，heredoc 风格多行文本）—— 直接编辑零转义；约定文本内不用反引号与 `${`。
- **内容**：按「总起 → call shapes → BYO-PTY → 模式 → 文件操作 → 输出/超时/后台」重排；BYO-PTY 段从 ~10 行压缩到 3 行（label 语义一次讲清：同 spawn 复用、异 spawn 拒绝、过期/未知 [E_NO_SESSION]、失败不占 label）；oneshot 的 wrapper/清理语义并入 Modes 段一句带过（setsid 私有会话 + EXIT trap + pidfile 清理）；rsync 段清理语义改准确（显式拆除，未确认报 cleanup:"unknown"）。
- **验证**：rsync/copy/ssh-process/transports/jobs-cleanup 定向 27+11 全过；remote 目录 **186/186**；typecheck 0。描述断言更新：文件段零 Python、整体含 "no Python" 否定声明。

## tool description 定稿（0.3.0-q，user 二次反馈）

用户裁定 0.3.0-p 版仍过长：以旧 release 版的 call-shape 表骨架为准、控制字数、融合当前行为。定稿 ~2.2k 字符（0.3.0-p 的 ~5.6k → 旧版的 ~7k）：call-shape 表（6 行）→ bare-name/byop 规则（2 句）→ oneshot/pty 模式（各 1-2 句）→ Files 段（copy 路由 + rsync 语义合并为一段）→ Output/timeout/background（一段）。全部行为承诺保留（argv verbatim、无强制默认、verified 语义、scp -R 拒绝、verify/mkdir 通道限定、真 delta/无全量回退、wrapper 回收、零 Python）。remote 目录 186/186；描述断言对齐（"bash only (no Python)"）。

## 第一人称验收行程（2026-10-11 晚，浏览器实测；时为 4995 线，该线现已迁 4999）

- 登录：fresh home 密码页（DEFAULT_PASSWORD 生效，shared credentials 的密码记录未覆盖此 home 的会话门）。
- DSH native 会话（模型 DeepSeek-V41-Flash / DeepSeek-V4-Pro）：10 步验收 prompt 发出后连续 `Request quota exhausted`（QUOTA）—— `.env` 的 `DEEPSEEK_API_KEY` 配额耗尽，两个模型同 key 同配额。upstream DSH CLI 的 native 模型供应商内置 DeepSeek-only，无法换 key。**第一人称 DSH 会话验收被环境阻塞（非产品缺陷）**；待配额恢复或 user 以自有账号亲验。
- 桥接 Claude 会话（glm-5.3，经 Hub runtime selector 切换）确认：桥接 runtime 工具面**无 `remote` 工具**（与 ADR/记忆一致 —— remote 是 better-dsh 的 DSH 侧工具）；该会话可调 Claude Code 原生工具 + `mcp__superd-hub__superd-hub`（仅 agents/agent_status/send/read/stop/exec actions，无 rsync/copy/argv 参数 —— 参数面与 remote 正交）+ chrome-devtools/WebReader MCP。桥接层行为正常，hub 工具面诚实（模型自行澄清 exec ≠ remote）。
- 安装产物 Surface 冒烟（前述 plugin.js 断言）+ fixture 行为验收（184 tests）覆盖了产品行为面；模型可见的第一人称回执样例留待 DSH 会话配额恢复后补录。

## 未完成/待放行事项

1. **dev3 目标机实装**：现行通道为 npm 发布后的生产安装（0.3.0-f/g 两轮均如此）；npm publish 需 user 对本轮明确放行（红线 §0.1c/§0.3）。放行 → 发布 → dev3 实装验收（create/prompt/resume 覆盖本次 remote 行为面）→ 报告补录。
2. **git 定版/commit/tag/push**：按计划红线，待验收 + 报告 + user 放行后执行（worktree 变更目前未提交）。
3. 4999 线保持运行供 user 亲手验收（第一人称会话验证 remote argv/copy/rsync 的模型可见行为；https://test.pc.internal.test/ 同入口）。

## 生产边界确认

未触碰 `~/.dsh`、`~/.superd`、生产 3080/3081、生产 Caddyfile。主 checkout 的 4999 测试线家族按 user 2026-10-11 明确指令停止（test-owned 单元，端口规则内），由本 worktree 的 4999 线（同 home 约定、共享 auth seed）接替；其余既有单元未动。dev3 仅只读探测（`ssh dev3 'ls/systemctl list-units'`），未安装/未重启任何服务。
