# Remote Default PTY：surface 先行的实施计划

> **待评审计划；本轮只交文档，不开发。** 2026-11-01。产品讨论稿为 [design-for-review.md](design-for-review.md)，模型可见 instruction、示例与 JSON schema 草稿为 [surface-draft.md](surface-draft.md)。两者尚不是已批准的 spec。开始编码前，先由 user 评审产品形态、兼容决策和最终 surface；若实施中发现规格不可交付，先改文档并再次评审。

**目标：** machine target 自动复用一个默认 PTY；`handoff` 可随时隔离该 shell；沿用现有 `run_in_background:true` 在提交长命令时立即移交默认 PTY；`mode:"oneshot"` 显式走无状态执行，SSH oneshot 使用 OpenSSH MUX 复用认证连接。**所有未涉及此 refactor 的现有功能原样保留**；下文 Ensure in place 只是 user 点名的有限高风险清单，绝不是保留范围的上限。移除旧 `input` action、显式 `<machine>:pty[:label]` 创建和历史 20 命令 ledger；保留其余行为，尤其 PTY 深度结果解析与增量 job 回显。

**源与交付：** 唯一可编辑 canonical 源在 `better-dsh/src/remote/`；Super 仅经现有构建生成 remote 窄闭包。不得改上游源码或以假类型/开发脚手架掩盖交付缺陷。代码实施时按根及子目录 AGENTS.md 执行；本文不授权发布、提交或生产操作。

## 0. Surface 先定稿

- [x] 三份文档放入同一 `docs/10_plans/2026-11-01-remote-default-pty-plan/` 目录。surface 主 instruction 复制 user 的简洁版本；同时明确其为讨论稿。
- [x] User 已裁决：旧 `input` action 与显式 `<machine>:pty[:label]` 创建不需向前兼容；PTY 仍使用原字段 `run_in_background:true` 作为即时 handoff，不新增 `background` 字段；`close.force` 保留忙碌保护；SSH oneshot 增加显式 MUX 配置。
- [x] User 二轮裁决（2026-11-01）：①配额 = 每 Agent session 全局 30 个 active PTY（跨 machine/connection/BYO 全计入，默认 PTY 也算；仅超限时透明报错并引导模型查 active session 自行 close/kill/复用/oneshot，surface 不预先披露上限；roster 必须可见全部 active session；15 分钟 TTL 原样保留）。②fresh `handoff` 后台创建空闲 shell 再隔离（默认 PTY 思维模型恒 ready，创建时机是实现细节；不可达错误回执实施内核对）。③job 首读起点——**已被三轮裁决覆盖**，见下一条。
- [x] User 三轮裁决（2026-11-01）：①**撤销「快照之后起读」的字节偏移方案**——`job_output` 保持宿主 job registry 原生从 0 首读：不改现有 read 通道、与其他借用 job registry 的形态一致、保持当前命令输出边界完整；handoff 前同步回执已展示的字节在首次 `job_output` 重放一次属接受的小冗余（简洁性优先）。三路（timeout 收养、显式 handoff、`run_in_background`）统一此原生语义。②`run_in_background` 的 surface 说明必须含 **went-async** 表述：本质是命令转 async（oneshot / 默认 PTY handoff / 已寻址 PTY 命令三路同义），不是 bash 的 `&`；须透明准确并说明 `job_output` 从当前命令起点读完整流。
- [x] User 三轮补充裁决（2026-11-01）：①went-async 文案补全第二半句 **「completion notification will follow」**——两层语义：went async 精确描述机制（防 bash background 误解）；完成会主动通知则释放模型心理负担（不必定时轮询，可放下不管；宿主 jobs 服务完成时确实主动推送，承诺有真实机制支撑）。②**close 不收 job 定位**——取消运行中命令的唯一入口是官方 `job_kill`（宿主 job registry 自带，oneshot/PTY 一切 job 一致）；`close {job}` 与 `job_kill` 完全重叠、双入口违背「action 是唯一派发维度」，从 surface/计划删除；close 语义边界收敛为关 shell，`close.force` 保留。
- [x] 配额并存、fresh handoff、timeout 首读起点已裁决（见上）；`handoff` output schema 最小增量与竞态归属已定稿并回写 spec §5 / surface-draft §5（result kind `handoff` 早退渲染：session(+label)/connection/cwd/created/running+commandId/ttlSec）。
- [x] 最终 instruction/输入 schema/输出 schema/回执样例/错误提示已在 Task D 定稿并被 tool.spec 锁定；第一人称验收由模型逐字引述 schema 表述核对（验收报告 §3）。
- [x] 2026-11-01 user 裁决提升为正式规格：[docs/specs/remote-default-pty/spec.md](../../../specs/remote-default-pty/spec.md)（规范正本，冲突以 spec 为准）。实现以**审定的 surface + 差异清单**为准；实现发现限制先回写、再评审。

