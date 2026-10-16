# Remote scp -3 身份定谳与 copy fail-loud — 0.3.1-f 修复轮

- 日期：2026-10-14 晚（Asia/Hong_Kong）
- 前轮：[2026-10-14-remote-copy-acceptance-fixes.md](2026-10-14-remote-copy-acceptance-fixes.md)（0.3.1-e）
- 本轮输入：**user 二轮受控实验**（agent 掩蔽效应定位）+ 全量 bug/surface 清单（F1–F8 / S1–S8）
- 规格：[remote-rescope §3.0.1](../specs/remote-rescope/spec.md)

## F1 定谳（user 实验，照录）

三台配置、`ssh -G` 解析、直连全部正常；唯一差异在 scp -3 的临时配置**刻意不写 IdentityFile**（0.3.1-e 修复时我只内联了 hostname/user/port/proxyjump，注释自设「keys are never taken from config」——错误地把「不吸收密钥材料」扩大到「不吸收密钥路径」）。受控矩阵：

| 配置 | dev2 | dev3 | dev4 |
|---|---|---|---|
| 无 IdentityFile + agent（=当时的临时配置） | ✓ | ✓ | ✗ Permission denied |
| 无 IdentityFile + agent 禁用 | ✗ | ✗ | ✗ |
| 补各自 IdentityFile | ✓ | ✓ | ✓ |

dev2/dev3 幸免原因：agent 恰持 `id_key1`（`VqCdZz…`），而两者的 authorized_keys 也认它；dev4 唯一授权 `id_key4` 既不在 agent、又被临时配置丢弃——**第一个戳穿缺陷的主机，非配置差异**。

## 修复（0.3.1-f）

| 项 | 实现 | 验证 |
|---|---|---|
| **F1** | `resolveThroughOriginConfig` 内联 `ssh -G` 的 `identityfile`（全部非默认行保序去重；过滤编译期默认五把 id_rsa/id_ecdsa/id_ecdsa_sk/id_ed25519/id_ed25519_sk——无 config key 的主机本就走默认表+agent，行为不变）；byossh 显式 key 仍排首；换行注入守卫覆盖新值 | **dev3→dev4 scp -3 实测 `exits:[0]`、cleanup released**（user 两次复现失败的原用例） |
| **F2** | tool 层 copy 与 rsync 同契约：`exits` 含非零即 `throw`（回执全量入 Error，失败不再以正常结果返回）；成功 `exit:0`（有 exits 时）| 失败用例 driver 层 `exits:[1]` → tool 层抛错；typecheck 0 错；remote 全套件 193 过 |
| **S5** | copy 成功回执 `durationMs` 真实计时（原恒 0） | 代码路径 + 套件 |
| **S1** | 目录 `-r` 指引上移 Files 段 action 层，显式标注「小写 `-r`=递归；大写 `-R`=scp 远端客户端模式，被拒」；argv 字段内的重复提示删除（单一信息源） | description 文本 diff |
| darwin 纪律 | mac 离线：不再滞留旧版本戳产物（banner 自校验必败=死重）。`BUILT-VER` 边车 + 不匹配即剔除；**本轮如实交付三 target**，mac 回归后下轮重建 | MANIFEST 0.3.1-f targets=3；pack 校验绿 |

## 交付与线

`better-dsh@0.3.1-f` 4a859013… / `super-dsh@0.3.1-f` 77552450…（pair 校验绿，helper-bin 叶子哈希入 provenance；**注意：本轮 darwin target 剔除后，mac 目标将走 POSIX shim——其 oneshot 在 mac 上本就依赖 killer 路径，行为与 0.3.1-e 前一致**）。PC 4999 与 dev3 4998 均已装 0.3.1-f 运行中。

## backlog（按 user 建议顺序，待排）

1. ~~F2+F1~~ ✅ 本轮
2. F3+D8：目录能力对齐（自动 `-r` 或树车道覆盖全端点）——**待 user 裁 D8**
3. S3/S4：统一回执结构（`ok:false+reason`；`verified:false`→`verification:"not-applicable"`）
4. F7：roster 陈旧 hub 注册探活过滤
5. 观察项：F6（docker exec 偶发 143）、S6/S7/S8、F8（byossh 跨轮）

## 复验建议（user）

1. `copy` `ssh:dev3` → `ssh:dev4`（应直接成功，无需 `-i` 绕过）；
2. 任意**会失败**的 copy（如目标父目录不存在）→ 现在应直接抛错而非返回正常结果；
3. 若手头有 mac 目标：本轮其 oneshot 回执应显示 `posix-shim`（darwin 产物暂缺，诚实回退）。
