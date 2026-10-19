# SuperD Remote 第一人称使用复盘与 PTY 重构方向（dev4 实测）

日期：2026-10-19（Asia/Hong_Kong）。基线：`ee64e8e`（0.3.1-f）+ 未提交的 P4/P5 工作树（`better-dsh/src/remote/` 6 文件 +194/−38）。运行面：本 GUI 会话内的 `remote` 工具（4999 线，helper `0.3.1-d.b596`）。目标机：`dev4` = `u1@137.131.54.174`，aarch64 Oracle VM，Ubuntu 24.04。
性质：**第一人称使用报告 + 设计讨论底稿**。不是发版验收；user 已明确本轮目的是"观察 agent 用不用 PTY，并比对 surface/functionality"。**2026-10-19 三轮定案已回填（§6.0 / §6.7）**；本轮范围只含 beta-remote（better-dsh `remote`），Hub 侧不动。

**实现回填（0.3.2-b）**：落地值以本行为准——id 为 `pty-xxxx` / `ssh-xxxx`（不是 `p-`/`s-`）；BYOP 不写 `byop:` 前缀，而是 `spawn` 在场 + `pty[:label]`（自动 id 即会话 id）；`script` 定名 `scriptPath`；`mode` 字段移除且未知根参数不强制拒绝（user 裁决）。实装面对照见 [PTY Workbench 计划 §12](../superpowers/plans/2026-10-19-pty-workbench.md)。

---

## 0. 一句话结论

工具**没有报错**，机制（nonce framing、同步 exit+cwd、handoff、busy 拒绝、TTL、重连）都在，而且大部分是我在上一轮误判为"缺失"的。
真正的落差不在 functionality，而在 **workbench 那一半**：native PTY 没有身份（session id）、没有账本（command id）、没有可见的 env、没有 close、同一 target 只能有一个会话。模型因此**无法确认自己处在哪个 shell 里**，只能靠 `cwd` 反推——这才是"黑洞感"的来源。

---

## 1. 背景与方法

user 给的任务是一个**真实运维场景**：盘点 dev4 环境 → 压缩 journal → 解开 apt 锁 → 升级系统包与三个 agent 工具 → 清理 → 最后讨论 PTY。任务本身不重要，重要的是给我一个"会自然产生多步、长任务、有状态需求"的场景，观察我什么时候切 PTY。

观测口径：

- 本轮 `remote` 调用约 30 余次：roster 1 次、oneshot 探针/校验约 30 次、**PTY 2 次**。
- PTY 两次全部成功，无重连、无 busy 冲突、无超时。
- 我在**事后**读了 `better-dsh/src/remote/` 的实现再写本报告；本报告里"我以为"与"实际"分开记录——这个差值本身是 surface 证据。

---

## 2. 第一人称时间线（含回执原文）

### 2.1 开局：roster 与 oneshot 探针

第一个调用是 `{}`（roster），一次拿到 hub machines / ssh hosts / docker / incus / live pty 四段。之后全部是 oneshot：

```
=== HOST === ...
[exit 0 · 2.7s · runner superd-run 0.3.1-d.b596 (aarch64-unknown-linux-musl)]
```

我没有用 PTY。理由很直接：每一问都是**封闭的一次性观察**（`hostnamectl`、`ss -tulpn`、`dpkg -l`、`docker ps`），结果可以整块拿走，下一步取决于我看到什么，而不是取决于 shell 里留下什么。这也复现了你们 2026-10-18 记录的现象：**即使同一 target 连续十几次调用，我依然不开 PTY**。

### 2.2 第一次切 PTY：apt upgrade

```
[PTY] cd /tmp && export DEBIAN_FRONTEND=noninteractive && sudo apt-get -y upgrade > /tmp/apt-upgrade-2026-10-19.log 2>&1; ...
→ APT_EXIT=0 ... [exit 0 · 97.7s · cwd /tmp]
```

