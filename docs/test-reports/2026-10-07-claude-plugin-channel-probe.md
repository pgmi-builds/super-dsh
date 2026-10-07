# Claude 插件 / Channels / SDK 输入探测

日期：2026-10-07（Asia/Hong_Kong）。一次性探测，不是第二批功能完成或 user 人工 Web 验收。未 commit、push、npm publish。

## dev3 CLI 对齐

按 user 本次指令，使用 dev3 已有 npm global prefix `/home/u1/.local`，将 `@anthropic-ai/claude-code` 从 `2.1.202` 更新到 exact `2.1.261`，实际 CLI `--version` 确认与本机一致。操作更新安装包，没有改 Claude 配置或清理、迁移已有会话。未重启生产服务。此前 `pluginDelivery: initialize` 的 CLI 最低版本缺口消除，但本轮没有实测该 delivery 选项；不要据版本号宣称它已行为验收。

## 一次性夹具

本机位于本 worktree `.scratch/claude-channel-probe/`，dev3 位于 `~/workspaces/superd/.scratch/claude-channel-probe/`。插件含 `.claude-plugin/plugin.json`、`.mcp.json`、Python stdio server；只登记 read-only `probe` 工具，返回 `TOOL-PROBE-OK`，无插件 hooks。server 声明 `experimental['claude/channel']`，在 initialized 后主动发送一条 `notifications/claude/channel`，请求回复 `CHANNEL-PUSH-RECEIVED`。

通过真实 Agent SDK `0.3.263` 的 streaming-input query 启动现役 native CLI `2.1.261`，保留 native user settings；插件通过官方 local plugins 增量选项传入。dev3 额外在 scratch runtime 安装 exact SDK（忽略脚本、omit optional），没有写入业务依赖或修改上游代码。非消费者功能验收，不代替 tarball 线。

首个输入要求实际调用 probe 工具后回复 READY；完成后继续等待，再通过同一 SDK 输入流送入 `origin: {kind:'peer', from:'superd-probe'}` 的消息，要求回复 `SDK-PEER-INPUT-RECEIVED`。query 保持存活至第二个 turn 完成并继续等待；不是只跑一个会自动退出的 single prompt。

## 实测

| 项目 | 本机 | dev3 |
| --- | --- | --- |
| local 插件增量加载 | init 列出 `superd-channel-probe@inline` | 同样通过 |
| native 已有插件同时加载 | init 同时列出 Corti、superpowers、ecc、connect-apps | init 同时列出 Corti、connect-apps |
| 自定义工具目录及连接 | `mcp__plugin_superd-channel-probe_probe__probe`，server connected | 同样通过 |
| 模型实际工具调用 | server 记录 tools/call，模型 READY，result success | 同样通过 |
| 未经工具触发的通知 | server 记录 notification_sent；没有 CHANNEL-PUSH-RECEIVED turn | 同样通过 |
| 后续 SDK peer 输入 | 回复 SDK-PEER-INPUT-RECEIVED，result success | 同样通过 |

本机测试 `--dangerously-load-development-channels server:plugin:superd-channel-probe:probe` 及 `--channels plugin:superd-channel-probe@inline` 两种启动方式；前者两端均测。普通 `--channels` 第一次使用错误 tag（缺 `@marketplace`）时启动失败，按 CLI 报错改为 @inline 后再运行，上表不把失败格式当作 Channels 行为结果。没有修改 allowlist / managed policy，没有假冒官方插件。

这证明 SDK 启动不会屏蔽插件与其 MCP 工具；安装或加载插件也不会自动授权它的 Channels 接收入口。本轮未做原生 interactive Channels 的正向验收，也未安装正式全局 Super D Claude 插件，不声称桌面应用支持自动加载。peer 输入的模型响应已验证，peer 来源对 permission classifier 等全部语义未单独验收。

