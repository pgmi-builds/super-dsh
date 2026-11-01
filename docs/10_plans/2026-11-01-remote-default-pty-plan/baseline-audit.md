# Task A 基线盘点与 surface 对账（2026-11-01）

> Remote Default PTY（spec：[docs/specs/remote-default-pty/spec.md](../../../specs/remote-default-pty/spec.md)）Task A 产出。证据来自当日源码通读 + LSP/AST 实查；行号对应当前工作树。测试与 dev3 实装核对按 plan Task F 执行。

## 0. 方法与工具（均实际使用，无缺口）

- **LSP**：typescript-language-server（dvc://lsp 网关，gate `unasked` 但 definition/references 正常返回）。`parseTargetForm`（target.ts:42）与 `preparePtyLane`（driver.ts:577）引用查询完成。
- **AST**：ast-grep（dvc://ast_grep）。ledger 读写、`parseTargetForm`/`sshCommandArgv`/`adoptRunningPtyJob`/`startRemoteJob` 调用点模式枚举完成（注意：`obj.method($$$)` 形式不匹配 member call，用 identifier 模式补齐）。
- 源码：tool.ts / driver.ts / pty-session.ts / jobs.ts / labels.ts / ssh-argv.ts 全读；roster.ts / status.ts / output-ring.ts / target.ts 关键段。
- 上游：本机 runtime checkout `@deepseek-ai/dsh`（`/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/`）内 dsh-jobs 类型已核对；better-dsh peer 范围 `>=0.2.2-0 <1.0.0-0`。**dev3 同版本接口核对未做**（需目标机），归入 Task F 前置。

## 1. 关键调用关系（现行）

| 符号 | 定义 | 引用/调用点 |
| --- | --- | --- |
| `createRemoteTool` | tool.ts:207 | plugin 注册处（每 Agent 一实例，`getSessionKey` 默认 `agent.id`） |
| `RemoteDriver.call` | driver.ts:136 | tool.ts exec/add；内部 `prepareRemoteInput` → `validate` → `execute` |
| `PtySession.dispatch` | pty-session.ts:171 | driver.dispatchPty（driver.ts:676）唯一入口；同步占位 busy（`activeCommand`）|
| `PtyPool` | driver.ts 内 `this.pool` | key 形如 `<sessionKey>|p:<id>`；`create/get/list/inspect/disposeAll` |
| `prepareRemoteInput` | （input.ts 内） | driver.call:139、driver.startPrepared:354、preparePtyLane:579 —— scriptPath 本地读取在此层 |
| `startRemoteJob` / `adoptRunningPtyJob` | jobs.ts:27 / jobs.ts:81 | tool.ts:257（run_in_background）/ tool.ts:280（timeout 收养） |
| `preparePtyLane` | driver.ts:577 | **仅 tool.ts:254**（background 前占位；registry 拒绝时 cleanup 拆新建会话） |
| `parseTargetForm` | target.ts:42 | driver.ts ×7（142/305/334/582/642/782/822）+ jobs.ts:29（LSP 确认闭环） |
| `sshIdentityArgv`/`sshCommandArgv` | ssh-argv.ts:43/55 | ssh-targets.ts:62（exec/probe，base 含 BatchMode）、rsync.ts:97（`-e` rsh）、ssh-rsync-native-relay.ts:47；identity 另供 scp dialect |
| `driver.input` | driver.ts:639 | tool.ts input action；拒绝 machine/创建形，绝不拨号 |

## 2. ledger 全部读写点（AST 枚举，删除前逐一处置）

| 位置 | 性质 | 处置 |
| --- | --- | --- |
| pty-session.ts:79-80 `LedgerEntry`/`LEDGER_MAX=20` | 类型+常量 | 删（类型仅剩 activeCommand 所需字段可内联） |
| pty-session.ts:113 `private ledger` | 存储 | 删 |
| pty-session.ts:142 `attachJob` 内 reverse-find | **现行命令状态路径**（timeout 收养回填 jobId） | 改走 `activeCommand`（attachJob 同函数 143 行已同时写 activeCommand） |
| pty-session.ts:183-184 push/shift | 写 | 删（push 时机 = dispatch 同步占位，与 activeCommand 同点） |
| pty-session.ts:195-196 abandon splice | 写（失败撤销） | 删（activeCommand 同步置 null） |
| pty-session.ts:153 `ledgerSnapshot()` | 读 | 删 |
| pty-session.ts:259-261 settle 更新 entry.exit/duration | 写 | 删（结果经 PtyJobResult/回执已有） |
| driver.ts:707/717 session card `renderLedger(ledgerSnapshot())` | 读（展示） | 删；card 保留 connection/state/cwd/TTL/活动命令 |
| status.ts:84-89 `renderLedger` | 渲染 | 删 |
| tool.ts:67（description "ledger of the last 20 commands"）、tool.ts:342（commandId desc "ledger key"）、tool.ts:362（Hub 附加段 "ledger"） | 模型可见文案 | Task D 重写 |

