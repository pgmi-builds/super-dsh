# PTY 交互增强计划：把 PTY 调成 oneshot 的形状（stateful oneshot）

Living doc：随讨论逐步补充。**本计划的核心是工具设计与顶层思想；rationale 与 surface
本身是产品交付物**（user 2026-10-18 裁决 R4）。可行性与代码实现居次。

## 背景：第一人称 findings（2026-10-18 讨论）

**现象**：DSH Web UI 事件流观察（含 tool call 与 thinking 披露）显示，模型几乎总是选
oneshot，即使同一 target（dev2/dev3/dev4）连续 10+ 次调用，也不开 PTY——除非任务本身
就是测 PTY。4999 测试 session 与 PC production session 均如此。

**模型第一人称的机制拆解**（五个原因，按权重排序）：

1. **决策单位形状对齐**：模型的工作循环是"决策 → 一个 tool call → 一个干净观察"。
   oneshot 与之 1:1 映射：stdout/stderr 分离、exit code 精确原样、结果封闭成帧。PTY
   的观察是"脏"的：流合并、命令回显、提示符、`\r\n`、增量 delta，每步都要额外解析，
   exit code 还得自己记得 `echo $?`。
2. **状态放哪**：模型强项是把状态持在 context；端点上的 shell 状态（cwd/env）是隐性
   依赖。oneshot 每次全限定命令，每步是可重放 checkpoint，compaction/恢复无损。PTY
   状态在端点，对模型不可见——**服务端持久化 ≠ 模型可见**（"黑洞"问题）。
3. **TTL 与思考节奏错配**：600s idle 对动辄数分钟到十几分钟的思考间隙太短；状态蒸发
   且模型未必知道，PTY 因此从效率项变成风险项。
4. **训练先验**：业界 agent 工具几乎清一色无状态 per-call shell；训练语料里远程执行
   绝大多数是 `ssh host 'cmd'`。持久交互终端是 human admin 模式（tmux 式），非 agent
   模式。一句话：**oneshot 是 agent-native，PTY 是 human-native**。
5. **Surface 叙事归类**：现描述里 pty 的叙事是 "persistent shell"，被模型归类为
   "给需要 tty 的程序用"（docker exec -it、TUI），而非"多步任务的效率选项"；描述中
   没有"何时选 pty"的决策启发式，模型永远回落 default。

**修正一个直觉**：模型不用 PTY 的主因**不是**"每次调用时不知道还要不要连续调用"——
即使明确知道要多步，上面 1–4 依然成立。真正的问题是"即使连续，oneshot 每步形状仍更
优"。因此解法不是提醒模型去用 PTY，而是**把 PTY 的结果形状改成 oneshot 的形状**。

## 用户裁决（2026-10-18）

| # | 裁决 | rationale |
| --- | --- | --- |
| R1 | **idle TTL = 15 min（900s）**（2026-10-19 二轮修订，原 30 min） | idle 计时随活动重置，在用的会话永不超时；PTY 可持续状态本就少（cwd/env/后台子进程），超时后重建代价 = 一次调用 + 一行回执；须配合「运行中会话不得被 idle 回收」与诚实过期披露（回执如实说明状态丢失） |
| R2 | **不加"N 次 oneshot 后 nudge"** | surface instructions 写明即可；模型运行中看到什么就让它自己决策。in-band 运行时提醒属教练式插话；若 instruction/surface 呈现不够好，那是设计问题，改 surface 而非加提醒。与 2026-10-18 早前裁决一致：工具面完整即可，运行时回退 OS 原生通道不算降级 |
| R3 | **方向：stateful oneshot** | 不卖"持久终端"，卖"有连续性的 oneshot"。PTY 交互模式向 oneshot pattern 靠拢：同步返回、完整状态回执、上下文内可见状态 |
| R4 | **设计优先** | 这么一个简单工具，可行性与代码开发不是最重要的；核心是设计与顶层思想；rationale 和 surface 同为产品一部分，必须记录 |

