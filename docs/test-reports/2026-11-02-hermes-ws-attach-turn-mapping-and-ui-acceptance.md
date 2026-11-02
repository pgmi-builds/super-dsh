# 2026-11-02 — Hermes WS-attach 回合映射完成 + 浏览器第一人称验收（0.3.3-g）

结论：**通过。** Hermes adapter 首次在 4999 pack 线上完成浏览器级 create → prompt → 回复 → follow-up → 刷新恢复全链路；retest 报告的 E1（stdio 占用）与 E2（虚假 resume 指引）均已修复并实测；E3（Preview Notice）在 0.3.3-g 新世界里两次按原流程复现均未出现（详见 §4）。浏览器验证全部经 browser bridge 以 DOM 交互完成，无 API/脚本替代。

关联：[原修复报告](2026-11-02-hermes-session-log-repair-and-ws-attach.md)、[浏览器复测](2026-11-02-hermes-browser-retest.md)。

## 环境与边界

- 时间：2026-11-02 09:00–11:10，Asia/Hong_Kong；主机 homepc；入口 http://127.0.0.1:4999/（Better Dash password gate，硬编码默认口令解锁，未注入 cookie）。
- 浏览器：browser bridge 管理的 CDP Chromium（headless）；用页面点击、输入与截图完成全部业务验证。
- 版本：`super-dsh@0.3.3-g` + `better-dsh@0.3.3-g`（`npm run version:release -- 0.3.3-g`），`bash super-dsh/test/start-4999.sh` 全量重建接管；unit `superd-4999-test` 进程环境含 `SUPERD_HERMES_TRANSPORT=attach`（systemd drop-in `~/.config/systemd/user/superd-4999-test.service.d/attach-transport.conf`，**仅 4999 线生效**；prod 3080 未触碰，仍 stdio）。
- 常驻 hermes gateway（pid 256084）全程未重启；本机 `~/.hermes/.env` 未改（热启用杠杆留给 prod pack 发布时）。

## 1. Bridge v2 — canonical 权威面回合动词映射（E1 修复）

`agent-hermes/bridge/hermes-ws-bridge.py` 从透传升级为契约翻译层。权威面（`gateway/session_controls.py` + `tui_gateway/contracts/canonical*.py`，全部 params `extra="forbid"`）与 adapter 的 stdio 契约共五处差异，全部按源码契约 + 实测回执落定：

| 动词 | 翻译 | 依据 |
|---|---|---|
| `session.create` | 剥 `cols`（CanonicalCreateParams 无此字段，4001 invalid_params） | probe 实测 |
| `prompt.submit` | 注入 `submission_id`（权威面无 request id 即拒）＋回执 AdmissionStatus → `{"status":"streaming","receipt":…}`；`{voice_stopped:true}` → JSON-RPC error | `session_controls.submission()`；adapter `prompt()` 只认 streaming |
| `session.steer` | 注入 `execution_generation`（事件帧顶层追踪） | `session_busy_controls.correct()` + `check_approval_generation` |
| `session.interrupt` | 注入 `execution_generation` | `AuthorityConnection.interrupt()` |
| `approval.respond` | `{request_id,choice}` → 精确集 `{session_id, execution_generation, prompt_id, choice}`，generation 取自 `approval.request` 事件载荷追踪 | `respond()` 的 set 相等校验 |

事件侧：绑定会话后丢弃外会话帧（外会话 approval 请求不再可能到达 adapter 层）；`execution_generation` 从 create/resume 快照、每条事件帧顶层、submit 回执与控制回执持续追踪。`session.usage/status/compress/close` 权威面 `-32601` 如实透传（close 本就 fire-and-forget；usage/status/compress 为诚实降级，不碰回合日志）。

**gateway 层实测**（`.scratch/hermes-bridge-v2/probe.mjs`，真常驻 gateway、真模型回合）：create（含 cols）→ prompt 回路 "BRIDGE-PROBE-1" 3.5s 完成；运行中 steer 回执 `{"status":"queued"}`；interrupt 回执 SessionHandle；history/model.options 透传 ✓。

