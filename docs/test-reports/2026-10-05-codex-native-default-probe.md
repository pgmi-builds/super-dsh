# Codex 原生默认配置与 OAuth 探针

日期：2026-10-05（Asia/Hong_Kong）。本轮按 user 要求只做探测，等待最终设计；没有将待定实现安装到 4999，没有重新登录、发布或修改原生 config/auth。

## 方法与边界

使用 adapter 实际解析到的 `@openai/codex` 0.154.0 binary，通过生产 `CodexAppServerTransport` 调用 app-server。直连和代理生成使用本机现有认证，`account/read(refreshToken:false)` 返回 `chatgpt`；线程 ephemeral、只读 sandbox、禁止工具，仅要求固定短回复。代理为测试环境变量 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://dev3.internal.test:7474`，loopback 位于 NO_PROXY。每次比较 config.toml/auth.json 的内容指纹，报告仅保存是否相等，不保存 token、账号标识或请求认证值。

配置优先级实验另用临时 CODEX_HOME、合成认证和 loopback endpoint，只运行 initialize/config/read/thread/start，不执行生成，故只证明本地路由，不证明合成凭据有效。

探针源码与脱敏输出位于 `.scratch/codex-oauth-spike/`：`probe.mjs`、`http-shape-probe.mjs`、`auth-probe.mjs`、各模式 JSON。

## 本地 provider 优先级

| 配置与调用 | config/read provider | thread/start provider |
|---|---|---|
| 顶层 model_provider 指向第三方，同时有 OAuth 形状认证 | probe-third-party | probe-third-party |
| 同上，仅 argv 覆盖 model_provider="openai" | openai | openai |
| 同上，仅新线程 RPC 指定 modelProvider=openai | probe-third-party | openai |
| 去掉顶层第三方选择，保留 OAuth 形状认证 | 未设置 | openai |
| 只有第三方 provider 表，没有顶层选择 | 未设置 | openai |

所有 fixture config 内容不变。因此“有第三方配置”必须区分表的存在与顶层选择；OAuth 的存在不会覆盖已选中的第三方。删除整个 config 不是必要条件，删除选择后还需满足有效认证和模型等条件，不能将路由选择等同于生成成功。

## HTTP 请求字段

真实 binary 向临时本地 HTTP mock 发起 Responses 请求（合成 API key）；捕获 `/v1/responses`。请求体无 provider/model_provider/modelProvider 字段，provider id 也未出现在 body 或 header values。只保存字段名和布尔结果，没有记录原始请求内容。mock 返回预期 400，实验用于观察请求形状。

此外，下表中的显式 builtin openai + 官方 OAuth 真实生成成功，直接否定“指定本地 openai 标签必然导致官方拒收”的假设。本地配置选择与服务端 HTTP 参数是不同层。

## 本机现有 OAuth 真实生成

本机 config 的 model 是 `gpt-6.1-sol`，顶层 model_provider 未设置。

| 情况 | 线程 provider/model | 结果 |
|---|---|---|
| 直连，bare app-server，无 provider/model 覆盖 | openai / gpt-6.1-sol | HTTP 403，生成失败 |
| GOST，bare app-server，无 provider/model 覆盖 | openai / gpt-6.1-sol | HTTP 400：该模型不支持用于此 ChatGPT 账号的 Codex 请求 |
| GOST，仅 argv 指定 builtin openai | openai / gpt-6.1-sol | 相同模型错误 |
| GOST，bare app-server；诊断性 thread/start.model 指定 model/list 默认模型 | openai / gpt-6-astra | completed，固定短回复完全匹配 |
| GOST，argv 指定 builtin openai；相同诊断性模型覆盖 | openai / gpt-6-astra | completed，固定短回复完全匹配 |

五次均 configUnchanged=true、authUnchanged=true，没有调用登录或显式刷新 token。两次成功证明现有 OAuth 可用于官方生成；早先无凭据 curl 的 401 不提供该账号认证有效性证据。直连 403 与代理结果不同，说明出口路径影响请求；本轮未进一步判定 403 是地理限制还是其他边缘策略。

## 模型目录发现

先前只读磁盘检查：桌面 App 0.160.0 写入的 models_cache.json 包含 `gpt-6.1-sol`；本机 config 也选择它。

这次 binary 0.154.0 的 model/list 实际返回：

- gpt-6-astra（isDefault=true）
- gpt-5.6-sol
- gpt-5.6-terra
- gpt-5.6-luna
- gpt-5.5

目录没有 gpt-6.1-sol；保留 config 的该模型时请求被服务端拒绝。换成目录默认模型后成功。这是本轮确认的失败点，尚不能单凭版本差异断言 SOL 只因 binary 版本而不可用。

原生 binary 自行刷新了共享 models_cache.json，随后只读检查其 client_version=0.154.0，目录与上述返回一致。config/auth 不变不意味着 native cache 完全不变；桌面与 CLI 共用 cache，单独读取磁盘旧缓存不能保证适用于当前 adapter binary。

## 留给最终设计的决定

1. `User Default` 可以严格采用 bare app-server，让原生 config/provider/auth 决定路径；本轮证明路由行为，但本机当前 SOL 配置的完全 bare 生成仍失败。
2. 如果要求完整继承用户 model，就应呈现实际模型错误；如果希望采用 app-server model/list 默认模型，需要 user 另行确认覆盖规则。本轮两次模型覆盖仅为诊断，不是产品默认行为。
3. 若需要 UI 模型目录，优先考虑当前 binary 的 model/list；需讨论 lazy spawn、目录刷新，以及第三方目录与 native 目录的边界。不能把另一 binary 留下的 cache 当作无条件权威。
4. 强制 builtin openai 的方向在技术上可行，真实同模型生成已通过；是否采用仍由 user 最终裁决。待定代码保持暂停，探针不构成 4999 或交付形态验收。
