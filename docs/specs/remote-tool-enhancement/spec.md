# Remote 工具 enhancement — 交付、生命周期与传输规格

- 日期：2026-10-10（Asia/Hong_Kong）
- **2026-11-02 修订（ADR 0016，user 决策）**：Super 不再注册模型侧 remote 工具——`superd-remote` 组合行与公开 `super-dsh/remote` 导出已删除，`remote`/`remote_transfer` 只由 Better Dash 交付；companion 自动/手动安装一并移除。Super 的生成闭包**保留为 hub 内部私有依赖**（hub exec/PTY/task/file lanes 引用其进程原语；无导出、无组合行，provenance 管线不变）。下文涉及 Super 组合行/公开导出与 companion 的条款仅作历史。Better 侧源码与「Super hub 在场即作 target」的检测逻辑不变。
- 状态：2026-10-10 user 已审阅并明确授权执行；Task0–7 已独立审阅通过；Task8 完整双包消费者验收进行中，L 实装暴露的 worker/SSH cleanup 缺陷已进入修复验证。用户亲验与发布尚未放行。
- 2026-10-25 surface 修订（user 指令，本轮实现）：`remote` 的判别字段改为**必填** `action: exec|add|close|status`；文件传输字段（`src`/`dst`/`argv`/`pullArgv`/`pushArgv`/`verify`/`mkdir`）迁到独立工具 `remote_transfer`，判别字段为**必填** `mode: copy|rsync`。`add` 只注册 BYO 身份/终端，不执行命令；`exec` 必填 `target` 且必须执行东西（warm 会话用 `cmd:"true"`）。工具简介把 PTY 重新定位为「stateful oneshot」并鼓励优先使用。下文 §5 的旧 `action:"copy"|"rsync"` 调用形与「无 action」形仅作历史。
- 0.3.2-b 对齐（2026-10-19）：`script` 已定名 `scriptPath`；`mode` 字段已移除（用 `<transport>:pty[:label]` 创建、`pty:<id|label>` 复用）；`byossh:`/`byop:` 前缀已移除（`ssh`/`spawn` 参数在场即 BYO）。下文旧调用形仅作历史。
- 输入：[2026-10-09 方向稿](../../10_plans/2026-10-09-remote-tool-optimization-directions.md)及 2026-10-10 会话裁决。
- 执行计划：[2026-10-10-remote-tool-enhancement.md](../../superpowers/plans/2026-10-10-remote-tool-enhancement.md)。本规格优先于方向稿的冲突条款。

## 1. 目标与本轮范围

为 Agent 提供省步骤、减少转义和连接错误的 remote 便利层。一个 `remote` 工具覆盖 SSH、Docker、Incus、BYO-PTY，以及 Super 在场时的 Hub machine。Super 和 Better 分别可独立交付，不因另一包关闭或卸载丢失自身代码。

本轮实现 P0/P1：

1. Better 单一源码、Super 构建副本；两条插件行默认开启，Agent 实例级一次注册竞争。
2. 可选 Hub 接入、动态 machine 清单；无远端机器时 Hub 清单为空，不执行本机。
3. oneshot `script` 文件载体与 Hub oneshot stdin parity。
4. 取消 Hub 模型工具缺省/显式本机执行入口，保留执行服务端与本地文件端点。
5. BYO-SSH 注册、复用及连接参数；BYO-PTY 保持既有语义。
6. oneshot 后台作业复用 DSH 原生 jobs 的 identity、pull-delta、完成通知及取消。
7. `copy` 跨受支持端点的二进制传输、校验与暂存清理。
8. `rsync` 仅 SSH；两个远端经发起机的 SSH 隧道中继，身份不下放。
9. 真实双包交付和模型 Surface 验收。

后续范围，不在本轮实现：P2 PTY 已完成命令的 backlog/offset 续读；P3 运行中 probe。取消：3.5M 提醒、一次性 `ssh://` target、`cmd[]` fan-out、push stdout、非 SSH/混合 transport rsync、BYO-WebSocket/Docker/Incus、命令黑名单、额外文件管理工具、inline cmd 扩容。

## 2. 包归属与交付