切 PTY 的判据是：**预计接近两分钟、而且退出之后我还要在同一个地方继续查日志和 `df`**。oneshot 也能做（把日志路径带回来再发一条），但 PTY 省掉了"重新建立上下文"的往返。回执里 `cwd /tmp` 让我确认了落点——**但没有 session 名字**，我不知道下次调用是不是同一个 shell。

### 2.3 第二次 PTY：multica 安装链

```
[PTY] cd /tmp/mc-upd && tar xzf m.tgz && ... install ... && systemctl --user restart multica-daemon && ...
→ Daemon: running (pid 27030, uptime 3s) ... [exit 0 · 4.4s · cwd /tmp/mc-upd]
```

多步、依赖 cwd、失败要就地查——PTY 是自然选择。回执给了 `cwd /tmp/mc-upd`，同样**没有 session id**。

### 2.4 体感：三个"我以为"

1. **我以为 PTY 是无名的**。回执里没有 identity，我就默认"它是 target 的附属物"，而不是一个可寻址的对象。我甚至在第二次调用时**习惯性重新 `cd`**，因为我不确定上一条 shell 还在不在——这就是设计想消灭的摩擦，而它真实发生了。
2. **我以为不能并行**。任务里我有一次"长 apt 升级 + 同时查 multica 版本"的需求，我的第一反应是"等升级完再查"，而不是"再开一个 PTY"。因为工具面没有告诉我可以开第二个；事实上现在的实现也确实不能（同 target 单会话）。
3. **我想关掉它但没有动词**。收尾时我想显式关掉 dev4 的 PTY，翻遍 schema 只有 `cmd`/`mode`/`timeout`/`run_in_background`，没有 close；于是"等 15 分钟 TTL"成了唯一选项。

这三个"以为"都不是 bug，是 **surface 没把 workbench 暴露出来**。

### 2.5 我上一轮的误判（必须记录）

我在讨论里把"应该有的功能"列成了"缺口"，user 当场质疑。事后对账：framing、handoff、busy 拒绝、TTL 900、重连提示、keepalive、roster/status **全部已实现**，其中 P4/P5 还是**未提交的工作树**。我误判的原因恰恰是 surface 的问题：**回执不携带这些状态，模型只能从实现里才知道它们存在**。

---

## 3. 机制核验（对账表）

| 能力 | 状态 | 证据 |
|---|---|---|
| nonce 帧（8 字节随机，`OSC 133;D;<nonce>;$?;$PWD`） | ✅ | `nonce-framing.ts` `genNonce`/`wrapPtyCommand`/`createNonceFrameParser` |
| 伪造 marker 免疫 | ✅ | 解析器只认本轮 nonce，其余按输出流过并剥 ANSI |
| 确定性初始化（`TERM=dumb`、空 PS1/PS2、`stty -echo`、40×120） | ✅ | `buildInitCommand` |
| 同步返回 exit+cwd（P1/P2） | ✅ | `driver.ts:521-529`；回执实测 `[exit 0 · cwd /tmp]` |
| 超时 handoff（P4/P5，不再自动 ^C） | ✅（工作树） | `pty-session.ts` `detach()`；`jobs.ts` `adoptRunningPtyJob` |
| busy 拒绝（Q6） | ✅（工作树） | `E_SESSION_BUSY`，提示 `job_output`/`job_kill` |
| TTL 900s + 运行中不回收（R1） | ✅（工作树） | `driver.ts:94`、`resetIdleTimer` 双条件 |
| 重连提示 | ✅ | `RECONNECT_NOTICE` |
| keepalive（`ServerAliveInterval=180`/`CountMax=2`） | ✅（工作树） | `ssh-argv.ts` |
| roster / status 会话层 | ✅ | `roster.ts`、`status.ts` `none/idle/busy/died` |
| 输出帽 + 尾窗 | ✅ | `output-ring.ts`、`tailWindow` |
| **native session id** | ❌ | 池键 `${agent}|t:${target}`，回执无 identity |
| **同 target 多会话 / 并行** | ❌ | 同上，单键单会话 |
| **command id 账本** | ❌ | 只有 jobId，且仅 handoff/background 时有 |
| **env delta** | ❌ | 回执只有 `cwd` + `ttlSec` |
| **显式 close** | ❌ | 只有 TTL / row teardown |
| **per-session 状态卡** | ❌ | 只能对 target 发 status probe，不能对 session |
| stdout/stderr 分流 | ❌（PTY 固有，非缺陷） | tty 层合并；计划文档已记录 |

