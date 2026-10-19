# PTY Workbench：身份、并行、账本与 BYO 统一（v2）

日期：2026-10-19（v2 同日第二轮裁决后）。基线：`804f619`（0.3.1-g）。

文档对齐：2026-10-19 20:30 回填 0.3.2-b 实装面（命名以 `scriptPath` / `pty-` / `ssh-` 为准；`mode` 按 user 裁决不强制拒绝；R2 修正见 §12）。
输入：`docs/test-reports/2026-10-19-remote-pty-first-person.md`（§5/§6 三轮定案）+ 本日 user 两轮后续裁决（BYO 统一、close、上限、commandId、统一 label 池）。
定位：one-shot 已把 **toolbox**（动作）做成熟；本轮补 **workbench**（状态）——PTY 是 one-shot 的 stateful 超集。

范围：只改 `better-dsh/src/remote/` + 测试 + 文档。superd-hub 侧协议（PtyPool、TTL 600）不动。幂等/retry-dedupe 不做。

---

## 1. 目标语法（`mode` 退休）

- `ssh:<name>` / `docker:<name>` / `incus:<name>` / `hub:<m4>` = 显式通道 oneshot；无 cmd = status probe。
- `<transport-target>:pty[:label]` = 创建 PTY。`:pty` 为保留后缀，仅当前置非空 transport target 时生效（`ssh:pty` = 主机 pty 的 oneshot）。带 label = 带名创建；不带 = 自动 id，每次 new（tab 语义）。
- `pty:<id|label>` = 复用；无 cmd = session card。裸 `<label>` 亦可直达（见 §2.5 池）。
- `mode` 从 schema 移除，无向前兼容。**不强制拒绝未知根参数**：`dsh-tools` 会透传未声明字段、字段被忽略（user 2026-10-19 裁决：不引入 `additionalProperties:false`，不报错；正常模型不会凭空创造字段，90% 可用即可）。
- hub lane：`hub:<m4>:pty` 选 PTY（无 session id、无 label、不可并行；回执首行自标 `[hub:<m4> pty — no session id, no parallel, no background]`）。`hub:<m4>:pty:<label>` → `E_TARGET_FORMAT`（比 E_PARAMS 更准确，见 §12.7）。

## 2. BYO 统一：entry point = 参数在场，target 无 BYO 前缀

`byossh:` / `byop:` 前缀移除。旧形态 = 普通解析错误，**不给迁移提示**。判定：**`spawn` 或 `ssh` 参数在场 = BYO**，schema 即入口说明。

**BYO SSH**（`ssh` 参数在场）：
- `{target: <四形态>, ssh:{host,user?,port?,key?,proxyJump?}}`：注册身份；无 cmd 仅注册。
- 注册后 label/id 与原生 alias 同位同语法：oneshot、`:pty` 创建、copy/rsync 全通用。
- roster 标注 `(built on)`；session card 同；dispatch 回执 connection 写平名 `ssh:<label>`。

**BYO PTY**（`spawn` 参数在场）：
- `{target: <四形态>, spawn, cmd?}`：创建 spawn 会话。
- 创建回执标注：`session pty-xxxx (byo-pty)`；BYO SSH 注册回执文本 `ssh:<label> registered (byo-ssh, no dialing)`。

**target 四形态**（spawn/ssh 在场时）：
1. `pty:<label>` / `ssh:<label>`（带前缀）
2. `pty` / `ssh`（裸前缀 → 自动 id）
3. `<label>`（裸 label）
4. 空串 / 省略（→ 自动 id；byo-pty 自动 id 即会话 id `pty-<4>`，byo-ssh 为 `ssh-<4>`）

**label 规则（v2 简化——不做任何 spec 对比）**：
- label 是唯一资源，池化（§2.5）。**同 label 已被任何条目占用（不论来源、不论 spec 是否相同）→ `[E_LABEL_IN_USE]`**，不执行；错误提示「直接寻址 / 换另一个 label / 命中 PTY 时 close 释放」。
- 同 spec + 新 label = 新建另一条（幂等复用取消——复用一律走寻址，创建一律新建）。
- 创建/注册**失败 → label 即时释放**；成功才入池并出现在 roster。