- 唯一可编辑源码：`better-dsh/src/remote/`。
- Super 构建时从该源码生成独立 remote 交付闭包，导出 `super-dsh/remote`。不复制 Better 整包、客户端、REPL、文档或其他工具；不建立 Super→Better 的 npm dependency/optional/peer 边。
- 生成目录及 provenance manifest 不手改；构建必须检查源码哈希与输出闭包，防止旧副本或跨包裸 import。
- Better 行保留 `id: dashr-remote`、`name: better-dsh/remote`；Super 新行 `id: superd-remote`、`name: super-dsh/remote`。两个 YAML id 不相同，两行默认开，模型工具名相同：`remote`。
- 不在 Super YAML 中禁用 Better remote，不写安装时脚本化的 profile enable/disable；已存在的用户开关选择保留。
- Super 的 companion 原生安装流程不改变；remote 是“Super 不携带 Better 文件”契约的窄范围自有源码复用例外，而不是恢复整包捆绑。
- 宿主模块继续 optional peer、真实类型和单实例契约；私有 schema 真实构建输入在生成闭包内解决，消费者不解析 Better 的 `#schemastery`。
- 根、Better、Super 同步版本；实现轮经 `npm run version:release -- <同步字母版本>` 和双 tarball 通道，不发布 registry。

## 3. Agent 实例级注册

### 3.1 上游事实

当前上游 `tools.register()` 同步插入 scoped registry，同 scope 同名立即抛错，不是先收集后统一去重。`agent/created` 是 setup 完成后、首轮工作放行前的 serial lifecycle 事件。preset revision/generation 被多个 Agent 复用，不能假设每个 session 重跑 preset 插件。

证据位置：

- `upstream/deepseek-harness/packages/core/tools/src/index.ts:1063`。
- `upstream/deepseek-harness/packages/core/scope/src/store.ts:43`。
- `upstream/deepseek-harness/packages/core/agent/src/runtime-types.ts:250`。
- `upstream/deepseek-harness/packages/preset/agent-preset-registry/src/index.ts:104`。
- `upstream/deepseek-harness/packages/api/session-controller/src/agent.ts:185`。

### 3.2 行为

- host 插件行只安装生命周期监听器，不在全局工具作用域注册 `remote`。
- 每次 `agent/created`，两份行各自在该 Agent 的真实 scope 尝试注册工具。先成功者供该 Agent 使用，后者只跳过该实例。
- 不自行判断 new/cold resume，不存 session 启动类型、不记录“已退出/待命”状态；官方创建事件本身给出尝试时机。必要改动仅为把现有 host 全局注册移到此事件的 scoped 注册，并局部处理同名冲突。
- 不保证 Super 优先，不按 UI/YAML 展示顺序推断赢家。两份相同源码均可接入 Hub，赢家不影响能力集合。
- 只处理实际的 `remote` 重名冲突，其他 schema、生命周期、服务异常继续抛出；不吞掉所有错误。
- 重名跳过不写 `disabled`，不让 host 行变成失败状态，也不使 Agent 创建失败。
- 注册、driver、PTY、BYO-SSH label 及 jobs 同时归该 Agent scope 和来源插件行所有：任一 owner 退出都撤注册并清理资源；不能仅依附 Agent 而留下已卸载包的执行闭包。
- 不轮询、不设接管队列、不在空位出现时重试。已存活 Agent 中途卸载赢家，当前实例不自动补位。
- new session 和 cold resume 创建新 Agent 时重新尝试；hot continuation、重开页面、给存活会话发消息不重试。
- 首轮插件热安装不追溯给既有 Agent 补注册，Surface 提示新建会话或 cold resume；普通 disable→enable 若该插件本身支持恢复，须记录实际窗口，不承诺热接管。
- foreign runtime 的既有 Hub 注入面与 native `remote` 不混淆：本轮不宣称所有 foreign agent 直接拥有 DSH scoped remote 工具。

## 4. 可选 Hub 能力

Better 不 import Super 包。共享 remote 定义 owned structural contract；Super 在官方 Cordis scope 提供 `superdRemoteTransport`，remote 用 `ctx.get()` 在能力消费时可选取得。absence 不形成硬 inject 等待，不修改宿主。