## 1. 更改矩阵与保护基线

### 明确 Go：需要实施的差异

| 项 | 需要形成的行为 | 验收证据 |
| --- | --- | --- |
| 默认 PTY | 每 Agent、每规范化 machine 一个懒建默认 shell；machine 连续 `exec` 保留 cwd/env；显式 oneshot 不读写该 shell | 连续命令、跨 Agent、裸名/前缀别名、SSH 连接复用 |
| handoff | fresh/idle/busy 默认 shell 隔离为 `pty:<id>`，保留原进程与输出源；fresh（尚无默认 PTY）时先创建空闲 shell 再隔离（2026-11-01 裁决，不可达错误回执如实）；machine 下次按需建新 shell | ID、cwd/env、busy 命令和新默认槽均正确；fresh 不可达回执 |
| PTY 后台 | 现有 `run_in_background:true` 在默认 PTY 中提交 framed cmd 后立即做同一次 handoff，回 jobId/session；在已有 `pty:<id>` 中立即返回 job 而不改 session；oneshot 继续可后台；说明含 went-async + completion notification 表述（三轮裁决） | 显式 handoff、后台、timeout 三路统一为宿主原生从 0 首读（不做偏移）；工具级后台与 cmd 中的 `&` 不混淆 |
| 主路径参数 | `mode:"pty"|"oneshot"`、PTY `exec` stdin-only 原样写、`cmd`/`scriptPath` 互斥、二者各可配 stdin | 参数矩阵与真实 schema 对账 |
| script + stdin | 本地绝对 script 连接前读取；各传输的脚本载体和业务 stdin 分离；PTY 脚本为子进程 | SSH/Docker/Incus/Hub 两模式真实调用 |
| SSH oneshot MUX | 工具启动的 SSH oneshot 执行、helper/probe/upload/killgroup、超时 cleanup 与按需 status 短 SSH 探测显式设置 OpenSSH ControlMaster/ControlPath/ControlPersist；重复调用可复用连接 | 不改本机 ssh config/身份、每命令仍隔离、socket 私有与有限寿命、首连/复用性能和清理真实验证 |
| close/status | machine `close` 只关 default；close 只收 target（machine/pty），不收 job 定位——取消命令统一官方 `job_kill`；status 展示即时状态；忙碌 shell 无 `force:true` 不得关闭 | handoff 会话/BYO 不被误关，force 后取消及关闭回执准确；close 传 job 字段被明确拒绝 |
| 生命周期 | 默认及 handoff shell 保留 15 分钟 idle TTL；每 Agent session 全局 30 个 active PTY（默认/handoff/BYO 全计入），仅超限时透明报错并引导查 roster 自行 close/kill/复用/oneshot；surface 不预先披露上限；roster 展示全部 active session | 30 上限触发回执、roster 全可见、15m TTL 真实边界 |

### 明确 No-go：允许移除的现有入口与历史状态

- [x] `input` action 已删；exec stdin-only 承接（`wrote 2 bytes into pty:… for command …` 回执 + commandId guard），第一人称 GOT:x/y 闭环。
- [x] `<machine>:pty` 创建语法已删（残留后缀 E_TARGET_FORMAT 教学）；多会话经默认槽 + handoff / `add {spawn}`（第一人称：add spawn 建会话、handoff 分离）。
- [x] 删除 PTY 最后 20 条**历史命令 ledger** 的存储、status/card 展示和专属测试/说明。保留每条当前活动命令的 ID、nonce 边界、parser、output ring、job 绑定、结果回执。删除前用 AST 枚举所有 ledger 读写，逐处确认不是当前命令状态或增量输出 cursor。（完成：存储/FIFO/渲染 12 读写点逐一改走 activeCommand；card 现为当前活动命令行，第一人称核对 `no command running` / `running: <id> (job …)`）

