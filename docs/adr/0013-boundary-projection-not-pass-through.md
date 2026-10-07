# ADR 0013 — 边界只做投影，不做穿透（Boundary Projection, Not Pass-Through）

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** user（裁决）+ superd-hub
- **Supersedes / relates:** ADR 0012（载体 = 原生插件，非 MCP）；spec D16（邮局形态）

## Context

两起事故（2026-09-29）表面无关，实为同一种缺陷：**边界把外来物当成了穿透（pass-through），而不是投影（projection）**。

1. **MCP 输入 schema 穿透**（exa `agent_run` 事故）。MCP server 的 `inputSchema` 被 `dsh-mcp-client` 原样写进工具定义（`packages/mcp/mcp-client/src/tools.ts` 的 `parameters: inputSchema`），未经任何校验。exa 那份 `pattern: "^agent\_run\_"` 不是合法 regex，被 DeepSeek 的 **Anthropic Messages 严格面**（`https://api.deepseek.com/anthropic`）拒绝，导致该 session 每一轮 `400 INVALID_REQUEST`（request_id `30ce3099-d936-4b4e-94df-a1e2abdb68ae`）。修复 = prod 里 `?tools=web_search_exa,web_fetch_exa` 过滤掉 `agent_run`（2026-09-29 20:50）。

2. **工具面穿透 transport 结构**（A2A `new_conversation` / `send` 两扇门）。工具面从 transport 的 1:1 结构（spawn 走会话创建、deliver 走投递）抬上来，导致两扇等价的门、两套 receipt、两种失败形态（throw vs 结构化）。wire 早已收敛成「信封 + kind」，surface 没跟上——leaky abstraction。

## Decision

**每一个边界只允许「投影 + 校验」，不允许「原样穿透」。**

- 外来 schema（MCP `inputSchema`）在进 wire 前必须过宿主自己的受支持子集校验；不支持 → 丢弃，绝不原样转交。
- 模型可见的工具面（surface）是**任务模型**的投影，不是 transport / hub 内部结构的投影；transport 的两条实现路径可以保留，surface 必须把它们投影成一个自洽的心智模型。

代码库里已经有这个原语，只是只用了一半：`assertSupportedJsonSchema`（`@deepseek-ai/dsh-tools`）被用在 MCP **output** 侧（`supportedOutputSchema`：不支持就丢），**input** 侧却原样透传。原生工具的 `defineTool` → `parameterSchemaSpecToJsonSchema` → `assertSupportedJsonSchema` 是**注册期**硬编译——这正是原生路径（ADR 0012）结构上优于 MCP 的原因：原生工具根本无法把非法 schema 送进 wire（boot 期即炸在自己面前），MCP 路径没有这道门。

## Consequences

- **MCP inputSchema 投影**：在 `dsh-mcp-client` 边界把 MCP `inputSchema` 投影进 DSH 声明受支持子集（与 output 侧对称）。这是**上游对齐轮**条目，需要 user 批**第 4 个 sanctioned patch**；升级无解（0.1.7-rc.2 / 0.2.0-rc.2 未修）。本轮不动。
- **工具面收敛**（0.1.8 surface pass）：一个 `send` 门 + `created` 标志，`new_conversation` 直接删除（底层 `newConversation` 逻辑 wire 进 `send`）；receipt 单形；`(conversation opened)` 字面量 → typed open。
- **持续隐患备案**：prod 默认路由就是 Anthropic 严格面，任何未来接入的 MCP server 只要 schema 有一处不合规就能杀整轮。所有 MCP server 的 `tools=` 白名单过滤是暂态缓解，根治在投影补丁。
- 命名纪律（延续 ADR 0012）：模型面 / 文档按实际载体称呼；「MCP」一词只在确指 MCP 载体时使用。
