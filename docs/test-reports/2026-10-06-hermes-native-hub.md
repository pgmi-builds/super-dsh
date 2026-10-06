# Hermes 原生 Hub 插件自动行为验收

日期：2026-10-06。工作区：`foreign-substrate-wave2`，基线 `81a5f80`。本轮未 commit、push 或 npm publish。Claude / AGY 尚未实现；本报告只覆盖 Hermes 及共享 transport 的改动。user 人工 Web 验收尚未进行。

## 实装结果

Hermes 使用官方 Python backend plugin 的 `register_tool` 登记 `superd-hub`，保留原有工具与插件。没有 skill + CLI 替代，没有 MCP、prompt injection、prefetch 或 turn-end hook。插件源码由整包交付；未发现现役 gateway 可用的任意 per-spawn 插件目录入口，因此按 user 授权安装 `~/.hermes/plugins/superd-hub`，通过官方 CLI 仅启用该插件 key。

插件公共文件只保存 loopback 地址及工具定义，不保存会话 capability。Super D 创建 / 恢复的 handle 在调用工具前登记门牌；gateway child 环境携带各自私有 capability。收信通过现有会话 handle，独立于工具调用。原生渠道没有此 capability，调用邮局后返回 `E_HUB_ADDRESS_REQUIRED`，不会虚构门牌。

owned marker 防止覆盖用户同名目录；安装和地址刷新按 native home 串行，文件使用独立临时文件原子替换。真实外部 Python reader 曾复现非原子写入导致 161 次无效 JSON，修复后并发测试通过。Hub mount 会刷新已由本产品拥有的插件公共地址，不需要先 spawn Hermes；无 owned marker 时不写 native home。该刷新由 Cordis effect 的 disposer 等待完成。只更新自有路径和自身 enable 项，没有改上游源码。

## 交付与环境

先以 `0.1.11-i` 跑首次 create / prompt / 主动投信及回信，再以包含并发写入和地址刷新修复的 `0.1.11-j` 在两端重启、原生无门牌调用、cold resume 复验。最终两端安装同一 tarball：

`super-dsh-0.1.11-j.tgz`

SHA-256：`5131f9fb63d82213c11a1c4a4816fa6e546542a162f5f8532e029cc5b02f9b33`。

本机 4999 使用现行 launcher、长期测试 home；dev3 4998 使用同一 tarball 和 `.tests/foreign-substrate`，未触碰生产 home / 3080 / 3081。Hermes 本机版本 `v0.21.5+5594.gafc47d6`，dev3 `v0.21.5+5798.g009afb3.dirty`，目标机原有 dirty 状态未修改。真实模型均为 `deepseek-v4-pro`。

## 行为证据

| 场景 | 本机 | dev3 |
| --- | --- | --- |
| 首次会话 | `session-48595e98-ea58-4eff-9756-abd23ef1347c` | `session-8183c63f-c289-41c0-8f07-0ee2865f8276` |
| Hub agents / exec、原生文件工具、send | exec `HERMES-WAVE2` exit 0；send conversation `44hz99`；自动收到 `PI-WAVE2-ACK` | exec `DEV3-HERMES-NATIVE` exit 0；send conversation `lwvrth`；自动收到 `DEV3-HERMES-REPLY` |
| j 冷恢复及保留历史 | `LOCAL-HERMES-RESUME` exit 0，报告旧 peer reply，turn 3 completed | `DEV3-HERMES-RESUME` exit 0，报告旧 peer reply，turn 3 completed |
| 尚未调用任何工具的接收会话 | `session-a9286b44-d914-45ee-b217-16677d88c033` | `session-1c13dbcd-cf4b-4bae-b60e-101c5bdd7343` |
| Pi 主动投信与自动回复 | conversation `4swifc`，准确回复 `LOCAL-HERMES-PASSIVE` | conversation `ybuht3`，准确回复 `DEV3-HERMES-PASSIVE` |
| 接收会话工具事件 | 0 tool/call、0 tool/result，turn 1 completed | 0 tool/call、0 tool/result，turn 1 completed |
| j 重启后尚未进行 Hermes spawn 的原生调用 | 真实 native registry 加载插件；调用到邮局返回 `E_HUB_ADDRESS_REQUIRED` | 同样通过 |

原生无门牌验证直接加载真实 `model_tools` / `tools.registry` 后调用插件 handler，删除 `SUPERD_HUB_SESSION`，不是测试替身；没有把这一操作称作人工 TUI / Web 验收。j 的 native 调用发生在每台机器重启后第一次 Super D Hermes prompt 之前，覆盖旧 URL 修复。

首次模型有原生 `tool_call` schema 使用错误，错误返回后仍完成实际操作；不把 assistant 自述作为唯一证据。Hub exec / send 用服务器实际记录和收信会话验证，dev3 冷恢复还含实际工具结果。首次本机发送的消息文字未按测试指令带上“Reply exactly”，所以本机 peer 实际回复为 `PI-WAVE2-ACK`，不声称收到未发生的精确 marker。

## 回归与 Surface

最终源码 Hub / Hermes / Pi / OMP / Codex 合并回归 1079 项通过；整包 contract、foreign lifecycle、Codex provider seed 20 项通过，合计 1099 项。pack 构建及消费者安装通过，`git diff --check` 通过。请求的代码复核发现两项并发 / 地址问题，已修复并复核通过。

实际工具 Surface 由官方 `register_tool` 注册，schema 与 Hub 定义同源；Hermes 原生工具搜索机制可能先通过 `tool_search` / `tool_call` 暴露新插件。真实模型成功发现并执行 Hub 功能，同时使用原生文件工具。Python 测试验证只登记工具，没有附加生命周期 hooks。未通过 user 人工检查模型界面。

证据位于本工作区 `.scratch/`：`wave2-j-tests.log`、`wave2-j-contract-tests.log`、`hermes-j-resume-summary.json`、`dev3-hermes-j-resume-summary.json`、`passive-receiver-summary.json`、`dev3-passive-receiver-summary.json` 及两端测试服务日志；长期会话 home 保留。

## 当前边界

Web 服务保持运行：[本机测试线](https://test.pc.internal.test/)、[dev3 测试线](http://dev3.internal.test:4998/)。服务可访问及上述自动行为验收不代表 user 人工验收通过。

Claude 现役 Corti 插件实际以插件内 stdio MCP 登记工具；异步收信可以继续走 Super D handle，但 user 对纯工具登记 / 调用层 MCP 是否允许的澄清尚未返回，因此未实现此方案。AGY 的 skill 格式验证不能代替工具注册，尚未实现。整批第二波不能标记完成。