### Ensure in place：未列为差异的功能必须保持

**总原则是全部保留：任何不在 Go/No-go 清单里的现有功能都不能改变。** 下表只是 user 能想起并特别强调的有限高风险枚举，不是完整功能列表或允许动其他功能的豁免。实施前须另从源码和实际 surface 建立完整基线；每项在实施报告中标记「未修改且现有证据有效」或「受影响并已实测」。

| 区域 | 现有必须保留的功能 | 验证方式 |
| --- | --- | --- |
| PTY 结果解析 | nonce 帧、echo 处理、ANSI/换行规范化、错误 nonce 防护、每命令 exit/duration/cwd/envDelta；envDelta 只列变量名/标记 | 真实 PTY 命令与现有 parser 测试；比较结果字段 |
| PTY 信息量 | 终端 echo 与合并 stderr 不丢；完整 retained output、`text`/`receipt` renderer、`session`/`commandId` 等原字段保留；不为简写强制增加 `stdout` | 对照现行与新 runtime 回执；不能减少有效输出 |
| PTY 交互 | busy 拒新 cmd；旧 `input` action 移除，但 exact-byte 写入、可选 `commandId` 防 stale write、空串零字节、Ctrl-C/Ctrl-D line discipline、写入回执不伪称执行结果迁入 `exec` stdin-only | busy/prompt/取消/继续真实 PTY 场景 |
| PTY job | timeout、显式 handoff、现有 `run_in_background:true` 共用官方 jobs；`job_output` 增量、`job_kill` 取消，Ctrl-C 后结算与 shell 存活；活动命令身份不丢 | 见 Task C 的精确 cursor 与竞态矩阵 |
| PTY 会话 | `pty:<id|label>` 选择、BYO PTY、`close.force` 忙碌保护；15 分钟 TTL、过期/失联/reconnect notice、关闭幂等性。只删除旧显式 machine `:pty` 创建语法 | 旧非废弃调用回归 + 新 default/handoff |
| oneshot | stdout/stderr 分流、verbatim exit、startup stdin、shell 无状态、后台 job、timeout/cancel 与进程组清理；MUX 只复用 SSH 底层连接 | 现有 SSH/Docker/Incus/Hub 实际执行 |
| 传输/身份 | SSH、Docker、Incus、Hub 可选；Hub pairing 每次校验且无 SSH fallback；BYO SSH/PTY、label/裸名/Agent-local、密钥仅本地引用 | 现有 target/add/status 及 Hub 行为回归 |
| Roster（用户重点点名） | `status {}` 当次读取本机 SSH config、Docker、Incus、Hub 列表；不拨号、不后台 watch、不维护全局 live 库存。结果合并进按 Agent session 分区的 label 表，只为名称稳定/撞名处理；BYO SSH/PTY、PTY label/session 不跨 Agent 泄露。裸名 miss 才按需刷新，`status {target}` 才按需探测 | 两 Agent 的 BYO 隔离；新建/删除容器下次扫描才反映；撞名/独立失败披露；无 target 不 SSH 拨号 |
| runner/留存 | helper 或 POSIX shim/Hub lease 真实 runner、cleanup/fallback；PTY 4M UTF-16 units/stream、Hub oneshot 4 MiB、`outputStats`/`truncated`/丢失披露、无 30K 返回窗 | 现有 output/runner 测试与真实回执 |
| 其他工具与交付 | `remote_transfer` copy/rsync/native 参数/两段 staging/验证与 cleanup 回执、BYO SSH 文件端点；Super remote 闭包与 provenance；`action` 分派、status 无拨号 roster、错误恢复提示 | 定向回归、整包 pair 验证 |

## 2. 实施顺序（评审通过后）

### Task A：基线盘点与实际 surface 对账

