# Remote 工具优化方向 — final draft v1（历史方向稿）

> **2026-10-10 后续裁决**：本稿保留原始讨论证据；大小包交付、Agent 实例级注册、SSH-only rsync tunnel relay、取消 3.5M 提醒及本轮范围，以 [Remote enhancement 规格](../specs/remote-tool-enhancement/spec.md) 和 [实施计划](../superpowers/plans/2026-10-10-remote-tool-enhancement.md) 为准。不是对本稿所有技术判断的实现验收。

- 日期：2026-10-09（Asia/Hong_Kong）
- 作者：dev3-deepseek-default（first-person 实测 + 代码检查）
- 状态：**final draft v1，已定稿并同步 PC**。PC 路径：`docs/10_plans/2026-10-09-remote-tool-optimization-directions.md`；dev3 本地：`docs/plans/` 同名。
- 证据基础：
  - 2026-10-08 first-person 测试轮（`docs/test-reports/2026-10-08-superd-hub-first-person-0.3.0-a.md`）
  - 2026-10-09 补充实测：native `remote` 工具（roster / ssh:pc 小命令 / 4.2KB inline E2BIG）、同 block 双 bash 并发探针
  - 代码：`better-dsh/lib/remote/plugin.js`（1189 行）、`super-dsh/superd-hub/dist/exec.js`；PTY 输出语义（`createNonceFrameParser` / `tailWindow` / `OUTPUT_HARD_CAP`）已逐行确认

## 0. 定位（共识，先立住）

Runtime agent 什么都会手搓——ssh、scp、nohup、分块 base64，它都能在十几个步骤内搞定。我们提供的是**便利层**：省步骤、减出错面、带上 hub 独有的连通性知识（pairing、roster、可达性）。不是给人用的 CLI，也不是给硬编码程序的 SDK。每个 feature 都要过一道账：**比手搓省了几步、少错了什么**。

## 0.5 架构归属与 hub 接入（本轮拍板）

**唯一开发主线 = better-dash 的 remote 工具**（better-dsh 插件包的子包），后续所有开发计划都按这个归属执行。

- **hub 探测**：remote 工具启动时判定 super-dash hub 是否在场。
- **在场** → 把 hub 的 WebSocket PTY **包装接入**，成为一种 target 字段，与现有 `docker:` / `incus:` / `ssh:` 并列（如 `hub:skc8`）。包装层等同 bring-your-own-PTY——工具替模型把 WebSocket 连好、包成一个 target 对象，功能对标 SSH：**PTY + 文件传输，即够**。一个工具同时覆盖 transport 层（ssh/docker/incus）和 mesh 层（hub machines）。
- **不在场** → 没有 WS target，工具照常只做 transport 层。
- **BYO 不设 WebSocket 层**：能搓出 WS-PTY 的 agent 搓到 PTY 那步直接交给 byop；hub 在场时由工具代为包装，无需用户/模型手工接线。
- super-dash 作为独立包安装时这套能力如何 deliver —— 用户另行与相关方沟通，不在本文档范围。

两个执行面的事实盘点（实测确认）：

| | hub exec（superd-hub） | native remote（better-dsh） |
|---|---|---|
| cmd 上限 | `CMD_MAX_CHARS = 4096` **字符**（exec.js:23，`cmd.length` 计，非字节非行） | 无显式常量；实测 4.2KB 撞 kernel `spawn E2BIG`（裸 errno，与环境饱满度相关，非固定阈值） |
| stdin | ❌ 无 | ✅ 有（`E_STDIN_WITHOUT_CMD` 门 + 直写 child.stdin，plugin.js:34/912） |
| 输出窗口 | 30 000 尾部保留 | 返回窗口 `maxOutputChars ?? 3e4` 尾部保留；**累积上限 `HARD_CAP = 4e6`（4MB）** ←—"4MB" 的出处，是输出不是输入 |
| 超时 | [1,600]s | 默认 120s 可覆盖 |
| 目标 | roster machine id（`skc8`） | ssh config / docker / incus / byop label |

**"4MB 也行"的勘误**：4MB 是插件对输出流的累积截断（plugin.js:12，pty 侧 :171 同值），不是 inline cmd 容量。inline cmd 走 execve argv，物理上限 MAX_ARG_STRLEN=128KB/参数，且实际更低（本次 4.2KB 即 E2BIG）——大脚本靠 inline 扩容是死路，文件载体才是正解。

## 1. P0-A 命令长度：维持 4096（使用者裁决）

**4096 字符，够，不加。** 裁决来自第一人称使用者（本 agent）而非直觉：

- 实测整轮测试 + 文件传输 + 代码勘察，单条命令最长也就几百字符级别；4096 对单条 shell 命令是宽裕的。
- 命令越长，LLM 出错概率越高（引号嵌套、转义、变量展开任何一环错了整条报废）——上限本身就是防错护栏，不是瓶颈。
- 超出单条命令的需求有更好的归宿：拆多步（PTY 持久会话天然支持分步执行）或走 §2 的脚本文件载体。
- 都是硬编码常量，改起来无障碍——但无需求，不动。

