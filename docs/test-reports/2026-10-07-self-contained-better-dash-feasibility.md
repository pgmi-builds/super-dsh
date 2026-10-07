# Super Dash 内嵌 Better Dash：可行性验证

2026-10-07。user 新裁决：DSH-only WebTrust 与 dev WebMCP 归 Better Dash；Super Dash pack 物理包含打包时最新本地 Better Dash。本轮回答可行性，不声称已完成正式迁移。

## 方案

使用 npm 原生 `bundledDependencies: ["better-dsh"]`，将本地构建的 Better Dash 包作为物理依赖内嵌到 Super Dash tarball。Super Dash 的 `dsh.bundle.patch` 声明按顺序读取内嵌 Better Dash 的原始 `cordis.patch.yml`，然后读取自己的 YAML。Better Dash 仍独立维护源码、YAML 和单独交付包。

“最新”指打包当时兄弟仓源码的已构建快照；最终 tarball 固定保存该快照的版本与内容。消费者安装不再另从 registry 获取 Better Dash。

WebTrust 的实现及策略由 Better Dash 维护，Super Dash 的重复实现与禁用 Better Dash WebTrust 的覆盖应移除。dev WebMCP 移到 Better Dash 的开发测试区域，继续遵守开发工具不进入正式交付物的既有约束。

## 源码证据

实际使用 LSP 查询 `collectProfileScopePackages` 定义及引用，用 TypeScript AST 检查 `bundlePatchFiles`、`bundlePatchPaths`、`dependencyClosure` 与 `collectProfileScopePackages`。

- `bundlePatchFiles` 支持有序 YAML 文件列表；`bundlePatchPaths` 按声明包目录定位每个文件。
- bundle 不自动激活传递 bundle，但 `createRuntimeResolution` 会遍历已选 bundle 的依赖闭包，提供内嵌 Better Dash 的裸包名与 subpath 解析。
- client modules 通过 Loader 同一解析机制寻找 host row 所属包的 manifest，内嵌 Better Dash 可保留自己的客户端身份。

## 实际隔离探针

从最近本地构建的 `better-dsh@0.2.5-e` tarball 构造临时 probe 包，声明 bundledDependencies 与上述有序 YAML；用当前共享 `pack-package.mjs` 执行真实 npm pack。

创建隔离 profile，只声明 probe 一个插件直接依赖，使用当前 pnpm `install --offline` 安装产物。未声明或单独安装 Better Dash，没有 registry Better Dash fetch。

检查通过：

- Better Dash 位于安装包内真实 `node_modules/better-dsh/`，YAML 和客户端文件存在。
- 原生 `loadProfileDirectory` 没有 skippedBundles，成功读取内嵌 Better Dash YAML。
- 原生 `composeEntries` 没有 warnings，八个 dashr host rows 均出现。
- `createRuntimeResolution` 将 `better-dsh` 映射到内嵌包目录。
- 内嵌包 manifest 保留 `dsh.client`，`lib/client/index.js` 存在。

探针输出 `.scratch/self-contained-feasibility.json`，日志 `.scratch/self-contained-feasibility.log`，脚本 `.scratch/self-contained-probe.mjs` 为一次性探索脚本；临时打包和安装目录已清理。

## 验收边界

这是 pack、离线安装、原生 composition 与解析的可行性证明，未执行正式 Super Dash 迁移、WebTrust 归属调整或 client 浏览器行为验收。正式落地需通过只安装 Super Dash tarball 的 4999 消费者路径验证登录、native eval、Super Dash UI 和 runtime 会话；发布前继续执行 dev3 实装、报告和 user 放行。

现有 4999 联合实例保持 active/running，未重启；未修改上游源码或生产，未发布 npm 或提交 Git。
