# dashr remote tool RM0 — DEV2 第一人称体感复测（轻量，非完整验收）

- **日期**: 2026-09-23
- **目的**: user 指定——只判断"这个工具能不能用 / 大模型做远端操作的摩擦是否下降"，**不重跑** RM0 六条验收
- **载体**: 运行时 **4988 活体实例本身**（我所在 session 的 tool surface 就含该 `ssh` 工具，即被测物与测试者同体）；目标 host = **dev2**（`admin@dev2.internal.test:22`）
- **与首份报告的关系**: `2026-09-22-dashr-remote-tool-rm0实测报告.md` 六条全绿；本报告是其"使用体感"补充，并记录**一个新发现的行为缺陷**（首份报告的验收脚本全是单行命令，覆盖不到）
- **代码面**: worktree `remote-tool-rm0`，tip `c913024`（final-review wave 已提交）
- **修订 v2（2026-09-23，user 质疑后复验）**: §三 A/B 原判"本机裸 ssh CLI 坏了"**撤回**——那是 agent 沙箱的用户命名空间 uid 映射假象，非宿主事实（user 自己终端 `ssh dev2` 正常）。已改写为"工具对沙箱免疫"。

## 一、结论（一句话）

**可用，且摩擦显著下降**；但**多行命令目前必须视为禁区**——输出错位一帧且 exit 只取首行 = 静默假成功。

## 二、便利面实测（逐项、verbatim）

| # | 动作 | 结果 |
|---|---|---|
| 1 | `ssh({})` | 一次列出 **8 个 targets**（user@host:port + online/offline），不拨号 |
| 2 | `ssh({target:"dev2"})` | 单调用拿到全 facts 块（见下） |
| 3 | `ssh({target:"dev2", bind:true})` | 绑定成功，status 增 `session : pty · cwd …`；随后 `ssh({cmd})` 免 target |
| 4 | `cd /tmp/rm0-probe` → 后续 `pwd` | `/tmp/rm0-probe`（cwd 跨调用粘住，相对路径可用） |
| 5 | `export RM0_PROBE=alive` → 后续 `echo $RM0_PROBE` | `alive`（env 跨调用粘住） |
| 6 | `sleep 30` + `timeout:3` | `[exit 130 · 3.1s · interrupted]`；随后 `echo alive` 正常、无残留 `sleep` 进程（session 存活） |
| 7 | TOFU | `.dsh-test/storages/better-dsh/remote-hostkeys.json` 新增 `"dev2":"SHA256:Xmc1Aald1oJIcxi/YIlGPD9+a3QIqNgd+FWmZPVr7kY"` |
| 8 | 审计 | 本 live session log 共 **11 条 `dashr/remote-exec`**，含失败那条（`E_NO_BINDING`，带 `error` 字段） |
| 9 | 连接复用 | 同一 conn `alive 1s → 18s → 53s`，`rtt 404–707ms`，跨约 10 次调用未重拨 |

status 块（dev2，verbatim）：

```
target : dev2 → admin@dev2.internal.test:22  (key /home/u1/.ssh/id_key1, via ~/.ssh/config)
conn   : alive 1s   rtt 707ms
cwd    : (unset)
env    : login-shell (bash -lc)
tools  : node v24.14.1 (/usr/bin/node) · python3 3.14.4 (/usr/bin/python3) · pip 24.0 (/usr/bin/pip) · git 2.43.0 (/usr/bin/git)
sudo   : NOPASSWD ✓
```

## 三、A/B：与"老办法"（bash + 裸 `ssh` CLI）对照

> **v2 修正**：本节原结论"本机裸 ssh CLI 默认是坏的"**撤回**。复验证明那是 **agent 沙箱的假象**，不是宿主事实。

