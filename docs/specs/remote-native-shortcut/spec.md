# Remote 文件操作：原生 CLI 语法糖与双 SSH rsync

- 日期：2026-10-11（Asia/Hong_Kong）
- 状态：实施方向，尚未实现或验收。[执行计划](../../superpowers/plans/2026-10-11-remote-native-shortcut.md)。现行代码与本规格不同。
- 0.3.2-b 对齐（2026-10-19）：`byossh:` 前缀已移除；BYO 身份注册后与原生别名同址（`ssh:<label>`，注册时 `ssh` 字段在场），见 [remote-tools](../../remote-tools.md)。
- 本规格取代本文先前的“第一阶段双 SSH rsync 保留 Python”和“每次 copy 默认独立哈希验证”方向；不追溯改变已发布产物。

## 目标与边界

`remote` 的首要价值是解析 `ssh:<name>`、`byossh:<label>`、`docker:<name>`、`incus:<name>`、本地与已有 Hub 端点，把目标寻址、调用和原生结果收成一次模型工具调用。以**开发者最少额外机制**为原则：能交给 `scp`、`rsync`、`docker cp`、`incus file` 的传输、选项、退出码和报错，就交给它们。SSH 支持 `copy` 和 `rsync`；Docker、Incus 支持 `copy`；Hub 与本地文件通道沿用现有边界。发起机已有 DSH Node 运行时与相应 CLI；远端不以 Python、Node 或自带 worker 为文件操作的入场条件。远端 rsync 操作本身仍要求 rsync 可用。