---

## 4. 设计不一致：为什么 native 只有一个 PTY

- native key：`${sessionKey}|t:${target}` → 一个 target 一个会话。
- BYOPTY key：`${sessionKey}|p:${label}` → 天然多会话、并行。
- 结果：**自建通道比 BYO 通道能力更弱**，与"原生不能比 BYO 降级"直接冲突。
- 人的参照：浏览器 tab / tmux window。真正需要并行的场景是"长任务阻塞 + 另一条边界清晰的任务"，这时排队就是错，拒绝并让模型另开才是对的。

---

## 5. 重构方向（user 2026-10-19 裁决，整理）

### 5.1 身份与命名空间

1. 创建 = `<transport-target>:pty[:label]`（`ssh:dev4:pty`、`ssh:dev4:pty:build`、`docker:corti:pty`、`byop:pty:build` + `spawn`）；**`:pty` 是保留后缀**，`target` 里出现即表示"发起 PTY"，不再有 `mode`。
2. 复用 = `pty:<id>`（label 为别名，`pty:<label>` 亦可）；同 machine 可无限 new，并行是一等能力，不排队。
3. BYOP 与 native 同一类对象：创建入口不同（machine target vs `spawn`），之后一律 `pty:<id>`；`connection` 对 BYOP 写 `BYOP`。
4. 回执第一个字段 = session id（label 作为可选别名字段并列）。

### 5.2 回执字段（顺序按 user）

| # | 字段 | 说明 |
|---|---|---|
| 1 | `session`（可选 `label`） | 可复用的 selector，如 `pty:p-7k2m`；有 label 时并列 `build` |
| 2 | `connection` | 底层连接身份：`ssh:dev4` / `docker:corti` / `incus:ctr-1` / `hub:b5rr` / **`BYOP`**（spawn 的真实 transport 不可知，见 §6.1） |
| 3 | `commandId` | 账本键，correlation 用（见 §7） |
| 4 | state | `cwd`、`envDelta`、`ttlSec`、`exit`/失败原因（`interrupted`/`died`/`closed`） |
| — | 现有 | `stdout`、`durationMs`、`truncated`、`outputStats`、`reconnected`、`running`、`jobId` |

### 5.3 并发与超时（user 定）

- **超时**：挂起成 job，保持现状（P4/P5）。
- **忙碌**：同 session 新命令**直接拒绝**，不排队；等多久、杀不杀由模型决定。
- **并行**：另开一个 PTY，或改用 oneshot。

### 5.4 close（已定：`action:"close"`）

`remote({action:"close", target:"pty:<id|label>"})`：关闭并回收 session，幂等 no-op；语义与互斥规则见 §6.3。

### 5.5 账本 = workbench 的支点

- `{target:"pty:<id>"}` 无 `cmd` → **session card**：connection、state、cwd、envDelta、ttl、最近 20 条命令（commandId/摘要/exit/耗时）。
- 账本条目复用 `jobId`（已有通道），不另造第二套 ID。
- 保留窗口 = **最近 20 条**（user 定案）；cmd 脱敏见 §6.5。

### 5.6 术语

- 采纳："**PTY 是 one-shot 的 stateful 超集**"（替换"stateful one-shot"）。
- 定位二分：**toolbox**（提供动作）+ **workbench**（提供状态）。one-shot 已经把 toolbox 做成熟；PTY 要补的是 workbench。

---

## 6. 讨论点（2026-10-19 部分已定案）

### 6.0 定案（2026-10-19，两轮汇总）