## 2. P0-B 脚本文件载体（script entry）

- 新增 `{script:"/abs/path"}`：本地读文件 → **stdin 注入 `bash -s`**，不走 argv。
  - 一石三鸟：绕开 argv/E2BIG/4096 全部容量限制；免转义（脚本原文直传）；heredoc 场景自然归并（heredoc 本质就是"把 document 当脚本"，直接存成文件更干净）。
  - write-once-run-many：agent 生成一次脚本，之后反复引用执行，省 re-generation token——这是 utility 层面真正的 enhancement，不只是扩容。
  - 实现落点：native remote 已有 stdin 通道，`{script}` 就是"读文件→stdin"的糖；hub exec 补 stdin 后同一模式复用。

## 3. P0-C 取消 local 腿（已确认）

- **确认取消**（保留 `localExec` 配置位，默认 off）。machine 缺省 = local 的 exec 腿移除。
- 理由：① 名称即边界（remote execution）；② local exec 与原生 bash 完全同权，原生一旦上沙箱它就是旁路面（2026-10-08 报告已论证）；③ local 场景 native bash 严格占优，零损失。
- 历史动机（local bash 无 PTY persist，所以 local 也给了 PTY+oneshot）→ **上移原生**：persistent shell 是 harness 通用能力，应该进 DSH 原生 bash，不该由 remote 插件顺手补——顺手补的代价就是今天要回头拆。
- 迁移：依赖 `execEnabled` 门（dist 中已存在）做过渡开关。

## 4. P1 oneshot stdin（hub exec parity）

- native remote 已有（见 §0.5 表），hub exec 缺 → **补齐**。与脚本载体是同一通道的两层。
- 当时开发没考虑到，属于明确不足，直接加。

## 5. P1 后台作业与流式：直接参考 DSH 上游机制

- **后台作业只加在 oneshot**：`{run_in_background:true}` → 返回 jobId → 增量读取 + 完成通知。**实现直接照 DSH 上游 bash 的 job 模型抄**（run_in_background / job_output 增量读 / 完成通知），本 session 亲测该模型够用，不自创。
- 与 PTY 分层：PTY 是"维持一条流式连接"，工具不探测内部进度；PTY 内长任务用 shell 原生 `(cmd > log 2>&1 &)` 模式（已文档化），后台作业不覆盖 PTY，两层不冲突。
- **不做 push 流式**（连续弹出 stdout 的通知模型）：打断推理 turn、token 不可控、中间态大多无行动价值。pull-delta（完成通知 + 按需读增量）就是 DSH job 模型本身。600s 超时上限维持（长任务由后台作业覆盖）。

## 6. P1 PTY 输出：现状语义与改善（代码确认）

现状（plugin.js 逐行核实，纠正早轮"会话全量缓冲"的说法）：

- 每轮 dispatch 一个独立的 `createNonceFrameParser`（OSC 133;D nonce 帧解析器），输出**从零累积**——跨轮不重复，上一轮的输出不会再来一遍。这点是对的。
- 返回 = **本轮命令输出**的尾部 30k 窗口（`[truncated: showing last N of M chars]` 头标 + 总长信息）；累积滑窗 4MB，超限静默丢头。

两个真实限制（改善空间）：

1. **单轮 >30k 中间段不可续读**：窗口只给尾部，超长输出（大构建日志）中间段对模型不可见，只能重定向到文件再分段 cat。改善：提供续读（backlog/offset —— 在 4MB 滑窗内按区间补读）。**P2**。
2. **运行中不可中途查看**：dispatch 阻塞到 exit 帧，命令没跑完就看不到任何输出。改善：dispatch 挂起时允许另发 probe 读当前缓冲。复杂度高，**P3 讨论**，不强求——长任务现行最佳实践（重定向 + oneshot 分段读）写入工具文档作引导即可。

## 7. P1 BYO 收敛：byop + byo-ssh（已确认）

- **byo-ssh（新增）**：`{target:"byossh:label", spawn:{host, user, port, key, proxyJump…}}` ——agent 运行时发现 host 变更/key 更换/需要 proxy，现场注册为 label target，之后直接 `target:label` 复用。
- **byop（保留）**：现状能力不动。
- **不设 BYO-WebSocket 层**：hub 在场时工具代为包装（§0.5）；不在场时裸 transport 无可操作面。
- **不设 BYO-docker/incus**：守护进程在宿主系统上；实例起来后名字已在，refresh roster 即识别。唯一边缘场景 remote docker daemon（DOCKER_HOST）= byo-ssh 先达宿主再 docker，被 byo-ssh 覆盖。

## 8. P1 文件操作（本轮重点能力）：copy + rsync 跨 machine

**功能清单裁决**：wrap 的只有 copy 和 rsync 两个。rm/mv/mkdir/chmod/tail/stat 走 exec 即可；checksum/stat 折进 copy 回执，不单列 op。

schema 草案（扁平 action，单工具单枚举）：

