# Remote 原生文件操作 Implementation Plan

> **For agentic workers:** 执行时使用 `superpowers:executing-plans` 逐任务推进；未经用户或适用规则明确要求，不派遣子 Agent。每一步用复选框追踪。

**Goal:** 把 `remote.copy`/`remote.rsync` 改为原生 CLI 的 target 寻址与有序参数透传，并为双 SSH rsync 提供不依赖远端 Python 的增量连接。

**Architecture:** 发起机 Node 解析现有 target/`byossh` 身份，构造原生 CLI argv 并原样报告退出。单端点路径直接调用 scp、rsync、docker cp 或 incus file；双 SSH copy 用 scp 经本机；双 SSH rsync 首选两条 SSH 端口转发，受限时尝试 Node 双向标准流连接。远端只运行原生 rsync/SSH 所需命令，不部署本工具 worker。

**Tech Stack:** TypeScript/Node.js、OpenSSH/scp、rsync、Docker CLI、Incus CLI、Vitest、既有 DSH `remote` tool。

**Spec:** [docs/specs/remote-native-shortcut/spec.md](../../specs/remote-native-shortcut/spec.md)

## Global Constraints

- 仅修改现役 `better-dsh/src/remote/` 及所需测试、tool Surface、文档；Super 的 `remote/` 只按既有构建规则再生成，不手改生成物。
- `argv` 是选项及选项值的有序字符串数组，`src`/`dst` 由工具附在其后；不经 shell 拼接，不维护原生选项白名单，不强制 `-a`、`--timeout`、`--dry-run` 或额外校验。
- 两端 SSH 身份留在发起机。双 SSH `scp` 强制经本机；双 SSH `rsync` 不使用远端 Python/Node。
- 文件操作只保留本地子进程和本工具确实创建的临时资源的最低限度生命周期；独立哈希、远端 lease、可证明式清理与三次重连不作本轮成功条件。
- 原生 CLI 报错、退出码与未独立校验/未确认清理的事实进入模型可见结果。旧高层参数和默认值不能悄然覆盖原生命令行为。
- 开发前先以 TypeScript LSP 查定义/引用/调用关系、AST 核实结构；核对上游官方 CLI/扩展入口。规划阶段已观察：LSP 定位 `driver.ts` 的 `runRsync` 导入和调用，TypeScript AST 命中 `tool.ts` 的四个写死参数字段及 `driver.ts` 的 `copy`/`rsync` 方法。执行阶段须复核当前树。
- 验收按根 `AGENTS.md`：真实 tarball、4999 Web 测试线与 dev3 安装态；报告写 `docs/test-reports/`。不触碰生产。未经验收、报告及本次明确放行，不 commit/tag/push 或 npm publish。

---

## 文件责任

| 文件 | 本计划职责 |
| --- | --- |
| `better-dsh/src/remote/tool.ts` | 模型可见 `argv`/`pullArgv`/`pushArgv` 字段、动作分派与诚实结果文案 |
| `better-dsh/src/remote/driver.ts` | 复用现有端点与 BYO SSH 解析，按路由选原生执行器 |
| `better-dsh/src/remote/native-copy.ts`（新） | scp、docker cp、incus file 的直接与两段执行；本机临时 SSH 配置/暂存 |
| `better-dsh/src/remote/rsync.ts` | local↔SSH 原生 rsync argv、回执与双 SSH 路由选择 |
| `better-dsh/src/remote/ssh-rsync-native-relay.ts`（新） | 双 SSH 的 daemon + `-L`/`-R` 生命周期及 Node 标准流备选 |
| `better-dsh/src/remote/ssh-relay.ts`、`ssh-source-proxy.ts`、`endpoints.ts` | 解除 copy/rsync 对旧 Python 链路的调用；确认 oneshot 仍在使用的代码不得误删 |
| `better-dsh/test/remote/{rsync,copy,container-copy,cli-copy-owner}.spec.ts` | 更新原生语义、选项透传、真实退出码与跨端增量断言 |
| `docs/remote-tools.md`、`docs/package-catalog.json` | 同步交付文案及 Better 包文档清单（仅确有新文档时改清单） |

## Task 1 — 固定原生参数与回执契约

- [ ] 在 `test/remote/rsync.spec.ts` 与 `copy.spec.ts` 写真实 tool 调用样例：`{action:"rsync",src,dst,argv:["-a","--partial","--dry-run"]}` 和 `{action:"copy",src,dst,argv:["-p"]}`；断言选项逐 token 保序，省略 `argv` 时不默加 dry run、archive、timeout 或 verify。
- [ ] 运行 `npm test -- test/remote/rsync.spec.ts test/remote/copy.spec.ts`（目录 `better-dsh/`），确认当前高层参数接口不满足新样例。
- [ ] 在 `tool.ts`、`driver.ts`、`copy.ts`、`rsync.ts` 把 CLI 请求改为 `src`/`dst` 加 `argv?: string[]`；两段 copy 使用互斥的 `pullArgv?: string[]` 与 `pushArgv?: string[]`。旧 rsync 高层字段从模型 Schema 移除并明确拒绝；`verify`/`mkdir` 仅由原有 Hub/纯本地 copy 通道消费，新原生 CLI 路径拒绝它们。目标路径继续走已有解析器。原生成功只表示 CLI 成功，回执不得填 `verified:true`。
- [ ] 用同一组测试复核新契约；再检查 `argv` 为非数组、非字符串元素、与两段参数混用及 Hub/纯本地旧通道误传 CLI 参数时均在拨号前明确报错。

