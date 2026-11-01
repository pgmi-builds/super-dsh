# Remote default PTY：设计讨论稿

> **历史讨论稿（已提升）。** 2026-11-01 两轮裁决后，规范正本为 [docs/specs/remote-default-pty/spec.md](../../../specs/remote-default-pty/spec.md)，冲突以 spec 为准；本目录三份文档保留为评审过程记录，实施计划见 [plan.md](plan.md)。

## 1. 产品目标与差异边界

模型平常以 `remote {action:"exec",target:"ssh:dev4",cmd:"…"}` 使用某台机器；工具为每个 Agent、每个规范化 machine 懒建一个可复用的默认 PTY，保留 cwd/env 与交互状态。`handoff {target:<machine>}` 把现有默认 PTY 隔离成可寻址的 `pty:<id>`；下次对 machine 执行时才建新默认 PTY。`mode:"oneshot"` 显式使用隔离的一次性执行。`add` 仍只负责 BYO SSH 身份与 BYO PTY。

**全部保留是默认规则。** 这是有限范围的 refactor：除下表明确列出的改变，现行 remote/remote_transfer 的所有功能、结果字段、回执渲染、错误恢复提示与交付边界都应保留。下文的 Ensure in place 是 user 特别强调的**有限枚举、重点防误改清单**，绝不是“只保留表中功能”。需要改变其他行为时，先写出具体差异供 user 评审。

| 领域 | 已确认的目标差异 | 当前基线/处理方式 |
| --- | --- | --- |
| `exec` | machine target 默认使用同一个 PTY；`mode:"oneshot"` 选现有 stateless lane | 当前 machine target 走 oneshot；旧显式 `<machine>:pty[:label]` 创建形式直接移除，不做兼容 |
| `handoff` | fresh/idle/busy 默认 PTY 可隔离，返回 `pty:<id>`；busy 同时返回当前 jobId 与已产生输出；fresh（尚无默认 PTY）时后台创建空闲 shell 再隔离（2026-11-01 裁决） | 新 action；对已存在的 shell 隔离不新建/不重启；fresh 是唯一例外——默认 PTY 在思维模型中恒 ready，创建时机是实现细节 |
| 输入 | PTY `exec` 只有 `stdin` 时原样写入当前 PTY，不创建命令帧；`cmd`/`scriptPath` 可携带 startup stdin | 旧 `input` action 直接移除，不做兼容；其 exact-byte 写入与可选 `commandId` 防误写能力迁到 `exec` stdin-only |
| 后台/超时 | 只用现有 `run_in_background:true`，PTY 与 oneshot 都可用。machine 默认 PTY 的后台执行在提交 framed cmd 的同时立刻 handoff；已寻址 PTY 立即返回 job，保留原 session。PTY timeout 仍是同步等待期限 | 保留现有字段与 PTY/oneshot 后台能力，不新增 `background` 别名 |
| SSH oneshot MUX | 工具发起 SSH oneshot 执行及其 helper/cleanup SSH 时，显式指定客户端连接复用配置；多次命令可复用握手/认证，但每条命令仍是独立的 oneshot 会话 | 继续读取本机 ssh config 和 BYO 身份；只覆盖工具自有的 MUX 选项，不把 PTY 或 `remote_transfer` 隐式改造成同一条线 |
| `scriptPath` | 本地绝对路径，连接前读取；PTY/oneshot 均能与业务 stdin 共用；PTY 子进程不改变父 shell | 扩展现有 oneshot-only 且与 stdin 互斥的路径 |
| `close` | machine target 只关默认 PTY；`pty:<id>` 关对应 shell；close 不收 job 定位（2026-11-01 裁决） | 保留现有 `force`：有 running 命令时，按 target 关 shell 默认拒绝；仅明确 `force:true` 才中断命令并关闭 shell。取消运行中命令的唯一入口是官方 `job_kill`（宿主 job registry 自带，oneshot/PTY 及一切 job 一致）；`close {job}` 从 surface 删除 |
| `status` | 展示 machine、BYO、默认 PTY、handoff PTY 的即时状态 | 删除最后 20 条命令 ledger 及其展示；保留活动命令 |
| 生命周期 | 15 分钟 idle TTL；每 Agent session 全局至多 30 个 active PTY session（跨 machine/connection/BYO 全计入，默认 PTY 也算），仅触达上限时透明报错并引导模型查 active session 自行 close/kill/复用/oneshot | 2026-11-01 user 裁决：原全局 10 调为 30，取消 per-machine 20 handoff 额度；surface 不预先披露上限；roster 必须可见全部 active session |

