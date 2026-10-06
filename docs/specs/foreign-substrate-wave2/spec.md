# Substrate Hub foreign plugins — 第二批

范围：Hermes、Claude、AGY。延续第一批 Hub factory / capability / delivery handle；插件只登记工具，不增加记忆式 prompt injection、prefetch 或 turn-end hooks。原生已有工具与插件保留。

user 2026-10-06 裁决：不采用 skill + CLI 替代插件；优先 per-spawn 增量插件，不支持时部署到 native data home。spawn / resume 时登记门牌及可接收 handle，不依赖任何工具调用。native TUI/CLI 未由 Super D spawn，没有门牌，调用由邮局明确拒绝。

Hermes：自有 Python backend plugin 注册 superd-hub，交付在单一 pack；官方 discovery 未见任意 per-spawn plugin path，按授权 fallback 安装 user home/plugins/superd-hub，并仅启用此插件。首次真实 spawn 前准备；draft 不安装、不启动。child 环境携带 session capability，native plugin 公共 connection 只保存同机 URL，无 capability。native 调用真正到达邮局并返回 E_HUB_ADDRESS_REQUIRED。

Claude：user 2026-10-07 裁决直接部署 native .claude，SDK 启动 user 现场 latest CLI。CLI 2.1.291 / SDK 0.3.291；原生 Mods 在 session.start 用 $.tool.register 注册工具，tool.call 直接访问同机 Hub HTTP，不启动外部 MCP server。后台 capability inbox + $.prompt.submit 保留插件来源唤起模型，无需先调用工具，不依赖 Channels。实际 session log 与模型请求中的 Surface 和执行行为为验收，SDK/UI 投影单列。原生未绑定仅登记工具、不取信，调用由邮局返回 E_HUB_ADDRESS_REQUIRED。安装增量配置 CLAUDE_CODE_PLUGIN_DIRS，保留既有插件及设置。

AGY：真实 CLI plugin validator 接受 root plugin.json 和 skills，但 skill 格式通过不等于工具登记；继续核实其插件工具入口，禁止用 skill 隐性代替。

验收：950 原有检查+针对新增生命周期及插件行为的回归；单一 tarball 4999+dev3 实装。三 runtime create/prompt/resume；工具共存；真实 Hub exec/send/自动回信；从未调用过工具的会话收到主动投信；native 未绑定调用收到邮局错误。user Web 验收状态单独报告，不以自动验收代替。
