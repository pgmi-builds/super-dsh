# 4999 session replay / New Session fixes

2026-10-07，Asia/Hong_Kong。针对 user 本轮四项反馈。代码修复和下述交付行为检查完成；浏览器按钮点击与视觉验收仍由 user 在长期 4999 线进行。没有 commit / push / tag / npm publish 本轮改动。

## 结论与根因

1. **Hermes / Codex base New Session**：上游 `ui-workspace/navigation.ts` 的 New Session 会复用同工作区的空白草稿，`session.create` 随后调用 adapter.resume。toast 中的两条 id 都只有 model / permission 等配置事件，没有 turn 或消息；它们不是截图中被重放的旧对话。adapter 却要求草稿已经有 native gateway / thread id。现在只有“没有 turn / user / assistant 消息”的草稿可以 lazy 新建 native 会话，保留同一 DSH id / cwd / settings；有历史却缺 native id 的记录仍拒绝，不拿空会话冒充恢复。
2. **OMP**：所报 `5030ee77-e8a5-44e0-a98f-54a453308837` 日志第一轮止于 step/end，缺 turn/end，随后冷恢复直接写第二轮 turn/start。当前主线确实仍缺冷恢复尾部关闭，不只是旧日志残留。现在使用宿主官方 interruptedTurnClosers，经同一 write handle 追加后再准备 seed，并同步 writer 计数。已出现内部非法边界的旧坏日志不修补、不删除。
3. **AGY 日志 / 工具名**：所报 `6e04fae9-7662-4f97-87df-dce2244a4bb6` 的首个失败是 tool `:2` 尚无结果就 step/end，且后续重复登记同一调用；该调用名字实际为 `run_command`，不是数字。前轮虽移除双 sink，当前 actor 在重复或并行调用时仍会提前关闭 step。现在重复帧去重、并行调用共用未关闭 step，结果逐一配对；text / onboarding 路径也保持 step 所有权。工具名优先取 CLI semantic tool_info.name；数字 wire code 不再被当成语义名字，没有真实名字时保持 unknown，不编造对应关系。数字形态的修复有回归证据，未声称取得真实模型工具调用的新验收。
4. **AGY 空白 completed / 欠费**：截图中本机 LOCAL-AGY-HUB 回合实际上没调用模型，写入的是缺 API key 的 system/message，而后 completed，Chat 未显示这条提示。现在提供可见 Chat 说明并以 AUTH error 结束。dev3 实际 CLI 返回 error_message 和 result.status=ERROR，保留计费原文；error_message 即使尾随 SUCCESS 也不会被掩盖。计费错误分为 QUOTA，真实消费者日志已验证 error + 原文。

## 检查与交付

- 开发前实际使用 TypeScript LSP definition/references 跟踪 createLiveClient / readStoredEvents；TypeScript AST 遍历确认四个 adapter 的 resume / consume / step 方法结构。私有证据 `.scratch/replay-bugs/lsp*.jsonl`、原 `.scratch/agy-hub/ast.jsonl`。
- 回归先确认失败再修改：blank adoption、OMP interrupted resume、AGY repeated / parallel calls、数字 code、error_message、隐藏认证失败与连续 onboarding step。最终整包 D 构建通过；Hub + 六个 runtime + pack contract 共 1,415 项，1,414 pass、1 个既有 skip、0 fail。独立只读代码复核针对性 42/42，通过且没有阻塞问题。`git diff --check` 通过。
- 唯一入口 pack.mjs；C / D 是本轮测试 tarball，没有发布 registry。
- 最终 `super-dsh-0.1.11-d.tgz` SHA-256：`7f810edce3ddb96ce12a5e9aa2101b5b23fd6e5c1d0e473127f9c85bb442759a`。本机 4999 与 dev3 4998 安装同一份，四个测试 / relay unit active。
- dev3 使用现有 `.tests/foreign-substrate`、实际 npm-installed DSH anchor、已有 `.scratch/socat` 和 launcher 官方 prebuilt WebMCP 选项；没有伪类型或 adapter 场景专用 boot。两端保留原 home、会话、credential seed；未触碰生产 home / 3080 / 3081 / Caddy。

## 真实行为证据与限制

- 本机通过真实 Web session/create 复用 toast 指定的两个 base 草稿，再 session/prompt：Hermes 返回 BLANK-HERMES-C，Codex 返回 BLANK-CODEX-C；重启至 D 后两条 native 会话继续回复 HERMES-RESUME-D / CODEX-RESUME-D（后者带句号）。
- 两端额外 create 空白草稿，在宿主重启后以原 id 复用成功，再分别经真实 Hermes / Codex 回答 BLANK-HERMES-D / BLANK-CODEX-D。本机新日志直接解压并通过上游 assertReleasedV4Relationships。
- 两端 OMP 真实 native read README、完成首轮 OMP-V4-C；宿主重启后冷恢复续聊返回 OMP-RESUME-D，两轮 page 可读。本机 persisted log 再次通过完整 V4 关系校验。异常中断尾部关闭通过真实 provider.resume + 官方格式 validator 回归；未强行制造现场崩溃。
- 本机新 AGY session/page 包含可见认证说明与 turn/end error AUTH。dev3 新 AGY `session-8d51c0f9-6659-49e3-8f97-ccde12b7fbe0` 的冷 page 记录 error QUOTA，带 Google 项目 billing 未启用的完整错误。没有购买额度、更改身份或修改计费。
- 提供的两份 OMP / AGY 旧损坏日志解压内容与诊断时保存副本逐字节相同，按 user 指令没有修补。
- 当前 CUA 返回无浏览器可用；没有把 HTTP / 格式检查冒称为浏览器点击与视觉验收。AGY 真工具调用仍受认证 / billing 阻塞。

继续测试：[4999](https://test.pc.internal.test/)、[dev3 4998](http://dev3.internal.test:4998/)。原 OMP / AGY 坏会话继续报 corrupted 是预期，验证修复请新建会话。registry latest 保持获准发布的 0.1.11-b。