machine key 要统一 `ssh:<name>` 与无歧义裸名，避免同一机器两个默认 shell；不同 Agent 仍彼此隔离。Hub 每次访问继续既有 pairing/authorization 检查。运行中不按 idle TTL 回收。

## 2. 必须确保在线的现有功能

以下只是特别容易误改的**有限枚举**；所有其他未涉 refactor 的现有功能也必须原样保留。具体接口须对照当前源码、[remote-tools.md](../../remote-tools.md) 和真实 runtime 投影核对。**保留不意味着重写。**

### PTY 命令、回执与交互

- 保留 nonce 命令分界、terminal echo 处理、ANSI/换行规范化、错误 nonce 防护，以及每条命令的 exit/cwd/envDelta/duration 解析。envDelta 只含变量名/变更标记，不泄露值。
- 保留 PTY 的完整终端流和 stderr 合并信息；与 oneshot 靠拢的结果字段和 renderer 不能减少信息量。沿用现有 `text`、`receipt`、`session`、`commandId`、`outputStats` 等字段，不凭讨论稿的简写将 `text` 换成 `stdout`。oneshot 继续分流 stdout/stderr，并返回原样 exit。
- 保留当前活动命令 ID、parser、output ring 和终端状态；**仅删除历史最后 20 条命令 ledger**。模型每次调用的输入/输出和现有命令帧已提供必要边界。
- 保留 PTY 同步结果、超时转官方 jobs、`job_output` 增量回显、`job_kill` 取消、PTY background 能力，以及 Ctrl-C 后的 job 结算与 shell 存活语义。忙碌 PTY 拒绝新命令。旧 `input` action 被移除，其 exact-byte 写入、空串零字节、`commandId` 防 stale write、写入回执不承诺程序消费都由 `exec` stdin-only 承接。Ctrl-C/Ctrl-D 仍由远端 line discipline 解释。
- 保留现有 `close.force`、忙碌 shell 默认拒绝关闭、关闭幂等回执、过期/失联时的真实 reconnect/notice/TTL 表达。

### Transport、jobs、输出与生态

- 保留 SSH、Docker、Incus、可选 Hub、BYO SSH/BYO PTY、label/裸名解析、Agent-local 身份边界；Hub 无 SSH fallback，Hub pairing/授权与错误披露继续。
- 保留 oneshot 的 shell 无状态性、startup stdin、stdout/stderr 分流、verbatim exit、后台 job、timeout/cancel 进程组清理和真实 runner 标识；helper/POSIX shim/Hub lease 的既有 fallback 与 cleanup 语义继续。SSH 可复用底层认证连接，但每条命令的 shell、fd、退出码与 job 仍隔离。
- 保留 PTY 每 stream 4,000,000 UTF-16 units 与 Hub oneshot 4 MiB 留存、超限披露、`outputStats`、`truncated`、完整 retained 输出及 jobs 增量读取；不恢复已移除的 30K 返回窗。
- 保留 `action` 分派、`status` 无拨号 roster 与按 target probe/card、`add` 不建原生默认 PTY、所有已有 result 字段与错误恢复提示。**Roster 按调用按需扫描、名称与 BYO/PTY 归属按 Agent session 隔离；没有持续同步的全局库存。** `remote_transfer` 的 copy/rsync 端点、native CLI 参数、验证/cleanup 回执、BYO SSH 与 BYO PTY 非文件端点规则不变。
- Better/Super 的 canonical remote 源、Super 生成窄闭包、helper binary/provenance、真实 `defineTool` 投影与结果 renderer 均保持交付契约。

