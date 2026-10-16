# Remote F4 竞态定案与 identity 过滤边角 — 0.3.1-g 修复轮

- 日期：2026-10-14 深夜（Asia/Hong_Kong）
- 前轮：[2026-10-14-remote-scp3-identity-fail-loud.md](2026-10-14-remote-scp3-identity-fail-loud.md)（0.3.1-f，user 复测确认 F1/F2/S1/S5 已修）
- 本轮输入：user 复测指出 **F4 依旧**（relay mtime 02:52 = 0.3.1-e 的修复——改了但没用）+ identity 过滤两处边角

## F4：0.3.1-e 修复为何无效（竞态）

0.3.1-e 的存活检查是**一次性瞬时判断**：`-L` 本地监听在 ssh 会话建立瞬间（t≈50ms）就绪并通过检查，而 daemon 脚本要到 t≈200ms 才因目录缺失 exit 64——**150ms 竞态窗内 rsync 已启动并打进死隧道**，顶层仍是 `Connection reset (code 12)`。

**0.3.1-g 修复**：不再瞬时判断，改为等待 daemon 脚本自己的 `SUPERD-RSYNC-TMP` stderr marker（它在**目录检查之后**、daemon exec 之前打印）：marker 出现 = 真就绪；持有会话先退 = fail-fast 并带其 stderr；5s 超时 = 如实报 never announced readiness。

**实测**（src=ssh:dev3，dst=ssh:dev4 不存在目录）：

```
dual-SSH rsync destination daemon exited before serving
[relay stderr]
dual-SSH rsync destination directory does not exist
```

真实原因直达顶层，code 12 消失。（另注：本地→SSH rsync 的同场景本就由 rsync 原生报 `Receiver mkdir failed (code 11)`，诚实路径不受影响。）

## identity 过滤边角（user 点名，已修）

| 边角 | 修法 |
|---|---|
| 自定义密钥放在别处但叫默认名（`/opt/keys/id_ed25519`）会被 basename 过滤误丢 | 改为**精确路径匹配**编译期默认五把（`~/.ssh/<name>` 与 `$HOME/.ssh/<name>`），basename 相同的自定义路径保留 |
| `IdentityFile none`（显式禁用）会被原样内联 | 值为 `none` 直接丢弃 |

## 交付

`better-dsh@0.3.1-g` e473cc7c… / `super-dsh@0.3.1-g` 804dd0c1…；PC 4999 与 dev3 4998 均已上线。**darwin target 仍诚实剔除**（mac 持续离线；BUILT-VER 纪律生效，无死重产物；回归后下轮重建）。测试：typecheck 0 错、rsync/container-copy/copy 25/25。

## 状态板（user 复测口径）

| 项 | 状态 |
|---|---|
| F1 scp -3 identity | ✅ 0.3.1-f（user 复测：三对组合全过，无 `-i`） |
| F2 copy fail-loud | ✅ 0.3.1-f（user 复测：两失败用例均抛 Error） |
| S1/S5 | ✅ 0.3.1-f（user 复测确认） |
| F4 relay 竞态 | ✅ 本轮（marker 等待；活体验证真因直达） |
| F3/D8 目录能力对齐 | ⚠️ 待 user 裁 D8 |
| S3/S4 回执结构、F7 roster 探活、S6/S7/S8、F6、F8 | backlog |
