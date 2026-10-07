# Better Dash + Super Dash 本地双包验收

2026-10-07。范围：user 授权的本地 4999 联合运行；服务保留供 user 手工检查。

## 结果与入口

- 公网：<https://test.pc.internal.test/>；LAN：<http://192.0.2.130:4999/>。
- `superd-4999-test.service` 为 active/running，监听 `0.0.0.0:4999`；复用 `.tests/superd` 与 `superd-pub` profile，保留测试会话和共享认证 seed。
- 原生 DSH 会话实际调用 Better Dash `eval`，返回 `PAIR-EVAL-42: 42`，turn 正常完成。会话标题为「Better Dash + Super Dash 本地双包验收」。
- 当前 CUA inventory 为 `apps: [], browsers: []`，无法执行浏览器交互；selector、settings 与客户端运行状态仍待 user 手工验收。HTTP 首页证据不替代浏览器行为验收。

## 交付物与来源

两个 Git/物理目录保持独立，不创建目录 symlink。Better Dash 源码为 `/home/u1/workspaces/dashr/better-dsh`，Super Dash 源码为 `/home/u1/workspaces/superd/super-dsh`。

每次 `bash super-dsh/test/start-4999.sh` 都先调用 `scripts/pack-pair.mjs`，构建两边最新源码并生成两份 tarball；缺少源码、构建失败或 exact-pin 不匹配即停止。旧 `SUPERD_TEST_TARBALL` 绕过入口退役，不回退 registry Better Dash。

本轮配对构建完成时间：`2026-10-07T11:48:55.286Z`。产物目录为 `.scratch/superd-pack/`：

| 包 | 版本 | SHA256 |
| --- | --- | --- |
| better-dsh | 0.2.5-e | `a24046c7cf7c22735385e95551f508ec441a27f1ff4b82822c7e75541c91d0fc` |
| super-dsh | 0.1.12-b | `7c75d5b510218e6ad2825a50b9d56a97de7416e61c88b9834bfd0bd8df6ef7f8` |

实际工具链：Node `v26.10.0`、npm `12.2.0`、pnpm `12.9.1`；本机没有 corepack，使用现有 launcher fallback，未声称执行 pnpm 10.33.2。DSH CLI checkout 包版本为 `0.2.0-rc.2`。

profile 的直接依赖与 pnpm override 都指向同一 Better Dash tarball。分别从 profile 与已安装 Super Dash 调用 `createRequire`，均解析到同一个物理 `node_modules/better-dsh/package.json`；该包目录不是源码 symlink。其 `cordis.patch.yml`、`lib/index.js`、`lib/client/index.js` 与本轮源码构建产物的 SHA256 一致。安装证明保存在 `.scratch/pair-install-proof.json`。

## 组合机制与边界

通过真实 `typescript-language-server` 查询定义、引用及调用层级，并用 TypeScript AST 解析核实上游 `readProfilePlugins`、`bundlePatchPaths`、`loadProfileDirectory` 与调用关系。结论：上游 plugin manager `reconcile()` 检查 profile 直接依赖，app boot 仅读取明列 bundles；不会递归激活 `super-dsh` 的传递依赖 bundle。

本轮原生 profile 明列 `base → web-app → better-dsh → super-dsh → dev-webmcp`，框架分别读取各包自己维护的 YAML。Super Dash 没有复制 Better Dash YAML，仅追加 `dashr-web-trust: disabled`，保留已有 `superd-web-trust` 的 authentication-only 行。Better Dash 的 eval、URL schemes、failover、compaction、mobile、remote、web-password 行均保留启用。

`super-dsh` 已声明 exact dependency `better-dsh@0.2.5-e`。**包被安装与 bundle 被激活是两个步骤：本轮联合 profile 不证明 registry 用户只安装 Super Dash 就自动激活 Better Dash。**该最终产品目标仍需接入设计与独立消费者验收，不能由 launcher 显式添加 bundle 掩盖。

Better Dash 自身仍维护独立包与组合定义，本轮没有修改其业务源码。

## 实际运行证据

