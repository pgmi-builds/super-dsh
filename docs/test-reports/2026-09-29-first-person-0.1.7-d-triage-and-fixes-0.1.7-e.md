# 2026-09-29 · dev3 agent《first-person 0.1.7-d》报告核查与处置（0.1.7-e）

**对象**：`2026-09-29-superd-hub-first-person-0.1.7-d.md`（dev3-deepseek-default，session 9b6dcc3a，第一人称 dev3→PC 全腿）
**核查方式**：逐项对代码与活体复核；F1 先复现再修（systematic-debugging）
**结论**：报告主张**全部成立**。1 真缺陷（F1）已修，F2/F3/F6 一并处置，F7 记档。

## Findings 处置表

| # | 定性 | 处置 | 落点 |
|---|---|---|---|
| **F1** 坏 cwd 静默失败（`exit:null` 空 shape，与 signal death 不可分） | **真缺陷，已复现确认** | spawn `error` 事件捕获诊断进 stderr（`exec: spawn failed — spawn bash ENOENT (cwd: /nonexistent-xyz-777)`）+ 新 `outcome` 字段四态 | 0.1.7-e `exec.ts` |
| **F2** `exit:null` 一哨三义 | **随 F1 修复消解** | `outcome: 'exited' \| 'signaled' \| 'timeout' \| 'spawn-error'`（端点透传；wire 腿对旧 peer 诚实推导——spawn-error 无法从旧形状恢复，降级 signaled 并注释）；工具 output schema 复用 send 的 `outcome` 字段（联合描述）；journal `exec.run` 非 exited 时带 outcome | 0.1.7-e |
| F3 注释说 "GET outbox" 而实路径 `/api/superd/a2a/outbox` | doc nit | a2a-row 注释改全路径（mesh-rpc 头注释本就正确） | 0.1.7-e |
| F4 非整数 timeoutSec 被 harness schema 先拒（parser 分支仅 HTTP 可达） | 层级注记 | 认可，无代码改动；exec.test 的 parser 分支本就直测 `parseOneShotExecBody` + 端点 400 | — |
| F5 pty 占位纪律 | 好评 | — | — |
| **F6** 远端 exec 无发起侧完成行 | 观察成立 | `a2a.exec.remote.done {machine, exit, durationMs, outcome?, truncated?}` 落在 a2a-row exec face post 返回后 | 0.1.7-e |
| F7 a2a turn 触发卡渲染 "Execution requested"（`turnTriggerDetails` 不识 a2a-relay/a2a-notice） | 上游 UI 分类，化妆级 | **记档待 P5/UI 轮**：改的是 upstream `dsh-client-ui-chat` 的 source-kind 分类——非本包急修面；呈现车道豁免原则下不影响投递语义 | backlog |

另按报告 §3.7 补：execEnabled=false 的**单元**锁定（hub-tool 测试，w2cd 行拒绝）——此前只有活体证据。

## 复现与修复验证
- **复现**（0.1.7-d）：`{cmd:pwd, cwd:/nonexistent-xyz-777}` 与 `kill -KILL $$` 返回逐字节相同的 `{exit:null, stdout:"", stderr:"", timedOut:false}` —— 与报告 F1/F2 完全一致。
- **修复活体**（0.1.7-e rig）：
  - bad cwd → `{"outcome":"spawn-error","stderr":"exec: spawn failed — spawn bash ENOENT (cwd: /nonexistent-xyz-777)","durationMs":7}`
  - signal death → `{"outcome":"signaled","stderr":""}` —— 两分成立
  - journal：`a2a.exec.run cmd=pwd exit=none durationMs=7 outcome=spawn-error`
- 单测：outcome 矩阵 4 态 + wire 透传（'signaled'）+ 旧 peer 推导三例 + spawn-error stderr 断言（含 cwd 路径）；hub 454/454，裸线 932/932；dev3 0.1.7-e 实装 world failed=0。

## 对报告本身的评注
- 证据质量高：F1 给了机制级根因（`child.once('error', () => resolve(null))` 吞错误）——正是修法落点；§3.3 尾窗边界 29999/30000/30001 与实现逐位吻合；§3.6 并发用 HTTP 批而非 harness 串行 tool 调用，方法论自觉；§2.6.1 把 "waking turn vs operator prompt" 钉到 `user_prompts` 机器面。
- §6 卫生记录（machines.json 备份/恢复 + diff IDENTICAL、孤儿进程复核、残留清单）完整可信。

**版本**：0.1.7-e（pnpm 同名 no-op 纪律：每个 tarball 换字母）。
