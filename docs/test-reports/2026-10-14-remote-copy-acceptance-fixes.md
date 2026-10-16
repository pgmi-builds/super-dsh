# Remote copy/rsync GUI 实测校准与 0.3.1-e 修复轮

- 日期：2026-10-14（Asia/Hong_Kong）
- 前轮：[2026-10-14-remote-rust-helper.md](2026-10-14-remote-rust-helper.md)（0.3.1-d 实装验收）
- 本轮输入：**user 第一人称 GUI 实测**（copy/rsync 全 lane 矩阵，10 项通过 / 5 项发现）
- 规格：[remote-rescope §3.0](../specs/remote-rescope/spec.md)（实测校准小节）

## user 实测矩阵（引用）

通过：scp 单文件→SSH；docker cp 双向；hub lane（`verified:true` + 自动 mkdir + 两端 digest）；跨端 ssh→docker 两段命令；rsync 本地→SSH（`-a --partial`）；`--dry-run -v`；尾斜杠语义；双 SSH rsync（自动反向隧道 + 临时 rsyncd）。

发现 → 处置：

| # | 发现 | 处置（0.3.1-e） |
| --- | --- | --- |
| 1 | copy 目录不加 `-r` → `not a regular file` | 未改行为（native-shortcut「不替 CLI 决定选项」原则）；**D8 决策点**：本地 src 为目录时 scp/incus 路线自动补 `-r` 并回执披露，待 user 裁。description 已补提示（「copy 目录自己带 -r 或用 rsync」） |
| 2 | ssh/docker 车道不建父目录、恒 `verified:false` | 即 re-scope Phase 1 提案本体（§3.1 mkdir 默认 + 回执）；D3 已获实测背书，待放行实施 |
| 3 | scp -3 双 SSH 实测不可用：`-F` 临时配置丢 `~/.ssh/config` 别名（复现两次） | **已修**：`ssh -G` 在 origin 解析别名（native、不拨号），effective `HostName/Port/User/ProxyJump` 内联进临时配置；显式注册字段（byossh）优先；key 只认连接自带，不吸收 config 的 IdentityFile |
| 4 | 双 SSH rsync 目标目录缺失报 `Connection reset by peer (code 12)`，误导 | **已修**：`-L` 本地监听即使远端 daemon 秒退也已建立——现在 daemon 可达后核查持有会话存活即 fail-fast（带 relay stderr 的真实原因）；且任何非零 exit 都附加 relay stderr（原仅 255） |
| 5 | docker cp 不跟随符号链接（`/etc/os-release` → invalid symlink） | 原生行为；description 已补 `[-L]` 提示 |
| 附 | superd-run 每呼 `setsid failed` 良性噪声 | **已消音**（ssh lane 的 exec 子进程本就是会话/组长，属预期回退路径；`SUPERD_RUN_DEBUG` 才回显）。dev2 实测：`run` 退出码逐字 + stderr 0 字节 |

## 0.3.1-e 交付证据

- 改动面：`native-copy.ts`（别名解析 + 临时配置内联）、`ssh-rsync-native-relay.ts`（fail-fast + 非 255 stderr 增强）、`helper/src/unix.rs`（消音）、`tool.ts`（两条 argv 提示）；MANIFEST ver 锁步 0.3.1-e，四 target 重建（x64 sha fd35fab4…）。
- 测试：typecheck 双通道 0 错；rsync/container-copy/helper 三套件 21/21。
- 打包：`better-dsh@0.3.1-e` 05edc1dd… / `super-dsh@0.3.1-e` a97a88ae…（pair 校验绿，helper-bin 叶子哈希入 provenance）。
- 线：PC 4999 与 dev3 4998 均已装 0.3.1-e 并运行（dev3 经 `.scratch/release-031e/pair`）。
- 消音活体：dev2 直跑 0.3.1-e 产物 `run -- /bin/sh -c 'echo QUIET_OK; exit 3'` → rc=3、stderr 0 字节。

## 复验建议（user）

1. 复跑原失败用例：`copy` `ssh:dev3` → `ssh:dev4`（scp -3，应解析别名成功）；双 SSH `rsync` 指向**不存在**的目标目录（应报 destination directory 不存在而非 code 12）。
2. 回执 stderr 应不再有 `setsid failed`。

## 待裁

- **D8**：目录 copy 自动 `-r`（scp/incus 路线 + 回执披露）是否采纳。
- **D3**：mkdir 默认 true + 回执（Phase 1）是否开工。
- registry 放行（0.3.1-e 或指定版本）与 commit 定版时点。