```
{action:"copy",  src:"pc:/abs/path" | "/local/path",  dst:"dev3:/abs/path",
 verify:true,   // 双端 checksum 回执，替代手工两次 md5sum + 比对
 mkdir:true}    // 目标侧自动建父目录

{action:"rsync", src, dst,
 delete:false, excludes:["*.log"], dryRun:true,  // 预览先行，对齐 ast_edit dryRun 心智
 preserve:true}
```

- 寻址统一 `[label:]path`，不带 label 即本机——两个端点各可 local/remote，天然覆盖 推/拉/远到远。

### 8.1 星型中转拓扑（hub 为中心）

- 两台 machine 之间**不解析、不代建**直连通道——不在 dev4 上创建 dev2 的 SSH 条目再回连。
- dev2 → dev4 传文件 = **dev2 → hub → dev4 两跳**，每一跳都是 hub↔machine 的既有通道（exec / WS PTY）。网络拓扑以 hub 为中心向外辐射。
- **嵌套规则**：SSH 类目标可以嵌套（ProxyJump 本就是嵌套 SSH），能嵌就嵌；**WebSocket 不能嵌套**（确认：WS 是应用层协议，hub A 的 exec 里连 hub B 的 WS 并非现成能力）——但星型设计让嵌套**无必要**：任何两点的路径都是"各自回中心"。
- hub 中转的暂存落点：`.scratch` 约定目录，两跳暂存（源端 → hub 暂存 → 目标端），不做源到目标的流式管道（简单、可校验、可断点）。

### 8.2 能力优先级与清理纪律（本轮拍板）

能力排序：**① 增量（rsync delta）→ ② 校验和回执（双端 hash）→ ③ 清理纪律**。

- **增量**是这次重点：迭代同步大目录时 delta 传输省的时间是数量级的；trailing slash / `--relative` / excludes 这些手搓高频出错点由 op 参数化兜住。
- **校验回执**：`verify:true` 一次返回双端 checksum（本 session 传报告手工做的就是这件事：两次 md5sum + 比对）。
- **清理纪律（工具行为规范，不是可选项）**：hub 作为中转站，**双方校验通过之后必须清理自己的暂存现场**——校验通过 = 文件责任已交割，中转方不留垃圾。默认 auto-clean；失败时保留现场供排查并在回执中明示。否则中转站垃圾越积越多，纪律失守。
- 战例（为什么这是重点）：0.1.7-g 轮 ssh 被宿主 key 变更卡死，8KB 报告走了 6×3800 字符 base64 分块 exec；以及 pairing-only（无 ssh alias）的 machine 对，手搓 scp 根本不通——copy op 走 hub 自己的通道，这是手搓给不了的。

## 9. P2 单调用扇出（讨论项，记录在案）

- 实测：同 block 双 **bash** 也串行（A-end 913.74 → B-start 913.88，间隔 140ms）→ 串行是 **harness 派发行为**，与工具/transport 无关（更正 10-08 报告"MCP 面上串行"的错误归因；hub 本身并发，0.1.7-g raw wire 已证）。
- 出路：`{cmd:["…","…"]}` 数组参数单调用扇出（hub 侧天然并发），或上游改 harness 派发。优先级低。

## 10. 明确不做（防 scope 蔓延）

- ❌ inline cmd 扩容（正解是文件载体，见 §2）
- ❌ rm/mv/mkdir 包装（exec 即可）
- ❌ 命令黑名单/过滤（对 LLM 生成的命令必然是筛子；安全边界在 pairing 与宿主权限，不在这）
- ❌ push 流式
- ❌ BYO-WebSocket / BYO-docker / BYO-incus

## 11. 优先级汇总

| 级 | 项 | 一句话 |
|---|---|---|
| P0 | script 文件载体（stdin/bash -s 注入） | 容量+转义+复用三杀 |
| P0 | 取消 local 腿（localExec 默认 off，已确认） | 名称即边界，堵沙箱旁路 |
| P0 | 架构归属：better-dash remote 为主线，hub WS 包装为 target 字段 | 一个工具覆盖两层 |
| P1 | hub exec 补 stdin | parity，与 script 载体同通道 |
| P1 | oneshot 后台作业（照抄 DSH 上游 job 模型） | pull-delta，不做 push |
| P1 | byo-ssh（byop 保留，其余 BYO 砍掉） | 运行时发现连接的注册口 |
| P1 | copy + rsync 跨 machine（星型中转 + verify 回执 + 清理纪律） | 本轮重点能力 |
| P2 | PTY 单轮续读（backlog/offset） | >30k 中间段补读 |
| P2 | cmd[] 扇出 | harness 串行派发的出路 |
| P3 | PTY 运行中中途查看、ephemeral `ssh://` target | 谨慎，先不做 |

## 12. 开放问题（开发中拍板即可）

1. `HARD_CAP` 4MB 输出累积上限是否暴露为配置项
2. rsync 依赖对端装有 rsync —— 探测缺失时的降级策略（copy fallback + 提示）
3. PTY 运行中中途查看（probe 读当前缓冲）是否值得做，或文档引导"重定向 + 分段读"为止
4. ephemeral `ssh://user@host:port` 免注册一次性 target 是否引入
5. super-dash 独立安装时 remote 工具 hub 接入能力的交付方式（用户与相关方沟通中）