- provider 在场 → 工具描述与 roster 说明 `hub:<machineId>`；机器目录可为空。机器变化只改变 roster，不增删 target 字段。
- provider 不在场 → SSH/Docker/Incus/BYO 继续可用，Hub target 返回有恢复提示的 unavailable 错误，不静默改走 SSH。
- provider 的出现/消失通过官方服务通知更新模型 Surface；不检查 npm 包目录，不轮询各机器可达性。
- roster 来自 pairing 表中的远端 m4，排除 self；执行时检查 unknown machine、`execEnabled` 与连接错误，保留原始原因。
- 远端执行服务端和文件 transport 随 Hub 本体提供，不依附模型侧 remote 行。关闭某台机器的工具行不应拆掉别人访问它的服务端。
- PTY 沿用现有 pairing cookie、auth/Host/Origin fence 与 WS executor。oneshot 沿用既有 authenticated RPC，不声称现有 HTTP exec 已改为 WS。
- 文件独立使用 binary WS lane；文本 PTY 不作为二进制文件通道。
- 对端旧版本无文件 lane 时明确 unsupported；不以 base64 手搓冒充新增能力。

## 5. 执行入口

### 5.1 script 与 stdin

`{ target, script: "/abs/local/script.sh", mode: "oneshot" }`：从工具所在运行时读文件，原文作为 `bash -s` 的 stdin。文件不要求能在目标机直接访问，不把源码拼入 argv。

- `script`、`cmd`、`stdin` 的选择：script 与 cmd 互斥，script 与 stdin 互斥；stdin+cmd 沿用现有模式。
- script 首轮仅 oneshot，BYO-PTY 或 mode pty 请求在读文件/拨号前拒绝。
- 本地路径必须绝对、无 NUL；文件读取失败在连接/执行前报告。
- 不做 script 自带业务 stdin 的第二通道；需要数据时用文件/参数，或用 cmd+stdin。
- 保留 Hub inline cmd 4096 字符上限；script 固定命令短于上限，正文走 stdin。
- Hub API、wire sender、legacy Hub tool exec Surface 同步支持 string stdin；PTY 不把 legacy stdin 支持悄悄扩成 script 模式。

### 5.2 local

- Hub 模型工具 exec 不再缺省本机；未传 machine 返回“请选择远端”提示，显式 self 默认也拒绝。
- `localExec` 配置默认 false，可作为显式兼容入口，但不替正常消费者加入测试专用业务守卫。
- 接收对端请求的本地 oneshot/PTY executor 保留；copy 的本地文件端点及读取 script 保留。

### 5.3 输出

- native/PTy 现有 4,000,000 UTF-16 code units 与 Hub oneshot 4MiB byte ring 是不同单位，回执必须真实说明；本轮不配置化，不凭文案把两者说成同一精确 4MB。
- 保留约 30k 返回尾窗；统计总输出、保留量、已丢头部，超限明确标注。修复 native oneshot 现有收头却被上层当作尾窗的偏差。
- 单次 dispatch 重新计数；达到上限不要求重启 PTY，重启不能找回已丢数据。
- 不新增 3.5M 预警、输出预测或 push 监控。

## 6. BYO-SSH

调用形态：`{target:"byossh:label", ssh:{host,user?,port?,key?,proxyJump?}, cmd}`；首次注册连接，随后只用 target 复用。使用 `ssh` 字段而非复用现有 string `spawn`，避免破坏 BYO-PTY schema。

- label 归 Agent 实例；不改 `~/.ssh/config`，不持久化凭据，不接受 inline 私钥内容；key 是发起机已有文件路径。
- 首次可登记后执行或仅登记；复用相同参数幂等，不同参数给出冲突与换 label 提示。
- host、user、port、key、proxyJump 通过参数数组、受控 config 文件或官方 SSH options 编排，不能拼出第二层任意 shell。
- 所有执行、copy、rsync 和中继复用同一已解析 SSH connection spec，不能 rsync 又退回只读系统 alias。
- roster 区分 SSH config 与 byossh labels，不导出密钥、cookie 或完整凭据。

