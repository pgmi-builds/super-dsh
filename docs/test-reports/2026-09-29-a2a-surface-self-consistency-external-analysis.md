# External analysis — superd-hub A2A 工具面自洽性评审（合并 new_conversation 与 send）

- **Origin:** 外部 agent（dev3-deepseek-default）产出，2026-09-29，实测 0.1.7-g + 代码核对 0.1.7-n。
- **Reviewed:** superd-hub 于 0.1.7-n 对照源码重核（2026-09-30）。**诊断采信，药方三处有异议**（`injected` 改名 / 冗余寻址 auto-derive / 拆工具），见文末「本仓库复核结论」。
- **归档理由:** 这是 0.1.8 工具面轮（surface/substrate 拆分 + `send` 唯一门）的直接输入。

---

（以下为外部分析正文）

先更正我自己的取样点：我这轮实测跑在 **0.1.7-g**，而 dev3 现在装的是 **0.1.7-n**。下面所有"代码事实"都是我在 0.1.7-n 上重新核对过的，实测现象则标注为 0.1.7-g。

## 一、先修正一个前提：它其实不太像 messaging app

`superd-hub` 里**没有 reply 这个动作**。reply/notice 是入站信封产物，而且带 provenance 标记：`form=relay`（对端真的走了通道）vs `form=transcript`（对端没理你，运行时把它 turn-end 的最后输出"收割"给你），并附一句明说这件事的 note。这是很扎实的一笔——它承认了"对端可能根本不在跟我对话"。

机制层自洽，模型面不自洽。病灶不是"分成两个入口"这个选择，而是**两处迁移各做了一半**，而且旧故事没撤干净。

## 二、new_conversation 能不能并进 send：不是能不能，是**已经并了，只是没并完**

`newConversation()` 内部：造 `messageId` → 造 `kind:'new-conversation'` 信封 → `routeEnvelope`（和 send 同一个原语）→ 回执同类型。**开新会话 == 发一封 `kind:'new-conversation'` 的信封**。它的真名是**信封的 kind**，不是模型的动词。而且 send 的说明已写"omit conversationId to open a new conversation"——**两扇门已经等价了**。

但现在两扇等价的门、两套契约：

| | `new_conversation` | `send` |
|---|---|---|
| receipt | `{conversationId, sessionId, agent, machine, warning?}` | `{outcome, messageId, conversationId, sessionId, error?, note?}` |
| 有 messageId 吗 | **没有**（id 造了又丢掉） | 有 |
| 失败形态 | **throw** | 结构化 `{outcome:'failed', error}` |

第一条消息是整个会话里最该有投递凭证的一条，偏偏它没有 `messageId`、没有 `outcome`。

所以方案不是重构，是**删掉一层映射**：

```
{action:"send", to:"<m4>-<a6>", conversationId?, title?, message, delivery?: queue|steer}
receipt 恒定: {outcome, messageId, conversationId, sessionId, created:bool, error?, note?}
```

`conversationId` 省略 ⇒ `created:true`；`title` 只在 `created:true` 时有意义，否则报错或警告；`new_conversation` 保留成严格别名或直接删。

**为什么当时没这么做**：两条腿来自两条实现路径（spawn 走会话创建、deliver 走投递）——surface 是**从 transport 1:1 抬上来的**，不是从模型的任务模型设计的。receipt 形状不同，就是它们曾走不同代码路径的化石。典型的 leaky abstraction：工具面镜像了 hub 内部结构，而不是对端的心智模型。现在 wire 已经收敛成"信封 + kind"，工具面没跟上。

## 三、"harness 非常驻"论证成立，但推理链要短一截

Agent Harness 不是常驻叙事，以 session 为单位、有上下文上限。它推出：conversation 必须是显式、持久、可 resume 的一等概念（有 id、registry、title）；title 是上下文死亡后的连续性锚点；投递必须是 mailbox + wake，不是同步 RPC。它**推不出**"所以要有独立的 new conversation 入口"——会话创建与消息投递的语义差别用一个 receipt 字段（`created:true`）就能完整承载。

而且真正的缺口在另一个地方：**连续性会无声降级**。实测 PC 整机掉线，registry 记录（含 `initiatorSession`）还在，恢复后**没有任何机制告诉模型"对端 session 被替换/压缩/重启过，叙事连续性可能断了"**。receipt 里有 `sessionId`，但没有 continuity/compaction 通知。这才是"以 session 为单位"应该暴露给模型的东西。

## 四、实测 + 0.1.7-n 代码核对的缺口清单