- [x] 用 LSP 查 `createRemoteTool`、`RemoteDriver.call`、`PtySession.dispatch`、`PtyPool`、`prepareRemoteInput`、`jobs.ts`、`sshArgv` / `sshCommandArgv` 的定义/引用/调用关系；用 AST 列举 `:pty`、`run_in_background`、`scriptPath`、ledger、output schema/render、所有 SSH oneshot/helper/cleanup 调用点与 `remote_transfer` 共用路径。核对上游官方 jobs 与 `defineTool` 入口及 dev3 同版本接口。工具不可用则记缺口。（2026-11-01 完成，见 [baseline-audit.md](baseline-audit.md) §0-3、§5；dev3 同版本核对归 Task F 前置）
- [x] 记录现行 model-visible catalog、description、输入/输出 schema、receipt/error text，以及 Go/No-go/Ensure 表中每项的实际实现位置和已有覆盖。特别沿 `tool.ts status` → `driver.roster` → `scanLocal`/`LabelPool.mergeScan` 核对当次扫描、Agent session key 与 BYO 隔离；不得把 per-Agent label 表误判成全局 live inventory。将最终 [surface-draft.md](surface-draft.md) 与**真实宿主投影**逐字段比对；当前根 object 是开放的，动作组合由 tool 运行时校验。（完成：baseline-audit.md §4-6；roster 链路与 per-Agent 分区核实无误）
- [x] 依据已确认裁决收紧输入参数矩阵：删除旧 `input` action 与 machine `:pty` 创建语法；把写入行为及 commandId guard 迁到 `exec` stdin-only；只保留现有 `run_in_background` 字段，不引入 `background`；`force` 保持原忙碌保护。其他旧字段/行为未经评审不得删除。（完成：baseline-audit.md §6 定稿 Task D 落实清单）
### Task B：默认 PTY、handoff、quota

- [x] 在 `driver.ts` / PTY pool 中建立 Agent+规范化 machine 默认槽，懒建、复用、TTL；machine close 只动此槽，oneshot 完全隔离。保持 BYO 与已有 addressable PTY 解析。（2026-11-01 完成：`defaultSlots` 登记表 + `machineSlotSpec`/`defaultSlot` 归一懒建，dispose/TTL 悬空登记惰性清理；测试 default-pty.spec 12 用例）
- [x] 以**移动同一会话引用**实现 fresh/idle/busy handoff；只把默认槽解绑并注册为 `pty:<id>`，不重启、不复制输出流。新 machine exec 才新建 shell；完成/移交竞态只产生一个归属。（完成：`driver.handoff` 纯解绑；fresh = createSession + warm 创建后隔离，不可达如实报错不残留；busy 附 commandId/jobId，竞态单一归属由 dispatch 同步占位保证）
- [x] 落实已裁决配额（2026-11-01）：`REMOTE_PTY_SESSION_LIMIT` 10 → 30，每 Agent session 全局，默认/handoff/BYO 全计入。超限在不可逆动作前报错：透明说明已达 agent session 全局上限，列出或引导查看 active session，由模型自行 close/kill/复用/oneshot；不预先在 surface 披露上限；roster/status 展示全部 active session；不静默回收活跃会话。（完成 + 新错误文案 + `default on <machine>` roster 标注 + status 默认槽行）
- [x] 检查 Hub 配对复验、alias 规范化、Agent 隔离、TTL 与 reconnect；普通重复 SSH exec 应复用已建立连接。默认 PTY 与 handoff 的 roster 状态应只出现在所属 Agent 的结果中，不改变原有现场扫描触发点。（完成：hub 槽每次经 ptyEndpoint 重验；bare/前缀同槽归一测试覆盖；per-Agent 隔离测试覆盖；默认槽即同一 SSH 会话进程复用；roster defaultMarks 按 sessionKey 分区）

### Task C：job handoff 与准确增量回显（高优先级）

