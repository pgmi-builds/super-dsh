# 外部先例对照 — DSH subagent / Agent Teams / OMP hub

服务对象：`docs/specs/machine-mesh-a2a/spec.md` 的 D20–D22（2026-09-29 回复语义
裁决）。本文件记录三条外部先例的**源码锚定事实**、我们各自采纳/已具备/拒绝的
对照，以及对最初调研稿的两处事实修正。锚点版本：`dsh-v0.1.7-rc.1`
（`upstream/deepseek-harness`）。

---

## 1. DSH subagent（`packages/subagent/subagent/src/`）

### 1.1 relay / settled 的刻意分型 — `continuation-messages.ts:12-35`

- `AgentMessageSource`（:12）`kind:'agent-message'` / `form:'relay'` —
  "Durable attribution for one **model-authored** message"、"content the
  **sender chose**"。
- `SubagentSettledMessageSource`（:25）`kind:'subagent-settled'` /
  `form:'notice'` — "**the runtime's own account** of a continuable child
  settling"。原注释（:22-24）：

  > Deliberately a different kind from AgentMessageSource: an Agent message is
  > content the sender chose, while this message is the manager stating what
  > became of the child, and a transcript that merged them **would credit the
  > child with words it never wrote**.

**采纳方式（D20）**：分型的诚实性采纳，wire 分裂不采纳——我们的信封统一为
`reply`，分型发生在 **hub 铸造的前缀**上（主动回复 `Agent <addr> replied:` vs
转写代投 `… — transcribed from its turn-end output, never sent via channel`）。
sender 拿到的都是普通 message，来源一眼可辨。

### 1.2 settlement 的判定与投递纪律 — `continuation-activation.ts:864/:871`

管理器跟生命周期走到终局，`notifySettlement()` 投不出就 fail-loud
（`continuation.ts:348/:355`："activation is being disposed; the message was
not delivered" / "direct parent is not live; the message was not delivered"）。
**采纳**：notice 投递失败必须显式（进有界待发缓冲，如实报 `send-failed` /
`stream-dead`），不装作没事。

### 1.3 stopReason 分档 — **拒绝采纳（D20 核心）**

completed/aborted/max-tokens/refusal/error/未知名的诚实分档，是**监护人对
委派任务的裁决语言**（refusal 注释明示「父 agent 不能当成已完成」）。我们的
sender 是对等收信人、不是监护人；通道只消费两个机器事实——**turn 边界 +
last output**——定性词一律不进通道面。stop 的 abort 事实由 stop 同步回执
`{stopped:true}` 承载。

### 1.4 assistant-output 采集规则 — `assistant-output.ts:1-10/:52`

> "Canonical selection of a child's final assistant output… the **last
> non-empty assistant message**. An empty-content message **records usage
> only**… else the **accumulated assistant text**."

**采纳（逐条）**：转写兜底的采集规则 = last non-empty assistant message、空消息
不覆盖、兜底累计流式文本。只借规则，不借 job 语义（run-settlement 的
completed→outcome / aborted→killed / error→failed 映射**不进**我们的面——
对等通道无 delegation/result 词汇）。

### 1.5 continuable 回报指引 — `continuation-messages.ts:81-96`

> "Your parent agent id is … Before you finish, send your result to that
> agent with `send_message({agent_id: …, message: "<self-contained result>"})`.
> The parent shares your workspace but **does not automatically receive your
> transcript, tool output, or reasoning**. Send earlier messages as well when
> a finding changes what the parent should do next; **sending a message does
> not end your turn**."

**采纳（教学信封 v3 的骨架，spec §7.3）**：三句对应我们模板的三句——
"sender 只见渠道内容" / "随时可发、发不结束 turn" / "结果经渠道投递"。
我们不写 parent/delegation 词汇（对等形态，都是 message）。

---

## 2. Agent Teams durable mailbox（`packages/experimental/agent-team` +
`docs/subsystems/agent-team.md`）