user 2026-10-19 拍板；第三轮（内联 `:pty`、close、mode 退休、范围）见 §6.7。

| # | 定案 | 位置 |
|---|---|---|
| 1 | **BYOP 并入 PTY**：(a) target 字段里两者同行、同一个东西；(b) 回执 `connection` 对 BYOP 直接写 **`BYOP`**——spawn 底层是 SSH/Docker 还是别的 transport，工具无从得知，不猜 | §6.1 / §6.4 |
| 2 | **session ID 不允许指定名称**，只自动生成 | §6.2 |
| 3 | **env delta 只回变量名 + 变动标记**，不显示真实值；要值就命令行自取 | §6.5 |
| 4 | **账本保留最近 20 条** | §5.5 |

### 6.1 第二个字段叫什么？（已定：connection）

| 候选 | 优点 | 问题 |
|---|---|---|
| `transport` | 工程语义精确（ssh/docker/incus/ws） | 值里混了 target；BYOPTY 没有"工具建立的 transport"，会写成谎言 |
| `origin` | 短 | **已被占用**：`PtySession.origin` = spawn 原文；且语义是"从哪来"，不是"接在哪" |
| **`connection`** | 读作"这个会话接在 X 上"；`ssh:dev4`、`BYOP` 都自然；与 `ssh` 注册的连接身份同族 | 与 `ssh:{host...}` 注册参数同名，需要在文档里区分"注册身份 vs 会话连接" |
| `machine` | 直观 | BYOPTY 无 machine，退化 |

**定案：`connection`**。取值 `ssh:dev4` / `docker:…` / `incus:…` / `hub:<m4>` / **`BYOP`**（大写）。BYOP 不写 spawn，也不猜底层 transport——这正是 user 2026-10-19 的定案理由。

### 6.2 session id 与 label（已定：id 自动、label 可选别名）

- **id 只自动生成**（`p-` + 4–6 字符），是唯一主键；不接受自定义 id。
- **label 可选**：创建时内联 `:pty:<label>`；作用域与 BYOP 一致（**每 agent 全局**，`^[A-Za-z0-9][A-Za-z0-9._-]*$`）；`pty:<label>` 与 `pty:<id>` 解析到同一会话。
- 同 label、同 connection → 复用该会话；同 label、异 connection → `E_LABEL_CONFLICT`，不执行任何命令。
- 创建（`{target:"ssh:dev4:pty"}`）每次都是**新**会话（tab 语义），回执给 id；同 connection 活跃会话数 >= 阈值时给一行 `notice`。

### 6.3 close 怎么做？（已定：`action:"close"`）

- **形状**：`remote({action:"close", target:"pty:<id|label>"})`——复用既有 `action` 枚举，不加布尔字段、不加新参数。
- **语义**：dispose 该会话（`exit` → 1s 宽限 → 整组 kill，复用现有 `dispose()`）；回执 `{session, connection, closed:true|false, reason?}`。
- **幂等**：对已关闭/已过期会话返回 `closed:false, reason:"not-found"`，**不抛错**——关闭动作不该因状态竞争失败。
- **互斥**：与 `cmd`/`spawn`/`stdin`/`timeout`/`run_in_background` 同时出现即 `E_PARAMS`（与 copy/rsync 同款校验）。
- close 之后再 `pty:<id>`：`E_NO_SESSION`，文案给重建形式 `{target:"ssh:dev4:pty"}`。

### 6.4 命名空间与创建语法（已定：内联 `:pty`）