## 交互形态设计（本期核心）

**P1 默认同步返回**：dispatch 写入命令后等待完成，一次性返回完整结果。命令行操作
70–90% 是同步的，模型在 80–90% 情况下立刻拿到结果，无需挂 background job 工具；确需
异步时再走轮询（见 P4）。

**P2 完整状态回执**：把 oneshot 的优势带进 PTY——每次执行完返回
`{output, cwd, exit code, session id, session status, TTL 剩余}`。对齐 hub exec pty
已有的 per-dispatch `exit/cwd` 返回（in-house 先例，设计直接搬）。

**P3 反"黑洞"**：从服务端后端视角，状态已持久化（persisted session）；但从模型视角
不可见即不存在。**让状态每次都留在上下文里**（P2 回执即状态快照），模型有掌控感，
才会愿意用。

**P4 长命令回执**：同步等待超时 → 先回执 `{status: running, 已积累 output, 提示稍后
轮询/查询增量}`（user 初步想法）。轮询必须**只读不写**：会话有命令在跑时，输入写进
stdin 会打进运行中程序——轮询是读增量，不是发新命令；新命令需排队或等空闲。

## Surface 改写方向（草案级）

- pty 段落改为**决策策略式**叙述："同一 target 预计多次操作且需要 shell 连续性 →
  pty（同步返回、带 exit/cwd/状态回执）；单发或无状态 → oneshot"。显式策略的服从度
  远高于中性机制描述。
- 回执形态在描述中给出示例（模型按示例对齐预期）。
- 失败恢复提示：oneshot lane 在某 target 失效时，receipt 提示 pty 可能可用
  （2026-10-17 Mac 实战教训：sticky-null + Linux-only shim 打死 oneshot 后，无提示
  导致模型弃工具走裸 ssh）。

## 已验证事实（实测背书）

- 2026-10-17 晚：`remote mac` pty lane 实测可用（`PTY-OK / arm64 / exit 0`，
  `ssh -tt bash`，不经 helper 不经 shim）；mac oneshot 被 sticky-null + `setsid`
  打死时，pty 是唯一产品内逃生道。
- hub exec pty 已实现 per-dispatch `exit/cwd` 返回——P2 的直接先例。
- OSC 133 shell-integration 帧解析机制仓内既有（R7 裁决脉络），是 P1 完成检测的
  现成底座。
- **血统查证（2026-10-19）**：方向与记忆相反——nonce 帧与会话池**诞生于 better-dsh**：
  `nonce-framing.ts`（a4f3f34 nonce-gated framing module）与 `pty-session.ts`
  （20a0412 session pool：init 协议/串行 dispatch/^C 中断/TTL/reconnect notice；
  4e2698c 两段式 130-marker 中断 P8；052ea29 kill 兜底收尸；ac8720a tail-ring
  OOM 防护）。hub exec 于 0.1.7-g（b059667）按 D12「原样照抄」移植接 WS
  （`exec-pty-framing.ts` 文件头自证）。**remote PTY 并未退化**——机制同源同备，
  Mac 实测回执 `[exit 0 · cwd /Users/m1k]` 为证；落后的只有 surface 与 dispatch
  语义（无 async、TTL 600s、描述不宣传 exit/cwd/stdin）。

## 实现注记（次要，按 R4）

- **完成检测**：shell integration 标记（OSC 133;C 输出开始 / D 结束+exit code）或
  sentinel 回显；exit 从 D 段取，不再依赖模型 `echo $?`。