## 2. E2 — resume 拒绝指引区分两种成因

`agent-hermes/src/index.ts` resume：无 durable id 且有回合内容时，按日志中是否有 `assistant/message` 分叉——有（旧时代记录）保留原文案；无（本轮冷启动失败，内容从未到达模型）改为 *"the Hermes gateway failed before this session was created; its recorded turn never reached the model — re-create the session"*。`provider-resume.test.mjs` 两例断言；套件 **142/142**。浏览器行为实测：旧失败会话再发送 = fail-closed（无新回合、文本回填输入框、仍 `1 turns 1 steps`），不再有 "predates durable-id capture" 的误导。

## 3. 浏览器第一人称验收（4999 线，0.3.3-g）

| 步骤 | 结果 |
|---|---|
| Unlock（默认口令）→ Hub → This machine → Hermes ▷ | 新建页就绪，`deepseek-v4-pro (reasoning)`、Full access |
| 新会话首条 prompt（误早发为 "R"） | **Completed in 12s**，真实回复，Usage 24.2K tok，`1 turns 1 steps` —— retest 的 GATEWAY_CRASH 不再出现 |
| 同会话第二条（HERMES-BRIDGE-UI-2） | **Completed in 2s**，逐字回复 `HERMES-BRIDGE-UI-2`，`2 turns 2 steps` |
| 整页刷新 → 重进 Hermes → 重开该会话 | 历史可读；第三条 **HERMES-BRIDGE-UI-3 逐字回复**，`3 turns 3 steps · 74.3K tok` |
| 旧失败会话（GATEWAY_CRASH 档）打开 | 历史与失败详情可读，Trajectory 正常渲染，无 "Session unavailable" |
| 旧失败会话再发送 | fail-closed（见 §2），文本保留在输入框 |

截图（hash 索引）：解锁后默认页 `8e0d5f6d`、Hub 列表 `915c702b`/`e7c5cad5`、hermes 首条回复 `d246e683`、UI-2 逐字回复 `3afe04ba`、刷新恢复 UI-3 `8d3a37ae`、旧失败会话 `bec677b8`。

## 4. E3 — Preview Notice 未在 0.3.3-g 复现

按 retest 原流程（进入失败会话 → Trajectory）两次干净复现（其中一次整页刷新后冷启动）均为**正常渲染，无弹窗、无 "Session unavailable"、无确认失败**。retest 的弹窗状态与当时那个跨修复/跨 stdio 抖动存活的世界上下文绑定，新世界（09:32 随 pack 线重建）不复现。

保留的结构性事实（潜在复发面，记录为后续项）：全体 world 的持久 profile patch 中，只有 `agents/omp-sdk/profiles/web/cordis.patch.yml` 带 `ui-settings-general` 行的 `welcomeNoticeVersion: 2026-09-28.1`（CTX0 profiles/superd-pub 有），hermes/omp/codex/claude/pi/agy 等 world 均缺失——native WelcomeNotice 的 ack 门在这些 world 读到未确认。后续修法：`superd-hub/src/world-provision.ts` 落 world patch 模板时从 CTX0 profile patch 镜像该行（版本随上游自动跟进，不硬编码）。本次未改，因未复现用户可见故障且属 Better/世界组合边界。

## 覆盖限制

- 未在本轮触发真实审批回路（gateway 会话策略未拦工具）；approval.respond 翻译为契约+单测级验证。
- steer 的浏览器路径未单测（对话型验收未中途打断）；gateway 层 probe 已验证 queued 回执。
- `session.compress/usage/status` 权威面降级未在浏览器触发（compact 工具未调用）。
- prod 3080 仍运行旧 pack（stdio 失败面不变），pack 更新待放行；`~/.hermes/.env` 热启用杠杆未拨。
- 测试会话与 draft 均保留未清理。