- **规则**：`<transport-target>:pty[:label]` = 创建；`pty:<id|label>` = 复用；`ssh:dev4` 之类不带后缀 = oneshot。
- 解析：`:pty` 只在前面有非空 transport target 时生效——`ssh:pty` 是主机 `pty`，`ssh:pty:pty` 才是创建；`docker:pty` 同理。
- **`:pty` 为保留后缀**：端口需求走 **BYO SSH**（`byossh:` label）；原生 SSH transport 只读系统 ssh config，因此不存在 `ssh:host:port` 与后缀的冲突（user 2026-10-19 澄清）。
- BYOP 创建：`{target:"byop:pty[:label]", spawn:"…", cmd?}`；旧 `byop:<label>` 直接移除，不保留别名（不做向前兼容）。
- 不带 `cmd` = 仅创建（预热）并返回 id；带 `cmd` = 创建并执行。
- `E_LABEL_CONFLICT` 保留：label 已存在且 connection/spawn 来源不同 → 拒绝，不执行。

### 6.5 env delta 的粒度与安全（已定：只回名字 + 变动标记）

- **定案**：`envDelta` 只回**变量名 + 变更标记**（新增/修改/删除），**不回任何真实值**，因此不需要值脱敏。
- 理由（user）：真实值模型此前一定在上下文或某个路径里给过；需要值时命令行自取。
- 形态示例：`envDelta: {added:["DEBIAN_FRONTEND"], changed:[], removed:[]}`。
- 捕获：命令后追加一次 `env` 侧信道（或 digest 变化时才取全量），与 nonce 帧分离，不污染 stdout。
- 成本：每条命令一次 env 采集（毫秒级 + 字节），可接受；要有开关。

### 6.6 每 agent / 每 connection 会话上限

- 建议 8 条/agent/connection，超限诚实报错（`E_SESSION_LIMIT`），避免 ssh 进程失控。

### 6.7 第三轮定案（2026-10-19）：内联 `:pty`、close、mode 退休、范围

| # | 定案 | 说明 |
|---|---|---|
| 5 | **创建语法 = `<transport-target>:pty[:label]`** | 与 BYOP 内联 label 同构；`pty:<id|label>` 复用（§6.4） |
| 6 | **`:pty` 是保留后缀** | user 澄清：端口需求走 BYO SSH（`byossh:`），原生 SSH transport 只读系统 ssh config，不存在 `ssh:host:port` 冲突 |
| 7 | **`action:"close"` 确认** | 复用既有 action 枚举；幂等关闭（§6.3） |
| 8 | **`mode` 直接退休，不做向前兼容** | 新 schema 不含 `mode`，写了即 tool-call schema validation 失败；插件重装/重启即换新 catalog，同一 session 由 plugin mutation 提示 tool catalog 变化 |
| 9 | **本轮只改 beta-remote（better-dsh `remote`）** | SuperD Hub 侧 `remote-provider` 的 PTY 池/协议不动（§8 边界） |

配套规则（同时生效）：

- 不带 `cmd` 的 `:pty` = 仅创建（预热）并返回 id；带 `cmd` = 创建并执行。
- label 作用域与 BYOP 一致：每 agent 全局，`^[A-Za-z0-9][A-Za-z0-9._-]*$`；同 label 异 connection → `E_LABEL_CONFLICT`（不执行）。
- `byop:<label>` 旧形态直接移除，不保留别名。
- hub lane 仍以 `hub:<m4>:pty` 选择 PTY，但回执无 session id、不可并行（Hub 侧协议本轮不动，已知边界）。

---

## 7. 澄清：命令 ID ≠ 幂等

我上一轮写"幂等/命令 ID"是把两件事合并了，错误在我：

- **命令 ID** = 身份/账本键。解决的是"这条执行是哪一次、对应哪条回执/哪条 job"——相关性、审计、compaction 后恢复现场。
- **幂等** = 重放策略：同一逻辑操作重复执行，效果与一次相同。
- 关系：ID 是幂等的**前提**，不是幂等本身。有了 ID 才能做 **at-most-once**（重试去重：同 id 在窗口内直接返回既有记录，不重跑）；但 shell 命令的副作用任意，**真正的幂等无法保证**。
- 结论：账本先做（低风险），"retry dedupe 窗口"作为可选策略后做（需要明确窗口与语义）。

---

## 8. 工作量与复杂度估计

