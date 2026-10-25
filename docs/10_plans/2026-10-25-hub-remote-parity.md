# Hub remote 双线并入同一形状：差距分析与实施计划（PTY / one-shot）——0.3.2-c

> 2026-10-25 user 指令：① 0.3.2-b 已本地 commit（`878d338`，阶段性验收）；② 下阶段把 hub machine 的 WebSocket PTY 接到现行 remote PTY 同一形状，one-shot 一并接入；③ 本文件回答「hub 两条线与其他渠道究竟差多少」并给出落地任务。
> **2026-10-25 晚 user 三点裁决（定稿设计）**：One-shot 线对端 handling 就是对端 Hub Server（runner 是 dumb-pipe 专用物，hub 线不需要、也不经 WS 上传）；PTY 线不走「channel 缝上收」，改走 **BYO spawn-pump**——`hub:<m4>:pty` 直接构造成 canonical 会话的一个本地子进程（WS 字节泵），零改动刚验收的 `pty-session.ts`；Q2（hub-tool `exec.pty` 迁 canonical）确认执行。版本号 **0.3.2-c**。

## 0. 一句话结论

**Hub 的 WS 字节泵和任务租约协议本身没拖后腿——差的是「会话层」**：PTY 线在 superd-hub 里养了一个 2026-10-19 时代 `pty-session.ts` 的分叉移植（`exec-pty-session.ts`），没有跟 0.3.2-b 的交互输入/立即 busy/handoff/身份层对齐；one-shot 线已同形，对端 Hub Server **本来就是**监督者（原生 Node：detached 组、两阶段组杀、超时强制、输出环、租约生命周期），只差披露与两处钉测试。对端 dumb executor（`/api/superd/exec/pty`）**零协议改动**。

## 1. 现状地图（谁在哪台机器上跑）

| 部件 | 位置 | 角色 |
| --- | --- | --- |
| `better-dsh/src/remote/pty-session.ts` | **本机**（消费者进程内） | 正本 PtySession：identity/label 池、占位制 busy、input、handoff、close、账本、env delta、**idle TTL 自管理** |
| `super-dsh/superd-hub/src/exec-pty-session.ts` | **本机**（superd-hub 提供 `superdRemoteTransport` 服务） | 分叉移植：老 FIFO/自动 ^C/无身份/无 input；`PtyPool.getOrCreate(machine\|origin)` 每 owner 每机器**隐式复用一个匿名会话** |
| `exec-pty-channel.ts`（`WsPtyChannel`/`LocalScriptChannel`） | 本机 | 分叉用的传输缝；本方案下随分叉一起删除 |
| `exec-pty-rpc.ts` | **对端 hub** | dumb executor：一个 WS = 一个 `script -qfec bash /dev/null`；text 帧=stdin/stdout；`{"op":"exit"}` 控制帧；WS 关=组杀。cookie+trust 门禁。**本轮零改动** |
| `remote-job-rpc.ts` / `remote-job-client.ts` | 对端 / 本机 | one-shot 任务线：有界租约（6s/续 2s）、prepare/start/read/renew/cancel、NDJSON 流、断连清理上界。**本轮零改动** |
| `exec.ts` `runOneShotExec` | **对端 hub** | 同步 oneshot：`bash -lc` + detached 组 + 两阶段组杀 + ByteTailRing。**本轮零改动** |
| `remote-provider.ts`（`createHubExec`/`createHubRemoteTransport`） | 本机 | `owners: Map<owner, PtyPool>` 管分叉会话池；本轮改为 canonical 会话 + 保留 per-owner 复用语义 |
| `hub-tool.ts` exec pty 动作（:576 一带） | 本机 | **第二消费者**：A2A 工具 `exec.pty`（同一分叉），Q2 迁移对象 |