**参数互斥**：
- `spawn` 仅配 pty 形 target（`pty`/`pty:<label>`/裸 label/空/省略）；配 `ssh:`/`docker:`/`incus:`/`hub:` 形 → E_PARAMS。
- `ssh` 仅配 ssh 形 target（`ssh`/`ssh:<label>`/裸 label/空/省略；允许 `ssh:<label>:pty[:lbl]` = 注册身份后开 PTY）；配 `pty:` selector 或其它 transport → E_PARAMS。
- `script` 改名 **`scriptPath`**（camelCase，与既有 schema 字段一致；本地绝对路径，oneshot only）。

## 2.5 统一 label 池（v2 核心；2026-10-19 三轮修正）

**每 agent session 一个注册表**（延续旧代码的 per-session 池键与 caller-scoped roster，本
轮只把命名统一上去）：机器名（ssh alias / docker / incus / hub）与认领（BYO ssh 身份 /
PTY 会话 label）共用一个命名空间，**到达顺序 first-mover-wins，session 内永不挪已立名字**。

- **机器名不落地存储**：roster / 裸名 miss 时**现场采集**（与旧 resolveBareName 的
  on-demand 扫描同一逻辑）merge 进本 session 注册表——OS 里现存的东西不需要在 app 层另存。
- **merge 规则**：同一实体（身份键）重扫后保持原槽；新实体撞已立名字 = latecomer，自动加
  `<transport>-<name>`（再冲突 -2/-3）——**无论对方是认领还是更早的机器，也无论新来的是
  不是系统原生配置**（例：BYO ssh 先认领 machine1，之后新出现的 docker 也叫 machine1 →
  `docker-machine1`）。本轮扫描里消失的机器出表（名字释放）；认领永远保留。
- **显式认领撞名 → [E_LABEL_IN_USE]**（名字是模型选的，不自动改名）；无 spec 对比。
- 加载序 ssh → docker → incus → hub 只影响**首次并存**的归类；此后一切以注册表到达序为准。
- 裸名解析：本 session 注册表（认领优先于机器——会话是操作环境）→ miss 触发一次现场采集
  → 再 miss：IP/域名落穿 ssh，其余 [E_TARGET]。
- 显式前缀 `ssh:`/`docker:`/`incus:`/`hub:` 直连通道绕过注册表。
- roster：本 session 的机器 + 认领 + 活会话（轻分组纯呈现）。

## 3. 会话身份

- id 只自动生成：PTY `pty-` + 4 位 `[a-z0-9]`（如 `pty-1a2b`）；BYO SSH `ssh-` + 4 位。label 可选别名，regex `^[A-Za-z0-9][A-Za-z0-9._-]*$`，禁用 `pty` 与 id 形态（`^pty-[a-z0-9]{4}$` / `^ssh-[a-z0-9]{4}$`）。
- `pty:<x>` 解析：先精确 id，后 label（裸 `<label>` 同）。创建永不复用（§2 v2），复用只经寻址。
- 回执字段序：`session`（有 label 并列）→ `connection` → `commandId` → `cwd` → `envDelta` → `ttlSec` → `exit|失败原因` → `durationMs` → 既有 `stdout` / `truncated` / `outputStats` / `reconnected` / `running` / `jobId`。state 平铺不嵌套。
- `connection` 取值：`ssh:dev4` / `docker:…` / `incus:…` / `hub:<m4>` / `BYOP`。
- 预热（创建形无 cmd）回执：`{session, connection, created:true, ttlSec}`，无 commandId/envDelta；`timeout` 忽略。

## 4. 并行与上限

- 池键 `<agent>|p:<id>`（原生与 BYO 同形）；同 connection 多会话、并行一等。
- 上限：**10 个 live PTY 会话 / agent**，跨所有 connection 统一计（native ssh/docker/incus + spawn）；**dead 会话不占配额**（留池只为一次 reconnect，death reaper 在 idle TTL 后 dispose 并释放 label）。超限 `[E_SESSION_LIMIT]`，错误只列活会话；schema/描述不强调。hub lane 不占配额（hub-side 池、无 id、无 close）【否决点 D 维持】。
- busy：同 session 有 detached job 时新命令直接拒绝；文案三出路：`job_output` / `job_kill` / 另开 `ssh:dev4:pty`（或改 oneshot）。
- 超时 handoff、idle TTL 900（运行中不回收）、ssh keepalive：沿用 0.3.1-g。

## 5. 账本与 session card

