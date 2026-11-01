# 独立复测四缺陷修复轮（0.3.3-c → 0.3.3-d）

日期：2026-11-01（Asia/Hong_Kong，21:00–22:30）。被测版本：`0.3.3-c`（F1–F4 修复）→ `0.3.3-d`（追加防御 + surface 披露）。
输入：[2026-11-01-remote-default-pty-first-person-independent.md](2026-11-01-remote-default-pty-first-person-independent.md)（独立复测，F1–F4）；[交付验收报告](2026-11-01-remote-default-pty.md)。
本轮**未 commit / tag / push / publish**；生产树未触碰。

---

## 0. 结论

1. **F1/F2（scriptPath 载体）根治**：`input.ts` 载体从 `bash -s`+stdin 拼接改为 **`bash -c '<script>'` 单条引号命令**（argv 通道，与 cmd 同一引号/尺寸纪律；新增 `E_SCRIPT_NUL` 拒含 NUL 脚本）。业务 stdin 整体归脚本进程 fd0。PTY 中 `-c` 是普通子进程命令：结算、nonce 帧正常、cd/export 不泄漏。
2. **F3（bg+scriptPath 丢载体）根治**：`preparePtyLane` 的 lane 输入改用 `prepared.cmd/stdin/timeout`。
3. **F4（raw Ctrl-C 后 job 滞留）**：按建议走 surface——stdin 参数与示例补「after a raw "\u0003" settle the job with job_kill」。
4. **回归**：better-dsh remote **33 文件 / 273 pass / 8 skip / 0 fail**（新增 F1 无 stdin 结算/不泄漏、F2 双 lane 中途 read、F3 带/不带 stdin 两例、hub 钉改写为 bash -c 载体）；tsc 零错。
5. **修复中发现新问题 R1（部分缓解，如实披露）**：rig-only 概率性「PTY background + startup stdin」丢失——见 §3。

## 1. 交付形态（0.3.3-d 终版）

| 项 | 实测值 |
| --- | --- |
| better-dsh tarball | `3b6869d979e9…`（重打后终版；首次 0.3.3-d 构建 `06027d65…` 作废） |
| super-dsh tarball | `ac40aa681572…` |
| 安装叶（双 rig 一致） | better `lib/remote/plugin.js` = `1363f808f41d…`；super 闭包 `remote/plugin.js` = `24d8b37cf95f…` |
| PC 4999 | 0.3.3-d + surface 补丁在位（grep 命中）；`/` 200；boot 零 import 失败 |
| dev3 4998 | 同上（file: 直装绕过 registry 旧缓存） |
| 同版本重装 | pnpm 对同版本 no-op 再证（v032e 教训重现）——`pnpm add <pkg>@<ver> --force` 或 file: 直装解决 |

## 2. 第一人称复验（PC 4999，真实模型会话 ×3 轮 + 仪器探针 ×8）

| 缺陷 | 0.3.3-c/d 模型回执 |
| --- | --- |
| F1 PTY 脚本结算 | `IN-SCRIPT [pty:pty-2vnm · … · exit 0 · 1.2s]`（不再 still running）；`LEAK=unset CWD=u1`、同 session id（无接管/泄漏） |
| F2 中途 read | oneshot `READ:GOT:hello-f2 [exit 0]`；PTY 同证（本地 + rig） |
| F3 bg+script | 无 stdin `PLAIN-BG [completed]`；带 stdin 见 §3 R1 |
| F4 | `wrote 1 byte …` → `[status: killed, interrupted: exit 130]`，card 回 idle；模型引述新教学行 |

## 3. R1：rig-only 概率性「PTY background + startup stdin」丢失（未根治，已披露）

**现象**：`run_in_background:true` + `scriptPath`/`cmd` + `stdin`，在 4999/4998 rig 上概率性丢失 startup stdin——framed 命令到达执行，随行 stdin 字节消失：`read -r` 得空（`BG-GOT:`，exit 0）或永等（job running）。后续 stdin-only 补写通道健康（`A[qq]B[ww]` 全达）。

**数据**（全部 rig 模型会话实测）：
- 丢失：`bg-read.sh` 形状（`printf 前置; read -r v` 无超时）**13/13 全丢**；`dbl`（双 `read -r` 无超时）阻塞 1 例；fix-c 三个会话内 6 例。
- 通过：`read -t` 变体 18/18；无前置单 `read -r` 12/12；tri/dbl2 单发 3/3。
- **本地不可复现**：src 直驱、闭包产物直驱、real-harness（含 rig 原样 closure+LocalJobs+ToolJobs+真 ssh+原样脚本+F1 先行序列）全部 0 丢失（>20 次）。

**已做缓解**：`pty-session.ts` 把 framed 命令与 startup stdin **合并为单次 stream write**（0.3.3-d）——理论消除两段到达窗口，但对 bg-read 形状无效（rate2 6/6 仍丢）。

> **勘误（2026-11-01 深夜定位轮）**：本节「合并无效」结论不成立——rate2（22:15）实跑在 0.3.3-c 进程（d 22:32 才装载），丢失从未在 d 上复现。定位轮以纯净 d + 0.3.3-e 插桩复刻原始组合：d 8/8 完成 + 值可见 6/6 送达，e 31/31 送达。**合并单写即 R1 的修复**。证据链与机制见 [2026-11-01-r1-localization.md](2026-11-01-r1-localization.md)。

**surface 处置（0.3.3-d 已上）**：`run_in_background` 参数与工具描述两处标注 **Known defect: startup stdin is NOT reliably delivered to a background command — run stdin-consuming commands in the FOREGROUND, or background them WITHOUT stdin and feed stdin-only writes afterwards (reliable)**。

**定位边界**：丢失点在 rig 宿主进程 → ssh 客户端 → 远端 tty 链路的某环，仅 rig 长驻进程复现；机制未定（远端 read 得空 EOF 与永等两种表现并存，排除「两段劈开」）。彻底定位需 rig 进程内插桩（本轮未做，避免为调试改动交付物）——留待专门一轮。

## 4. 附带修复与勘误

- `input.spec` hub 用例改写为 bash -c 载体（含单引号 shQuote 往返 `q't`）；`driver.spec` hub 钉同步；`ssh-targets` 增真实 sshd 中途 read 例（顺带修 label 复用）。
- `docs/remote-tools.md` scriptPath 行更新（bash -c + stdin 语义）。
- hub oneshot 的 4096 上限现同样约束 scriptPath（脚本即 argv）——hub suffix 与描述已如实标注（大脚本走传输 + cmd）。

## 5. 现状

- 4999（`https://test.pc.internal.test/`）与 dev3 4998（PC `localhost:4996` 转发）运行终版 0.3.3-d 供 user 复验。
- 未 publish / 未 commit；F1–F4 + R1 披露待 user 裁决（R1 是否开专门定位轮）。
