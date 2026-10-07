# Better Dash 本地联合测试实施计划

> **For agentic workers:** 按当前 user 的“现在拉起 4999”授权在本会话执行；不提前 commit、发布或另设批准步骤。

**Goal:** 使用两边最新源码生成两个 tarball，通过现有 Super Dash launcher 在 4999 联合运行。

**Architecture:** 两仓独立，新增双包构建协调器；测试 profile 使用两份物理 tarball 与显式 bundle 顺序，由原生框架分别读取两包 YAML。Super Dash 层只做跨包覆盖，不复制 Better Dash 组件定义。

**Tech Stack:** Node ESM、npm pack、Cordis YAML patch、systemd user service。launcher 优先 pnpm 10.33.2；本机无 corepack，本轮实际为 pnpm 12.9.1 fallback。

**Spec:** `docs/specs/better-dash-local-pair/spec.md`

## Global Constraints

- 两包始终本地构建；不静默回退 registry，不用源码链接替代交付安装。
- 不修改上游；不触碰生产；重用测试 home 和共享 cookie seed；4999 保持运行。
- 仅联合 profile 验收，不声称上游已支持传递 bundle 自动启用。

## Task 1: 包依赖与 composition

- [x] 添加使用原生 `loadOverlayPatches` / `composeEntries` 的行为契约测试；先观察 exact 依赖与重复 WebTrust 测试失败。
- [x] 修改 `super-dsh/package.json`：本地迭代 `0.1.12-b`，exact 依赖 `better-dsh@0.2.5-e`。
- [x] 修改 `super-dsh/cordis.patch.yml`：追加 `id: dashr-web-trust, disabled: true`。
- [x] 运行 `node --test super-dsh/test/better-dash-composition.test.mjs`，检查 Better Dash 所有组件保留且只一份 WebTrust 生效。

## Task 2: 双 tarball 默认构建与安装

- [x] 新增 `super-dsh/scripts/pack-pair.mjs`：定位并校验兄弟包；清理 Better Dash 生成输出；执行其原生 build 与 npm pack，再调用现有 `scripts/pack.mjs` 构建 Super Dash；保存版本、路径与 SHA256 到 `.scratch/superd-pack/pair.json`。
- [x] 修改 `test/start-4999.sh`：始终调用双包协调器；从 pair.json 读两个路径；profile 明列两个 bundles 与两份 tarball；pnpm workspace override 同一 Better Dash 产物；保持既有启动/认证/隔离机制。
- [x] 运行 `bash -n super-dsh/test/start-4999.sh`、pack contract 和完整 launcher；检查安装来源和依赖解析单实例。

## Task 3: 真实运行验收与交付

- [x] 检查安装的原生 composition、HTTP 认证、foreign roster 和启动错误。
- [x] 创建 native 会话，实际调用 Better Dash eval，核验请求 header 中的工具 Surface、工具结果与正常 turn end。
- [ ] 浏览器确认 Super Dash selector 与 Better Dash settings/components 同时出现：本机 CUA 无可连接浏览器，留给 user 访问 4999 手工检查，不计作已验收。
- [x] 通过 requesting-code-review 技能做独立审查，修复与本次范围有关的问题。
- [x] 更新 `test/README.md`、`docs/07-cordis-dsh-dev-test-guides.md` 与局部 AGENTS 开发准则；报告写入 `docs/test-reports/2026-10-07-better-dash-local-pair.md`。
- [x] 给 user 4999 URL，保持服务运行；明确单包自动启用仍未完成产品验收。

## Task 4: user review — 统一 pack 方式

- [x] 核实原差异：Super Dash 普通 `npm pack`，Better Dash 单独解析 `--json`；LSP 引用查询与 AST 调用检查已执行。
- [x] 两包共用 `scripts/pack-package.mjs`，普通 npm pack 后验证 tarball 内 manifest；移除 `pack-result.mjs` 及 npm JSON 双格式兼容测试。
- [x] 真实 npm fixture 检查同版本重打包取得最新文件，并覆盖含空格路径；完整相关检查 8 项通过。
- [x] 从两仓最新源码完整构建两份 tarball，记录结果；保留当前 4999 实例供 user 检查。