| 项 | 改动面 | 风险 | 估时 |
|---|---|---|---|
| native 并行 + 内联 `:pty` + label + ID | 池键、目标语法解析、selector、roster/status、描述 | 中（语法与 label 冲突语义，不是机制） | **2.5–3.5 人日** |
| 回执字段（session/connection/commandId）+ schema/render | `driver.ts`、`tool.ts`、输出 schema、渲染 | 低 | 1–1.5 |
| command id 账本 + session card | 会话内 ring、复用 jobId、status 渲染、保留策略 | 低 | 1–2 |
| env delta（已定：仅名字 + 变动标记） | 侧信道采集、diff、schema、测试 | 中（不能碰 framing） | 1–1.5 |
| close（`action:"close"`） | 枚举 + dispose 复用 + 错误语义 | 低 | 0.5 |
| busy/超时/描述/文档同步 | 文案 + 既有测试 | 低 | 0.5–1 |
| 4999 整包验收 + 报告 | pack/install/实测 | — | 1–2 |
| **合计** | | | **约 8–12 人日**（并行+内联语法+ID+connection+账本+close+env 仅名字；hub 不在范围） |

判断：**并行本身是最小的一块**（池键从 target 换成 session id，BYO 已经是这个形状），贵的是 surface、目标语法解析、兼容与测试；**env delta 是唯一有真正技术风险的**（侧信道不能碰 framing、每条命令的采集成本）；账本最小。**SuperD Hub 侧本轮明确不动**——`superd-hub/src/remote-provider.ts` 的 PtyPool（TTL 600、无 session id）维持原样；hub lane 暂为每 machine 单会话、不返回 id，作为已知边界记录在案。

---

## 9. 开放问题（第一至三轮定案已回填）

1. ~~`byop:` 是否本轮并入 `pty:`~~ → 已定：并入（§6.4）。
2. ~~session id 是否允许模型指定~~ → 已定：只自动生成（§6.2）。
3. ~~env 值是否默认回传~~ → 已定：只回名字 + 变动标记（§6.5）。
4. ~~账本保留窗口~~ → 已定：最近 20 条（§5.5）。
5. ~~close 是否用 `action:"close"`~~ → 已定：是，幂等 no-op（§6.3）。
6. 会话上限与"超限"文案（建议 8 条/agent/connection）。
7. session card 是否带最近一次输出尾部（倾向不带，避免与 `job_output` 重叠）。
8. native 并行后 roster 是否按 `connection` 分组展示。
9. ~~BYOP 无 label 创建形态~~ → 已定：`byop:pty[:label]` + spawn（§6.4）。
10. hub lane 的 session 化（session id / 并行）留待 Hub 侧协议变更，本轮只记录边界，不动 superd-hub。

---

## 附录 A：本轮 PTY 回执原文

```
[PTY] apt upgrade            [exit 0 · 97.7s · cwd /tmp]
[PTY] multica 安装链          [exit 0 · 4.4s · cwd /tmp/mc-upd]
[oneshot] 典型探针            [exit 0 · 2.7s · runner superd-run 0.3.1-d.b596 (aarch64-unknown-linux-musl)]
```

## 附录 B：代码证据

- `better-dsh/src/remote/nonce-framing.ts`：nonce/帧/初始化/尾窗。
- `better-dsh/src/remote/pty-session.ts`：状态机、`detach`、`E_SESSION_BUSY`、TTL 双条件。
- `better-dsh/src/remote/driver.ts:94`（TTL 900）、`:521-529`（pty 回执）、`:577`（`ptyTtl`）。
- `better-dsh/src/remote/tool.ts:45-58`（描述）、`:87-92`（mode/timeout 语义）、`:95-116`（输出 schema）。
- `better-dsh/src/remote/status.ts` `renderSession`/`renderPtySession`。
- `docs/superpowers/plans/2026-10-18-pty-interaction-enhancement.md`（R1–R4、P1–P19、Q6）。
- `docs/test-reports/2026-10-19-pty-p4p5-4999.md`（P4/P5 4999 验收）。
