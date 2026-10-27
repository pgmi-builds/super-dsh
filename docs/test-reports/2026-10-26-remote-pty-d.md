# 0.3.2-d 第一人称验收：hub 控制字节修复（F4）+ remote surface 重写

日期：2026-10-26（Asia/Hong_Kong）。被测版本：`0.3.2-d`（root / better-dsh / super-dsh 同步）。
计划：[2026-10-26-remote-v032d](../10_plans/2026-10-26-remote-v032d.md)。前置：c 复测报告（[2026-10-26-remote-pty-c-retest.md](2026-10-26-remote-pty-c-retest.md)，F4/F1/F2 发现处）、c 轮报告与计划。本轮**未 commit / tag / push，未 npm publish**。

**性质**：本报告由执行实测的 DSH agent 本人写。单元/lane 钉测试在源码树跑；行为验收走 PC 4999 安装线的 `remote` 工具（安装态 = tarball = 源码构建，哈希链见 §1）；hub 对端为既有 mesh pairing `hub:bfwu`（DEV3，混版对端——对端协议自 c 起冻结，本轮再次印证只动发起侧）。

---

## 0. 结论

1. **F4 修复成立**：hub lane 的 `^C` / `^D` / `job_kill` 恢复「中断命令、会话存活」——本地包装改 `stty raw -echo`（只动本地半段，解释权在对端 canonical pty），四条 lane 级钉 + 安装态实测全过。
2. **F2 修复成立**：130-marker 延后 80ms 躲开 ISIG 输入队列 flush；「裸 `^C` 后 job_kill」不再吃 marker 首字节，干净结算 `killed · exit 130`，会话存活。
3. **F3 / CF 落地**：stdin 异步写错有常驻监听（不再可能进程级 uncaught）；`close force:true` 杀掉的 job 结算 killed 族（`interrupted: exit 130` / 帧不可达时 `session closed`），不再 `failed / session died`。
4. **F1 维持如实披露**：裸 `^C` 后 job 仍保持 running（无 marker 不误结算）；F2 修好后 `job_kill` 是可靠出路，surface 一句教学（Cancel: job_kill; try Ctrl-C first）。
5. **surface 重写落地**（user 定稿）：Actions/Targets/PTY/Oneshot/Examples 分组；PTY 段四词导语逐字（stateful oneshot / interact-able stdin / managed output / persistent env）；两个 Examples 的回执与 renderValue 逐字一致（BYO-PTY 一跳登录 + managed output、BYO-SSH 注册一次到处用，`remote_transfer {mode:…}` 纠偏入例）；`input` 动作保留（裁决 §3），教学句「exec.stdin = startup input; input = subsequent input」。
6. 测试账：better-dsh remote **245 pass / 8 skip / 0 fail**（基线 241 + 新 4：argv raw 钉 ×1 段、F2 本地钉、tool surface 钉 ×2、examples 钉）；superd-hub **647 pass / 1 skip / 0 fail**（648 tests，+F4 四钉）。

---

## 1. 现场与证据链

| 项 | 实测值 |
| --- | --- |
| 版本（root/better/super） | `0.3.2-d` 同步（`npm run version:release -- 0.3.2-d`） |
| better-dsh tarball | `.scratch/superd-pack/better-dsh-0.3.2-d.tgz`，SHA-256 `97f21dd48848d16091d1a60618048f760f0a0e21a6b03f462ecd07d8220d11bf` |
| super-dsh tarball | `.scratch/superd-pack/super-dsh-0.3.2-d.tgz`，SHA-256 `f3acbb0976752b9620f3719d3c47ccdc766a32abe8b6afc4008b463045cd1cdb` |
| `verify-package-pair.mjs` | 通过（closure 叶子哈希 + 泵资产 + canonical sources） |
| **哈希链（PC）** | 源码构建 = tarball 内 `package/lib/remote/plugin.js` = 安装态 `.tests/superd/profiles/superd-pub/node_modules/better-dsh/lib/remote/plugin.js`，同为 `3528ed04cbac9e210be8e22789d1ee78ddfdcc0e986876ac27621d317f1b9142` |
| **哈希链（dev3）** | 安装态 `.tests/foreign-substrate/.../plugin.js` 同为 `3528ed04…`；super-dsh 0.3.2-d；root 200×3（重启后热身窗口短暂 404，已知形状） |
| PC 4999 | `superd-4999-test` 常驻，root=200；安装态 surface 含新 PTY 导语/Examples、wrapper 含 `stty raw -echo` |
| hub 对端 | `hub:bfwu`（DEV3）；本轮对端侧零改动（协议 1 冻结） |

---

## 2. F4 修复与钉测

### 2.1 修法