`docs/subsystems/agent-team.md:28`（账本纪律，一句全文）：

> "The Lead Session first stores the complete queued message. A target receipt
> is acknowledged only after its pending inbox item or recorded user message
> is **durable**, leaving **queued-minus-delivered** as the recovery mailbox."

配套纪律（README）：发送方**永不重发**（queued 已安全持久）；恢复按
queued−delivered 有序重投；被否方案 = "先把邮件写进目标 Session、再入 Lead
日志"——**目标侧的收下才是 ack 与去重边界**；保证边界如实声明 "in-process
retry + target Session 去重，**不是跨进程 exactly-once**"；协调记录只进日志、
永不进对话面（不占模型 token）；`wait_agent` 只等注册后的边沿、唤醒后重读
权威状态。

**对照**：

| 点 | agent-team | 我们（0.1.6-k 已落地） |
|---|---|---|
| ack 边界 | 目标 Session durable 持有 | 入站 ingest 按 messageId seen-set 重 ACK 不重执行 |
| 发送方纪律 | 永不重发，账本兜底 | park → sweep/重 POST → 目标侧幂等吸收 |
| 应答守卫 | —（同进程） | ingest 应答归一 v1 send-receipt（防投递成功却判失败的假阴性，§7.1 双投根因） |
| 诚实边界 | 不承诺跨进程 exactly-once | seen-set ≤128 LRU → *effectively-once*（spec §7.5） |
| 协调面 | 账本不进对话面 | registry/outbox/seen 全在 `<home>/superd/`，不占 session 面 |

> **事实修正 ①**（对最初调研稿）：「park 后 sweep 重投 + 接收侧零去重 = 重复
> 交付来源」描述的是 0.1.6-j 时代。0.1.6-k（`7a6db7e`）已落地目标侧去重 +
> 应答归一，即本节模式的 hub-to-hub 版；残余差异仅为有界 LRU vs 持久账本。

---

## 3. OMP hub

auto-delivery + wait（绝不轮询）/ no-double-delivery（投递即出队、仅失败进有界
缓冲）/ incoming 信封教学 / peek 与 consume 分离。

**采纳**：auto-delivery + NEVER-poll（工具描述保留、按 D20 改写措辞）；
no-double-delivery 与有界缓冲沿用。

> **事实修正 ②**：我们的 `read` **consume** 该缓冲不是「缺 peek」——unread
> buffer 只覆盖 session 不在线的窗口，`read` 是该窗口**唯一**的 drain（DSH/OMP
> 的 peek/consume 分离服务于 wait+peek 两个动作，我们只有一个动作）。待验
> seam：同一条 buffered 消息不得存在 read + splice 双路径（E5，spec §7.5，
> 0.1.7-a 钉死）。

---

## 4. 对照总表

| 先例机制 | 我们的对应 | 状态 |
|---|---|---|
| relay/settled 刻意分型（1.1） | 转写前缀标注（wire 不分裂） | D20，0.1.7-a 落地 |
| settlement fail-loud（1.2） | notice 投递失败进缓冲 + 如实报 | 已落地 |
| stopReason 分档（1.3） | **拒绝**——通道只消费 turn 边界 + last output | D20 |
| assistant-output 规则（1.4） | 转写采集规则（逐条） | D20，0.1.7-a 落地 |
| continuable 回报指引（1.5） | 教学信封 v3 骨架 | D20，0.1.7-a 落地 |
| 账本：目标收下才是 ack（2） | messageId seen-set + 应答归一 | **0.1.6-k 已落地** |
| 发送方永不重发（2） | park + 幂等重 POST | **0.1.6-k 已落地** |
| 诚实保证边界（2） | spec §7.5 effectively-once 声明 | 本轮落地 |
| peek/consume 分离（3） | read = down 窗口唯一 drain；E5 seam 待钉 | 0.1.7-a |
| 协调面不进对话面（2） | registry 族全在 hub 私有目录 | 已落地 |