## 3. handoff 与增量输出的关键不变量

活动命令的 nonce parser、output ring、累计 UTF-8 byte cursor 和官方 job 身份必须随**同一个** PTY 移交；不得新建 parser、重跑命令或从旧会话历史重新拼输出。显式 handoff、默认 PTY 的 `run_in_background:true` 与 timeout handoff 共用同一移交逻辑；完成/移交竞态只能产生一个命令归属和一个 job。`run_in_background:true` 是工具级后台执行，不是把 `&` 加进 cmd；在模型发出长命令时即可立即移交。`handoff` 独立 action 仍可在 default PTY fresh、idle、busy 的任何状态下调用。

`job_output` 沿用宿主 job registry **原生从 0 首读**（三轮裁决，2026-11-01，覆盖二轮）：以当前命令为完整输出边界，不做「已发送前缀」字节偏移——不改现有 read 通道、与其他借用 job registry 的形态一致、保持命令边界完整；handoff/timeout 前同步回执已展示的字节在首次 `job_output` 重放一次，属接受的小冗余。快照与 job 注册之间到达的字节自然包含在首读内。UTF-8 byte cursor 与 UTF-16 留存长度不得混用。环形缓冲淘汰时沿用既有丢失披露，不冒充完整输出。移交不能重放之前多次 PTY 命令的输出，也不能遗漏上次回执之后的新字节。`job_kill` / `close.force` 必须针对绑定的当前命令，不能误杀下一条命令或整台机器。

已审计（2026-11-01，baseline-audit §3）：上游 `dsh-jobs` 契约 `read(fromByte)` 首读从 0；ring 为每命令一建，先前命令不会重放。**三轮裁决（2026-11-01）：保持原生从 0 首读，不做偏移适配层**——见 §3 与 §6.3。

## 4. Roster 的现有按需边界（重点防回退）

现行 `remote {action:"status"}` 不带 target 时调用 `roster()`：当次读取本机 `~/.ssh/config` 的字面 Host 别名，运行 `docker ps -a`、`incus list`，并读取当前 Hub target；**只做本机列表采集，不 SSH 拨号、不做 reachability probe，也不在后台 watch**。不同来源的错误独立披露。新 Docker/Incus 容器可在 Agent 已运行后创建；下一次 roster 扫描才看到是预期的按需语义，列表不保证实时连续更新。

扫描结果会合并进现有 `LabelPool`，其注册表由 `sessionKey`（当前从 Agent ID 取得）分区；这只是同一 Agent 内的名称稳定、first-mover-wins/迟到撞名前缀处理和 BYO label 认领，**不是工具维护的全局机器库存**。已消失的机器在重扫后出表，显式 BYO 认领仍只属于创建它的 Agent；一个 Agent 的 BYO SSH、BYO PTY、PTY label/session 不能出现在另一个 Agent 的 roster 或解析结果中。裸名未命中时按现有逻辑现场刷新一次；`status {target}` 才对该目标做按需探测或读 session card，结果只表示当时事实。新默认 PTY/handoff 的状态展示必须沿用这条边界，不能引入启动时快照、全局共享 BYO、轮询或 live inventory；同时按 2026-11-01 配额裁决，本 Agent 的全部 active PTY session（默认 + handoff + BYO）必须在 roster/status 中可见，供模型感知并自行关闭。
回归场景：Agent A 注册 BYO，Agent B 的 roster/同名解析看不到；A 运行后创建 Docker，A 下次 `status {}` 才看到；另一个 Agent 在不同时间扫描可得到自己的当前列表；迟到撞名维持原前缀规则；容器消失后重扫出表；一个来源扫描失败不掩盖其他来源；无 target roster 不产生 SSH 拨号。

