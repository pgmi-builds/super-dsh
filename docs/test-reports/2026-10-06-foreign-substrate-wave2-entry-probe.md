# Foreign Hub 第二批入口探测

日期：2026-10-06。范围：Claude、Hermes、AGY（Antigravity）。状态：Claude / AGY 仍在入口调查；Hermes 原生插件已实现并完成两端自动行为验收，见 [Hermes 报告](2026-10-06-hermes-native-hub.md)。不把格式验证算作模型接入成功。

## 已完成的第一批收尾

实现提交 `59c72f2`，合并 `18c3687`，合并消费者复验及清理记录 `81a5f80`。主工作区 `master` 保留本轮功能和主线已有 Codex runtime-fetch 修复。旧 `foreign-substrate` worktree、分支及注册已删除；必要测试证据 / 会话夹具迁出，长期测试数据保留。没有 push / npm publish。

合并后 950 项测试通过，`0.1.11-h` tarball 在本机 4999 和 dev3 4998 的 PI / OMP / Codex 会话均 cold resume 后实际调用 Hub exec，turn 4 completed；详见 [第一批报告](2026-10-06-foreign-substrate.md)。

## Claude

本机 CLI `2.1.261`，dev3 `2.1.202`。现役 adapter 使用真正 Claude Agent SDK query bridge；官方 `Options.plugins` 接受 `{type:'local',path}`，默认通过增量 `--plugin-dir` 传递。`pluginDelivery:'initialize'` 要求 CLI 至少 2.1.261，因此本轮不能用它作为两端共同基线。

本机 CLI help 明确 `--plugin-dir` session-only / repeatable；已有资源发现保持不关闭。SDK 实际声明列出插件能力 commands / agents / skills / hooks，插件还可包含 MCP。没有据这些入口宣称能直接注册普通自定义函数。

一次性无执行的格式夹具 `.scratch/foreign-wave2/format-probe`：`.claude-plugin/plugin.json` + `skills/hub-probe/SKILL.md` 经 `claude plugin validate` 通过，仅有缺少 author 的 warning。未安装到用户 home、未运行模型。

官方参考：[Anthropic plugin structure](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/plugin-dev/skills/plugin-structure/SKILL.md)。实际 SDK 类型声明位于本机 `agent-claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`。

## Hermes

本机 `v0.21.5+5594.gafc47d6`，dev3 `v0.21.5+5798.g009afb3.dirty`；目标机已有 dirty 状态非本轮造成，保持不改上游源码。

本机源码 `hermes_cli/plugins_discovery.py:189` 明确发现顺序为 bundled、user home/plugins、opt-in project cwd/.hermes/plugins、Python entry points；未找到任意 per-spawn 增量路径参数。项目目录入口需要 `HERMES_ENABLE_PROJECT_PLUGINS`，不能因此把用户 cwd 改为插件目录，也不能在用户项目里偷偷写插件。

`hermes_cli/plugins.py:457` 的真实 `PluginContext.register_tool` 接受 name / toolset / schema / handler / check_fn / requires_env；注册受插件生命周期跟踪，不需要替换原生工具。原生 Spotify 插件提供真实 register 用例。插件还受 `plugins.enabled` gate 控制，不能只复制目录就声称已启用。

如果后续无法找到适合现役 gateway 的按次入口，应按 user 已批准的 fallback 安装自有插件到 Hermes home，并仅合并自己的 enable 项。待核验：目标机对应 API、gateway 进程 toolset 选择、冷恢复绑定与原生会话缺少 Hub binding 时的可见行为。

## AGY

两端 CLI `1.2.16`。现役 adapter 是 stream-json headless CLI；当前 help 未公开增量 plugin path 参数。`agy plugin` 提供 install / import / enable / validate；`import` 可导入 Gemini 或 Claude 插件，不因此认定 manifest 逐项通用。

同一个无执行夹具：只放 `.claude-plugin/plugin.json` 被 AGY validator 拒绝，要求 root `plugin.json`。加 root manifest 后验证成功，skills processed 1；没有 hooks / agents / commands / MCP。这证明 skill 格式可消费，尚未证明模型加载、按次增量、工具执行或 resume。

`plugin install --help` 被此 CLI 当作待安装目录并拒绝，未执行安装；不能按其他 CLI 的帮助行为推断此入口。后续安装及 enable 必须复用真实 CLI / settings 合并，保留其他插件与原生 home。

## 实际 LSP / AST

使用 typescript-language-server stdio，并在 initialize 设置真实上游 TypeScript tsserver 路径。初次使用旧 CLI flag `--tsserver-path` 被拒绝，改为 initializationOptions 后成功。Claude `buildOptions` definition 指向 `claude-client.ts:424`，references 为定义及 `:348` 调用；没有把浅层查找扩大为 SDK 内部语义核实。

TypeScript Compiler API AST 实际遍历三个 client 的 CallExpression，定位 Claude sdkQuery / buildOptions、Hermes spawn、AGY spawn。Python ast 定位 Hermes collect_directory_manifests 和 register_tool 的完整参数结构。结果在 `.scratch/foreign-wave2/{lsp-results.jsonl,ast-results.json,python-ast-results.json}`。

## 历史候选设计（已被 user 否决）

沿用第一批零 MCP：Claude / AGY 的插件 skill + 本地 HTTP 调用脚本可消费现有 Hub facility；Hermes 使用原生注册工具。调用、身份绑定、回信仍复用第一批实现，不复制 Hub 业务。Claude 与 AGY 的 manifest 分别生成，脚本主体可共享。

与直接工具方式相比，skill 路线的模型实际 Surface 是 skill 指引 + 原生 Bash 工具，必须验收模型加载指引后真正执行 HTTP 调用，不能声称目录中出现一个独立 `superd-hub` 函数。如果选择官方 MCP，则需要扩展此前零 MCP 的设计边界；已向 user 提出这个具体选择。此处仍是候选设计，没有实装 native home 插件或改动业务代码。

## user 纠正与 Corti 实际核验

user 明确拒绝 skill + CLI 替代插件；要求 Claude、Hermes 以插件登记工具，不能 per-spawn 时写原生 data home。spawn / resume 直接登记可寻址的 handle，不依赖任何工具调用；native 未经 Super D spawn 的会话调用到邮局后报没有门牌号。无记忆式 prompt injection / prefetch / turn-end hooks。

Corti 实际源码：Hermes `src/integrations/hermes/__init__.py` 是原生 MemoryProvider；Claude `src/integrations/claude-code/.mcp.json` 与 `mcp/mcp_server.py` 则以插件内 stdio MCP 登记工具。`docs/runtime-integration.md` 同样注明 MCP tool surface。因此 Corti 不能证明 Claude 已有无需 MCP 的普通工具注册 API。已向 user 核实其禁止范围是否包含纯工具登记/调用层；异步投信明确不走该层，而由已持有的会话 handle 注入。

自动行为验收与 user 人工 Web 验收是独立状态。“测试线继续运行”只指服务可访问；未做 user 人工验收，不宣称 user 验收完成。