**真缺口**
1. **open 无投递凭证**：`messageId` 当场丢掉。
2. **打开事件是伪消息**：`A2A_OPENING_MESSAGE='(conversation opened)'` 是常量、无类型、无 id。正解：建模成 typed message（`kind=open` + messageId）。
3. **`stop` × queue 交互未定义**：stop 只取消活动 turn，那已排队（queue）的消息在 stop 之后还投不投？

**词汇过度承诺（最隐蔽的一处）**
4. R4 明确退役了跨线 completion watch——"receipt 只回答 inbox 接受"。但字段仍叫 `receipt`、值仍是 `outcome:"injected"`。接口里还留着 `delivery/onWatch` 这些 "for wiring compatibility" 的 vestigial deps。

**冗余与解析**
5. **冗余寻址**：`agent` 必须重复传，而 registry 记录里明明有 machine/agent/sessionId/initiatorSession。这凭空制造了一整类 mismatch 错误。
6. **解析与契约不符**：`parseAgentAddress` 只按第一个 `-` 切，不校验 `<m4>-<a6>` 形状，尽管描述声称地址就是这个格式。实测 `no-such-agent-zzz` → `a2a/unknown-machine "no (not paired)"`。加正则，错误区分 malformed / unknown。
7. **失败仍铸 id**：实测失败的 send 也返回了 `messageId`。给一个从未投递的消息发 id，模型后面可能真的去引用它。另外 stop 走 throw、send 走结构化 failed——失败形态两制。

**教学缺口**
8. **没有生命周期叙事**：五个动作各自描述了"形状"，但没有一句"open 一次 → 之后一直 send → 唤醒时 sweep 一次 read → steer 仅紧急 → stop 仅离题"。
9. **`read` 与 "NEVER poll" 有张力**：live 时 push、非 live 时 buffer，而模型无法观测"我是否曾经非 live"，所以"我漏没漏"只能靠 `read` 回答，而指令重点全在 NEVER poll。措辞该是"别在等回复时轮询；在唤醒/边界处 sweep 一次 read"。
10. **跨 surface 冲突**：同一个模型上下文里，orch-a2a 的 `a2a_send` 用的已经是统一形态（"传 title 或 session_id 则继续，否则开新会话"）+ `a2a_close`，而 superd-hub 是分裂形态。两个 A2A 心智模型打架。
11. 顺带（低优先级）：`superd-hub` 一个 action 枚举里塞了 7 条腿，把 mesh 消息（a2a）和远程 shell（exec）混在同一层。

## 五、一句话结论

机制层不需要改；工具面需要**把迁移做完**。wire 已经收敛成"信封 + kind"，surface 还留着两扇门；completion watch 已经退役成 inbox-acceptance，词汇还写着 injected。**要么把迁移做完（一个 send + `created` 字段 + typed open + 统一 receipt），要么把旧故事讲圆——别两头挂着。**

---

## 本仓库复核结论（superd-hub，2026-09-30）

**采信并已核对的（代码锚点均 0.1.7-n）：**
- 两扇门等价：`send` 在 `row === undefined` 时造 `kind:'new-conversation'`（`a2a-service.ts` ~1004）；`newConversation` 造 `messageId` 又丢掉（~918 vs 返回 `{shortId, sessionId}`）。
- `parseAgentAddress` 只按第一个 `-` 切、不查长度/字母表（`hub-tool.ts` ~172-182）。
- 失败 send 仍铸 `messageId`（`fail()` 恒带 `messageId`）；receipt 契约写 `messageId` = "durable identity of the injected user message"——失败时返回违反自身契约。
- `stop` 只路由 turn-scope cancel，队列语义无记载。
- `A2A_OPENING_MESSAGE` 常量在位（`a2a-service.ts:325`）。

**三处异议：**
1. **`injected` 不该改名 `accepted`**：`A2aReceiptOutcome = 'injected'|'queued'|'pending'|'failed'` 上明写 OMP-hub-compatible——是 wire 兼容值，不是自由命名。正解是降词汇不动 wire：`injected` 恒附 note + 描述写死 accepted≠delivered。
2. **冗余寻址（#5）不成立**：mirror row 上两个合法地址且路由不同——`{self, hostAgent}`（本地路由）vs `{row.machine, row.agent}`（D20 write-back 路由到发起方 hub）。`agent` 是**方向选择器**，不是冗余。正解是保留必填、mismatch 报错列双合法地址。
3. **拆工具（#11）不支持**：拆成 `superd-hub` + `superd-exec` 得两个注册/描述/initiator 绑定，收益只是少点超分派。正解是描述里分三族（观察/投递/控制 + shell）。

**已关闭（0.1.7-n，别重开）**：#9（read 描述已 "sweeps buffered while down" + send note）、R1/R2（信封 + reason 三分类已落地 h…m）、F1（exec `outcome` 枚举含 `spawn-error`）。