- [x] 先审计 `pty-session.ts` ring 的 UTF-8 **byte cursor**、nonce parser、当前命令快照和 `jobs.ts` output source/adoption 的首次 `read(fromByte)` 起点；记录当前行为，不猜测。（完成：baseline-audit.md §3——ring 每命令一建，「先前命令不被重放」结构上已成立；上游 `dsh-jobs` 契约首读从 0。）job admission 在命令不可逆启动前可用。
- [x] 衔接点语义定稿（三轮裁决，2026-11-01）：**不做字节偏移适配层**——`job_output` 沿宿主原生从 0 首读当前命令完整流；快照后到 job 注册前的新字节留在**同一** ring，自然包含在首读内；与 handoff 前同步回执的重复是接受的已知冗余，须在 surface/消费者文档如实披露；不得引入字符串去重。显式 handoff、PTY `run_in_background`、timeout 三路共用此原生语义，唯一要求仍是：同一 ring、同一 parser、完成/移交竞态只产生一个 job 归属。
- [x] 用真实 PTY 验证：①超时自动 handoff；②busy 时显式 handoff；③默认 PTY `run_in_background:true` 提交长命令即刻 handoff；④已寻址 PTY 后台执行不换 session；⑤快照与 adoption 之间插入输出（首读完整包含，不遗漏）；⑥UTF-8 多字节和 ANSI/回显；⑦ring 淘汰及丢失披露；⑧命令恰在 handoff 前/后完成；⑨同步 exec 与外部 handoff 并发；⑩同一 PTY 先前多条命令不被重放；⑪`job_output` 首读=当前命令完整流（与 handoff 前回执的重复属已裁决接受的冗余），后续轮询按 cursor 连续无重复/缺口；⑫`job_kill`/`close.force` 只作用于绑定命令，后续命令不受误写/误杀。（2026-11-01 单测层完成：default-pty.spec 14 用例 + jobs.spec 9 用例覆盖 ①②③④⑧⑨⑩⑫ 与 ⑪ 的消费制连续读；⑥⑦ 由现有 pty-session/output-ring 回归承载；⑤ 结构性成立（同 ring 首读从 0）；dev3 真机 12 项终验归 Task F）
- [x] 保留 PTY 同步返回结果和 timeout 的现有解析/回执信息量。不同机器、oneshot 与已隔离 PTY 可并行；忙碌默认 PTY 的新 cmd 仍拒绝，stdin-only 可写入当前交互命令并保留 stale-write 防护决策。（2026-11-01 随 Task B/C/D 全部完成并测试覆盖）

### Task D：参数、script、status、ledger、错误

- [x] 在 `tool.ts` 增加审定的 action/字段和 action-specific 校验：`cmd`/`scriptPath` 互斥；PTY 可 stdin-only；oneshot stdin-only 拒绝；PTY/oneshot 的命令或脚本可用现有 `run_in_background:true`（其说明含 went-async + completion notification 表述，三轮裁决），raw write 不可后台；`close` 只收 target（machine/pty）不收 job 定位（取消命令统一官方 `job_kill`，传 job 字段明确拒绝），按 target 关 busy PTY 只有 `force:true` 才允许。旧 `input` action 不再注册；不存在新 `background` 参数。（2026-11-01 完成：handoff action 注册、ACTION_PARAMS exec+commandId+mode、schema mode/commandId 新 desc、description 全面重写并通过 tool.spec 教学断言）
- [x] `scriptPath` 在本地读验后才连接目标；脚本载体与业务 stdin 分离，PTY Bash 子进程不能改父 shell cwd/env；覆盖 SSH/Docker/Incus/Hub，包括 Hub inline cmd 4096 限制与长脚本。失败不得执行部分脚本；取消和失联时如实披露 cleanup。（完成：input.ts 校验放开（PTY 允许、stdin 拼接随行）、mode 透传不再强制 oneshot；hub 4096 与长脚本用例回归绿；PTY 子进程语义由 wrapPtyCommand 既有机制承载）
- [x] 新 `exec` stdin-only 走既有 exact-byte PTY 写入核心，不创建命令帧、不伪造 exit/cwd/envDelta；支持可选 `commandId` 拒绝 stale write。旧 `input` action 和显式 machine `:pty` 创建不做向前兼容。（完成：driver.input 扩展 machine 默认槽寻址（无槽不懒建、如实报错）；tool 层 raw-write 分支复用 `input` result kind；`:pty` 语法在 target.ts 删除并给出指向 default/handoff 的 E_TARGET_FORMAT 教学）
- [x] 删除**仅历史** ledger 的存储与 status 展示；status 仍显示当前活动命令、cwd、连接、TTL 和默认/handoff 状态。保持无 target roster 的按需本机扫描与按 Agent label 分区，禁止新增全局常驻机器库存、启动快照、后台轮询或跨 Agent BYO 共享。更新受影响的模型可见错误提示与消费者文档，不重写其他 remote/transfer 文案。（完成：pty-session ledger 全删、attachJob 改 activeCommand、cardReceipt 活动命令行、E_SESSION_BUSY/E_NO_SESSION 文案更新、Hub 附加段重写、remote-tools.md 同步）
- [x] 让 tool description、参数、输出 schema、render、示例与审定 surface 一致；保留现有全部 result 字段与结果解析，`handoff` 只添加最小必要输出字段。（完成：kind enum +handoff、renderValue 早退路径、示例回执与 renderValue 逐字段对齐并被 tool.spec 锁定）

