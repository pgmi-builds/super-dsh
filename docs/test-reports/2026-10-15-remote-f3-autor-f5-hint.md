# Remote F3 自动 -r / F5 符号链接提示 / darwin 回归 — 0.3.1-h 修复轮

- 日期：2026-10-15 凌晨（Asia/Hong_Kong）
- 前轮：[2026-10-14-remote-f4-race-identity-edges.md](2026-10-14-remote-f4-race-identity-edges.md)（0.3.1-g，user 第三轮复测确认 F4 已修）
- 本轮输入：user 第三轮复测 + 「go ahead fix it」

## F3 / D8：本地目录源自动 `-r`（user 三轮点名，视为采纳 D8）

- **实现**：`recursiveFlag()` —— 本地 src `stat` 为目录且调用方未带 `-r`/`--recursive` 时，scp 与 incus file push 路线自动补 `-r`。**披露即回执**：追加的旗标出现在实际执行的 argv 里（receipt 原样展示），不静默。远端源不猜（不为 stat 拨号）——远端目录仍需调用方自带 `-r` 或走 rsync。docker cp 原生处理目录，无需旗标。
- **description 更新**：「copy of a directory from a LOCAL source auto-appends the route's recursive flag (-r, shown in the receipt argv); from a REMOTE source pass -r yourself or use rsync」。
- **验证**：单测（fixture ssh：本地目录无 argv → `exits:[0]`、argv 含 `-r`、远端内容完整）；**dev2 活体**：`scp -o BatchMode=yes -r /tmp/f3-src dev2:/tmp/f3-dst` exit 0、内容 f3-payload 完整；套件 25/25。

## F5：docker cp 符号链接报错提示

- **实现**：`withSymlinkHint()` —— docker cp 路线非零退出且 stderr 含 `invalid symlink` 时追加一行 `hint: docker cp follows symlinks only with -L — pass argv:["-L"]`。
- **如实记录**：本轮在本机 docker 29.1.3 上**未能复现**原生错误（推方向原样落链接且容器内目标存在；拉方向新版 daemon 直接解析）——提示武装在精确错误串上，user 环境（复现过 invalid symlink）命中即生效。

## F7：hub 陈旧注册（挂账 hub 侧，非 roster 过滤）

`MachineRow`（superd-hub/src/machines.ts）**无 lastSeen/liveness 字段**；roster 的零拨号原则（Ruling P19）禁止拨号探测。正解 = hub 配对表演进（lastSeen 记录 + 老化策略），属 hub 域设计变更，不在 remote 工具侧hack。待立 hub spec。

## darwin 回归

mac 主机恢复 → 四 target 全量重建（`BUILT-VER` 纪律生效：darwin 重新入列，MANIFEST 0.3.1-h 四条目，provenance 12 outputs）。mac 实测：banner ver=0.3.1-h、`run` 退出码逐字（exit 5）、pidfile 清理。

## 交付

`better-dsh@0.3.1-h` 0f2cd7f4… / `super-dsh@0.3.1-h` 37d104fc…（pair 校验绿）；PC 4999 与 dev3 4998 已上线（四 target 完整）。

## 状态板

F1 ✅ F2 ✅ F4 ✅（均 user 复测）· **F3 ✅ 本轮（D8 采纳）** · **F5 ✅ 提示已武装（本机不复现原生错误）** · F7 → hub 侧 spec 待立 · backlog：S3/S4 回执结构、S6/S7/S8、F6、F8。