调用链（PTY 现状）：`remote{action:exec, target:"hub:<m4>:pty"}` → driver `hub.pty(machine, cmd, owner)`（[driver.ts:176](../../better-dsh/src/remote/driver.ts#L176)）→ `createHubExec.face.pty` → 分叉 session over `WsPtyChannel`。全程在我们进程里，对端只当字节泵。

## 2. PTY 线差距矩阵（hub vs ssh/docker/incus/BYO 现状 = 0.3.2-b）

| # | 维度 | 其他渠道 | hub PTY 现状 | 差距量级 |
| --- | --- | --- | --- | --- |
| P1 | 会话身份 | `pty:<id>`+label 池、每次 `:pty` 新建（tab 语义）、roster/card 可见、10/Agent 配额 | 无 id 无 label；`machine\|origin` 键**隐式单会话复用**，第二次调用悄悄进同一 shell | **整层缺失** |
| P2 | 交互输入 | `input` 动作：写入运行中命令、commandId 守卫、busy 联动 | 只有启动 stdin；WS 双向但会话层无 input 入口（分叉无 activeCommand） | **缺失**（0.3.2-b 主特性） |
| P3 | busy 语义 | 同步占位制，新 cmd 立即 `E_SESSION_BUSY` 四出路 | 老 FIFO 排队（还能和等输入死锁） | 分叉落后一代 |
| P4 | 超时行为 | P4/P5 handoff 成 running job（job_output/job_kill） | 超时自动两段 ^C 打断（0.3.1 前行为） | 分叉落后一代 |
| P5 | background | `run_in_background`，jobId=commandId | jobs.ts 明确拒绝（[jobs.ts:28](../../better-dsh/src/remote/jobs.ts#L28)） | 缺失（P4 的自然结果） |
| P6 | close/card/账本/env delta | close 幂等、session card、20 条账本、E 帧环境增量 | 全无（close 只能靠 idle TTL/owner 释放） | **整层缺失** |
| P7 | idle TTL | 15min 双条件（运行中命令豁免） | 固定 600s；旧逻辑 | 分叉落后 |
| P8 | 重连语义 | dead→下次 dispatch 重连新 shell + RECONNECT_NOTICE | 已移植 markDead/重启（WS 重开=新 shell） | 基本平 |
| P9 | stderr 合并 / 4M 上限 / stats | 是 | 是（移植同款） | 平 |
| P10 | 每次建连重验 pairing | n/a（ssh/docker 每次拨号） | `face.pty` 每次 dispatch 重验 registry 行（好设计，需保留） | 需在统一后保留 |
| P11 | 工具面 | `pty:<id\|label>` 可寻址、`input`/`close`/card 全动作 | `hub:<m4>:pty` 专用一次性形；surface 明示「no session id, no parallel, no background」 | surface 例外句全部删除 |

计：**6 项整层/主特性缺失，3 项分叉行为落后，2 项已平**。

## 3. one-shot 线差距矩阵（hub vs 其他渠道）

| # | 维度 | 其他渠道 | hub one-shot 现状 | 差距量级 |
| --- | --- | --- | --- | --- |
| O1 | 执行/监督 | `superd-run` helper（内核锚定清理）或 POSIX shim，回执 `runner` 字段如实 | 对端 = **我们自己的 Hub Server**：`runOneShotExec`（同步）/ `startOneShot(['bash','-lc',cmd])`（租约）原生 Node 监督（detached 组、TERM→2s→KILL、reap 上界、输出环）；**回执无 runner 披露**。runner 是 dumb-pipe 专用物，hub 线不装也不用（**文档化 non-goal**） | 披露缺失（结构无缺口） |
| O2 | 租约/所有权 | 本地进程所有权 | 有界租约协议（prepare/token/续租/断连清理上界，单调时钟）——监督模型不同但**不弱** | 语义差异写进 surface，不需改造 |
| O3 | timeout | 本地计时杀组 | `timeoutSec` 传对端由对端杀；客户端租约独立续（双钟） | 钉测试核验 |
| O4 | scriptPath | 本地文件 → `bash -s` + stdin | 同一 PreparedRemoteInput 通路，理论已通；**未验收过** | 钉测试 |
| O5 | background | job_output/job_kill | hub oneshot background 腿已存在 | 已通，补回归即可 |
| O6 | stdin / 分流 / byte stats / 诊断 | 是 | 是（NDJSON 增量流 + 绝对字节坐标去重） | 平 |
| O7 | 限制披露 | — | inline cmd ≤4096（对端 parse 上限）；`execEnabled` 行门禁；self 拒绝 | 已在 surface，保持 |
| O8 | 二阶差异（如实记录，不改造） | helper 有 Linux starttime 防 PID 复用；initiator 死亡后 helper 独立存活强制超时 | Node 路径无 starttime 边车；**对端 hub 进程崩溃**时进程内定时器同死、运行中组孤儿化（hub 活着时租约兜底） | 写进披露文档 |

计：one-shot 实质差距仅 **O1 披露 + O3/O4 钉测试**；无结构性缺口。

## 4. 统一设计（user 定稿：BYO spawn-pump）

**核心手法：hub PTY 不新造缝，直接落进 canonical 会话已有的 BYO spawn 通道。** canonical PtySession 只认 `argv` 并 `spawn()` 本地子进程（[pty-session.ts:373](../../better-dsh/src/remote/pty-session.ts#L373)），全部会话智能走进程 stdio；docker PTY lane（`script -qfec 'stty -echo; exec docker exec -it …'`，本地 PTY 嵌远端 PTY）在 0.3.2-b 已验收 input/^C/EOF——**把 `docker exec` 换成一个 WS 字节泵子进程，就是 hub lane，骑完全相同的已验证机器。**

### 4.1 泵（pump）子进程

- 新资产 `better-dsh/src/remote/hub-pty-pump.mjs`（手写哑泵，helper-bin 同款「原样资产」纪律）：读环境变量 `SUPERD_HUB_PTY_URL` / `SUPERD_HUB_PTY_COOKIE` / `SUPERD_HUB_PTY_WS`（ws 模块**绝对路径**），`require(wsPath)` 建 WS（Cookie 头随 upgrade），`process.stdin → ws`、`ws → process.stdout`；`{"op":…}` JSON 控制帧**不进字节流**（对端 exit 帧吞掉、泵随之退出）；WS 关 → exit；错误先写 stderr 再 exit 1。crash-proof：`'error'` 监听永远先挂（mesh-gateway 教训）。
- 构造（canonical `transports.ts` 新增 `buildHubPtyArgv()`，**单一事实源**，remote-provider 复用）：
  `['script','-qfec', 'stty -echo 2>/dev/null ; SUPERD_HUB_PTY_URL=… SUPERD_HUB_PTY_COOKIE=… SUPERD_HUB_PTY_WS=… exec <node> <pump.mjs>', '/dev/null']`
  ——cookie/URL 走 wrapper 内 env 赋值（不进 argv，不落 `ps`）；`<node>`=`process.execPath`；pump 路径按 `dirname(import.meta.url)` 定位（npm 包与闭包同构，helper.ts 同款纪律）；`ws` 路径由**调用方在创建前** `createRequire(import.meta.url).resolve('ws')` 解析（分叉的 `require('ws')` 在同一解析树上跑了多轮生产，可行；解析失败 → 创建时诚实报错，不做静默回退，单一代码路径）。
- 字节链：session 写 → 本地 script PTY（`stty -echo` 已关本地回显）→ 泵 stdin → WS → 对端 script PTY → bash；反向同路。kill 链：session 组杀 → 泵死 → WS fd 关 → 对端组杀（TERM→2s→KILL）；对端死 → WS 关 → 泵退 → session dead 回调。双向自然闭合。
- 代价（已接受）：每个 hub PTY 会话多一个 node 子进程（~40-60MB、~50-80ms 启动；配额 10/Agent 封顶）。

### 4.2 driver / 闭包侧（better-dsh）

- `hub-contract.ts`：`HubRemoteTransport` 增 `ptyEndpoint(machine): { url, cookie }`（实现方校验 registry 行 = P10 每次重验；url = `ws(s)://<hub-origin>/api/superd/exec/pty`，路径常量在闭包侧自带一份——remote-job-client 先例）。**`protocol` 不动**（能力是 initiator 侧重组，无对端新面）。
- `driver.ts`：`hub-pty` 表单分支（:176）从 `hub.pty(...)` 改为「`ptyEndpoint` → `buildHubPtyArgv` → `createSession(connection:'hub:<m4>')` → dispatch」，回执=标准会话回执（sessionId/commandId/…），删「no session id…」横幅；hub 会话进统一 label 池与 10/Agent 配额（Q1 自动成立）；`dispatchPty` 对 hub 会话每次 dispatch 前重取 `ptyEndpoint`（P10：复用不豁免）；`input` 的 hub-pty 拒绝文案改为「按 `pty:<id|label>` 寻址会话」。
- `jobs.ts`：删 hub-pty background 拒绝（超时 handoff/后台随会话化自动成立）。
- `plugin.ts` 导出面：`PtySession` + `buildHubPtyArgv`（remote-provider 消费，Q2）。
- `tool.ts` surface：hub 附录改写——hub PTY = 同形状会话（身份/input/background/close/card/账本/TTL/配额），创建形 `hub:<m4>:pty[:label]`；全部「no session id / no parallel / no background」例外句删除；base description 保持 hub 中立（hub.spec 守卫）。
- **one-shot 披露**：hub 回执补 `runner: "hub-lease (peer bash -lc, peer Node supervision)"`；surface 补一句监督模型说明：hub 对端是自己的服务器，不经 WS 上传 helper（non-goal），并对 O8 二阶差异如实一句带过。

### 4.3 super-dsh 侧

- `remote-provider.ts`：删 `owners/PtyPool` 与分叉 import；`face.pty(owner, machine, cmd, opts)` 改为**canonical PtySession + per-owner 复用**（保持 A2A 持久 shell 语义：owner→session map，dead → 重建 + `reconnected:true`；idle TTL 900 与 canonical 对齐）——argv 用闭包导出的 `buildHubPtyArgv`，与 driver 同一构造。
- 删除 `exec-pty-session.ts`、`exec-pty-channel.ts`；`exec-pty-rpc.ts`（对端 dumb executor）**保留零改动**。
- `hub-tool.ts` exec pty 动作：走迁移后的 face（行为不变，错误文案微调）；Q2 完成。
- 构建：`copy-helper-bins.mjs` 同款新增泵复制（better-dsh `lib/remote/hub-pty-pump.mjs`）；`build-remote.mjs` 把泵带进闭包 `remote/` 并计入 provenance outputs（非 import 检查叶子，helper-bin 先例）；`verify-package-pair.mjs` 叶子哈希核验覆盖。

### 4.4 已裁决开放点（全部关闭）

- **Q1 配额合并**：成立——hub 会话即 canonical 会话，同池同限 10/Agent。
- **Q2 hub-tool pty 迁移**：**user 确认必须**（单会话实现，杜绝双轨）。
- **Q3 legacy `pty()` transport 方法**：随分叉删除而消失；实现时核实无第三调用方。
- **Q4 self 机器**：继续拒绝（roster 不列 self；本地裸 pty 已覆盖）。
- **Q5 阶段 B**：递延（one-shot 等待窗口转后台不在本轮）。

## 5. 任务清单（0.3.2-c）

✅ T0 版本：`npm run version:release -- 0.3.2-c`（root+双包+锁文件同步）。
✅ T1 better-dsh：`hub-pty-pump.mjs` + `transports.ts:buildHubPtyArgv` + `hub-contract.ts:ptyEndpoint` + driver hub-pty 会话化分支 + jobs 解禁 + plugin 导出 + 构建复制。
✅ T2 super-dsh：删分叉两文件；remote-provider face.pty 迁 canonical（per-owner 复用 + reconnected）；hub-tool 文案核对；build-remote 泵资产 + provenance；闭包重建。
✅ T3 surface + 披露：tool.ts hub 附录改写、例外句删除、hub oneshot `runner` 披露、O8 说明；docs/remote-tools.md 同步 + better-dsh/docs 副本再生成。
✅ T4 测试：pump 单测（对本地 ws 服务器）；driver hub 会话创建/input/busy/handoff/close/card/复用重验；jobs 解禁回归；hub.spec/tool.spec 文案与 schema；既有 236/8 全绿；scriptPath-over-hub 与 timeout 双钟钉测试。
✅ T5 验收：PC 4999 ↔ dev3 4998 双现场 0.3.2-c（含 companion 同步 `better-dsh@0.3.2-c`）；真实模型会话：hub pty 创建 label → 两道提示 input → busy 四出路 → 超时 handoff → close → card；hub oneshot 回执 runner 披露可见；hub-tool `exec.pty` 迁移后通路；self 拒绝；报告入 `docs/test-reports/`；本文件勾销。

## 6. 验收标准

真实模型在真实安装产物上对 `hub:<m4>:pty` 做到与 ssh/docker/incus/BYO **逐动作同形**：创建有身份、提示可见后 input 补输、busy 四出路、超时 handoff、close 幂等、断线重连提示、roster/card 可见；one-shot 回执如实披露 `hub-lease` 监督；旧「no session id / no parallel / no background」例外句从 surface 消失；对端 `/api/superd/exec/pty` 与任务租约协议**零改动**（protocol 1 不动）。
