# External analysis — MCP 工具 schema 严格解析（谁在拒绝 `^agent\_run\_`）

- **Origin:** 外部 agent（修复 exa 过滤的 agent）产出，2026-09-29。
- **Reviewed:** superd-hub 于 0.1.7-n 对照上游 checkout 重核（2026-09-30），结论**采信并钉死在代码**：不对称是 `parameters: inputSchema`（verbatim）vs `output: createOutput(..., supportedOutputSchema(...))`（校验）那一行。
- **归档理由:** 修正了根因叙述——不是「DSH 笼统透传 schema」，而是「Anthropic Messages 严格面编译 `pattern`」；以及「20:36 不是切模型、是切 API 面」。
- **本仓库的回应:** ADR 0013（边界只投影不穿透）+ ADR 0012（原生 > MCP 的结构性原因 = 注册期编译器）。

---

（以下为外部分析正文）

Their test settles the third leg — and it's neither of our earlier stories. I pulled the provider side locally:

## 谁在严格解析：是 API 面，不是 harness

| | Hermes | DSH |
|---|---|---|
| 端点 | `https://api.deepseek.com/v1/chat/completions`（OpenAI 兼容） | `https://api.deepseek.com/anthropic`（**Anthropic Messages 面**） |
| 证据 | research 库里 24,574 个 `deepseek-v4-pro` 会话的 base_url | `dsh-llm-deepseek` 插件里唯一的 baseURL 就是它，带 `anthropic-version` / `anthropic-beta` 头 |
| 同一份 `pattern: ^agent\_run\_` | 通过（他们刚实测：请求过、resume 过、坏 id 被客户端正则拦住） | 拒绝（`"^agent\_run\_" is not a "regex"`） |

`agent_default_model` 在 prod 里现在就是 `deepseek-official/deepseek-flash` → 也就是说这条严格面是**默认路由**。

所以对他们那条结论的修正只有一句，但很关键：**Hermes 并非"从不把这份 schema 交给严格解析器"** —— 它把 schema 发出去了（7–8 月那些 dump 里 exa schema 就在 `body.tools` 里跑 DeepSeek）。只是 OpenAI 兼容面不用严格正则去编译 `pattern`。Hermes 的安全是**端点属性**，不是它的设计。可证伪：把一个 Hermes profile 指到 Anthropic 面（或 DeepSeek 的 `/anthropic`）+ exa 不过滤 + 关掉 `tool_search`，预期同样 400。

我之前说的"20:36 切模型"也要再收敛一格：不是切了个模型，是**切到了另一个 API 面**——`zai-plan/glm` 走 openai-completions 风格，`deepseek-official` 走 Anthropic 面。同一个 72 工具表，之前几十轮全在宽松面，20:36 一过就撞严格面。

## 回答他们的问题

**research profile：保持原样，什么都别动。** 它现在能用，但"能用"的来源是端点宽松 + agent_run 那份 schema 没进 wire（老的没这个工具、9/29 那份被 tool search defer 掉了）。别把这次成功当成"Hermes 比 DSH 稳"的证据——换个面它就一样炸。

**DSH 要不要拿回 agent_run：** 值得，但不是这轮该顺手做的事。

- **正确修法（推荐，留到下次上游对齐轮）**：在 `dsh-mcp-client` 边界把 MCP 的 `inputSchema` 投影进 DSH 自己声明的受支持子集——它对 output schema 已经这么干了（`supportedOutputSchema`：不支持就丢弃），input 侧却原样透传。一屏代码 + 测试，且对**所有** MCP server、**所有** route 都成立。前提是要你批准第 4 个 sanctioned patch；要进 prod 还涉及构建/发版决定。注意升级没用：`0.1.7-rc.2` 和 `0.2.0-rc.2` 我都拉下来看过，都没修。
- **短平快（想要这周就在 prod 用上）**：exa 那份 schema 目前的报错只点名 `pattern`（`minLength`/`maxItems`/`$schema` 是提示性关键字，丢了无损，约束权威仍在 exa 服务端——他们那个坏 id 测试正好说明服务端/客户端校验都在）。所以一个把 pattern 规范掉的小本地 MCP 代理就能恢复 agent_run，不碰上游；代价是多一个受监管进程。
- **零成本**：保持现在的 `?tools=web_search_exa,web_fetch_exa`，agent_run 缺席但 search/fetch 齐全，而 agent_run 你在 Hermes 那边照样能用。

我的建议：**这轮就停在过滤**（已经在跑、已验证），把 mcp-client 的 inputSchema 投影写进下一次上游对齐轮的正式条目；如果你现在就想在 DSH 里用上 agent_run，我按短平快那条做个最小代理，先在 499x 测试线上按"同一份坏 schema 两种 route"验证一遍再上 prod。

---

## 本仓库复核结论（superd-hub，2026-09-30）

- 采信；不对称代码锚点：[`upstream/.../packages/mcp/mcp-client/src/tools.ts`] `parameters: inputSchema`（verbatim）vs `supportedOutputSchema`（`assertSupportedJsonSchema` 校验后丢弃）。
- 原生路径有注册期编译器（`defineTool` → `parameterSchemaSpecToJsonSchema` → `assertSupportedJsonSchema`），所以 superd-hub 的 schema 无法非法进 wire——这就是「原生插件做得到、MCP 做不到」的机器级答案。
- 短平快（本地代理）**不建议做**：为丢得起的关键字多起一个受监管常驻进程。