- 现象：从 agent 的 bash（沙箱内）裸调 `ssh -o BatchMode=yes dev2 '…'` → **rc=255**，报 `Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`。
- **真因（复验）**：agent bash 跑在**用户命名空间**内——`/proc/self/uid_map` = `1000 0 1`，即只有 uid 0 被映射到我的 uid，**其余 root 拥有的文件在该命名空间里一律呈现为 overflow uid `65534` = `nobody`**。证据：同一个沙箱内 `/etc/passwd`、`/etc/shadow` 也显示 `nobody:nogroup`（宿主上显然不是）。OpenSSH 见到"config 文件不属于 root/自己"即拒绝启动 → CLI 在沙箱内必死，与宿主配置无关。
- **user 自己的终端（非沙箱）`ssh dev2` / `ssh dev3` 正常可用**，SSH config 配置有效——与此完全一致，宿主无任何问题。
- 沙箱内要跑通 CLI 才需要绕行：`ssh -F /dev/null -i ~/.ssh/id_key1 -o BatchMode=yes -o StrictHostKeyChecking=accept-new admin@dev2.internal.test '…'`（5 个 flag，且 user/host/key 要自己拼）。
- **修正后的准确结论**：`ssh` 工具走 ssh2 库 + 自行解析 `~/.ssh/config`，**不读 `/etc/ssh/ssh_config.d/`** → **对沙箱免疫**。这一优势对 agent 仍然真实（agent 都在沙箱里跑），但性质是"沙箱友好/免绕行"，**不是**"宿主 CLI 坏了"。
- 老办法的其余成本仍成立、且与沙箱无关：无 session 状态（每条命令自包含 cd/env）、无 status 发现块（user/toolchain/sudo/rtt 要自己试探）、无审计、host key 自处理。这些是设计成本，非环境故障。

## 四、摩擦面 / 新发现缺陷

### 4.1【高】多行 `cmd`：输出错位一帧 + exit 只取首行（静默假成功）

顺序（非并发）复现，verbatim：

```
① ssh({cmd:"echo L1\necho L2\necho L3"})   →  "L1"                 [exit 0]
② ssh({cmd:"echo MARKER"})                →  "L2\nL3\nMARKER"      [exit 0]
③ ssh({cmd:"echo ok\nfalse"})             →  (无输出)              [exit 0]   ← 第二行失败却报成功
④ ssh({cmd:"false\necho ok"})             →  (无输出)              [exit 1]   ← 首行失败才报失败
⑤ ssh({cmd:"echo DRAIN"})                 →  "ok\nDRAIN"           [exit 0]
```

- **推断根因**：帧解析在**第一个 shell prompt** 处收尾；PTY 里后续各行的输出落到下一次读，footer 的 `exit`/`durationMs` 因此只对应**首行**。
- **影响定性**：执行**本身是对的**（多行确实全跑了——函数已定义、env 已设、heredoc 内容已产出），坏的是"结果信封"：agent 可能把**上一条命令的输出**当成当前命令的结果、把**只成功了首行的脚本**当成整体成功。这比"文档 overpromise"严重，属**静默假成功**类。
- **状态**：tip `c913024` 的 description 仍写 `(multi-line allowed)`（live 实例 session log 中该措辞 5 处命中），`framing.ts`/`tool.ts` 均无护栏；SDD ledger 以 **Minor 6** 记录，未进 final fix wave（该 wave 只修 5/8/11）。
- **建议**：(a) 短期 agent 侧一律单行 `;`/`&&` 链；(b) 工具侧——`cmd` 含换行时 fail-loud 或显式告警，或修帧边界；**优先度建议从 Minor 上提**。

### 4.2【低】无 auto-bind

`ssh({target:"dev2", cmd:…})` 之后，模型的直觉是直接 `ssh({cmd:…})` → `E_NO_BINDING`。错误信息清晰可行动（明说 `bind:true` 或显式给 target），但会撞一次。属 R5 zero-routing 的设计取舍，记为摩擦点而非缺陷。

### 4.3【低】远端文件编辑无 read/edit 平价

工具自我定位 "entry point, not a file API"：远端读写文件要走 shell（`cat -n` / `sed -i`）。而**写文件最自然的形态是 heredoc** —— 恰好落在 4.1 的错位区间（执行成功，但你读不到确认，且 exit 不可信）。

### 4.4【信息】status 是 probe，不建 PTY

