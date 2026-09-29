# ADR 0012 — 工具面载体 = per-runtime 原生插件；MCP 不作载体

- 状态：accepted（user 裁决：2026-09-20/21 讨论 + 2026-09-29 复述并追问；落档 2026-09-29）
- 关联：spec `machine-mesh-a2a` §1 D13/D14、§9（单工具面）、§10（P5 注入分阶段）；
  docs/01-component-boundaries（`mcp-client` 明确归「DSH agent 运行时」= 上游，superD 不拥有）；
  ADR 0009（wire gateway）、ADR 0011（邮局形态）；codex 计划（`codex mcp-server` ≙ 已弃方向）、
  teleport 设计（MCP = additive 工具桥，非 substitute）

## 背景

superd 的工具面（`superd-hub`）要给「本机与远端的各种 agent runtime」用。候选载体有二：

1. **各 runtime 自己的插件/扩展接口**——往对方进程里挂我们自己的一段代码；
2. **MCP**——用一个协议标准把事情做成「加一个 MCP server」。

user 在 2026-09-20/21 的 a2a 工具面讨论中已裁定 ①，并给出理由：**MCP 的异步与投递面薄弱**
（SSE/长连接脆弱、跨进程 lifecycle 不在我们手里、schema 校验面不归我们管），而插件形态
「写什么都可以，想同步就同步、想异步就异步」。此裁决当时只存在于会话记录与各 adapter 研究里，
**未落档为决策**——本 ADR 补记，并给出落地边界。

2026-09-29 的反面证据（一次真实事故，与本仓无关但同类）：生产 profile 的 MCP 配置里，
exa MCP server 的 `agent_run` 工具 schema 写着 `"pattern": "^agent\_run\_"`（zod `.startsWith`
转义产物，不是合法 regex）。**DSH 逐字透传 MCP input schema**，于是模型提供方整请求拒收
（`INVALID_REQUEST: Invalid schema for function 'mcp__exa__agent_run'`），**该 session 每一轮都失败**
——症状就是「session 卡死、无法恢复」。修法是 MCP 侧把该工具过滤掉（prod `web` profile
`cordis.patch.yml` 2026-09-29 20:50 已改：`url: …?tools=web_search_exa,web_fetch_exa`）；
Hermes 的 `mcp_servers.exa` 仍是未过滤 URL，同类故障面仍在。
这条链路恰好是「不要把 superd 的工具面押在 MCP 上」的实证。

## 裁决

1. **superd 的工具面一律走各 runtime 自己的插件/扩展接口，代码是我们自己的**：
   - **DSH（现状，唯一已落地）**：superd 本身就是一个 DSH cordis 插件行；工具在
     **进程内**经宿主 `tools` 服务注册（`ctx.tools.register(defineTool(...))`，
     `@deepseek-ai/dsh-tools`）。没有独立进程、没有网络 hop、没有外部 schema 校验面。
   - **OMP / Pi（P5）**：per-spawn 增量插件——hub 保留插件体，spawn 时动态挂载。
   - **Claude Code（P5）**：盘注入（插件写入其插件 path 目录）+ SDK 控制面
     （`setMcpServers`/`reloadPlugins`/hooks 等，见 claude adapter 研究）。
   - **Codex（P5）**：`app-server` 的 `plugin/*` 面（160+ 方法里已有）；`codex mcp-server`
     早已判为弃方向。
   - **Hermes / agy**：后排。
2. **MCP 明确不作 superd 工具面的载体**：superd 不实现 MCP server，也不经由 MCP client
   投递自己的任何能力。MCP 只作为**宿主/runtime 自带的第三方工具来源**存在
   （exa / graphify / orch-a2a / web-reader / zai-vision 等是生产 profile 的 MCP 配置，
   与 superd 无关）。
3. **异步能力的落点**：a2a 回复走宿主 Agent handle（`followup` / `steer` / `inject`，
   进程内、无人轮询）；exec / PTY 走 **hub↔hub 的 HTTP/WS 通道**（spec §8），在目标机本机
   runtime 内落地。两者都不借 MCP 的 transport。
4. **命名纪律（语义面即产品）**：模型面/文档/报告里必须按实际载体称呼——
   DSH 原生工具叫「DSH-native tool（tools service）」，外来 runtime 叫「<runtime> plugin」；
   **不得把 DSH 原生工具写成 MCP**。术语错误即产品缺陷（消费者是模型/agent，名字就是接口）。
   —— 触发本条的历史：2026-09-29 的 0.1.7-g / 0.1.7-m 第一人称报告把 `superd-hub`
   写成「MCP tool surface / MCP leg」，我方 triage 报告照抄，直接导致 owner 误判
   「remote execution 是用 MCP 实现的」。相关报告已加更正横幅。

## 后果

- **P5 = per-runtime 注入实现**，验收统一为：在**该 runtime 的第一人称会话内**调用 `superd-hub`
  完成一次 `send`（以及 exec 一条）——与 DSH 原生同一标准。
- 明确否掉「给所有 agent 加一个 MCP server」的捷径；也否掉「superd 内部再叠一层 MCP」。
- 对上游的 bug 报告（与本仓无关但值得提）：harness 对 MCP input schema 应做**校验/消毒**
  （非法 regex 应被拒或规范化），而不是逐字透传给模型提供方导致整轮失败。
- 开放：Codex / Claude 的具体注入点仍需 P5 spike 在真机验证（adapter 研究已打底）。