## 7. oneshot jobs

`{target, cmd|script, run_in_background:true}` → 原生 jobId；读取/取消使用 DSH `job_output` / `job_kill`，完成由宿主通知。PTY mode 明确拒绝此选项。

- 使用官方 `ctx.jobs.start`、owner、JobHooks、output source/pump；不自建第二份 job registry、poller 或通知渠道。
- 子进程/远端任务在 job admission 后启动；启动被拒不能留下已经运行的进程。
- job 输出必须运行中真实增量可读，不能等 command 完成后才一次 append 全量。
- done 等到进程、远端任务及资源释放后结算；cancel 终止真实本地组/远端 job，不只把本地 Promise 标为取消。
- provider 需要对 Hub oneshot 提供 job-owned start/read/cancel/done 协议；仅 abort HTTP fetch 不视为远端取消。
- jobs service 不在场时同步 exec 仍可用，background 请求 fail-loud 并说明缺失的官方能力。
- 前台 timeout 保持现有上限；background 无前台等待截止但受 owner cancellation 和 job kill 管理。

## 8. 文件操作

### 8.1 寻址及能力边界

`{action:"copy", src, dst, verify:true, mkdir:true}` 与 `{action:"rsync", src, dst, delete:false, excludes:[], dryRun:true, preserve:true}`。

端点使用 `[target:]绝对路径`；例如 `/tmp/a`、`ssh:dev3:/data/a`、`byossh:review:/data/a`、`docker:build:/data/a`、`hub:skc8:/data/a`。按最后一个 `:/` 边界解析 target/path，避免把 transport 前缀冒充 host。裸 label 的兼容解析复用 remote roster 规则，不另建命名系统。

- copy 首轮支持文件与目录的 local、SSH/byossh、Docker、Incus、Hub 端点；每条腿使用实际 binary stream，保持精确路径与明确的内容/目录语义。
- byop 是任意交互 shell，不保证 binary I/O 或 filesystem；copy/rsync 不承诺可用，拒绝并建议用显式 transport target。
- rm/mv/mkdir/chmod/stat 不增加 action；mkdir 仅 copy 的建父目录选项。
- 校验使用 SHA-256；目录使用排序、长度编码的相对路径/条目类型/内容 manifest，明确 symlink 不跟随，避免文件名含空白/换行破坏回执。
- 覆盖默认允许普通文件，目录合并无删除；不得悄悄把 copy 变为 rsync delete。路径/type 不兼容返回错误。

### 8.2 copy 中转

任意两远端通过工具所在发起机中转，各腿使用其已有 target 通道，不向其中一端复制另一端连接身份。中转采用任务级 `.scratch` 暂存，先收完整载体，再向目标发送；不宣称提供源到目标流式复制、delta 或断点恢复。

- 二进制 lane 需要 backpressure、传输错误/关闭、显式完成帧、有限 metadata/frame buffer 和 cancellation。
- tar/archive 或等价 carrier 在解包前验证成员路径，不接受绝对成员、`..` 出界或借 symlink 写出目标目录。
- `verify:true` 返回独立源/目标 hash 或 manifest digest、条目/字节统计、校验结果；数据端失败不能给成功回执。
- 中转任务成功后清理 owned 暂存；失败保留可诊断载体，回执给出位置和原因。保留不意味着自动重试。
- 远端临时进程、监听/临时接收文件必须取消/结束清理，不能因为“失败保留诊断”而留后台服务。
- `verify:false` 不显示已校验；successful transfer 也清理中转载体，不无限堆垃圾。

### 8.3 SSH-only rsync

