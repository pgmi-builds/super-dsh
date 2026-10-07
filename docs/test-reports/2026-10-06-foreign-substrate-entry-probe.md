# Foreign runtime 接入 Substrate Hub：入口探测

日期：2026-10-06。状态：历史入口调研；后续实现和行为验收见 [最终报告](2026-10-06-foreign-substrate.md)。以下保留当时证据范围，不回写为实现结论。

## 工作区与本轮裁决

- worktree：`/home/u1/workspaces/superd/.worktrees/foreign-substrate`，branch `foreign-substrate`，HEAD `7410543`。
- 主目录上一阶段未提交的 tracked 改动及项目 untracked 文件复制为工作基线；`.claude/` 本机设置未复制。无 commit / publish / 生产服务变更。
- user 裁决：优先按次增量加载，插件由 Super D 保存，不改变已有插件，不写 foreign runtime 原生 home。原生 GUI / CLI 新会话不自动获得该 facility。
- 仅在按次增量机制不可行时写原生 data home；届时原生会话获得同机 loopback Hub facility 是接受的结果。此授权不涉及 `~/.dsh` / `~/.superd` 或生产服务操作。

## 证据与边界

### PI 0.84.2

本机 `pi --version` = `0.84.2`。`--extension/-e` 可重复；`--no-extensions` 是独立开关。

已安装包 `dist/core/resource-loader.js` 的 `reload()` 先解析已有 packages，再解析 `additionalExtensionPaths`（`temporary: true`），默认 `mergePaths(cliEnabledExtensions, enabledExtensions)`。这是增量合并的源码证据。

现役 adapter 是 in-process SDK；`agent-pi/src/pi-client.ts:66` 调 `createAgentSession`，不是 CLI spawn。接入时应使用官方 `DefaultResourceLoader.additionalExtensionPaths` 保留原有资源发现，再传给 `createAgentSession.resourceLoader`。

### OMP

本机 CLI 明确提供可重复 `--extension/-e`、独立 `--no-extensions` 和 `--plugin-dir`。现役 `agent-omp/src/rpc-client.ts:104` 执行 `omp --mode rpc ...args`，可通过现有 argv 接缝加扩展路径。

本轮没有验证 PI 与 OMP 的 Extension API 逐项兼容，也没有跑 OMP 扩展加载行为；同源不替代互通验收。计划共享插件主体，通过少量宿主兼容接线处理真实 API 差异。

### Codex 0.160.0

本机 `codex --version` = `codex-cli 0.160.0`。通过该 binary 的 `app-server generate-ts --experimental` 生成实际协议，输出在 `/tmp/superd-codex-0160-protocol`。

- `thread/start.dynamicTools` 接受函数 / namespace 定义。
- `item/tool/call` 将工具调用回交 app-server client，响应含 `contentItems` / `success`。
- `plugin/install` 接受 marketplace + pluginName；安装面与动态工具执行面是两个接口，不能仅由 `plugin/*` 存在推导支持自有工具代码执行。
- 在隔离 `CODEX_HOME=/home/u1/workspaces/superd/.tests/foreign-substrate-probe/codex` 中启动 stdio app-server，initialize 开启 `experimentalApi`，`thread/start` 注册一个无副作用工具（`ephemeral: true`）成功并返回 idle thread。无模型请求，没有写原生 Codex home。

这证明本机 binary 接受会话级动态工具注册；尚未证明模型实际调用、原有工具共存、resume、旧 thread 升级和原生客户端恢复同一 thread 的行为。

官方文档说明动态工具存入 thread metadata 并在 resume 恢复。故“原生新会话不自动加载”与“原生客户端恢复 Super D thread”必须分别验证。0.160.0 生成的 `ThreadResumeParams` 未公开 `dynamicTools` 字段，不能直接照最新版文档给旧 thread 补工具。

官方来源：[App Server](https://learn.chatgpt.com/docs/app-server)，[插件打包](https://developers.openai.com/plugins/build/plugins)。

## 代码入口核实

实际启动 typescript-language-server，通过上游 farm 的 TypeScript 6.0.3 查询 PI `createAgentSession` 的 definition / references；得到本地 SDK 结构声明和调用位置。全局 TypeScript 安装缺少 server 文件，首次启动失败，改用既有上游 farm 后成功。当前 worktree 尚无依赖解析环境，因此这次 LSP 结果没有深入真实 SDK 定义。

使用同一 TypeScript compiler AST 核实三条调用入口：PI `createAgentSession`、OMP `spawn`、Codex `thread/start` / `thread/resume`。未修改任何上游源码。

## 建议设计，待讨论

1. 共享 Hub 工具描述、schema 与执行逻辑；调用身份从接入层绑定 runtime + DSH session，避免现有 `a2a-row` 的 `native` initiator 固定值被错误复用。
2. PI / OMP 共用扩展主体，分别经 SDK resource loader / CLI `-e` 增量挂载。OMP 子进程通过会话绑定的 loopback transport 调 Hub；PI 可复用该 transport 保持插件体互通。
3. Codex 优先使用现役 app-server 的动态工具回调；由 adapter 自有代码执行 Hub 操作。这是官方宿主扩展接口，不是 marketplace manifest 插件，也不需要 MCP 或原生 home 安装。
4. 回信复用现有 Hub delivery → adapter handle 的 followup / steer / inject；模型工具的调用结果、工具描述和恢复提示均列入行为验收。
5. 实现后覆盖三个 runtime 的 create / prompt / resume、send / 自动回信 / exec、原插件共存；走整包 tarball 4999 与 dev3，保留 Web 测试线供 user 验收。

尚无功能代码变更，未运行构建 / 单测 / 整包行为验收。该报告不能作为发布放行依据。
