# Claude Code native Hub Mod — 2026-10-07

状态：CLI 与 SDK 升级已实装；原生 Mod 工具与模型 Surface 已通过两端整包线；最终 q 包的 create / prompt / 被动收信与两端重启恢复已通过。user Web 人工验收尚未进行，未 commit / push / npm publish。

## 版本与入口

本机与 dev3 的 user PATH CLI 均升级并实际执行确认 `Claude Code 2.1.291`（当次 registry latest）；匹配的 SDK latest 为 `@anthropic-ai/claude-agent-sdk@0.3.291`。adapter exact-pin 已同步，SDK 仍在首个真实 prompt 自取，两端交付 home 实际包版本均为 `0.3.291`。本机 npm 12 拒绝原下载命令 `--exact`，改为官方 `--save-exact`，消费者自取成功；包安装面仍零 SDK/binary 依赖及零 install hooks。

插件直接安装 native `~/.claude/plugins/superd-hub`，owned marker 与原子写入；官方 `CLAUDE_CODE_PLUGIN_DIRS` 增量启用，原有 settings / enabledPlugins / permissions 保留。原生实测初始化同时加载 Super D、Corti、superpowers、ecc、connect-apps。公共 connection.json 只保存同机 loopback URL 和工具定义，会话 capability 仅进入 Super D child env；原生无门牌号不取信，工具请求由邮局拒绝。

Mods 在 `session.start` 调用 `$.tool.register`，工具 handler 用 `tool.call` 返回真实 Hub HTTP result；不创建 MCP server，不使用 Channels。原生工具名字仍为 `mcp__superd-hub__superd-hub`，这是 Claude 对动态工具的命名规则，不能据此前缀推断它经过外部 MCP 通道。收信由后台 `$.clock.every` + capability inbox + `$.prompt.submit` 发起，保留插件来源。原生 `turn.start` 对仅属于本插件的投信标记回报开始回执，用于关联 DSH 源消息和真实运行轮次；不作 system prompt injection、记忆 prefetch 或 turn-end 挂钩。