**结论**：无增量输出 cursor 依赖 ledger；唯一非展示依赖是 attachJob（→ activeCommand）。计划预设成立。

## 3. jobs 输出通道与「首读从 0」契约（Task C 输入）

- 上游 `dsh-jobs/lib/types/types.d.ts:99-107`：`JobOutputSource.read(fromByte)`，注释明确 **"a prior read's `nextOffset`; 0 first"** —— 宿主首次读取从 0 开始。
- jobs.ts:14 `ptyOutputSources`：`read: fromByte => holder.job?.read(fromByte)`；`adoptRunningPtyJob`（timeout 收养）直接包 running job → 首次 `job_output` 会重放同步回执已含的 `ring.text`（detach 时 resolve 的 output，pty-session.ts:225-231）。**三轮裁决（2026-11-01）：不做偏移修复**——保持宿主原生从 0 首读（当前命令完整边界），不改现有 read 通道、与其他 job registry 消费者一致；与同步回执的重复是接受的小冗余，surface/消费者文档如实披露；jobs.ts 输出通道零改动。
- ring 为**每命令一建**（pty-session.ts:212 `new Utf16TailRing(OUTPUT_HARD_CAP)`），累计 UTF-8 byte cursor；「先前多条命令不被重放」结构上已成立。
- 三路 handoff 现状：timeout=detach()（pty-session.ts:219-231）；`run_in_background`=dispatch `{background:true, jobId}` + tool.ts preparePtyLane 占位；显式 handoff=**新 action，无现实现**。run_in_background 路径 output source 从 job 注册即持有 holder，首读从 0 且模型从未见过同步快照——**无重放问题**；需统一的是 timeout 收养与显式 handoff（busy 快照回执）两路。

## 4. 现行 model-visible surface（对账基线）

- **action 集**：`exec/add/status/close/input`（tool.ts ACTION_PARAMS:95）；`handoff`、`mode` 不存在。
- **输入 schema**（tool.ts:325-352）：action/target/cmd/stdin/commandId/timeout/run_in_background/ssh/spawn/force；`scriptPath` 在 exec set 但**仅 oneshot**（tool.ts:214-218：pty target 拒、与 cmd 互斥、与 stdin 互斥）。
- **输出 schema**（tool.ts:327-368）：kind enum `exec|status|roster|job|close|input`；字段与 surface-draft §输出 基本一致，但 `receipt`/`outputStats` 注册为 `type:'json'`（draft 转写作 `{}`）；`commandId` desc 为 "ledger key"（须改）。
- **渲染**（renderValue:375）：session/label/byoTag → conn → cmd → cwd → env → idle-left → runner → interrupted → exit → secs → still-running → truncated/stats → [stderr]；posix-shim 失败尾注。
- **Hub 附加段**（tool.ts:362）：提及 input、ledger、`:pty` 创建 —— 全部需重写。
- **错误文案受影响清单**（教学面随 No-go 更新）：E_SESSION_BUSY（pty-session.ts:167 提及 input action）、resolvePty E_NO_SESSION（driver.ts:583 教 `:pty` 创建）、E_SESSION_LIMIT（driver.ts:515 "limit 10"、close 语法）、input 相关全部文案（tool.ts/driver.ts:639-693）、startPrepared "background oneshot takes a machine target"（jobs 分流改变后语义变化）。
- **示例**：REMOTE_TOOL_DESCRIPTION 内嵌 BYO PTY + 后台 + job_output 流程（保留）；`docs/remote-tools.md`（消费者文档）多处教授 `:pty`/`input`/"no mode field"/"at most 10 live sessions" —— Task D 一并更新。

## 5. Go/No-go/Ensure → 现行实现位置摘要