- 支持 local↔SSH，以及 SSH↔SSH；目标连接来自系统 SSH config 或 byossh 注册。
- 两个 remote 参数不能直接传给普通 rsync；工具负责变成原生 rsync 可接受的一端本地视角。
- remote↔remote 通过发起机建 SSH 隧道中继；一种实现为目标端短命 loopback rsync daemon + 发起机 local forward + 源端 reverse forward。rsync delta 算法仍为原生实现。
- 两端 identity 仅由发起机 SSH 进程使用；禁止复制 private key、导出登录凭据、ssh-agent forwarding 或修改远端 SSH config。
- daemon 仅绑定 loopback、模块限定目标目录，以当前登录用户启动；不安装永久 daemon，不公开监听。SSH 禁止 forwarding 时返回原始拒绝。
- `dryRun` 默认 true、`delete` 默认 false；`excludes`、preserve、trailing slash 内容语义通过参数表达。真正传输显式 dryRun false。
- 预检两端 rsync 和所需 SSH forwarding；缺失不静默 fallback copy，更不能对 delete/excludes 回报假成功。
- 捕获 rsync 原始退出码与 itemized changes，保持 stderr；非零不标成成功。
- 无论成功、失败、cancel 都清理 tunnel、短命 daemon 与本任务临时 config；复用 transport 不等于关掉用户既有 SSH 会话。

## 9. 验收和完成定义

代码、传统测试、打包成功只说明阶段进度，不等于产品验收。

1. scoped 真实 Cordis/Agent fixture：双包仅一个 remote；Agent 创建不失败；非重名异常不被吞；不同 Agent 互不争抢；赢家卸载当前实例不补位；new/cold resume 可恢复；hot continuation 不假装恢复；退出清理。
2. 单包 Better tarball：无 Super import/安装，SSH/Docker/Incus/BYO 按已有能力工作；jobs 缺失错误真实。
3. Super tarball：禁用/卸载 Better 后 remote 仍可用；两包启用顺序相反都可用；Hub 存在但 machine 清单空的 Surface 正确；关闭模型工具行不拆 Hub executor。
4. 4999 完整 launcher：安装双 tarball、真实模型 roster/script/stdin/PTY/后台任务/job_output/job_kill/copy/rsync 与错误恢复；工具 catalog 和 REPL 路由属于验收。
5. dev3 同版本实际安装：配对但无 SSH 的 Hub PTY 与 binary copy；dev3↔另一 SSH 目标经发起机中继，远端无对方 key/config；第二次改少量内容证明真实 rsync delta；cancel/异常证明无残留。
6. 记录上游实际 checkout、目标宿主版本、同步版本、tarball SHA-256、安装步骤、模型可见 Surface 和失败证据至 `docs/test-reports/`。
7. Web 测试线保持运行，报告真实访问 URL，供 user 亲验。
8. 不触碰生产 home/3080/3081/Caddy，不修改上游，不 npm publish、不 commit/tag/push 定版。发布需要本次单独放行。

## 10. 书面确认边界

本稿实现上述会话裁决，没有把 P2/P3、非 SSH rsync 或热接管重新塞入首轮。字段 `ssh`、端点解析、copy 的 BYO-PTY 不支持回执是保持已有接口并使交付可实现的具体化；user 可在书面规格审阅时修订。收到书面审阅后，按执行计划进入实现，不再为已批准的 routine 实现步骤重复请求授权。


### 2026-10-10 consumer worker delivery correction

The generated Super `remote/` contains exactly `plugin.js`, `plugin.d.ts`, private `file-worker.js`, and `provenance.json`. The worker leaf is built solely from canonical `better-dsh/src/remote/file-worker.ts`, has Node-builtins-only imports, and is hashed/checked with the closure. It has no public package export, host peer imports, duplicated host modules, source loader or Better dependency. The public plugin contract remains unchanged. The existing owned child-process/group cleanup remains the receiver boundary; no worker-thread lifecycle replacement. This narrow extra generated leaf fixes actual installed receiver resolution, not a general guarantee that host plugins import outside their host resolver.

### Task8 delivery correction: owned SSH oneshots (Ruling22)

Real consumer job-kill exposed local-only SSH termination. Foreground/background/script/stdin SSH oneshots therefore reuse the portable receiving sideband owner, preserving native literal stdio and connection normalization. Remote Bash4.1+, Python3.7+ (macOS3.10+), shared non-adjustable cross-process monotonic clock, Unix fcntl.flock and mktemp/mv/rm/sleep are required. Ordinary commands never require rsync; origin needs no Python, and this path needs no Linux/pidfd. Three SSH startups (clock, control, work), with authenticated same-identity cleanup reconnect after ambiguous startup; existing lease/bounds remain. Receiver helper/group cleanup precedes settlement, followed by up to2500ms work-stream drain; unavailable drain explicitly marks incomplete received output without fabricated counters. PTY/BYOPTY and rsync-specific restrictions remain unchanged. No second jobs registry or availability polling.