[transports.ts](../../better-dsh/src/remote/transports.ts) `buildHubPtyArgv`：wrapper `stty -echo` → `stty raw -echo`。ssh `-tt` / `docker exec -it` 的前台子进程自己置 raw，哑泵不会——同一 `script` 模板只有 hub lane 漏了 raw（c 复测 §4.2 实验室对照的根因）。raw 只作用本地半段；对端 canonical 恰是正确语义（`^C`/`^D` 在对端成 SIGINT/EOF）。降级路径不变（`2>/dev/null`，stty 失败 = 现状 canonical，不劣化）。泵资产零改动（provenance 链不变）。

### 2.2 lane 级四钉（superd-hub `exec-pty.test.mjs`，真 pump + WS + 对端 executor）

| 钉 | 场景 | 断言 |
| --- | --- | --- |
| pin 1 | bg 命令 → `input 0x03`（1 字节过线）→ 1.5s 内 job 仍 running（F1 如实，旧 wrapper 此处 session died）→ `interrupt` | `exit 130`；后续 `pwd` 出 `/tmp`（同 shell、状态保持） |
| pin 2 | `cat` → input `abc`（无换行）→ `0x04` 一次 | job 输出出现 `abc` 且仍 running（EOF 规则在**对端**）；再 `0x04` → `exit 0`；后续命令正常 |
| pin 3 | bg `sleep 30` → `interrupt` | `exit 130`；会话 ready |
| pin 4 | `timeoutSec:2` handoff → `interrupt` | 同 id `exit 130`；`reconnected:false` |

### 2.3 安装态实测（真实模型会话，PC 4999，对端 hub:bfwu）

见 §5。

## 3. F2 / F3 / CF

- **F2**：`twoStage()` 的 130-marker 改为 `^C` 后 80ms（`MARKER_SETTLE_MS`）注入；cleanup 摘 markerTimer（防泄入下一命令）。本地钉（pty-input.spec）：裸 `^C` → job 仍 running → `interrupt` → **exit 130**、`AFTER-F2` 同 shell 打出、无 reconnect。旧形状在这里是 `'rintf' not found` → 会话死。
- **F3**：doStart 给 `proc.stdin` 挂常驻 `error` 监听（记 diag；死亡语义仍由 `close → markDead` 独占，无双路径竞态）。
- **CF**：`dispose()` 对在跑的 detached job 先走 `interrupt()` 再收组（且此时不写 `exit\n`——它会抢先结束 shell 令 marker 永远无帧，实测教训）；`ptyOutcome` 认得 `timedOut && !aborted` = 会话侧收束 → killed 族。driver 钉：force close → job `timedOut:true` + `exit:130`。

## 4. surface（user 定稿）与 Examples 纠偏

- PTY 段逐字（不加不减；唯一措辞修正 `30KB` → `~30k chars per read`，对齐代码 cap=30_000 字符）。
- Examples 两枚入 surface；对 user 底稿的纠偏（均核实代码）：① 三个 `remote {…}` 补 `"action"`（0.3.2-a 起 action 必填）；② `remote {action:"rsync"…}` → **`remote_transfer {mode:"rsync"…}`**（拆分后派发字段是 mode）；③ `"dst":"./app-logs/"` → 绝对路径（transfer 要求 absolute endpoints）；④ `key` 用绝对路径；⑤ exec 回执标记行补 `conn BYOP`；⑥ **spawn 创建不再叠加 registered notice**（`[session created…]` + 标记行已完整承载；旧 notice 的 "ssh alias" 措辞对 pty 不通）——示例回执即真实回执。
- 现役承诺保留：runner 三态、输出界、E_LABEL_INUSE、统一池/前缀、scriptPath、4096、两步 Ctrl-D（收敛为一句）、stale commandId 拒写、Hub 不回落 SSH。Targets 行不放 `hub:<m4>`（无 hub 时不得广告——既有中立性守卫钉在 hub.spec）；hub 目标行在 hasHub 附录里。
- Oneshot 段保留 `The endpoint needs bash only — no Python.`（copy.spec 守卫锚同步）。

## 5. 安装态实测与真实模型验收

真实模型会话 `session-ffea6cd3-b11a-46f4-a4b5-07eb1e01b14b`（deepseek-flash，standard preset，PC 4999 安装线，turn 49.6s 完成；transcript `/tmp/v032d-acc.jsonl`）。模型按 12 步清单**只用 remote 工具**执行，关键回执逐字：