### Task E：SSH oneshot MUX（只改执行链）

- [x] 核对 `sshArgv` / `sshCommandArgv` 与 `buildOneShotArgv`、helper 的 probe/upload/run/killgroup、取消后的 cleanup SSH 和按需 status probe 的调用关系。共享身份组装逻辑继续读取本机 ssh config 与 BYO 字段；只在 SSH oneshot 路径注入工具自有 MUX 选项，不修改用户 config 文件，也不波及 PTY、scp/rsync/relay。（完成：新模块 `ssh-mux.ts` `SshMux.argvFor` 经 `extraArgs` 注入——buildOneShotArgv/buildHelper{Probe,Upload,OneShot,Killgroup}Argv/helperShellArgv 增可选 `muxArgv`；driver `muxArgvFor`（仅 ssh plan，身份 = 原始 target + host/user/port/key/ProxyJump）贯穿 nativeProcess 两条 lane（helper+shim）与两条 cleanup killer、status `probeTarget(muxArgvFor)`；PTY `buildPtyArgv`、copy 的 mkdir pre-hop（helperShellArgv 默认形）、rsync/scp/relay 零改动；HelperRegistry.ensure 透传 muxArgv）
- [x] 在实际 SSH argv 中显式加入 OpenSSH `ControlMaster=auto`、`ControlPath=<tool-owned private socket>`、有限的 `ControlPersist=<duration>`。socket 目录需 0700，路径满足 Unix socket 长度，按 Agent 与有效连接身份隔离，至少区分原始 target/host/user/port/key/ProxyJump；同一身份重复调用共用 master，跨身份不能串用。实施前确认**发起端** OpenSSH client 版本与实际行为；CLI MUX 选项会覆盖用户 config 对同名选项的值，其他身份选项照常读取。（完成：发起端 OpenSSH 10.2p1 实测（探针 2026-11-01）——首连 ~80ms 建 master、复用 ~6ms（约 13×）、并发 5 路同 master 全成、master fork 后 PPID=init 自成会话组（客户端组杀免疫）、master 被 SIGKILL 留残 socket 且下个客户端自愈、`-O exit` 干净拆除、persist 到期 master 自删 socket；目录 `superd-mux-<owner8>` 0700 懒建（每 driver = 每 Agent 一个 SshMux，`agent-registration` 每 Agent 一 driver），socket 名 = 身份 sha256 前 16 hex，路径 >104 字节或目录不可建诚实退化不注入；`ControlPersist=600`；`-o` 选项后置于 BatchMode/identity，last-option-wins 只覆盖同名项）
- [x] 设计 master 空闲到期与 Agent teardown 清理；首连失败或 socket 不可用时按 SSH 真实失败/回退语义返回，不冒充复用成功。重复 one-shot 应省去额外握手与认证；每条命令仍有独立 shell/fd/exit、stdin 和远端进程组。原有 `BatchMode=yes`、超时、取消及 cleanup SSH 均须有效。（完成：到期 = ControlPersist 600s 自退（实测 T7）；teardown = driver dispose 在进程排干后 `ssh -O exit` 逐 socket + 删目录；**关键实测发现并修复**：mux master 经 fd-passing 持有被杀客户端的会话 fd 到远端会话结束，cleanup killer 若等本地 close 后发射即死锁——process.ts 新增 `onCancel` 钩子（取消时刻同步回调，至多一次），driver 两条 lane 的远端 killer 改为取消即发 + done.then 兜底；每命令独立 session channel/shell/fd/exit 不变，stdin 逐命令透传，BatchMode/timeout/cancel 语义保持，ssh-process.spec 既有 6 用例原样通过）
- [x] 验证首次连接、第二次复用、并发 oneshot、不同 BYO key/跳板不共 master、socket 权限、有限 idle 到期、客户端取消后远端清理、config Host alias/IdentityFile 继续生效。固定 config 在调用期间不变是本次前提；若中途修改 config，新命令可能沿用存活 master 的旧身份，需在报告中如实披露。（完成：新增 `test/remote/ssh-mux.spec.ts` 9 用例——单测锁 argv 形状/身份键 7 维分离/0700 目录/dispose `-O exit`+删目录/超长路径退化/builders 注入面（PTY 与 helperShellArgv 默认形无 MUX）；真实 sshd 夹具锁首连-复用（1 socket + `-O check` Master running）、并发 3 路、超时取消后 master 存活且后续 oneshot 复用、status 探测同链复用、harness dispose 后目录清空、双 BYO 身份 2 socket 不串、同 driver PTY argv 零 MUX、SIGKILL master 残 socket 自愈、config alias `fixture-native`（HostName/Port/IdentityFile 全经 -F config 解析）与 MUX 并存复用；idle 到期与 socket 文件权限由探针 T7/目录纪律覆盖并记入 spec §7.3；config 中途变更的沿用效应按前提披露，Task F 报告重申）

