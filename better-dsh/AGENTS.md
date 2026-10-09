# better-dsh — Better Dash 原生工具包

本文件管辖 `better-dsh/` 及其子目录；上层为根 `AGENTS.md`。

- 独立 npm 包 `better-dsh`，增强原生 DSH 的工具、REPL、URL schemes、客户端体验和 Web 策略；不引入 Foreign Agent Hub。Super Dash 通过 exact-version npm dependency 复用，不能为它再维护第二份原生组件。
- `cordis.patch.yml` 是本包的组合正本；保留独立消费者视角。大包额外改动在 Super Dash 自己的 YAML 层表达。
- WebTrust、密码页、WebServer defaults、credential onboarding、welcome notice 在此实现；dev WebMCP 的测试附加包在根 `dev-webmcp/`，不进入任何正式 tarball。
- 宿主 import 使用 optional peer 与真实上游链接；零安装期下载/钩子。kernel 在运行时 provision，类型与运行时同源。
- 根 `npm run pack` 总是先构建本包独立 tarball；Super Dash 不携带本包物理文件，以 exact-version 普通依赖由消费者 registry 安装。根 `npm run version:release -- <version>` 同步两包；不得仅改本包版本。两个包都使用同一普通 npm pack 流程。
- `scripts/copy-docs.mjs` 按根 `docs/package-catalog.json` 生成包内文档副本；新增共享/原生资料应更新清单。根资料不因发包被改写；Hub 专属资料不进入小包。
- 测试以根整包 launcher 为准，单包消费者用 `SUPERD_TEST_CONSUMER=better-dsh` 与独立 `.tests/` home；仍构建双产物。语义 Surface 必须通过真实模型工具行为验收。
- 历史规则/术语/报告可在 `docs/legacy/better-dash/`、`docs/00_adr/`、`docs/20_specs/` 与 `docs/50_test-reports/` 查询；原兄弟仓保持原样，不参与现役开发与构建。