| 项 | 现行实现 |
| --- | --- |
| machine exec 分发 | driver.execute:186-260：hub oneshot → createPtyLane（spawn/ssh-BYO/native `:pty`/hub-pty）→ BYO ssh 注册 → pty-selector 复用 → direct/bare oneshot。**默认 PTY 需在此为 direct/bare/hub 增加默认槽分流，`mode:"oneshot"` 走现路** |
| 配额 | driver.createSession:507-516：`REMOTE_PTY_SESSION_LIMIT=10`（driver.ts:99），live（非 dead）计数，含 listing。**改 30 + 文案按裁决重写** |
| TTL | `ptyIdleTtlSec`（15min）+ `ptyTtl()` 快照回执；运行中豁免 |
| close | driver.closePty:606-621：`detachedCommandId` 非空且非 force → E_SESSION_BUSY；幂等 not-found/already-closed-or-reaped；machine target 现不支持（tool.ts:169 直接当 pty selector 剥前缀）——**需加 machine → 默认槽语义** |
| roster/status | driver.roster:764-777（scanLocal 一次、mergeScan、零拨号）+ status:781-825（probe/会话列表/card）。LabelPool 每 session 注册表（labels.ts:60-160），first-mover-wins、迟到前缀、认领保留、miss 才刷新（resolvePoolEntry:457）——与 spec §6 边界一致 |
| SSH argv | ssh-argv.ts 单一 identity 组装；base 旗标在调用点（ssh-targets.ts:61 BatchMode、rsync.ts:97）。MUX 注入点 = oneshot 执行链各调用点 base/extra，**不触** PTY（buildPtyArgv）、scp/rsync/relay |
| remote_transfer 共用 | driver.resolveConnectionTarget:865-881（拒 pty/hub/create-pty 形态）——`:pty` 语法移除后 create-pty 分支删除，其余不动 |
| 环境识别 | `builtOn`（BYO ssh 之上建 PTY）标记保留 |

## 6. surface-draft ↔ 现行投影差异（Task D 落实清单）

1. 新增 `handoff` action（action/enum/description、ACTION_PARAMS、ACTION_HINT、错误路径）。
2. 新增 `mode` 参数（exec set；enum `pty|oneshot`，default pty；`pty:<id>` 目标拒绝该字段或忽略——**按 spec §5 开放 object + 运行时校验**，定稿：addressable PTY target 上 mode 视为冗余但合法，值为 `oneshot` 时报错）。
3. `stdin` 语义扩展：PTY 无 cmd/scriptPath = raw write（复用 driver.input 核心 + `input` result kind 回执）；`scriptPath`+`stdin` 组合放开（现 tool.ts:217-218 两处互斥拒绝删除，oneshot 侧同步放行）。
4. `commandId` desc 去 "ledger key"；`input` action 参数集/action 枚举/错误清单移除；`kind` enum 增 `handoff`。
5. 配额：**任何 surface 不出现 30**；E_SESSION_LIMIT 文案改为「agent session 全局上限 + 列出 live + 自行 close/kill/复用/oneshot」。
6. roster 行已更新（spec §5 底稿）；示例中 `~/.ssh/id_key4` 路径展开核对现有 key 规则（ssh-config.ts normalizeSshConnection —— 现行要求本地文件路径引用，实施时验证 `~` 展开行为并如实记录）。
7. Hub 附加段、E_NO_SESSION/E_SESSION_BUSY/BUSY 教学路径改为 default/handoff 语义。
8. `run_in_background` 说明补 **went-async + completion notification** 表述（三轮裁决）：本质 = 命令转 async（oneshot / 默认 PTY handoff / 已寻址 PTY 三路同义，非 bash `&`），立即返回 job 且**完成会主动通知**（无需轮询，宿主 jobs 服务确实主动推送——现行回执 "completion is reported by the host" 即其机制）；`job_output` 首读从当前命令起点读完整流（与 handoff 前回执重复属预期）；`job_kill` 取消。
9. **close 不收 job 定位**（三轮补充裁决）：schema 删除 `job` 字段；取消运行中命令唯一入口 = 官方 `job_kill`；close 只收 target（machine=默认槽 / `pty:<id|label>`），`close.force` 保留杀命令+关 shell 一步语义。

## 7. 受影响文件清单（实施面）

- 源码：tool.ts、driver.ts、pty-session.ts、jobs.ts、target.ts（删 create-pty/hub-pty 形态或改解析）、labels.ts（默认槽注册策略）、status.ts、input.ts（stdin-only 核心）、ssh-argv.ts/ssh-targets.ts/oneshot 相关（MUX）。
- 测试（better-dsh/test/remote/）：input.spec.ts、pty-input.spec.ts、pty-session.spec.ts（ledger 断言）、jobs.spec.ts、tool.spec.ts、status.spec.ts、target.spec.ts、driver.spec.ts、ssh-jobs-cleanup.spec.ts + 新增 default-pty/handoff/quota/mux 用例。
- 文档：docs/remote-tools.md；REMOTE_TOOL_DESCRIPTION 本体。

## 8. 结论

plan §1 矩阵与源码事实全部对上；无发现需要回写 spec 的矛盾。二/三轮裁决（30 全局 / fresh 创建后隔离 / 首读保持宿主原生从 0——不做偏移 / went-async + 完成通知文案 / close 不收 job 定位）实施路径明确：jobs.ts 输出通道零改动，配额落 driver.ts:99+515，fresh handoff 复用 createSession + warm()（pty-session.ts:163「会话已就绪必须是真的」语义不变），`run_in_background` surface 说明补 went-async + completion notification，close 分支删 job 参数并明确拒绝教学。