官方 [Channels reference](https://code.claude.com/docs/en/channels-reference) 明确自定义 Channels 开发 bypass 在 `-p` / Agent SDK 中被忽略；正式 Channels 还需每 session 启用、allowlist 与组织策略等条件。因此不能表述为“所有 Channels 在所有 SDK 情况下一律不支持”。[Channels 概览](https://code.claude.com/docs/en/channels) 还明确普通 MCP server 不向会话推消息。未找到普通 MCP notification 自动唤醒现役会话的受支持替代入口。

## 按模型 Surface 重新验证（user 纠正后）

原先的 `notification_sent` 只证明插件写 stdout，不证明模型看见。旧 probe 使用 `persistSession: false`，debug 中出现的 transcript 路径实际不存在，因此旧结果不能作为 session log 核验。

本次复跑启用 session 持久化；每轮使用全新 UUID 标记；一次性 loopback HTTP 代理转发到原先配置的模型服务，记录实际请求 body，不记录认证头。只覆盖 probe 子进程的 endpoint，没有改 native settings。插件在发送 channel 通知后发送标准 MCP ping；Claude 回应 ping，证明同一连接已处理通知之后的数据。仍不能把 ping ack 当作模型 Surface。

| 证据 | 本机 | dev3 |
| --- | --- | --- |
| Claude session id | d9ed49dc-6948-4ff4-9542-7aff9707fec1 | 6d74144b-5660-4dad-a739-5d1d9ec54865 |
| 原生 JSONL session log | 45 records | 33 records |
| 通知后 ping response | 有 | 有 |
| session log 包含 channel 唯一标记 | 无 | 无 |
| 实际模型请求 | 3 次，messages 数量 2 / 5 / 8 | 同样 |
| 所有模型请求 body 包含 channel 唯一标记 | 无 | 无 |
| session log / 最后一次模型请求包含 SDK 输入标记 | 有 / 有 | 有 / 有 |

本机原生 session log：`~/.claude/projects/-home-u1-workspaces-superd--worktrees-foreign-substrate-wave2--scratch-claude-channel-probe/d9ed49dc-6948-4ff4-9542-7aff9707fec1.jsonl`。dev3：`~/.claude/projects/-home-u1-workspaces-superd--scratch-claude-channel-probe/6d74144b-5660-4dad-a739-5d1d9ec54865.jsonl`。

结论：本轮 SDK / 自定义插件启动条件下，Channels 通知没有进入 session transcript，也没有以任何形式 surface 给大模型；不能称为收信成功。传输层正常和工具目录加载成功都不能代替此结论。未据此扩大为所有正式获准 Channels 均不可用。

SDK 对照输入确实进入模型，但实际形式是普通 `role: user` 文本；不是 `<channel>`，不是 system-role 事件。虽然提交消息带 `origin: peer`，本轮 session log 未保存 origin，也没有把内容自动包装为 peer 信封，所以不能声称该字段已经提供模型可见的 peer 语义；正式实现仍需显式来信信封。

新证据位于两端 scratch：`development-surface-output.jsonl`、`development-model-requests.jsonl`、`development-server.jsonl` 以及真实 native session log。模型请求 body 含实际上下文，仅保留在私有 scratch，不整段输出或提交。新 surface probe 覆盖了同目录 development server/debug 文件，旧输出文件保留；分析须以本节 session id 对齐。

## AGY 调查进展

两端仍为 CLI `1.2.16`。官方 [插件说明](https://www.agy.dev/docs/plugins?tab=cli) 明确 root `plugin.json` + `mcp_config.json` 为外部工具服务器声明；CLI 安装路径为 `~/.gemini/antigravity-cli/plugins/<name>/`。现役 CLI 对 `.scratch/agy-plugin-probe/` 一次性格式夹具实际返回 `mcpServers: 1 processed`；不把格式验证当作工具启动或模型调用成功。

CLI help 未公开任意 per-spawn plugin path。没有证明“不可能按次加载”，也没有已确认插件运行故障。下一步仍需核实实际 install / enable、自有路径保护、原生无门牌错误和 Hub spawn 的 create / prompt / resume；收信应复用持有的会话 handle，独立于 MCP 工具调用。

## 实施建议

Claude 仍可 per-spawn 增量加载插件而保持 native home 不变。插件内 stdio MCP 只承担工具登记和调用；Hub 来信通过 held SDK session 的 streaming input 投递，优先带 peer 来源及 Hub 信封。门牌于 spawn / resume 注册，不等待工具调用。全局插件部署不会消除 Channels 的启动模式与授权 gate；仅在 per-spawn 不适用时使用已授权 native-home fallback。

本轮证据：本机 scratch 的 `development-output.jsonl`、`development-server.jsonl`、`channels-output.jsonl`、`channels-server.jsonl`；dev3 同目录的 development 文件、`sdk-install.log`，以及 `~/workspaces/superd/.scratch/claude-upgrade-2026-10-07.log`。debug 日志含运行上下文，保留在 scratch，不整段输出或提交。