### Task8 container oneshot ownership correction (Rulings23–24)

Actual installed Docker/Incus native job cancellation reported killed while receiving children remained live. Canonical oneshot foreground/background/script/stdin therefore share the SSH portable receiving gate/control/work barrier through native container exec argv, not local CLI termination. Each command requires three native exec startups (clock, owner, literal-stdio work), remote Bash4.1+, Python3.7+, Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep. Linux containers additionally require stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER before business admission; the work helper reaps only its own/adopted children and stays alive until its work group is absent. This supports ordinary non-reaping PID1 containers without forcing --init, privilege/capability, image/config mutation, rsync, pidfd or origin Python. PTY/BYOPTY stay unchanged; SSH portable prerequisites are not broadened. The same eight-second counted lease, gate recovery, actual cleanup barrier and 2500ms honest final-output drain apply, with no enlarged grace, second job registry or availability polling. Consumer iteration N must prove real native killed status together with owned process/group/helper/state absence; M failures remain historical evidence.

Ruling25 supersedes the original two-remote source -R/private-master/sshd-FD/pidfd design after actual default dev3 source failed its permission requirement. A task-owned portable Python loopback proxy, inside the existing receiving helper/group/lease, carries bounded binary frames over authenticated SSH work stdio to an origin TCP bridge into the destination -L tunnel. A real full-route @RSYNCD greeting precedes business admission. No source Linux /proc, pidfd, privileged sshd access or source forwarding permission is required; native find, native rsync and the existing portable Bash/Python/fcntl/shared-monotonic prerequisites remain. No origin Python, credentials on peers, copy fallback, lease increase or second registry. Five-byte type/length frames cap data at64KiB and Python queues at256KiB; one active connection, real backpressure and half-close, prior reader/socket close before next OPEN. Ordinary two-remote transfer measures12 SSH startups: source preflight+inspection clock/work3, relay source/destination preflight2, destination clock/daemon+tunnel2, source proxy clock/owner/work3, native source rsync clock/work2. Fault recovery adds only task-owned authenticated cleanup reconnects, never transfer retries. Same real helper/listener/group/metadata/tunnel/socket cleanup barrier; receiving progress remains an explicit assumption. Historical M permission failure remains in the acceptance report; current default-dev3-source source test passes, installed next-artifact proof is separate.


### CLI binary receiving ownership (consumer correction, Ruling26)

Actual N native SSH copy cancellation settled while the remote import process and its unnamed staging file remained live under a finite work-channel EOF hold. CLI export/import/digest now reuse the canonical portable receiving owner, with raw binary work streams and the same counted lease, admission gate and authenticated recovery. Cancellation/failure waits for receiving helper/group/temp cleanup before local transport teardown/settlement. Normal success must completely drain the binary stream; the oneshot text lane's 2500ms incomplete-output rule does not apply. Archive validation, selected manifest digests, merge/no-delete behavior and canonical SSH identity/ProxyJump are unchanged. Local and Hub file lanes are unchanged.

This intentionally replaces the former Python-only minimum for CLI peers: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep; Linux containers also need stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER. No rsync or origin Python requirement, auto-install, second registry, fallback, peer polling or increased lease. Minimal Python-only peers no longer support this CLI lane; use a supported peer or authenticated Hub.

Each remote export/import/digest costs three native transport starts: clock, independent owner/control, literal binary work. Thus verified local→CLI or CLI→local costs six; CLI→CLI twelve. verify:false skips digest operations, reducing counts to three/three/six. Local/Hub operations do not contribute CLI starts. Fault recovery may add same-identity authenticated cleanup starts and may remain pending until genuine cleanup observation is possible. Artifact O must re-prove installed cancellation and complete binary integrity; N failures remain historical evidence.
