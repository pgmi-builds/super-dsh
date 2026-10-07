# ADR 0011 — Hub 即邮局：机器寻址 + 不透明管线

- 状态：accepted（2026-09-28 user 裁决，pivot 级）
- 关联：ADR 0009（GatewayFace 本地/远端同形原则——本 ADR 将该原则**上移一层**重新应用）、
  spec `machine-mesh-a2a` §1 D16–D19 / §7（改形落档）、ADR 0003（不存原始会话——
  本 ADR 是其在 wire 侧的推论加强）

## 背景

P3 交付的 A2A 里，发起方 hub 经 RemoteGatewayFace **直打远端 session plane**
（跨线 `session/create|prompt|follow|cancel`），并跨线解析 `SessionFollowFrame`
抽取最终 assistant 文本做完成捕获。这使本机 hub 成为「远端 live session 的
handler」：它必须理解对端的 session-plane 词汇与格式——恰是上游漂移最快的面
（session log format 版本、follow 帧形状、turn 语义；0.1.7 已见上行帧协议新增）。
沿此形态延伸，将来还要 handle 远端 WS PTY、兼容远端 V1/V2/V3……复杂度随
（机对 × runtime 版本）几何增长，每个 hub 都要自建兼容层。

触发观察（user，2026-09-28）：单向配对视角下，"A2A service" 悄悄变成了
remote session handling——无论配对方向如何，这个形态本身就是错的。

## 裁决

hub 是**邮局**。四条不变式：

1. **跨机线上只跑不透明流量**：机器寻址（`<m4>-<a6>`）+ pass-through 的不透明
   载荷——A2A 信封、回信/通知信封、将来的 PTY 帧与呈现流。host 永不解释远端
   session-plane 内部结构。需要版本化的唯一协议 = hub-to-hub 信封协议本身，
   一次、集中。
2. **业务逻辑与 session 同居**：create、注入、完成捕获、turn 语义解释、取消
   ——全部在 session 所在机器的本机 hub 内完成（同机同版本，兼容性白拿）。
   「发起 live session」= 投 new-conversation 信封，由远端 hub 在它本机发起。
3. **呈现车道豁免**：host UI 可以消费远端数据但**只做呈现**（RemoteGatewayFace
   保留给浏览/呈现远端 session plane）。schema 漂移由 corids slot 系统自愈吸收
   （缺字段降级，绝不炸业务逻辑）。呈现永不反推业务逻辑。
4. **负担摊平（distributed）**：每个 hub 只 handling 自己机器的会话。「handle
   remote live session」「compatible with remote V1/V2/V3」这类义务整体消失。

ADR 0009 的「本地 in-process 与远端 wire 对消费面同形」原则**上移一层**重新
应用：同形的是 **A2A 信封协议**（本地 = 同一协议的进程内短路；远端 = 上线）；
session plane 退回每个 hub 的边界之内。

## 后果

- federated A2A 路径改造：send / new_conversation → 信封投递到对端 a2a ingest；
  回投 = 对端完成捕获后发**回信信封**；stop = stop 信封；跨线 session/follow
  完成订阅与 SessionFollowFrame 解析从 A2A 路径删除。
- conversation 注册表双侧化：发起方行 + 对端镜像行（shortId 发起方铸造、信封
  携带、对端原样收养）——信封的 conversationId 续聊条款处处兑得现。
- roster 保持瘦；session 列表移 **per-agent 状态查询**（orchestra agent-listing
  窗口语义），5min 周期 sweep + 显式 per-machine live fetch，全单向 API（D18）。
- conversation title 概念剥离（hub 自有、immutable、`[undefined]` 占位、永不
  write-through 上游 runtime session title）见 spec D17。
- P4 remote exec 同纪律：PTY 挂在远端，host 只 pass 帧（BYO-PTY 状态机照抄、
  通道换 WS 的原方案不变，但宿主侧不解析远端会话内部）。
- 双向拓扑 = mutual pairing（双侧各自贴 token，机制零新增）；auto-reverse-
  registration 留后续策略讨论（D19）。