- 每条 PTY dispatch **起始**分配 commandId（`remote-<16 hex>`，与现行 jobId 同生成器）；`run_in_background` 时同一 id 兼任 jobId（字面相等）；timeout handoff 由 registry 另生成 jobId，账本记 `(job <jobId>)` 两者并列，`job_kill` 文案用 registry id。commandId 与 jobId 同构。
- 账本条目：commandId / 命令首行截 72 字符 / exit / 耗时；保留最近 **20 条**；随会话存亡。
- session card（`{target:"pty:<id|label>"}` 无 cmd）：connection（+`(built on)`/`(byo-pty)` 标注）、label、state/cwd、最近 20 条账本；**不带 env delta、不带输出尾**；dead 卡片不显示 `idle-left`。
- 读不续命：card / roster / status 不重置 idle TTL。

## 6. close

- `{action:"close", target:"pty:<id|label>", force?}`；`force` 默认 **false**。
- 默认：有 detached job → **报错**，错误列出 pending jobIds 与杀法（逐个 `job_kill` 后重试，或 `force:true` 一步）。
- `force:true`：杀整组 + dispose + 关闭，回执披露 `killed:["remote-…"]`（「Ctrl-C + 硬关 tab」一步形态）。
- 幂等：对已关/过期会话返回 `closed:false, reason:"not-found"|"already-closed-or-reaped"`（附 message），不抛错。close 后寻址 → `[E_NO_SESSION]`，文案给重建形式 `{target:"ssh:dev4:pty"}`。
- 互斥：与 `cmd`/`spawn`/`ssh`/`stdin`/`timeout`/`run_in_background` 同现即 E_PARAMS。

## 7. env delta

- **恒开，无开关**。只回变量名 + 变动标记：`{added:[…], changed:[], removed:[]}`，不回真实值。
- 采集：命令完成后于 nonce 帧后追加独立 marker 区（`env -0` + base64），parser 剥离不入 stdout；与上一快照按名字 diff。技术红线：不触碰 nonce framing 主路径。

## 8. 决策快照

| # | 裁决 | 来源 |
|---|---|---|
| 1 | BYO SSH 并入 `ssh:` 地址空间；`ssh` 参数在场 = BYO；label 与原生 alias 同位 | user |
| 2 | BYOP 并入 `pty:` selector；`spawn` 在场 = BYO | user |
| 3 | `byossh:`/`byop:` 前缀移除；旧形态直接报错，无迁移提示 | user |
| 4 | `script` → `scriptPath`（实现命名；原写 `script_path` 已按实装回填） | user/实现 |
| 5 | BYO 无 label → 自动 id（pty `pty-`/byossh `ssh-`，均 4 位） | user 定方向，前缀实现定 |
| 6 | roster 标 `(built on)`；创建回执标 `(byo-ssh)`/`(byo-pty)` | user |
| 7 | close 撞 detached job = 报错 + 列杀法 | user |
| 8 | env delta 恒开无开关 | user |
| 9 | 上限 10 会话/agent 跨 connection；仅 error message 披露 | user |
| 10 | commandId 套 jobId 通道，可挂 run_in_background，同构 | user |
| 11 | card 不带输出尾；roster 不分组 | user |
| 12 | 0.3.1-g 已本地 commit（804f619）；本轮版本号做完再定 | user |
| 13 | **无 spec 对比**：label 唯一资源；同 label 任何来源 → label in use；同 spec 新 label = 新建 | user v2 |
| 14 | 创建/注册失败 label 即时释放；成功才入池/入 roster | user v2 |
| 15 | BYO target 四形态：`pty/ssh[:<label>]`、裸 `<label>`、空/省略 | user v2 |
| 16 | **统一 label 池**：机器加载序 ssh→docker→incus→hub，迟到者 `<transport>-<name>`；裸 label 全局唯一直达，顺序解析链废除 | user v2 |
| 17 | close.force 默认 false；报错列 pending jobIds 与杀法 | user v2 |

## 9. 推导默认（v2 由上推出，未否决即实施）

- **创建永不复用**（推翻第一人称报告 §6.2「同 label 同 connection 复用」）：创建 = 认领新名字；复用 = 寻址既有名字；两者不混。模型重复创建同名 → `[E_LABEL_IN_USE]` → 改用 `pty:<label>` 寻址。
- `[E_LABEL_CONFLICT]` 更名 `[E_LABEL_IN_USE]`（语义变了：不是冲突仲裁，是资源占用）。
- 裸名 miss 落穿仅限 IP/域名形态走 ssh；单词 miss → `[E_TARGET]` 提示 roster/前缀。
- 迟到者前缀再冲突 → `-2`、`-3` 递增。
- roster 保留轻分组（machines / PTY sessions），纯展示。

