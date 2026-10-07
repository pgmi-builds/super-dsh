# 0.1.10-h 浏览器缺陷修复

依据：`docs/test-reports/2026-10-04-superd-hub-0.1.10-h-browser-webmcp-acceptance.md`。

1. Codex 主路线必须能创建、follow、续聊及列模型。world composition 保留 SessionController 必需的 host 服务，即使服务所在包有 client half。
2. Claude / Pi / Hermes / Antigravity 在同会话选择模型后，无需重开就更新模型芯片；续聊后统计反映新增 turn。以实际 control/follow 传输与 UI 验证。
3. Hermes 同一 live agent 的每次 prompt 都写入 DSH user/message，先于该轮 assistant；session/title 仍引用首条 user seq。

不改变 world/gateway 架构、不修改上游、不恢复原生日志读取、不补造历史丢失消息。保留起始未提交改动与测试资产；迭代仅 tarball，新字母版本。验收使用整包测试线，保持运行交用户，目标机实装需要遵守 prod 重启授权红线。

2026-10-04 user 补充：先提交 0.1.10-h 现场；Codex rig 至少准备 DeepSeek 或 ZAI 一个第三方 provider，避免把本机官方账号登录差异误判成服务故障。主验收使用本版本新建会话，切去 Native 或另一 agent world，再切回来重放并真实续聊即算通过；旧版本会话仅作兼容性观察。

4. i 实测补充：Codex 首次冷启动的 thread/start 与 turn/start 必须使用当前所选 provider/model，不能回退到本机官方账号的默认模型。