冷 target 的 status 会拨号 + degraded probe（换来 tools/sudo/rtt），但不建 PTY session；首次 exec 才建。符合 Ruling 2，与报告 §三 一致。

## 五、对 user 问题的直接回答

**问**：有了 SSH 工具，大模型做远端操作的"心理摩擦"是否下降？

**答**：下降明显，且不是"方便一点"，而是**从"能不能做"变成"要不要做"**：

1. **发现成本归零**：`ssh({})` 直接把可用 host 摆在面前（本机 8 个），模型不必先知道/猜 host 名单。
2. **决策成本归零**：`ssh({target})` 一次给出 user/key/toolchain/sudo/rtt —— 动手前就能判断目标合不合适（以前要么盲试，要么花好几轮探测）。
3. **状态负担下降**：login shell 常驻，cwd/env 跨调用粘住，多步操作不必每条都写成自包含单行。
4. **失败可预期/可回溯**：TOFU pin + `dashr/remote-exec` 审计 + 清晰错误码（`E_NO_BINDING`/`E_BAD_TIMEOUT`/…）。
5. **agent 的 CLI 路径在沙箱里被 uid 映射挡住**（见三）——工具走 ssh2 库 + 自解析 ssh config，沙箱免疫；对 agent 而言这是真实的可用性差异（user 自己的终端不受影响）。

**唯一的反向摩擦**（4.1，多行）恰好是最容易踩的：模型第一次撞上多行（返回空 / 下次调用冒出陌生输出 / `exit 0` 其实失败）就会本能地不信任这个工具，退回"只敢单行 `&&` 链"甚至干脆不用。**把多行规范化（拒绝或修帧），是把"可用"变成"敢用"的最后一块。**

## 六、边界与未验

- 未重跑完整六条验收（首份报告已做）；未做 `ss` 级单 TCP 采样（以 conn alive 时长 + rtt 稳定间接印证）。
- 仅测 **dev2**；mac / dev1 / dev3 / dev4 / ctr-1 / github.com 未测。
- 未测 `stdin` 通道（RM0 已知 best-effort）、并发多 target、长 idle TTL、断线重连。
- 本 4988 实例与 tip `c913024` 未逐字节核对；但 §4.1 缺陷在 tip 源码面**无护栏**（已 grep 确认）。

## 七、修复回执（2026-09-23，§4.1 闭环）

- **修复 commit**: `123f7e3`（parent c913024）——`wrapPtyCommand`（`{\n<cmd>\n}` 单复合命令包裹，多行 = 一次 command-read = 一对 C/D 帧，exit = 复合体末命令状态）+ `PS2=''`（续行提示符不入流）+ `stdin` 改为复合体后原生写（PTY 路径，恢复 REPL 形可用性；degraded 路径保持 disclosed compose）。修备过程中纠了一个 controller 裁决错误：`{\n…\n; }` 形是非法 bash（换行列表终结符后不可起 `;`），改为裸 `}` 收束（实证 rc=last-command、尾 `;` 容忍、引号/嵌套/exit N 透传全过）。
- **单测**: 164/164（+12：wrap ×4 / 多行回归 ×3 / stdin ×3 / engine 线程 ×2）；tsc 0 新错。
- **第一人称复测**（4988 活体重启后，headless 对 dev2 逐条重放 §4.1 ①–⑤，verbatim）：
  ① `echo L1\necho L2\necho L3` → `L1\nL2\nL3` [exit 0]（三行全出，一帧）
  ② `echo MARKER` → `MARKER`（**无**残余 L2/L3 前泄）
  ③ `echo ok\nfalse` → `ok` [**exit 1**]（静默假成功消灭）
  ④ `false\necho ok` → `ok` [exit 0]（末命令语义，与 ③ 互补自洽）
  ⑤ `echo DRAIN` → `DRAIN`（跨调用零泄漏）
- **§4.3 连带改善**：heredoc 形多行写文件现落在同一修复面内（单复合帧、exit 可信）。
- **遗留不变**：§4.2 auto-bind（设计取舍）、stdin 的 PTY/degraded 双路径语义差异（已披露）。
