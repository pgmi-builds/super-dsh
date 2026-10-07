# Claude 原生 Hub Mod

User 已明确批准：两端升级 latest runtime、核实对应 SDK，插件直接部署 native .claude；真实 runtime 的模型 Surface 与执行行为是主验收，SDK/UI 投影单独记录。基线 wave2，禁止本轮自行 commit/push/publish，保留 Hermes 已实现改动。

1. CLI 2.1.291 两端实装；SDK registry latest 0.3.291，现役 durable SDK pin 由 0.3.263 对齐 0.3.291并验收真实解析。
2. Hub foreign binding 增加有 capability 的文本 inbox；GET 查看首项、POST ack，native 无 capability 与工具端一致报无门牌。Claude client 异步 lazy 准备 native Mod，子进程携带私有 capability，原生公共配置无 capability。
3. Mod 用 session.start 注册工具和后台取信，tool.call 返回实际 Hub HTTP result，来信用 $.prompt.submit（保留插件来源、显式 Hub 信封），不使用 MCP server/Channels，不增加每 turn 记忆 hooks；投信加 opaque id，由原生 turn.start 回报实际开始，绑定原源消息与运行轮次。SDK init 不作为投信来源证据，开始回执幂等重试，持续失败则取消尚未进入模型的本次原生轮次、信留inbox再投递，禁止模型执行后晚到回执错开空轮次，普通异步原生输出也保持有效 DSH 轮次。注册工作在启动发生，与是否调用工具无关。
4. install 自有 ~/.claude/plugins/superd-hub（owned marker、atomic 文件）、增量设置官方 CLAUDE_CODE_PLUGIN_DIRS，保留既有 native 插件与配置。Hub mount 仅刷新已 owned 公共 endpoint。create/resume binding 注册；ClaudeAgent 对 A2A 来源使用 client inbox 投递，继续保留 upstream source/turn 生命周期。
5. TDD：capability/inbox ack隔离、安装/设置保留、真实 Mod register、native无门牌、lazy客户端取消/SDK env、A2A路由。先红后绿；LSP/AST追踪现役入口及实际CLI生成Mods types，运行相关回归。
6. 新 tarball 字母通道4999+dev3；真实 Claude create/prompt/resume、工具共存/exec、主动投信/自动回信、未调用工具的接收会话；检查 native session log与真实模型请求。native渠道工具调用抵达邮局并明确无门牌。报告SDK/UI可见行为差异；服务保留供user人工验收。