- **cwd 捕获**：OSC 7（`file://host/path`）或 PROMPT_COMMAND 附带。
- **回显/提示符噪声**：输出取 C→D 段即确定化；已知写入字节可减除。
- **忙碌会话只读轮询形状**（P4 的必要补充，见上）。
- **keepalive（2026-10-19 定案）**：OpenSSH **无协议级默认 keepalive 单位**
  （ServerAliveInterval 默认 0=禁用；TCP SO_KEEPALIVE 内核默认 2h）；正确机制 =
  在**自有 spawn argv** 内固定 `-o ServerAliveInterval=180 -o ServerAliveCountMax=2`
  ——纯客户端侧，零对端配置依赖（对端 sshd 对 keepalive global request 自动应答，
  答什么都证明存活），效果即「每 3 分钟自发一次，不管对端怎么配」；ServerAlive 是
  transport 控制消息，与 channel 数据分流，**不触碰 PTY 字节流**；必要性：NAT/WiFi
  路由 idle TCP 映射常见 ~5min 过期，15min TTL 内的静默间隙足以被掐，且 2×180s
  死亡检测让池诚实标记死会话而非 hang。
- **流合并是 PTY 固有损失**：stdout/stderr 不可分，如实记录不掩盖；oneshot 的流分离
  仍是其独有优势。
- Ctrl-C/超时策略：Q2 已解决——显式 cancel 复用两段式 ^C+130-marker（P8 机制）；
  **行为 delta 如实记录**：现实现同步 dispatch 超时即自动中断，P4/P5 之后改为
  超时回执+轮询、取消显式化。

## 2026-10-19 讨论：四问四答与 P5

**Q1 确认：hub exec 双 mode 均 per-call 同步**。pty 每条 dispatch 包成
`{ <cmd> } ; printf '\033]133;D;<nonce>;%s;%s\007' "$?" "$PWD"` 的自注入 nonce 哨兵尾
（`exec-pty-framing.ts`），等 marker 帧到即返回 output+exit+cwd——不是全量 shell
integration，不依赖 PROMPT_COMMAND 配合，任意有 printf 的 shell 都能跑。会话建立即
`stty -echo` + `PS1=''/PS2=''` + `TERM=dumb`：回显与提示符噪声从源头消灭，非事后
剥洗。中断语义已实现：`\x03` + 注入同 nonce 的 130-marker（会话存活，bash 回到
标记态），3s 宽限后 group-kill 兜底（`exec-pty-session.ts`）。**P1/P2 的完成检测与
回执机制在仓内已有成品先例，remote PTY 照搬即可。**

**Q2「等不来 marker 的命令」：不是固定命令集，是两类行为**：
- (a) 按设计不终止的产出者：`tail -f`、`watch`、`top`、dev server、测试 watcher——
  输出持续流动，marker 永不出现（直到 Ctrl-C）。
- (b) stdin 等待者：裸 `cat`、REPL（python3/node/mysql）、密码提示、分页器/编辑器
  （less/vim/man）——等输入，marker 要到模型退出它才来。

静态预判不可行且有害：误报（`python3 -c '…'` 秒退、`tail -n 100` 无 -f 正常结束）
与漏报（任意阻塞脚本）并存；更关键的是对 (b) 类「立刻返回让轮询」是错误处置——
REPL 的下一步是**发输入**，不是轮询。**诚实的检测器就是超时本身**：「等了 N 秒无
marker」是行为级信号，零误判成本；模型自己通常也知道在发长命令——这正是 P5
（同步/异步自选）作为正门的原因，而非服务端预判。

**Q3 增量设计裁决：每个字节恰好交付一次，且尽早交付**。同步等待期间驱动端本来就在
缓冲流（扫 marker 需要）；**超时回执必须携带至今积累的 output（tail 上限如 30k，
溢出如实报 dropped）并同时建立读游标**；此后每次轮询只回游标之后的增量，轮询即推进
游标。答案：「下一次增量不包括那一分钟已等过的输出」——**因为它已在超时回执里交付
过一次，不是被丢弃**。反面设计（回执不带、首次轮询从头重放）浪费一整个往返的信息
量，且有双交付混淆风险。

**Q4 → P5：dispatch 级同步/异步自选**（user 提案，确认采纳方向）：
- 形状对齐本地 bash 工具的前台调用 vs `run_in_background` + job 通知——模型原生
  已知，零新概念。异步 = 立即回执 `{session, status: running, cursor}`；完成通知
  走既有 job/wake-boundary 通知机制（诚实注记：agent 工具调用是请求-响应式，「推」
  落在步骤边界，不是 mid-turn 注入），模型亦可主动轮询。