## Task 2 — 原生 copy 路由

- [ ] 在 `copy.spec.ts` 与 `container-copy.spec.ts` 建立实际文件行为样例：local↔SSH `scp`、SSH↔SSH 两个不同 BYO key 的本机中转、local↔Docker `docker cp -a/-L`、local↔Incus `incus file push/pull`；跨端点 copy 验证两条 CLI 分别取得 `pullArgv`/`pushArgv`。保留空白、引号和换行路径的现有覆盖。
- [ ] 在 `native-copy.ts` 用原生 argv 运行相应命令；SSH↔SSH 使用 `scp -3` 和仅本机可读的临时 SSH config 来区分两端身份，任务结束删除临时配置；两段 copy 仅暂存于发起机。双 SSH 调用中的 `scp -R` 在启动前报与身份边界冲突，普通 `-O` 由原生 scp 处理。
- [ ] 运行 `npm test -- test/remote/copy.spec.ts test/remote/container-copy.spec.ts`；核对原生非零 exit/stderr 原样进入结果，源/目标额外独立摘要缺失时回执明确为未独立校验。

## Task 3 — local↔SSH 的原生 rsync

- [ ] 在 `rsync.spec.ts` 建立原生选项样例：无 `argv` 即按 rsync 默认执行；显式 `--dry-run` 不写盘；`--partial`、`--inplace`、`--delete`、`--exclude=...` 均保持调用者选择。用大文件少量变化验证真正发生原生 delta，沿用尾部斜杠行为样例。
- [ ] 在 `rsync.ts` 只构造原生 rsync 调用与 target 对应的本机 SSH 身份，使用 `RSYNC_RSH` 作为默认 remote-shell 接线，允许显式 `-e/--rsh` 按 rsync 原生规则覆盖；不注入旧 `--rsync-path` Python owner 或固定 rsync 参数。保留 CLI exit、stdout、stderr；只在 CLI 实际输出统计时解析对应字段。
- [ ] 运行 `npm test -- test/remote/rsync.spec.ts`，确认 local↔SSH 的新目标路径、BYO 身份、失败报错及尾部斜杠语义。

## Task 4 — 双 SSH rsync 的 SSH 原生转发路线

- [ ] 在 `rsync.spec.ts` 的两端 fixture 加入“来源与目标持不同本机私钥、目标已有大文件且仅少量字节不同”用例；记录 `Matched data`、`Literal data` 与实际两条 SSH 连接选项。再用拒绝来源 `-R` 的 fixture 验证只标记路线不可用，不悄悄整份拷贝。
- [ ] 在 `ssh-rsync-native-relay.ts` 启动目标 loopback rsync daemon，建立目标 `ssh -L`、来源 `ssh -R`，等待两段转发确实就绪，再启动来源原生 rsync；转发链中身份始终在发起机。每个自建 daemon/config/SSH 子进程在正常退出和本机可观察的取消时释放；失联时把未确认的远端状态报告出来，不建立 Python 租约。
- [ ] 运行 `npm test -- test/remote/rsync.spec.ts`，确认同一次 rsync 协议对话的匹配字节显著多于 literal bytes；取消和启动失败的回执只陈述可观察事实。

## Task 5 — 被禁转发时的 Node 标准流路线

- [ ] 先建独立 fixture：禁用两端 TCP forwarding、保留 SSH 远程命令执行，目标已有大文件，运行两端原生 rsync 并要求 `Matched data` 非零且本机不生成整份源文件。这个用例用来判定标准流方案是否真的保持增量，不把两次普通 rsync 当成实现。
- [ ] 本机 Node 双向转发两条 SSH exec 的 stdin/stdout；目标端以 rsync 可配对的单次接收命令运行，来源端用最小远端命令行适配将**正常 rsync 发起端**的双向流接入既有 SSH 标准流。只使用目标环境已有的 shell/rsync，不上传 Python/Node。将 stderr 与协议 stdout 分开，正确处理背压、双向 EOF、非零退出和本机取消。
- [ ] 用禁转发 fixture 实测数据、退出、错误和中途断开。若标准流适配无法通过当前支持的 rsync 版本与 POSIX shell 组合，明确把该环境标为不支持双 SSH rsync；不得以 Python 或完整暂存静默回退，并在报告中记录失败证据。

## Task 6 — Surface、交付与报告

- [ ] 删除/改写 `tool.ts` 和 `docs/remote-tools.md` 中“文件操作必须 Python”“默认 dry run/verify”“只有固定四项 rsync 选项”等旧说明；示例展示 `argv` 原样透传、双 SSH 两条路线及转发不可用时的真实错误。
- [ ] 运行受影响的 `better-dsh` 测试与 `typecheck`，构建根目录双包 tarball；核对 Super 生成的 remote 闭包与 Better 唯一源码一致，不手改生成物。
- [ ] 按 `super-dsh/test/start-4999.sh` 和 `docs/07-cordis-dsh-dev-test-guides.md` 在测试 home/4999、dev3 安装态逐项验收：local↔SSH rsync、SSH↔SSH 增量、SSH↔SSH scp、Docker/Incus copy、一次原生失败、实际模型看到的参数说明与回执。保持 Web 测试线可访问并提供 URL。
- [ ] 报告写入 `docs/test-reports/`；逐项记录哪些路由成功、哪种 fallback 已验证、实际原生参数/退出码、未独立校验和未确认清理的边界。验收与用户本次发布放行之前，不执行 git 定版或 npm 发布。