## 10. 否决点状态

- **A（close force）**：已定形——默认 false 报错列杀法，force:true 杀组披露 killed ids。
- **B（byossh label 撞原生 alias）**：被 §2.5 统一池吸收——一切 label 占用都是 `[E_LABEL_IN_USE]`。
- **C（BYO SSH 自动 id 前缀 `ssh-`）**：维持默认。
- **D（hub lane 不占 10 配额）**：维持默认。

## 11. 工作分解（v2 实施进度 2026-10-19）

1. ✅ **统一 label 池 + 目标语法解析器**：`labels.ts`（LabelPool/加载序/迟到者改名/认领释放/E_LABEL_IN_USE）、`target.ts` `parseTargetForm`（`:pty` 后缀、selector、四形态、hub 无 label）。
2. ✅ 会话池重键（`p:<id>`）+ 并行 + 上限 10（E_SESSION_LIMIT 附会话清单）+ built-on/byo-pty 标注。
3. ✅ 回执/schema/render：session→connection→commandId→cwd→env→ttl→exit 序、预热回执、`[pty:pty-xxxx (label) · conn ssh:dev4 · cmd remote-xxxx · cwd … · idle-left ~15m · exit …]` 渲染。
4. ✅ commandId 账本（`remote-` 通道同构；background 传入 registry id 字面相等；handoff 收养回填 `(job …)`）+ session card（renderLedger 20 条）。
5. ✅ close（默认拒绝列杀法 + force 杀组披露 + 幂等 not-found）。
6. ✅ env delta 恒开（E 帧侧信道 `env -0|base64`、init 基线、名字+变动标记、`__superd_*` 过滤、±~/- 渲染）。
7. ✅ `scriptPath` 改名 + `mode` 退役 + `byossh:`/`byop:` 前缀移除（tool schema/description 全重写；未知根参数不强制拒绝，user 裁决）。
8. ✅ 测试改写 + R2 回归全绿：v2 全量套件见 `docs/test-reports/2026-10-19-pty-workbench-4999.md`（893 passed / 6 failed 均为 browser-device 无 Chrome 预存环境项 / 9 skipped）；R2 新增 3 条回归（`test/remote` 29 files / 213 passed / 8 skipped，见 §12.8）。新增用例：identity/账本 20 条帽/env delta 名字-only/lastCwd/attachJob/detachedCommandId/上限 10+close 释放/E_LABEL_IN_USE 教学/E_NO_SESSION 重建提示/latecomer 前缀/会话 per-key 隔离/hub-pty 无 background。实现修正三则：jobs 通道补 sessionKey 透传；startPrepared direct 形态不进池 + ssh 首注册支持；FRAME_BODY_RE 终止符必需（我重写时误加 `?`，chunk-split 回归测试当场抓住）。
9. 🟡 0.3.2-a 4999 整包验收已过（报告 `docs/test-reports/2026-10-19-pty-workbench-4999.md`）；0.3.2-b 的 R2 修正见 §12 与 `docs/test-reports/2026-10-19-pty-workbench-r2-fixes.md`，0.3.2-b 正式整包验收报告待补。

**实现注记**：tool.ts 发现 dsh-tools 类型双实例问题（TS2719）——schema×execute×import 链组合触发、无单一根因（多轮清缓存二分定位）；解法 = execute 实现移入 `remoteExecute` + 本文件结构类型（RemoteArgs/ExecLike/JobRegistryLike），字面量只剩三行委托，运行时零变化。升级 dsh-tools 版本时复查此隔离是否仍必要。

1. **统一 label 池 + 目标语法解析器**：池条目/加载序/迟到者改名/认领释放/四形态 target/`:pty` 后缀/错误文案（E_LABEL_IN_USE / E_SESSION_LIMIT / busy 三出路 / E_TARGET 提示）。
2. 会话池重键（`p:<id>`）+ 并行 + 上限 + `(built on)`/`(byo-pty)` 标注。
3. 回执 / schema / render 重排（session/connection/commandId 序、预热回执）。
4. commandId 账本（`remote-` 通道复用）+ session card + status/roster 更新。
5. close（默认报错列杀法 + force + 幂等）。
6. env delta 侧信道（marker 区、diff、schema/测试）。
7. `scriptPath` 改名 + `mode` 退役清理（schema、描述、旧测试改写）。
8. 全量测试 + 4999 整包验收轮 + 报告。