官方依据：[Mods API](https://code.claude.com/docs/en/plugins/mods/api)、[Create a mod](https://code.claude.com/docs/en/plugins/mods/create)。原生 `claude plugin validate` 已验证生成模块的真实 API 调用与事件注册。嵌套的接收 `$` helper 被真实静态校验拒绝，已改顶层 helper，不以 Node 单测替代原生校验。

## SDK 与 Surface 的实际证据

升级 SDK 前还专门用旧 SDK `0.3.263` 启动 CLI `2.1.291`：原生 Mod 工具实际返回 `TOOL-PROBE-OK`，随后后台 `$.prompt.submit` 发起第二轮，模型准确回显唯一 marker，SDK 收到普通 assistant / result。原生 session `ad5f664a-8e20-40b0-b808-a176ac00f45f` 与代理截获的真实模型请求都含：

```
The superd-mod-probe plugin sent a message:
Reply exactly CHANNEL-SURFACE-f9c823cb-9a3d-401c-acf2-49a70f075717. Do not call tools.
```

原生继续附上说明此消息由插件提交、在用户位置启动本轮的句子。marker 沿用旧 Channels 探针变量名，此次传输实际为 Mod，未使用 Channels。模型请求取证只存 body、不存鉴权 headers，原件保留为私有 scratch 文件；不是“发送通知但未看到回复”。

整包 `0.1.11-m` 又验证真正 Hub 投信：本机 session `2ea759c1-affa-4eaf-9885-5de1bdfdb672`、dev3 `21d40ff5-0424-4a8c-af16-4b3b56ccfab0` 均从未调用工具，原生 transcript 均包含 `The superd-hub plugin sent a message:` + 完整 A2A 来源信封；准确回复 `LOCAL-CLAUDE-MOD-PASSIVE` / `DEV3-CLAUDE-MOD-PASSIVE`，回复自动回到 Pi。此前 l 轮虽也收信成功，但原生日志证明走旧 SDK prompt 路径，原因是旧记录写 user-rpc，而实际上游 source.kind 为 user + rpcId；已修正且不将 l 轮冒称 Mod 收信通过。

## 整包行为

本机 4999 和 dev3 4998 使用现行 launcher 与长期测试 home，未触碰生产 3080 / 3081 或生产 DSH home。

| 行为 | 本机 | dev3 |
|---|---|---|
| 真实 Hub agents / exec | `LOCAL-CLAUDE-MOD`，exit 0 | `DEV3-CLAUDE-MOD`，exit 0 |
| 重启后 resume / exec | `LOCAL-CLAUDE-RESUME`，exit 0，正确回忆旧 marker | `DEV3-CLAUDE-RESUME`，exit 0；原生历史保留 |
| Claude → Pi → Claude | conversation `560mae`，收到 `LOCAL-CLAUDE-AUTO-REPLY` | conversation `tioh30`，收到 `DEV3-CLAUDE-AUTO-REPLY` |
| Pi → 全新 Claude，无工具调用 | conversation `l610o8`，原生插件来源 + 精确回复 | conversation `t87b9y`，原生插件来源 + 精确回复 |
| Native 无门牌号 | 原生 SDK 消费 native 插件，实际 tool result 为 `E_HUB_ADDRESS_REQUIRED` | 同形实测，原生 session `74f7a152-5fcf-47c7-90c7-ef944d0212e7`，实际相同错误 |

m 轮发现自动回信在 native 正常另开轮次，但 DSH 仍记入旧 turn。改为绑定 opaque 投信 ID 的 native 开始回执，禁止用下一条 SDK init 猜测来源；混合普通输入与 Hub 投信的回归已加入。最终 tarball 和轮次检查下附。

Web 保留供 user：[本机](https://test.pc.internal.test/)、[dev3](http://dev3.internal.test:4998/)。可访问与上述自动行为不代表 user 已验收。

## 最终 q 交付复验

两端部署同一 `super-dsh-0.1.11-q.tgz`，SHA-256 `2e939a4aaf10f46bed7a01032a1c6a0e1724869ac233b6088708ef44dacaa67a`。首轮 m 记录的轮次缺陷曾使两个测试 DSH session 无法恢复；原件保留，没有编辑历史掩盖缺陷。修复后新建会话验证独立完成的 turn 1 / turn 2，再重启验证 turn 3。

- 本机有效 session `32e6d282-6172-4059-9adf-f1426de9e98b`：o 轮完成真实 exec `LOCAL-O-REAL` 与 Pi 回信 `LOCAL-O-REPLY`，独立 turn 1 / 2；q 重启恢复后 turn 3 实际 exec `LOCAL-Q-RESUME`，exit 0，正确回忆旧 Pi marker，正常 completed。
- dev3 q 新 session `a4f4bc1f-04eb-4c84-a545-6ded8ba4d11a`：turn 1 实际 exec `DEV3-Q-REAL`，exit 0，send conversation `95gbg6`；自动收到 `DEV3-Q-REPLY`，独立 turn 2 completed；重启同一 q 包后原 session turn 3 实际 exec `DEV3-Q-RESUME`，exit 0，正确回忆 `DEV3-Q-REPLY`，正常 completed。
- q 全新被动收信：本机 session `8b7ee414-b6cd-45d6-878b-2d76b53db44b` / conversation `0ra1ve`；dev3 session `e874365e-58e4-4c40-b20b-de36063df8d6` / conversation `5iy0kq`。原生 transcript 均有插件来源框架及 opaque inbox 标记，工具调用均为 0；模型精确回复 `LOCAL-Q-PASSIVE` / `DEV3-Q-PASSIVE`，DSH 正确 turn 1 completed。

开始回执仅对本 session 待发的 opaque ID 生效，重复回执幂等。插件在 `turn.start` 做有限立即重试，持续失败就取消尚未进入模型的这轮，保留信件等待下次投递；禁止后台晚到回执和猜测下一次 SDK init 的来源。HTTP 故障模拟覆盖失败保留、取消和恢复重投；正常路径使用上述真实消费者验证。尚未以真实模型故意制造网络断路来验收取消分支。

最终 Hub + Claude + Hermes + PI + OMP + Codex 回归：1,320 项，1,319 pass、1 个既有 boot probe skip、0 fail；整包/Codex package contract 7 项通过。最终 native `claude plugin validate` 通过，仅缺少 author 元数据警告；审查无剩余阻塞项。真实 runtime Surface 与工作行为已证明，SDK 不回显 Mod 的 user 输入事件不阻碍模型工作，adapter 用开始回执建立展示轮次。
