# Remote Default PTY 规格（已批准）

> **规范正本。** 2026-11-01 user 三轮裁决（含补充）后批准（提升自 `docs/10_plans/2026-11-01-remote-default-pty-plan/`，该目录三份文档保留为评审过程记录）。实施计划：[plan.md](../../10_plans/2026-11-01-remote-default-pty-plan/plan.md)（Task A–F）。实现以本文 + plan 的 Go/No-go/Ensure 差异清单为准；实现发现限制先回写本文、再评审。冲突时以本文为准。

## 1. 产品形态（目标差异）

唯一可编辑 canonical 源：`better-dsh/src/remote/`；Super 仅经现有构建生成 remote 窄闭包。

| 领域 | 规范行为 |
| --- | --- |
| `exec` | machine target 默认使用每 Agent、每规范化 machine 的懒建可复用默认 PTY（保留 cwd/env/交互状态）；`mode:"oneshot"` 显式走现有 stateless lane，不读写默认 PTY |
| `handoff` | 新 action：fresh/idle/busy 任何状态下把默认 PTY 隔离为 `pty:<id>`——以**移动同一会话引用**实现，不重启、不复制输出流；busy 同时返回当前 jobId 与已产生输出快照；machine 下次 exec 按需建新默认 PTY |
| fresh handoff | 尚无默认 PTY 时后台**创建空闲 shell 再隔离**（思维模型：默认 PTY 恒 ready，创建时机是实现细节）；目标不可达时的错误回执实施内核实 |
| 输入 | PTY `exec` 仅 `stdin` 无 `cmd`/`scriptPath` 时原样写入当前 PTY（exact-byte、空串零字节、可选 `commandId` stale-write guard），不创建命令帧、不伪造 exit/cwd/envDelta |
| 后台/超时 | 只用现有 `run_in_background:true`（不新增 `background`）。其语义 = 命令 **went async**（不是 bash 的 `&`）且**完成会主动通知**：oneshot、默认 PTY handoff、已寻址 PTY 命令三路本质都是转 async 执行并立即返回 job——此双层表述必须出现在模型可见 surface（见 §4 三轮-2/3）。默认 PTY 后台 = 提交 framed cmd 的同一操作内立即 handoff；已寻址 PTY 后台保留 session；oneshot 后台不变。PTY timeout 仍是同步等待期限 |
| `scriptPath` | 本地绝对路径连接前读取；PTY 与 oneshot 均可；可与业务 `stdin` 共用（载体与 stdin 分离）；PTY 中为子进程，不改父 shell cwd/env |
| SSH oneshot MUX | 工具发起的 SSH oneshot 执行链（含 helper probe/upload/run/killgroup、取消 cleanup、按需 status 短探测）显式 `ControlMaster=auto` + 工具自有 `ControlPath` + 有限 `ControlPersist`；每命令 shell/fd/exit 仍隔离 |
| `close` | 只收 target：machine target 关默认 PTY；`pty:<id|label>` 关对应 shell。**不收 job 定位**——取消运行中命令的唯一入口是官方 `job_kill`。忙碌 shell 无 `force:true` 拒绝关闭；`close.force` = 杀命令+关 shell 一步 |
| `status` | machine/BYO/默认 PTY/handoff PTY 即时状态；无 target = 按需本机扫描 roster，不拨号 |
| 生命周期 | 15 分钟 idle TTL（运行中豁免）；配额见 §4 |

machine key 统一 `ssh:<name>` 与无歧义裸名，避免同机双默认 shell；Agent 间彼此隔离；Hub 每次访问沿用 pairing/authorization 检查。

## 2. 移除项（No-go）

- 旧 `input` action 及其参数/教学入口，不做向前兼容；能力迁入 `exec` stdin-only。
- 旧 `<machine>:pty[:label]` 显式创建语法（含 `hub:<m4>:pty`，即 `parseTargetForm` 的 `create-pty`/`hub-pty` 形态）及相关教学入口；BYO `add {spawn}` 与 `pty:<id|label>` 寻址保留。
- `close` 的 job 定位（`close {job}` / `job` 字段）：与官方 `job_kill` 完全重叠，双入口违背「action 是唯一派发维度」；从 surface、schema 与计划中删除，传入 job 字段明确拒绝并指向 `job_kill`。
- 历史最后 20 条命令 ledger（存储、status/card 展示、专属测试与说明）。**现行命令状态不在移除之列**：每条活动命令的 ID、nonce 边界、parser、output ring、job 绑定、结果回执全保留；`attachJob` 等经 ledger 查找现行命令的路径改走 `activeCommand`。删除前用 AST 枚举全部 ledger 读写点逐一确认。
## 3. 保留基线（Ensure）