1. 匿名首页返回 200 密码表单；匿名 `POST /api/session/list` 返回 401。launcher 的 readiness 已改为同时核验这两点，避免把登录表单误判为认证成功。
2. 实际密码提交返回 303 并签发 cookie；携带 cookie 的首页为 200 应用页，含 module script、Super Dash fusion flag 与 `ownsHost:true`。公网首页亦为 200 密码表单。证据不输出 cookie 或认证 seed 内容。
3. 认证后的 `/api/agent-runtime` 返回七个 runtime：native、Claude、Codex、Hermes、Pi、Antigravity、OMP，各行 ready=true、failed=false，hub 版本为 0.1.12-b。未据此声称验收 foreign agent 会话行为。
4. 通过上游原生 session API 创建 standard preset 会话 `session-24676308-e0d0-4d20-8b25-37006251d919`，模型为 `deepseek-official/deepseek-flash`。该会话 `request/header` 中实际出现 `eval`、`remote`、`superd-hub` 工具。
5. 会话 seq 17 为实际 `eval` 调用，cell 为 `print("PAIR-EVAL-42:", 6 * 7)`；seq 18 工具结果为 `PAIR-EVAL-42: 42`、isError=false；seq 24 为 turn/end completed。验收提示明确要求不改文件、不启动或联系其他 agent。

配对记录与脱敏运行证据为 `.scratch/superd-pack/pair.json`、`.scratch/pair-live-proof.json`；运行日志为 `.scratch/superd-4999.log`。本轮重启后的新日志切片无启动 warning/error/fail；不把历史日志当作本轮失败计数。

## 检查与审查

- 初次 `node --test` 执行 composition、pack-result、pair-login、pack-contract 四组检查：9 项通过，0 失败。后续统一打包方式后的检查见下文。
- `bash -n super-dsh/test/start-4999.sh` 与 `git diff --check` 通过。
- composition 使用上游真实 `loadOverlayPatches` / `composeEntries`，无 composition warnings，组件与重复 WebTrust 状态符合预期。
- 初次曾为 npm 12 的 keyed object 与 npm 11 array 添加解析兼容；user review 后已删除此实现，改为两包共用普通 npm pack 并核验实际 tarball。
- requesting-code-review 独立审查发现登录表单误判与旧配对记录失效时机问题；均已修复并复审，无剩余 important 问题。

## 尚未验收与操作范围

浏览器视觉与交互、foreign runtimes 的 create/prompt/resume、dev3 实装以及 registry 单入口自动激活均未在本轮验收。本轮只完成 user 指定的本地联合实例、交付物来源和原生 eval 行为检查，手工页面验收待 user。

未执行 npm publish、Git commit/tag/push；未修改上游源码、生产 home 或生产 3080/3081。服务保持运行，user 检查后再收尾。

## User review 后：统一两包 pack 方式

user 要求两个 repo 使用相同 pack approach。核实原流程中 Super Dash 使用普通 `npm pack`，Better Dash 单独使用 `--json`；差异来自本次协调器实现，没有理由继续维护。LSP 引用查询及 AST 调用检查后，移除 `pack-result.mjs` 与其双格式解析测试。

现在两包打包步骤都调用本仓 `scripts/pack-package.mjs`：同一 PATH 下的 npm 执行 `npm pack --pack-destination`，旧同名产物先删除，随后直接读取实际 tarball 的 `package/package.json` 核验包名与版本。各自源码 build 仍由各自构建入口完成。Better Dash 单独发包无需依赖 Super Dash 脚本。

真实 npm fixture 检查同版本重打包后包含最新文件，并验证带空格的路径。composition、pack-package、pair-login、pack-contract 共 8 项通过，shell syntax 与 diff whitespace 检查通过。

完整双包重构建成功，配对时间 `2026-10-07T11:57:08.091Z`：

- Better Dash SHA256：`15b8c1a9d2d10fb1d517547ad22c3156785e74be5de0c279c9f5f1a50736d974`。
- Super Dash SHA256：`7c75d5b510218e6ad2825a50b9d56a97de7416e61c88b9834bfd0bd8df6ef7f8`。

与当前 4999 安装树逐文件比较：Super Dash 411 个文件完全一致；Better Dash 737 个文件中仅 5 个构建生成的 `.d.ts` 不同，其余文件一致，包括实际运行 JS 与 YAML。记录为 `.scratch/unified-pack-proof.json`。此修改只涉及开发打包脚本，不进入两包发布 files；保留当前 4999 实例，没有重启打断 user 检查。原生会话行为证据对应前述初次安装产物，不能冒称已重新安装本次新 tarball。