- 「无 helper、无对端产物」对 PTY 车道成立：零端点残留（无 cache 上传、无
  superd-run），代价换为持久连接 + keepalive。oneshot 车道不变，helper 留守其自身
  保证（killgroup/超时清组语义 PTY 不替代）。
- Ctrl+C：模型原生理解；硬部分仓内已实现（130-marker 注入、会话存活、group-kill
  兜底）。异步模式必须有显式 cancel 形状（原 Q2 的答案：要，复用该机制）。
- 边界修正（「PTY 内部是大模型的工作」）：命令层成立——`&` 后台、jobs/wait、
  exit code、REPL 交互都是模型的事；但**管道契约归 harness**：nonce marker、
  echo off、游标、busy/idle 状态、cmd/stdin/poll 三形状分发、中断映射。模型指挥，
harness 维持舞台。
- 结构性限制如实记录：每会话单前台流——异步命令每会话一次一条（busy 时排队或拒绝
  并回状态）；并行 = 模型原生 `cmd &`（shell 内可查）或多会话。

### P5 落地修订（2026-10-19 二轮）

- **复用 run_in_background 字段，零新增 surface**：oneshot 已有该字段与
  jobId/job_output/job_kill 三件套；driver 现状 `'remote: background requires
  oneshot'` 明确拒绝 pty——解除该限制即可。语义映射：jobId 指认**运行中的命令**
  （会话仍按 target 寻址）；job_output = 游标增量轮询（自动推进游标）；job_kill =
  显式 cancel（两段式 ^C+130-marker）。
- **cmd/stdin/poll 三形状中前两者已备**：pty-session 的 `PtyDispatchOptions.stdin`
  即「喂运行中进程」形状；poll 由 job_output 承担，无需新参数。
- **异步运行中的会话不得被 idle TTL 回收**：回收条件改为「无运行命令且 idle
  超时」双条件，防静默长任务被掐。
- **hub 侧对齐**：hub exec 目前 oneshot 有 run_in_background、pty 无；同一字段
  后续补齐（与 Q5 字段统一合并处理）。
- **Q6 倾向**：现池为串行 dispatch（20a0412）；异步时代 busy 收到第二条异步
  命令 → 倾向拒绝并回 running 状态（诚实优先于排队），待终裁。

## Open questions（持续讨论区）

- Q1：sync-pty 是否应成为「该 target 已有会话」时的默认 dispatch，还是永远显式 mode？
- Q2：✅ 已解决（2026-10-19）：提供显式 cancel，复用 exec-pty 的 Ctrl-C+130-marker
  机制；同步等待超时不自动打断（维持 P4 设计）。
- Q3：流合并损失是否可接受；是否提供可选 tagged 包装（注意会扰动程序行为）？
- Q4：TTL 剩余是否进回执（当前倾向：是）。
- Q5：✅ 基本解决（2026-10-19）：remote PTY 直接采用 hub exec 的回执 contract
  （P2 已定向），残余仅字段命名统一。
- Q6（新）：busy 会话收到第二条异步命令——排队还是拒绝？倾向**拒绝并回 running
  状态**（诚实优先于排队；现池为串行 dispatch），待终裁。

## 决策记录

