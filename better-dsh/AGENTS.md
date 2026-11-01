# better-dsh — Better Dash 原生工具包

本文件管辖 `better-dsh/` 及其子目录；上层为根 `AGENTS.md`。

- 独立 npm 包 `better-dsh`，增强原生 DSH 的工具、REPL、URL schemes、客户端体验和 Web 策略；不引入 Foreign Agent Hub。两包彻底独立（2026-11-02 user 裁决，ADR 0016）：Super 不安装本包，用户自己分别安装；两包无 npm 依赖边，不维护第二份原生组件。本包是模型侧 `remote`/`remote_transfer` 工具的唯一交付方；两包同装时本包的 remote 工具自动检测 Super hub 并列为 `hub:<m4>` target。
- `cordis.patch.yml` 是本包的组合正本；保留独立消费者视角。大包额外改动在 Super Dash 自己的 YAML 层表达。
- WebTrust、密码页、credential onboarding、welcome notice 在此实现；原生 WebServer / HMR 保留上游，欢迎层通过官方客户端 slot 与生命周期接入；dev WebMCP 的测试附加包在根 `dev-webmcp/`，不进入任何正式 tarball。
- 宿主 import 使用 optional peer 与真实上游链接；零安装期下载/钩子。Python 在运行时发现并复用现有解释器，不自动安装或创建 venv；类型与运行时同源。
- 根 `npm run pack` 总是先构建本包独立 tarball；Super Dash 不携带本包物理文件或 dependency 声明，也不安装本包（companion 已移除）。根 `npm run version:release -- <version>` 同步两包；不得仅改本包版本。两个包都使用同一普通 npm pack 流程。
- `scripts/copy-docs.mjs` 按根 `docs/package-catalog.json` 生成包内文档副本；新增共享/原生资料应更新清单。根资料不因发包被改写；Hub 专属资料不进入小包。
- 测试以根整包 launcher 为准，单包消费者用 `SUPERD_TEST_CONSUMER=better-dsh` 与独立 `.tests/` home；仍构建双产物。语义 Surface 必须通过真实模型工具行为验收。
- 历史规则/术语/报告可在 `docs/legacy/better-dash/`、`docs/00_adr/`、`docs/20_specs/` 与 `docs/50_test-reports/` 查询；原兄弟仓保持原样，不参与现役开发与构建。

- **remote 窄范围构建复用例外（2026-10-10；2026-11-02 收窄，ADR 0016）**：`better-dsh/src/remote/` 是唯一可编辑源码；Super 生成的 `remote/` ESM/dts 闭包及源码 SHA-256 provenance 保留，但收窄为 **Super hub 内部私有依赖**（无公开 `super-dsh/remote` 导出、无 `superd-remote` 组合行，仅由 hub exec/PTY/task/file lanes 引用其进程原语）。生成物不手改，不含 Better 整包、client、其他工具或 npm 依赖边；模型侧 remote 工具只由本包的 `dashr-remote` 行注册。现行决策见 `docs/adr/0016-two-independent-packages-no-companion.md`。


### 2026-10-10 consumer worker delivery correction（2026-11-02 注记：闭包内容清单仍准确；唯一变化 = 闭包不再有公开导出与组合行，见上条收窄）

The generated Super `remote/` contains exactly `plugin.js`, `plugin.d.ts`, private `file-worker.js`, and `provenance.json`. The worker leaf is built solely from canonical `better-dsh/src/remote/file-worker.ts`, has Node-builtins-only imports, and is hashed/checked with the closure. It has no public package export, host peer imports, duplicated host modules, source loader or Better dependency. The public plugin contract remains unchanged. The existing owned child-process/group cleanup remains the receiver boundary; no worker-thread lifecycle replacement. This narrow extra generated leaf fixes actual installed receiver resolution, not a general guarantee that host plugins import outside their host resolver.

### 2026-10-14 helper-bin amendment (spec: docs/specs/remote-rescope)

The closure enumeration above is extended by exactly one directory: `helper-bin/` (superd-run supervision helper, `bin/MANIFEST.json` + per-target static binaries). Leaves are copied verbatim from canonical `src/remote/helper/bin/`, hashed into provenance `outputs`, and leaf-verified in `verify-package-pair.mjs`; import checks stay text-only (.js). The helper is per-invocation (never a daemon, no listening endpoint), verbs frozen to `banner`/`run`/`killgroup`, and every miss falls back to the POSIX wrapper — receipts record which path ran (`runner` field). Built assets are committed via `src/remote/helper/build.sh`; no postinstall ever runs.

### 2026-10-25 hub-pty-pump amendment (plan: docs/10_plans/2026-10-25-hub-remote-parity.md)

The closure enumeration is extended by exactly one more leaf: `hub-pty-pump.mjs` — the dumb WebSocket byte pump spawned as the local child of a canonical hub-machine PTY session (0.3.2-c: `hub:<m4>:pty[:label]` = same-shape session over BYO spawn; the forked `exec-pty-session.ts` in superd-hub is deleted). The leaf is copied verbatim from canonical `src/remote/hub-pty-pump.mjs` into `lib/remote/` (better-dsh `scripts/copy-hub-pty-pump.mjs`, chained after tsdown) and into the closure `remote/` (build-remote.mjs), hashed into provenance `sources`+`outputs`, leaf-verified in `verify-package-pair.mjs`; import checks stay text-only (.js leaves; the pump is plain .mjs JS with Node-builtin imports only). The pump carries no dependency edge and never resolves modules by name: the `ws` module path is resolved by the transport side (superd-hub context, the fork's proven resolution chain) and passed via environment (`SUPERD_HUB_PTY_WS`); resolution failure is an honest creation-time error (`E_HUB_PTY_SETUP`), never a silent fallback. Connection facts (URL/cookie) likewise ride wrapper env assignments, never argv. The peer executor (`/api/superd/exec/pty`) and the task-lease protocol are unchanged (protocol 1).