**全部保留是默认规则**：不在 §1/§2 清单内的现有 remote/remote_transfer 功能、结果字段、回执渲染、错误恢复提示与交付边界原样保留。有限高风险防误改清单见 [plan.md §1 Ensure 表](../../10_plans/2026-11-01-remote-default-pty-plan/plan.md)；实施报告须逐项标「未修改且现有证据有效」或「受影响并已实测」。

## 4. 已裁决决策

**一轮（2026-10-31，plan §0）**：旧 `input` 与显式 `:pty` 创建不需向前兼容；PTY 用原字段 `run_in_background:true` 做即时 handoff，不新增 `background`；`close.force` 保留忙碌保护；SSH oneshot 显式 MUX 配置。

**二轮（2026-11-01）**：

1. **配额**：每 Agent session **全局 30 个 active PTY session** 上限（跨 machine/connection/BYO 全部计入，默认 PTY 也算；由现有 `REMOTE_PTY_SESSION_LIMIT` 10 调整而来；per-machine 20 handoff 额度取消）。仅触达上限时报错：透明说明已达 agent session 全局上限，列出/引导查看 active session，由模型自行选择 close、kill、复用或 oneshot。**上限不预先出现在任何模型可见 surface**（instruction/schema/示例）。范围内全部 active session 必须在 roster/status 可见。15 分钟 idle TTL 原样保留，不向模型解释网络成本动机。
2. **fresh handoff**：创建空闲 shell 再隔离（见 §1）。

**三轮（2026-11-01，覆盖二轮第 3 条，含补充）**：

1. **job 首读起点：保持宿主原生从 0 读，不做任何偏移**。上游 job registry 的 `read(fromByte)` 契约即首读从 0；我们不改这一通道、不加「已发送前缀」字节偏移适配层——与所有借用 job registry 的工具调用形态一致，且保持**当前命令**输出边界的完整性。代价：handoff/timeout 之前同步回执已展示的字节，会在首次 `job_output` 重放一次——接受的小冗余，换简洁性。三路（timeout 收养、显式 handoff、`run_in_background`）统一为这一原生语义。
2. **`run_in_background` 的 surface 说明 = went-async + 完成通知双层表述**：①「the command went async」精确描述机制（本质是命令转 async 执行——oneshot、默认 PTY handoff、已寻址 PTY 命令三路同义——不是 bash 的 `&`，防语义误解）；②「completion notification will follow」释放模型心理负担——完成时宿主 jobs 服务**确实主动推送**（现行后台回执 "completion is reported by the host" 即其机制），承诺真实成立：不必定时轮询，可放下不管；`job_output`（从当前命令起点读完整流）与 `job_kill` 随需可用。
3. **close 不收 job 定位**：取消运行中命令的唯一入口是官方 `job_kill`（宿主 job registry 自带 job queue，oneshot/PTY 及一切 job 一致）；`close {job}` 与 `job_kill` 完全重叠、双入口违背「action 是唯一派发维度」且分裂教学。close 语义边界收敛为关 shell（machine = 默认槽，`pty:<id|label>` = 指定会话）；`close.force` 保留（杀命令 + 关 shell 一步）。传 job 字段明确拒绝并指向 `job_kill`。

## 5. Surface 契约

- 底稿：[surface-draft.md](../../10_plans/2026-11-01-remote-default-pty-plan/surface-draft.md)。Task A/D 以**真实宿主 `defineTool` 投影**逐字段对账后定稿。`handoff` output 最小增量（Task C/D 已定稿回写）：result kind `handoff` 早退渲染，字段 = session（+label）→ connection → cwd → created（fresh 预热形）→ running+commandId（busy 形，busy 时并带 job 追随指引）→ ttlSec；不带 exit/stdout/envDelta（无命令执行）；renderValue 与示例回执逐字段对齐并由 tool.spec 锁定。
- 宿主参数根为开放 object；跨 action 条件约束由工具运行时校验，不伪称顶层 discriminated union。
- 输出保全：从现行注册 output schema 与 renderer 出发，保留全部现有 result 字段与渲染行为；不为简写 rename `text`→`stdout` 或复制全文；`input` result kind 可复用于 `exec` stdin-only 写入回执。
- `run_in_background` 说明按 §4 三轮-2 写入双层表述（went async + completion notification will follow + job_output 从 0 读完整流）；首读与 handoff 前回执的重复属预期，如实呈现，不加去重机制。
- `close` 无 `job` 字段；取消命令的教学一律指向官方 `job_kill`。
- 移除项的教学、错误提示、schema 描述（`input` action、`:pty` 创建、ledger 措辞、Hub 附加描述等）随实现同步更新；除此之外不重写其他 remote/transfer 文案。