| 日期 | 内容 |
| --- | --- |
| 2026-10-18 | 建档：第一人称 findings + R1–R4 + P1–P4 + surface 方向 + Q1–Q5 |
| 2026-10-19 | 四问四答落档：Q1 hub exec 同步机制确认（nonce 哨兵 + stty -echo + 130-marker 中断）；Q2 无静态黑名单、超时即检测器；Q3 增量 = 字节恰好交付一次 + 游标；新增 P5 dispatch 级 sync/async 自选；Q2/Q5 关闭，新增 Q6 |
| 2026-10-19 二轮 | 血统查证：帧/池诞生于 better-dsh，hub exec D12 原样照抄——remote PTY 机制未退化，欠的是 surface 与 dispatch 语义；R1 修订 TTL 30→15min；keepalive 定案：自有 argv 固定 ServerAliveInterval=180/CountMax=2，零对端依赖，控制消息不触碰 PTY 流；P5 落地修订：复用 run_in_background、job 三件套映射、运行中会话免 idle 回收；Q4 增量裁决确认（不含已交付内容） |
| 2026-10-19 三轮 | **Q1 关闭（user 裁决：不做默认 dispatch）**——回执已清楚披露会话状态，模型选 oneshot 是知情决策；保留显式 mode 也保留了「PTY 是否堵塞/等输出」的观察口。**hub exec pty 对齐 → 另立 change**（涉 foreign agent 命令与工具面，之后统一对齐）。4999 验收放行（dev3 本轮不用）；版本字母 0.3.1-f 为并行已授权轮（mobile），本次走 0.3.1-g |

## 实现状态（2026-10-19 实施，未发版）

**源码**（better-dsh/src/remote/，唯一可编辑源）：

- `pty-session.ts`：`PtyRunningJob`（byte-cursor read / stats / interrupt / done）；`dispatch` 增加 `background` 选项与超时 handoff（不再自动打断，P8 两段式 ^C+130-marker 移入 `job.interrupt`）；`E_SESSION_BUSY` 拒绝（仅当占用者是 detached job，同步 FIFO 语义不变，Q6 裁决）；idle 回收双条件（inFlight>0 → 重挂 TTL，R1）。
- `transports.ts` + `ssh-argv.ts`：`SSH_PERSISTENT_KEEPALIVE = ServerAliveInterval=180/CountMax=2` 常驻 pty ssh argv（oneshot 不带）。
- `driver.ts`：`REMOTE_PTY_IDLE_TTL_SEC=900`；callCtx 增加 `ptyBackground`；pty 回执携带 `running/ptyJob/ttlSec`（回执即状态快照，P2/P3）；E_NO_SESSION 文案 600s→15min。
- `jobs.ts`：`startRemoteJob` pty 分支（hub: 拒绝）；新增 `adoptRunningPtyJob`（P4 handoff 收养）。**注**：`ptyOutcome` 的 `controller.signal.aborted` 必须在 `await done` 之后采样（JS 实参求值顺序在挂起前取值——已修并注释）。
- `tool.ts`：`run_in_background` 开放 pty；同步超时 handoff → 有 jobs 服务则收养成 jobId、无则打断 + 教学 notice；渲染 `still running — poll job_output <id>`、`idle-left ~Nm`、shim 失败时 pty 逃生道提示；参数与顶部描述按 P1–P5 重写（决策策略式）。

**测试**：新增/改写 12 项（pty-session 8、jobs 3、transports 1），全部通过；全量 883 passed，11 failed 均为预存环境失败（本地 ssh fixture 5 + 无 Chrome 的 browser-device 6，stash 基线对照证实与本次改动无关）。typecheck 0 错误，`npm run build` 通过。

**未做（待后续裁决/流程）**：未 commit、未发版（npm publish 待 user 单轮放行）；hub exec pty 侧的 run_in_background 对齐（user 裁决 2026-10-19：另立 change，涉 foreign agent 工具面）；**Q1 已关闭**（user 裁决：不做默认 dispatch——回执已披露会话状态，oneshot 是模型的知情选择，且显式 mode 保留了「PTY 是否堵塞/等输出」的观察口）。

**4999 验收已完成（2026-10-19，0.3.1-g）**：整包 tarball 线双包安装（Better 经原生 PM 显式升级，companion 不强行重装规则如实生效）、安装树闭包与 bundle 双处 surface 字符串核验、单元级行为证据 12 项全绿；报告 `docs/test-reports/2026-10-19-pty-p4p5-4999.md`。dev3 本轮不用（user 裁决）。测试线保持运行供 user 亲手验收：https://test.pc.internal.test/
