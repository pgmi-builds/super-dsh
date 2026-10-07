# Super D 0.3.0：同仓双包与历史合流

2026-10-07 user 批准：当前 Super D 仓为统一开发与 GitHub 主仓；导入 Better Dash 物理源码与历史，原 `/home/u1/workspaces/dashr` 完整保留且本轮零写入。名称沿用已发布 `better-dsh` / `super-dsh`，用户口述 beta-dash 指 Better Dash，不另改 registry 包名。

- 根只有一个 Git，源码同层 `better-dsh/` 与 `super-dsh/`；开发 WebMCP 在 `dev-webmcp/`。当前 GitHub remote 保留 `pgmi-builds/super-dsh`；大全包 homepage 根 URL，小包 homepage 子目录 URL，两包 repository.directory 各自包目录。
- 统一正式版本目标 `0.3.0`；迭代 tarball `0.3.0-a` 起两包同步。根 private manifest 编排版本/构建/测试，不成为第三个发布包；现有独立包安装机制保持。
- Super Dash pack 默认只读同仓 Better Dash 源码，exact-pin 同版本，统一 npm pack，本地实际 Better tarball内嵌并全文件核验；禁止旧仓或 registry 自动回退。
- Git 完整保留两条无共同祖先历史，合流第一父线为 Better Dash、第二父线为旧 Super Dash。原 SHA不改；导入历史 refs/tag 使用 legacy 来源前缀避免 v0.1.4/v0.1.6 冲突。保留旧仓原 refs，GitHub/npm定版需验收报告与单次放行。
- 源码、文档、spec、报告与参考资料导入；碰撞选当前 Super D 总纲为根正本，旧 Better根总纲/词汇表/环境记录保留 provenance。技能相同文件共享，差异副本保留到 legacy。包内文档按 package catalog 筛选，Better小包不因合仓携带 Hub专属报告/资料。
- 上游保持当前同源 DSH0.2.0-rc.2；本仓 upstream唯一基座，optional harness peer单实例。不复制上游、node_modules、.env、测试home、venv或其它机器运行状态为Git产品。
- 本地4999使用现行launcher与长期home，独立Better consumer额外测试口/隔离profile；dev3现有测试4998长期home安装同一双tarball并使用实际宿主anchor。目标端显式接收已验证pair仅负责delivery，不从registry取Better；验签和内嵌全文件检查仍执行。
- 每种consumer覆盖登录、实际General welcome版本、onboarding默认、原生模型eval/create/prompt/resume；Super roster和client graph无重复，六个未改动foreign runtime不以boot冒充prompt验收。
- 本轮不 npm publish、不修改生产home/3080/3081/Caddy、不修改原仓、上游；测试Web线保留供user验收。
