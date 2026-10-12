# better-dsh — Better Dash 原生工具包

本文件管辖 `better-dsh/` 及其子目录；上层为根 `AGENTS.md`。

- 独立 npm 包 `better-dsh`，增强原生 DSH 的工具、REPL、URL schemes、客户端体验和 Web 策略；不引入 Foreign Agent Hub。Super Dash 运行时调用原生 Plugin Manager，按其自身版本精确请求本包，失败依次回退 latest、裸包名；两包无 npm 依赖边，不维护第二份原生组件。
- `cordis.patch.yml` 是本包的组合正本；保留独立消费者视角。大包额外改动在 Super Dash 自己的 YAML 层表达。
- WebTrust、密码页、credential onboarding、welcome notice 在此实现；原生 WebServer / HMR 保留上游，欢迎层通过官方客户端 slot 与生命周期接入；dev WebMCP 的测试附加包在根 `dev-webmcp/`，不进入任何正式 tarball。
- 宿主 import 使用 optional peer 与真实上游链接；零安装期下载/钩子。Python 在运行时发现并复用现有解释器，不自动安装或创建 venv；类型与运行时同源。
- 根 `npm run pack` 总是先构建本包独立 tarball；Super Dash 不携带本包物理文件或 dependency 声明；由运行时 companion 协调器调用宿主原生安装入口。根 `npm run version:release -- <version>` 同步两包；不得仅改本包版本。两个包都使用同一普通 npm pack 流程。
- `scripts/copy-docs.mjs` 按根 `docs/package-catalog.json` 生成包内文档副本；新增共享/原生资料应更新清单。根资料不因发包被改写；Hub 专属资料不进入小包。
- 测试以根整包 launcher 为准，单包消费者用 `SUPERD_TEST_CONSUMER=better-dsh` 与独立 `.tests/` home；仍构建双产物。语义 Surface 必须通过真实模型工具行为验收。
- 历史规则/术语/报告可在 `docs/legacy/better-dash/`、`docs/00_adr/`、`docs/20_specs/` 与 `docs/50_test-reports/` 查询；原兄弟仓保持原样，不参与现役开发与构建。

- **remote 窄范围构建复用例外（2026-10-10）**：`better-dsh/src/remote/` 是唯一可编辑源码；Super 仅生成独立 `remote/` ESM/dts 闭包及源码 SHA-256 provenance，导出 `super-dsh/remote`。生成物不手改，不含 Better 整包、client、其他工具或 npm 依赖边；两条 remote 行默认开，按 Agent 官方创建事件竞争注册。除此例外，原独立双包边界不变。赢家卸载不热重抢，新 Agent 或冷恢复可重新竞争；现行决策见 `docs/adr/0015-independent-bundles-agent-remote.md`。


### 2026-10-10 consumer worker delivery correction

The generated Super `remote/` contains exactly `plugin.js`, `plugin.d.ts`, private `file-worker.js`, and `provenance.json`. The worker leaf is built solely from canonical `better-dsh/src/remote/file-worker.ts`, has Node-builtins-only imports, and is hashed/checked with the closure. It has no public package export, host peer imports, duplicated host modules, source loader or Better dependency. The public plugin contract remains unchanged. The existing owned child-process/group cleanup remains the receiver boundary; no worker-thread lifecycle replacement. This narrow extra generated leaf fixes actual installed receiver resolution, not a general guarantee that host plugins import outside their host resolver.
