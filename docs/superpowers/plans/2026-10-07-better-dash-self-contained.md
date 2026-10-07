# Better Dash 自包含交付实施计划

按本会话 user 裁决直接执行，不另设发布或 Git 批准步骤。规格：`docs/specs/better-dash-self-contained/spec.md`。

1. [x] Better Dash 增加 welcome Host entry，读取安装锚对应的 Models client 常量；通过官方配置钩子同步确认原 namespace。真实 Loader 测试覆盖自动升级、首次快照与禁用恢复；无匹配/歧义常量拒绝。
2. [x] Better Dash YAML 承担 WebTrust authentication-only、webserver 0.0.0.0 与关闭 credentialOnboarding；本地迭代版本 0.2.5-h。
3. [x] dev WebMCP 移到兄弟仓 `dev-webmcp/` 并改名 better-dsh-dev-webmcp；Super Dash 删除自身 WebTrust 重复代码/exports/rows，测试改为使用 Better Dash。
4. [x] Super Dash 本地版本 0.1.12-e、exact better-dsh 0.2.5-h、bundledDependencies 与有序 YAML 声明；pack.mjs 始终本地构建 Better Dash，pair 入口复用，不重复构建。tarball 的嵌入内容与独立 Better Dash tarball 字节一致。
5. [x] launcher profile 仅安装并启用 Super Dash，默认 host 来自 Better Dash，仅覆盖 port 与共用 credentials；dev WebMCP 读取兄弟仓开发包。
6. [x] 相关测试、完整双包 build、tarball 安装、真实登录、settings 首次快照、native 会话 eval 与 resume；独立代码审查后处理重要问题。
7. [x] 更新开发规范、报告与规格；4999 保持运行并提供访问地址。消费者路径已改为单 Super Dash 包，不再沿用双直接依赖 profile 的验收结论。

源码证据：LSP/AST 已检查上游 bundle 文件列表与依赖闭包；实施前补查 Settings/config-editor/Loader 的更新关系、Models 常量和 WebServer 配置。Settings.update 的 profile reconciliation 等待 root Loader；启动组件避免在自身 apply 中等它。

最终产物 0.1.12-e / 0.2.5-h；报告见 `docs/test-reports/2026-10-07-self-contained-better-dash.md`。自动化浏览器和 dev3 未验证，不能用本地通过冒称发布验收。