**唯一需要新增数据连接设施的是双 SSH 的 rsync**。普通 rsync 不接受两个不同远端作为一次传输的两端；但两端原生 rsync 可以经发起机建立的通道进行同一次双向协议对话，目标端已有文件的分块信息无需整份拉回本机。SSH↔SSH `copy` 先用现代 OpenSSH `scp` 的经本机传输模式；Docker/Incus 跨端点 `copy` 若需两条原生命令，则由发起机串接或暂存，并如实说明这不是单条 CLI。参见 [rsync 手册](https://rsync.samba.org/ftp/rsync/rsync.1)、[scp 手册](https://man.openbsd.org/scp.1)、[Docker cp 文档](https://docs.docker.com/reference/cli/docker/container/cp/)。

## 模型可见接口

- `src`、`dst` 仍为 `[target:]/absolute/path`。`byossh` 身份先按现有注册方式登记，密钥始终留在发起机。
- `argv?: string[]` 是**有序的原生选项及其值**，不是 shell 命令字符串；工具在其后放入解析后的 `src`、`dst`。不维护 rsync/scp/docker/incus 选项白名单，不替原生 CLI 决定 `--partial`、`--inplace`、`--delete`、`-a`、`-p` 等含义；未知或不兼容选项由该 CLI 报错。数组元素原样作为一个 argv token，避免 shell 再解析。CLI/子命令由所选操作和端点决定，`src`/`dst` 不由 `argv` 重写。
- 一次原生调用使用 `argv`。必须拆成 `pull` 与 `push` 两条命令的 `copy`，用各自的 `pullArgv?: string[]`、`pushArgv?: string[]`；这两种字段与 `argv` 互斥。每一段只接受该段原生 CLI 的选项，不能把 Docker 的 `-a` 偷换成 SCP 或 Incus 的同名参数。Hub/纯本地旧通道不声称接受 CLI 选项；有 `argv` 时明确报不适用。
- 当前 `dryRun`、`delete`、`excludes`、`preserve` 这些 rsync 高层开关从新 CLI 路径移除；`verify`、`mkdir` 仅留给现有 Hub/纯本地 `copy` 通道，新原生 CLI 路径不接受也不默认独立验证/建父目录。执行期迁移工具 Schema、调用代码与测试，不把旧 `dryRun:true` 默认值偷偷保留下来。模型需要 dry run 时显式传 `--dry-run`。这属于工具 API 的可见变更，交付时必须更新模型说明。
- 保留原生工具的选项空间，但不承诺不同 transport 的选项语义相同。显式 `rsync -e/--rsh`、`scp -F/-i` 等若覆盖工具选择的 SSH 身份，按调用方的原生选项执行并在回执中展示实际命令参数；不暗中合并两套身份。双 SSH `scp` 禁止会改成源端再认证目标端的 `-R`，因为会越过“两个身份都留本机”的已确认边界。

## 路由

| 路由 | 原生执行 | 本规格的额外工作 |
| --- | --- | --- |
| local↔SSH `copy` | `scp`，默认 SFTP；调用方可显式选 `-O` | 解析 target、保留完整 argv/exit/stderr |
| SSH↔SSH `copy` | `scp -3`，数据经发起机 | 两端 BYO 身份不同则生成仅本机使用的临时 SSH 配置别名；不向远端复制密钥 |
| local↔Docker `copy` | `docker cp` | 解析容器端点 |
| local↔Incus `copy` | `incus file pull/push` | 解析实例端点与方向 |
| 其余已支持的跨端点 `copy` | 两条对应的原生拉取/推送命令 | 发起机暂存或流式串接；每段独立选项与状态；不添加远端 worker |
| local↔SSH `rsync` | 原生 `rsync` over SSH | 将 target/本机 BYO SSH 身份接入原生 remote shell；不设远端 owner |
| SSH↔SSH `rsync` | 两端 rsync 进行同一次协议对话 | 首选本机持有的目标 `ssh -L` 与来源 `ssh -R`，把目标端 rsync daemon 接到来源端；若转发被拒，尝试下述 Node 标准流路线 |

双 SSH rsync 的首选路线要求两端相应的 SSH TCP 转发权限。目标端临时 rsync daemon 仅监听 loopback；本机持有两条 SSH 连接与身份。来源端 rsync 通过来源端 loopback 的 `-R` 端口，经过本机，再经目标端 `-L` 到目标 daemon。发起机只转发 rsync 协议字节，不暂存完整 A 或 A′。来源 `-R` 或目标 `-L` 被拒时，不误报“rsync 不可用”，而进入下一路线。[OpenSSH 转发说明](https://man.openbsd.org/ssh)、[服务端限制](https://man.openbsd.org/sshd_config)。

第二路线是**待实证的实现任务，不先声称完成**：本机 Node 双向连接 A/B 两条 SSH 远程执行标准流。A 需运行正常 rsync 发起端，并通过普通命令行适配把其 rsync 子进程的双向流接入已有 A 端 SSH 会话；B 运行与之匹配的 rsync 接收端。两次独立的 `A→本机`、`本机→B` rsync 不是这条路线：前者可能整份拉取 A，不能利用 B 的 A′ 做跨端增量。直接手写 rsync `--server/--sender` 属内部接口，优先用已文档化的 remote-shell/daemon 路径；若最小适配无法通过真实版本测试，则明确报告“SSH 转发被拒且无可用双向标准流路线”，不回退 Python，也不把整份复制冒充 rsync 增量。[rsync 内部选项说明](https://rsync.samba.org/ftp/rsync/rsync.1)。

## 原生结果与可选增强

基础回执保留执行的原生命令种类、脱敏后的 argv、各段 exit、stdout/stderr 与未运行/运行中/成功/失败状态。`rsync --stats`、`--itemize-changes`、`--checksum`、`--timeout`、`--stop-after` 等由调用方通过 `argv` 选择；不代替原生语义下结论。原生 rsync 会核对已传输文件的重建结果，但 `--checksum` 是传输前决定是否更新文件的选项，两者不同。[rsync 手册](https://rsync.samba.org/ftp/rsync/rsync.1)。

独立读回哈希、额外耗时统计、远端进程所有权、断线后证明式清理、三次重连重试均为后续可选增强，**不是基本 `copy`/`rsync` 成功的前置条件**。本地取消可停止本地 CLI/SSH 子进程；不能因此宣称远端所有派生进程和临时文件均已清理。原生 `rsync` 默认删除中断的临时半成品，`--partial`/`--inplace` 会改变磁盘状态；`scp`/SFTP 可能留下目标半成品。若工具为两段 copy 或双 SSH rsync 自建本机暂存、远端临时配置/daemon，负责在正常退出和可观察中断时尽力释放；无法确认时返回未知状态。它们不是“缓存清理”。远端无需本工具的单调时钟或 Python lease。[rsync partial 说明](https://rsync.samba.org/ftp/rsync/rsync.1)。

当前实现的 Python archive worker、源端 Python 代理与 lease 是旧路线，不应成为新原生路线的隐藏依赖。旧 `copy` 回执中 `verified:true` 只能在确实做了独立校验时继续出现；仅原生 CLI 成功时应标记“未独立校验”，不能沿用旧承诺。原生 CLI 的退出码本身照实返回。

## 实施核验边界

先在本地可控 SSH fixture 验证 `argv` 透传与原生默认、双端不同 BYO 身份的 `scp -3`、local↔SSH rsync 增量。双 SSH rsync 分别测允许转发与拒绝转发，特别核对目标已有大文件时匹配字节和实际传输量；Node 标准流路线须通过相同语义测试，不能用完整拉回本机代替。随后按仓库交付契约经双包 tarball、4999 与 dev3 安装态实测，并验收模型实际看到的 tool description/错误/结果。报告落 `docs/test-reports/`；不触碰生产，不自动发布、commit、tag 或 push。

Rust 自带 worker 的比较结论仍是：替换 Python owner/代理虽可行，却引入跨平台构建、上传、ABI、升级和运行时清理问题；本规格没有需要 Rust 才能完成的文件传输能力。若以后重新要求强远端生命周期保证，再单独评估。