### Task F：交付形态验收与报告

- [x] 先运行与变更风险直接相关的 parser、PTY/job、transport、tool schema 和 transfer 回归；复核 Go/No-go/Ensure 表。测试使用真实 PTY 与相应安全夹具；killgroup 信号语义仅在容器/VM，禁止宿主 UID sweep。（完成：remote 全量 33 文件 / 270 pass / 8 skip / 0 fail，含 source/better/super 三交付变体；tsc 零错；Go/No-go/Ensure 对照见 spec §2/§6 与验收报告 §4）
- [x] 按仓库既有 launcher/pack 路径清理旧产物、构建同步版本的 Better/Super tarball、核对 remote 闭包/provenance，走 4999 Web 测试线与 dev3 目标机实装。不能以源码树绿灯、boot 或进程存活代替真实模型第一人称行为验收。（完成：0.3.3-b 同步双 tarball cb1935b0…/ca358b80…；PC 4999 launcher 全链 + companion spec 升级；dev3 4998 经 pack 传输 + read-pack-pair 核验 + 独立测试锚安装；双 rig 安装态叶哈希逐字节一致 323e74f1…/cd209e74…，boot 零 import 失败；第一人称见下一项）
- [x] 在每个受影响 runtime 做 create/prompt/resume，并由模型实际调用全部场景。（完成：PC 4999 真实模型会话 A×3 轮 + B×1，dev3 4998×2 轮；spec §8 场景全闭环——默认 PTY 状态保留/fresh·busy handoff（超时置忙路径）/机器默认 run_in_background 同操作 handoff + 完成通知实际送达/went-async schema 逐字引述/job_output 从 0 首读/busy stdin-only GOT:x/y/oneshot 隔离/script+stdin/BYO `~` 展开/status·close.force/E_SESSION_BUSY→job_kill→close/配额 30 触顶与恢复/两 Agent roster·BYO·label 隔离（B 5/5）/外部新建容器下轮 roster 出现/roster 即时无拨号/MUX 复用宿主侧 socket+master 证据（两 Agent 各自目录、同身份对各自 master）；模型上报 4 处清单分歧均定性非回归；既有 PTY 回执字段（cwd/envDelta/idle-left/exit/duration）无下降）
- [x] 报告落 `docs/test-reports/2026-11-01-remote-default-pty.md`（版本/哈希链/schema 对账/第一人称证据表/4 处分歧定性/披露/收线指令）；4999（test.pc.internal.test）与 dev3 4998 保持运行供 user 验收；未 publish、未 commit/tag/push（待放行）；生产树全程未触碰。

## 3. 实施审查准则

实施 PR 若改了 Go 表之外的公开行为，必须给出事先评审过的 surface 差异；若删除了 Ensure 表中的任何能力，不能以“说明更简短”为理由通过。尤其禁止：把 PTY 结果解析简化成原始 terminal 文本、丢失 exit/cwd/envDelta 或 stderr/echo 信息、让 job 查询重复/遗漏输出、用历史 ledger 代替活动命令状态、从旧会话重放输出、把按需 per-Agent roster 改成全局 live inventory 或让 BYO 跨 Agent 可见、绕过真实包投影验收。

状态：spec 已提升为正本（docs/specs/remote-default-pty/spec.md）；Task A–F 全部完成——实现（B–E）+ 交付形态与模型第一人称验收（F，[2026-11-01-remote-default-pty.md](../test-reports/2026-11-01-remote-default-pty.md)）；publish 与 git 定版待 user 放行。