| # | 步 | 回执（逐字关键行） |
| --- | --- | --- |
| A1 | `ssh:dev3:pty:dspot` bg `cd /tmp && echo SSH-SPOT-OK` | `Started remote-63bc2036d7644706 on pty:pty-9uc6 (dspot) (ssh:dev3)` → `SSH-SPOT-OK` / `[status: completed, exit code: 0]` |
| B2 | `docker:corti:pty:ddock` 交互 `read` + `input "ok\n"` | `wrote 3 bytes` → `A=ok` / `[status: completed, exit code: 0]`；close ✓ |
| C3 | `hub:bfwu:pty:dacc` bg `cd /tmp && sleep 90` | `Started remote-db58800cd7704f50 on pty:pty-frla (dacc) (hub:bfwu)` |
| C4 | busy 检查 | `[E_SESSION_BUSY] … still runs a command (remote-db58800cd7704f50) — send it more stdin with the input action … job_output … job_kill … or address other work to another session / oneshot`（四出路全文） |
| C5 | **裸 ^C**（模型交出真 U+0003） | `wrote 1 byte into pty:pty-frla` |
| C6 | 4s 后 `job_output` | `[status: running]`——裸 ^C 无 marker，不误结算（F1 如实；**旧 0.3.2-c 在这里 session died**） |
| C7 | `job_kill` | `[status: killed, interrupted: exit 130; acceptance step 7: …]`——**F2 修复：marker 干净落地**（旧形状 `'rintf' not found` → 会话死） |
| C8 | 会话存活 | `pwd && echo ALIVE-CTRL-C` → `/tmp` / `ALIVE-CTRL-C`，标记行 `[pty:pty-frla (dacc) · conn hub:bfwu · cmd remote-1fe193fc4f054ce6 · cwd /tmp · env +OLDPWD ~PWD · idle-left ~15m · exit 0 · 0.1s]`——**同 shell、无 reconnect（F4 核心主张）** |
| C9 | **^D 两步 EOF**：`input "abc"`（无换行）→ `input ^D` → 再 `input ^D` | 第一次后 `job_output` 出 `abc` 且 `[status: running]`（EOF 规则在**对端**）；第二次 → `[status: completed, exit code: 0]`；随后 `echo ALIVE-EOF` 正常 |
| C10 | hub oneshot | `HUB-D-OK` / `[runner hub-lease (peer bash -lc, peer Node supervision) · exit 0 · 0.1s]` |
| C11 | roster | `hub machines: hub:bfwu (DEV3), hub:skc8 (homepc)` + 会话可见 |
| C12 | close ×2 | `closed pty:pty-frla (hub:bfwu)` / `closed pty:pty-9uc6 (ssh:dev3)` |

模型在 C5/C9 两处按 surface 指引交出**真控制字节**（`\u0003`/`\u0004` 在工具参数 JSON 层解码为原始字节，回执 `wrote 1 byte` 为证）——新 surface 的控制字符教学句在真实模型上成立。模型另自发用 `hub:bfwu` oneshot（`sleep 4; echo WAITED`，runner 行在回执）做等待节拍，行为合规。

## 6. 未测 / 限制 / 披露

- 对端 hub（dev3 生产）本轮零改动；混版对端再次可用（协议 1 冻结）。
- `hub:skc8`（homepc）未拨测；`hub:bfwu` 已满足可达对端。
- 泵 stderr cause-detail 透传仍为 non-goal（嵌套 PTY 形状固有）；oneshot wait-window 后台 handoff（Phase B）不变。
- F1 完整修复（无标记中断的完成检测）另轮处理；本轮以 F2 + surface 缓解。
- hub 超时 handoff 本轮未在模型回合重演（lane 级 pin 4 钉 + c 轮实测已证同路径；d 未改 handoff 代码）；close force 的 killed 结算由 driver 钉覆盖。
- 生产环境零触碰：未动 `~/.dsh`、`~/.superd`、3080/3081、Caddyfile；4999/4998 为既有测试线（安装 0.3.2-d 属计划内重启）。
- 未 `npm publish`；未 commit/tag/push。

## 7. 清理

- 实测会话的 PTY 全部 close（`pty:pty-frla`、`pty:pty-z45z`、`pty:pty-9uc6`，回执见 §5 C12/B2）。
- 验收脚本与产物：`.scratch/v032d-acceptance.mjs`、`.scratch/v032d-acceptance-out.txt`、`/tmp/v032d-acc.jsonl`（保留供查证，可删）。
- dev3 `.scratch/pack-0.3.2-d/`（tarball 对 + pair.json，安装源，保留）。
- 双 rig 保持运行（4999 / 4998，0.3.2-d）。


---

## 勘误（2026-10-27，发布前复核）

§1 的 better-dsh tarball SHA-256 应为 **`3c8868e4fab07b1738bcc9cf0a72f7d5210fd1f746a12953c97245294cf87fe4`**。原文 `97f21dd4…` 是 `npm run pack`（05:19）打印的**重打包前**值；`start-4999.sh` 的 pack-pair 于 05:22 重打包（pair.json `builtAt=2026-10-25T21:22:18Z`）生成本轮实际发运对——与 0.3.2-c 轮同类现象。发布前复核（2026-10-27）：盘上 tarball 实测与 pair.json 同值 `3c8868e4fab07b1738bcc9cf0a72f7d5210fd1f746a12953c97245294cf87fe4`，`verify-package-pair.mjs` exit 0，双 rig 安装态 `plugin.js` 三处同为 `3528ed04…`。另：独立复测（[2026-10-27-superd-0.3.2-d-retest.md](2026-10-27-superd-0.3.2-d-retest.md)）所指 5 个失败用例在无沙箱运行线复跑为 25/25 全过，确认为 bwrap 夹具环境问题，非产品回归。