## 6. 关键不变量

- **handoff 三路统一**：nonce parser、output ring、累计 UTF-8 byte cursor、官方 job 身份随同一 PTY 移交；不新建 parser、不重跑命令、不从历史重拼输出；完成/移交竞态只产生一个归属和一个 job。`job_output` 按宿主原生从 0 读当前命令完整流（快照→job 注册之间的字节自然包含；与同步回执的重复已裁决接受，见 §4 三轮-1）。UTF-8 byte cursor 与 UTF-16 retention 长度不得混用；ring 淘汰沿用既有丢失披露；`job_kill` / `close.force` 只作用绑定命令。
- **roster 按需边界**：当次读取本机 SSH config/Docker/Incus/Hub 列表，不拨号、不后台 watch、无全局 live inventory；label 表按 Agent `sessionKey` 分区；BYO/PTY 不跨 Agent 泄露；裸名 miss 才现场刷新，`status {target}` 才按需探测。本 Agent 全部 active PTY session（默认+handoff+BYO）必须可见（§4）。
- **MUX 边界**：只作用于 SSH oneshot 执行链；socket 目录 0700、路径满足 Unix socket 长度、按 Agent × 有效连接身份（原始 target/host/user/port/key/ProxyJump）隔离；有限 `ControlPersist` + Agent teardown 清理；不改用户 ssh config，PTY/scp/rsync/relay 路径不变；MUX 失败按 SSH 真实语义回退，不冒充复用成功。前提：调用期间本机 SSH config 不变；中途变更的沿用效应在报告如实披露。
- **生产红线**：按根 AGENTS.md —— tarball + 4999 + dev3 真实验收、报告落 `docs/test-reports/`、npm publish 需本轮放行、不触碰生产。

## 7. 实施期核实项（非 user 裁决）

1. `handoff` output schema 最小增量与 busy `exec`/外部 handoff 竞态回执归属（Task C/D，定稿后回写 §5）。
2. fresh handoff 目标不可达错误回执（Task B 实测）。
3. MUX `ControlPersist` 时长与清理时机 —— 已定（Task E，发起端 OpenSSH 10.2p1 实测 2026-11-01）：`ControlPersist=600`；teardown = Agent dispose 逐 socket `ssh -O exit` 后删 socket 目录；master 与客户端进程组完全脱钩（客户端 killpg 取消不影响 master，后续 oneshot 继续复用）；master 被 SIGKILL 留下的残 socket 由 `ControlMaster=auto` 下一个客户端自愈重建；超长 socket 路径或目录不可建时诚实退化为普通连接（不注入选项）。关键实测发现：mux master 经 fd-passing 持有被杀客户端的会话 fd 到远端会话结束——远端清理 killer 必须在**取消时刻**发射（process `onCancel` 钩子），不能等本地 close 之后的 done（否则 close 等远端结束、远端结束等 killer，死锁）。
4. surface 示例中 `~/.ssh/...` key 路径展开与现有 key 规则核对（Task A）。
5. scriptPath 载体定稿（2026-11-01 独立复测 + 修复轮 0.3.3-c/d）：载体 = `bash -c '<script>'` 单条引号命令（argv 通道，与 cmd 同一纪律；NUL 拒绝 `E_SCRIPT_NUL`），业务 stdin 整体归脚本 fd0；PTY 中为普通子进程命令（结算、不泄漏父 shell）。hub oneshot 的 4096 上限随之约束 scriptPath（如实标注）。**已知缺陷（未根治，surface 已披露）**：rig 上 `run_in_background` + startup stdin 概率性丢失（bg lane；stdin-only 补写可靠）——详见 docs/test-reports/2026-11-01-remote-default-pty-c-d-fix-round.md §3。

## 8. 验收

按 plan Task F：定向回归 → 清理重建同步版本 tarball → 4999 Web 线 + dev3 实装 → 受影响 runtime create/prompt/resume 模型第一人称验收（含 §4 配额、fresh handoff、三路 handoff 原生从 0 首读、went-async + 完成通知双层表述、close 无 job 定位、MUX 复用与隔离、roster 全可见与 Agent 隔离）→ 报告与放行流程按根 AGENTS.md。