## 5. SSH oneshot 连接复用边界

使用 OpenSSH 原生 MUX：每条 SSH oneshot 执行命令在 argv 上**显式**带 `ControlMaster=auto`、工具自有 `ControlPath` 与有限的 `ControlPersist`。首次调用建立连接，后续调用可复用认证后的连接；本机 ssh config 的 Host/IdentityFile/ProxyJump 等仍照常读取，既不改用户配置，也不在服务器安装东西。复用失败时由 OpenSSH 正常新建连接，不能把业务命令判成成功。与已有 `BatchMode=yes`、超时/清理语义并存。

控制 socket 放在工具拥有的 0700 私有目录，路径短且按 Agent 与有效 SSH 连接身份隔离；至少区分原始 target、host、user、port、BYO key/ProxyJump，避免两个身份意外共用 master。空闲 master 有有限寿命并在 Agent 生命周期结束时清理，不留下无界连接。MUX 只优化传输握手，不复用远端 shell 或命令状态；helper probe/upload/run/killgroup、取消后的 cleanup SSH 和按需 status 的短 SSH 探测也走同一连接策略，但无拨号 roster 仍不连网。当前独立的 PTY SSH 连接、scp/rsync/relay 等路径不在此次变更范围，保留原语义。

风险边界：正在存活的 master 固定了建连时的认证和目标；若用户在这段时间内修改 ssh config/key/跳板配置，新命令可能继续使用旧连接直到 master 退出。这里的产品前提是本机 SSH 配置在调用期间不变；实施验收要披露并验证有限的 `ControlPersist`、socket 权限和连接身份隔离。配置变化实时生效若成为需求，应另行设计失效策略。

## 6. 需要评审的开放决策

1. **已裁决（2026-11-01）**：每 Agent session 全局 30 个 active PTY 上限，默认/handoff/BYO 全计入；仅超限时透明报错（说明已达 agent session 全局上限，引导查 active session 后自行 close/kill/复用/oneshot），surface 不预先披露；roster 必须可见全部 active session；15 分钟 TTL 原样保留。
2. **已裁决（2026-11-01）**：fresh `handoff`（尚无默认 PTY）后台创建空闲 shell 再隔离——思维模型上默认 PTY 恒 ready，创建时机是实现细节。实施中仍需核对目标机不可达时的错误回执；示例中的 `~/.ssh/...` 路径展开应与现有 key 规则核对。
3. `handoff` output schema 的最小增量，以及 busy `exec` 与外部 handoff 竞态的回执归属，需在 surface 定稿前核对。**首读起点三轮裁决（2026-11-01，覆盖二轮）**：撤销「快照之后起读」——`job_output` 保持宿主 job registry 原生从 0 首读（当前命令完整边界），不做偏移；与 handoff 前同步回执的重复是接受的小冗余（简洁性 + 与其他 job registry 消费者一致）。
4. MUX 的有限空闲保留时长与目录清理时机，在实现前用目标机 OpenSSH 行为确认；本稿固定安全边界，不凭空指定已验证数值。

上述决策评审后先同步 [surface-draft.md](surface-draft.md) 与本稿，再进入开发。未裁决的旧行为保持。

## 7. 交付与验证原则

真实模型应看到审定后的 instruction、输入/输出 schema、示例和错误恢复提示。当前宿主 `defineTool` 的参数根是开放 object；跨 action 的条件约束由工具运行时校验，不伪称宿主有顶层 discriminated union。交付前按根 AGENTS.md 走 tarball、4999 Web、dev3 实装的真实 create/prompt/resume 验收，报告落 `docs/test-reports/`，保留 Web 入口供 user 验收。本阶段只写文档，不进入开发或生产操作。