## 12. R2 复核修正（2026-10-19 晚，针对 `docs/test-reports/2026-10-19-remote-pty-workbench-review.md`）

第一人称复核在 0.3.2-a 上发现 P0/P1 偏差。user 裁决：**`mode` 字段不管**——从未 surface 过，是旧残留，不报错即无所谓；其余逐项处理。主体纪律不变：只改 `better-dsh/src/remote/`，super 侧只 copy 闭包。

### 12.1 P0-1（回归，必修）：init 超时杀掉了已就绪会话
- 现象：创建成功 ~30s 后整组 SIGTERM，`died`；再寻址以 reconnect 掩盖，cwd/env 丢失。
- 根因：`doStart()` 的 init 超时 timer 只在"初始化前死亡"的 waiter 里 `clearTimeout`；`onFrame` 成功分支没有清，30s 后回调 `killTree()`。0.3.1-g 原本有这一行，v2 重写时丢了。
- 修法：`onFrame` 首行 `clearTimeout(timer)`（成功与 dispose 竞态两分支都撤）。回归用例：`initTimeoutSec: 0.15` + 600ms 后断言 `ready` 且下一次 dispatch `reconnected === false`。

### 12.2 P0-2：死会话回收 + 配额语义
- `markDead()` 之后（ready 过的会话）挂 death reaper：一段 idle TTL 后 `dispose()` → 出池 + 释放 label；`start()`/`dispose()` 清该 timer。
- `REMOTE_PTY_SESSION_LIMIT` 只统计**非 dead** 会话：死会话没有进程，留池只为一次 reconnect，算进"live"会让 10 条死标签永久锁死 Agent。
- 文案：`E_SESSION_LIMIT` / `E_NO_SESSION` 的分钟数由 `ptyIdleTtlSec` 推出；dead 卡片不再显示 `idle-left`；`E_LABEL_IN_USE` 命中 pty 会话时补 `close` 出路。

### 12.3 预热创建真正拨号
- 创建形无 cmd 时 `await session.warm()`（拨号到 init 帧）再回执：`created` 必须是真的 ready，且只有 ready 过才挂 idle 回收（cold 会话原本没有 timer，永不回收）。
- 回执带整段 `ttlSec`（`idleMs === null` → 满 TTL）。

### 12.4 TTL 单一口径
- `plugin.Config.idleTtlSec` 默认改为 `REMOTE_PTY_IDLE_TTL_SEC`（900s = 15 min）；错误文案/回执/描述全部由该值推出。旧 `600` 是残留。

### 12.5 close 回执结构化
- driver 返回 `{closed, reason: 'not-found'|'already-closed-or-reaped', killed, message}`；tool 面把 `closed/reason/killed` 放进 output schema（文本保留）。

### 12.6 background PTY 首回执可寻址
- 新增 `RemoteDriver.preparePtyLane()`：pty 创建/复用先在池里占位（不拨号），把 `pty:<id>` 交给官方 jobs registry；registry 拒绝时拆掉新建会话，复用形绝不拆。
- 首回执：`Started <jobId> on pty:pty-xxxx (label) (conn)`，字段带 `session/connection/label`。

### 12.7 其余 surface 对齐
- hub PTY 回执首行自带 `[hub:<m4> pty — no session id, no parallel, no background]`（与 oneshot 可区分）；错误码 `E_TARGET_FORMAT` 保留并在此回填计划（比 `E_PARAMS` 更准）。
- BYO ssh 建立的会话 card 标 `(built on)`（与 roster 同词）。
- busy / close 拒绝文案 `foreground command` → `detached command`（后台 job 不是前台命令）。
- 回执字段序对齐 §5.2：session → connection → commandId → cwd → env → idle-left → exit → duration。
- 命名回填：`scriptPath`（不是 `script_path`）、id `pty-xxxx` / `ssh-xxxx`（不是 `p-xxxx`/`s-xxxx`）。

### 12.8 验证
- `better-dsh` typecheck 绿；`test/remote` 29 files / 213 passed / 8 skipped（含新增 3 条 R2 回归）。全量套件见当天报告。
