# Codex official override、binary 与客户端身份探针

日期：2026-10-05（Asia/Hong_Kong）。本轮接续 native-default 探针，按 user 要求仅调查，产品代码保持暂停，4999 未更新，未发布、登录或改变 remote-control 注册状态。

## 结论

1. 当 config 顶层选了第三方且本机有 OAuth 时，子进程参数 `-c model_provider="openai"` 可覆盖 provider 选择，并用现有 OAuth 在官方路径真实生成。无需删除第三方表。
2. 该参数仅覆盖 provider 选择，不代表丢弃整个 config。model、model_catalog_json、profile 和其他设置仍需按原生合并规则处理。本轮共存配置没有自定义模型目录，不能据此声称任意第三方 config 都能仅靠一项覆盖完全恢复 official 默认设置。
3. 现场有客户端身份信息：initialize.clientInfo、CODEX_INTERNAL_ORIGINATOR_OVERRIDE，以及 remote 环境记录的 client_type。桌面 UI 使用 CODEX_CLI/CODEX_DESKTOP_APP 区分图标，支持 user 对消费端身份的观察。
4. 此次 SOL 差异不是必须依赖 desktop 身份才能解释的现象。同一认证、配置、代理与自有客户端名，0.160.0 binary 可生成 SOL，0.154.0 不可。尚未定位两版内部哪项请求或能力变更导致服务端结果不同。
5. 本机桌面核心与 DEV3 npm CLI 核心均 0.160.0，SHA-256 完全一致。因此这两个现场不是两份不同功能的 desktop/CLI 核心构建。

## Binary 盘点

| 来源 | 路径 | 版本 |
|---|---|---|
| 本仓 adapter | super-dsh/agent-codex/node_modules/@openai/codex/bin/codex.js（npm Node 入口） | 0.154.0 |
| 本机桌面 | /usr/lib/chatgpt/resources/codex（核心 ELF） | 0.160.0 |
| DEV3 CLI | /home/u1/.local/bin/codex → ../lib/node_modules/@openai/codex/bin/codex.js | 0.160.0 |
| DEV3 CLI 核心 | /home/u1/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex | 0.160.0 |

桌面核心与 DEV3 CLI 核心 SHA-256 均为 `12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`。SSH 只读查询；没有在 DEV3 发起生成、改配置或重启。非交互 SSH 的 PATH 初次找不到 codex，改为已定位的绝对路径后正常读取版本。

## 探针方法

一次性脚本 `.scratch/codex-oauth-spike/identity-probe.mjs`。沿用 CodexAppServerTransport，GOST HTTP 代理，ephemeral thread，read-only sandbox，拒绝工具，仅要求固定短回复。

binary/身份对照清除继承的 CODEX_*、OPENAI_* 与 proxy 变量，再明确设置 GOST 和 loopback NO_PROXY；保留 native home 的认证和 config，不设置模型或 provider 覆盖。标准客户端名是 superd-identity-probe。

桌面 ELF 不能直接作为生产 transport 的 command：该 transport 使用 `node <command>`，假定 command 是 npm Node 入口。首次探针因此出现 ELF SyntaxError；添加一次性 `desktop-entry.mjs` shim 转发 stdin/stdout 后完成实验。未改变产品 transport。这是探针启动问题，不是桌面核心不支持 app-server。

共存对照使用临时 CODEX_HOME：config 顶层选择 probe-third-party，第三方地址 loopback port 1，env key 为合成测试值，模型 gpt-6-astra；auth.json 是原生 auth 文件的只读使用链接，没有复制 token。裸启动仅观察路由，不向该第三方发送生成请求；显式 openai 案例向官方生成。每次检查原生 config/auth 内容指纹，全部 unchanged=true。

## 真实路由与生成结果

| 案例 | Binary | 客户端名 / originator override | Thread provider / model | 结果 |
|---|---|---|---|---|
| 共存 config，bare | 0.154.0 | 自有名 / 无 | probe-third-party / gpt-6-astra | 路由到第三方；未生成 |
| 相同共存 config，加 -c model_provider=openai | 0.154.0 | 自有名 / 无 | openai / gpt-6-astra | completed，固定短回复匹配 |
| native config，bare，无桌面身份 | 0.160.0 | 自有名 / 无 | openai / gpt-6.1-sol | completed，固定短回复匹配 |
| native config，bare，同一干净环境 | 0.154.0 | 自有名 / 无 | openai / gpt-6.1-sol | failed，HTTP 400：模型不支持该 ChatGPT Codex 请求 |
| native config，桌面身份 | 0.160.0 | codex_desktop / Codex Desktop | openai / gpt-6.1-sol | model/list 包含 SOL；未重复生成 |
| native config，旧 binary 加桌面 env | 0.154.0 | 自有名 / Codex Desktop | openai / gpt-6.1-sol | model/list 仍无 SOL；未重复生成 |

0.160.0 model/list 默认 SOL，包含 gpt-6-astra/6-sol/6-luna 和前轮旧目录。0.154.0 默认 Astra，未包含 SOL 6.1。目录只提供候选清单，成功 turn 才是实际访问证据。

## 桌面客户端的静态证据

只读解包现场 `/usr/lib/chatgpt/resources/app.asar` 中相关 JS 到 scratch，未执行这些模块。

- application-network-startup 模块为 app-server 子进程设置 CODEX_INTERNAL_ORIGINATOR_OVERRIDE，默认 Codex Desktop；initialize 使用 clientInfo.name=codex_desktop、title=Codex Desktop。
- 同模块存在 features.code_mode_host=true、analytics-default-enabled，以及可选 CODEX_APP_SERVER_CHATGPT_BASE_URL/CODEX_APP_SERVER_OPENAI_BASE_URL。它们是另外的启动差异，但本轮不带这些桌面启动参数也成功生成 SOL，所以不是本轮 SOL 成功的必要条件。
- 主模块把 remote 返回的 client_type 映射到本地 clientType；同时读取 environment kind、app_server_version 等字段。
- remote-connections-settings 模块根据 clientType 的 CODEX_CLI 与 CODEX_DESKTOP_APP 等枚举选择不同图标。
- 实测改变 CODEX_INTERNAL_ORIGINATOR_OVERRIDE 会改变 initialize userAgent 和 thread.originator；没有令旧 binary 的 SOL 目录与新版一致。
- 0.160.0 自带生成协议的 ClientInfo 只有 name/title/version；RemoteControlEnableParams 只有 ephemeral。本轮没有发现名为 desktop 的标准 initialize 切换参数。

这些证据确认了客户端身份与展示字段的存在，但没有确认服务端怎样生成 client_type，也没有直接检视 iOS 标签代码。不能把 UI 标签直接当作模型授权机制，更不能承诺靠伪装身份获取权限。

## 官方说明与后续决策

[官方 app-server 说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)解释 initialize.clientInfo.name 用于请求来源归属、version 用于 User-Agent；模型目录不等于访问授权，完成一次 inference turn 才验证该次模型访问。该页面介绍的是另一种 Sign in with ChatGPT 接入配置，本轮沿用原生 Codex OAuth，没有照该页面复制 token 或变更 provider 端点。

最终设计可讨论保留两个明确语义：User Default 完全继承原生选择；OpenAI OAuth 用子进程覆盖 builtin provider，认证交给 binary。模型目录应来自实际使用的 binary，而不是另一客户端留下的共享缓存。若拟升级 adapter 的 exact-pin，应单独执行构建、协议与 4999 交付形态回归；本轮成功探针不是该升级的交付验收。
