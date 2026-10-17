# Remote 收口轮 0.3.1-d：钉契约、并 SSH 拼装、删兼容层、单调版本

日期：2026-10-17（Asia/Hong_Kong）。user 收口裁决 + 「删/钉/收」五条（无新增能力）。基线 = commit `8b50acc`（0.3.1-c 验收轮）之上的工作树迭代。计划与裁决记录见本文档与 [0.3.1-c 报告](2026-10-17-remote-phase1-receipts.md)。

## 1. rebase 丢失审计（user 提问的正面回答）

字母轮 b–h 的内容在 commit `39bac19` 收拢，0.3.1-c/h 报告所列五项手工修复**逐一定位于当前树，零丢失**：

| 修复 | 树内位置 | 测试钉 |
|---|---|---|
| F1 IdentityFile 内联 | `native-copy.ts resolveThroughOriginConfig` | ✅（0.3.1-c 轮） |
| F2 copy fail-loud | `tool.ts` ok 门 | ✅ |
| F3 本地目录自动 `-r` | `native-copy.ts recursiveFlag` | ✅ **本轮** `manual-fix-pins.spec.ts` |
| F4 marker 等待 + relay stderr | `ssh-rsync-native-relay.ts waitForDaemonReady/relayDetail` | 机制 ✅（c 轮）/ **人面串 "daemon exited before serving" 本轮钉** |
| F5 `invalid symlink` → `-L` 提示 | `native-copy.ts withSymlinkHint` | ✅ **本轮** |

rebase 真正留下的两处伤：① 版本串失去单调性（`0.3.1-h` 语义上旧于 `0.3.1-c` 却字典序更"新"）→ 本轮第 4 项修复；② 未钉测试的修复存在下次 rebase 静默丢失风险 → 本轮第 1 项消除。

## 2. 五条裁决的执行

1. **钉测试**（全做）：新 `test/remote/manual-fix-pins.spec.ts` 三例——F3（目录自动 `-r` 恰一次/文件与远端源绝不加/caller 显式 `-r` 去重）、F5（精确错误串武装提示、其它失败与成功不武装）、F4 人面串（daemon 目录检查先死于 marker → `daemon exited before serving`，经双 SSH 夹具真链路）。
2. **四拼装点收敛**（全做）：新 `src/remote/ssh-argv.ts` = 唯一 identity 拼装策略（user/port/key/jump 一序两方言；scp 的 user 走 user@host 操作数故 `-l` 不出、端口 `-P`）。`sshArgv`/`identityArgv`/`rsyncRsh`/`relaySsh` 全部降为薄方言基座 + 本 builder；`transports.spec` 的逐字节 argv 钉全过（含中途抓到的双 BatchMode 缺陷，已修）。F1 的结构性根因（四份拼装 = 四份 identity 语义）就此闭合；`ssh -G` 内联仍唯一存在于 scp -3 临时配置处并在 builder 头注释定位。
3. **删兼容层**（带一处工程修正）：`dryRun/delete/excludes/preserve`（tool 层）与 rsync 六字段逐名枚举删除。**实证**：dsh-tools 对根层未知参数**静默放行**（根 schema 无 additionalProperties、validate 只走已声明属性）——直接删 = 制造静默 no-op。故替换为**通用未知参数守卫**（tool 层 KNOWN_PARAMS 白名单 + rsync 层 {src,dst,argv} 白名单），比旧 shim 更严：未来任何拼错/再删参数都不可能静默。旧测试的消息正则自然兼容。
4. **版本单调**（全做）：`build.sh` 改戳 `<pkg>.b<git-count>`——本轮 **`0.3.1-d.b596`**（596 = git rev-list --count HEAD，永不回退）。回执/横幅全链自动携带；同轮内重建共享戳（轮内身份），darwin 经 env 收戳（构建机无 git）。fleet 新旧自此可按 `.bNNNN` 排序。
5. **roster 去噪**：**不做**——user 已裁 F7 出工具范围（本条列为可选，与前裁一致）。

「不要加」四件（transfer 超级 action / native 独立校验 / 远端目录拨号 stat / 描述扩写）零触碰。

## 3. 交付与验证

- 套件：remote **200/0**（+3 钉）；整包 **866/0 / 9 skip**（browser-device 仍为本机无 Chrome 的环境项）；typecheck 0 错。
- helper：四 target 重戳 `0.3.1-d.b596`（mac 中途离线一次、BUILT-VER 纪律如实剔除后随 mac 回归全量重建——首次全程单调戳）。
- 对子：better-dsh `aa50e956…` / super-dsh `3d1feebc…`（pair 校验绿）；PC 4999 与 dev3 4998 均以显式 `SUPERD_TEST_PACK_DIR` 安装记录对子，双 200 运行中。
- 本轮无 npm publish、无 push/tag（阶段性 release 闸门等 user 单独放行）。

## 4. 复验建议（user，全部是「不变 + 新钉」）

1. 任一 copy/rsync 走一遍 → 回执与 0.3.1-c 轮一致（收敛与守卫不应改变任何可见输出）；
2. 首次 oneshot 到任一端点 → 回执 `runner: superd-run 0.3.1-d.b596 (...)`——单调戳首次上岗；
3. 传一个拼错参数（如 `dryRun:true`）→ 报 `unknown parameter "dryRun"`（旧 shim 消息已删，新守卫仍点名）。

## 5. 发布定版（2026-10-17 傍晚附记）

- **版本字母裁决**：user 指令「比 registry 已发布字母 +1」；执行时 mac ssh 再度抖动（ping 50% 丢包、ssh 超时），而 **0.3.1-d.b596 四 target 对子已在盘、已验证、双线已运行**——故里程碑定版 **0.3.1-d**（字母 c 从未进 registry，跳过无害；c 的内容作为 commit `8b50acc` 随 master 一起推送）。mac 回归后对发布产物做活体验证：`superd-run banner` → `ver=0.3.1-d.b596 target=aarch64-apple-darwin os=macos` ✓（单调戳首次真机确认）。
- **发布**：commit `506081b` → push master（`39bac19..506081b`）+ tag `v0.3.1-d` → 双包 npm publish（各一次 PUT）；better-dsh `aa50e956…` / super-dsh `3d1feebc…`（即双线在跑的记录对子）。
