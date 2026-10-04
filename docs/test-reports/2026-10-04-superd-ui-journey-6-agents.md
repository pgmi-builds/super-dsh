# Super D UI Journey Test — 6 Foreign Agents(真实 UI 操作全链路)

- **日期**: 2026-10-04
- **被测线**: `superd-4999-test.service`(pack `super-dsh@0.1.10-e`,profile `superd-pub`,DSH base `0.2.0-rc.2`),经 live Caddy `https://test.pc.internal.test` → `127.0.0.1:4999`
- **测试者**: omp browser device(真实 Chromium)⊕ 页面 WebMCP(`@pgmi-builds/superd-dev-webmcp`,dev-only 注入)
- **方法**: 全部 journey 为真实 UI 行为 —— 点击 Hub 面板 → 点击 `Switch to <Agent>` → 处理模态(如 Claude 的 Preview Notice)→ 点击 `New session` → 点击 composer(Lexical 编辑器)→ 逐键输入 prompt → 点击 `Send message` → 轮询会话面板直到终态。HTTP RPC 记录(`POST /hub/api/*?agent=<label>`)仅作佐证。
- **Prompt**: `Reply with exactly: UI-OK-<XX>`(每 agent 唯一标记,防串扰)

## 总矩阵

| Agent | seat 切换 | 会话创建 | turn 执行 | 上游结果 | 判定 |
|---|---|---|---|---|---|
| **OMP** | ✅ | ✅ | ✅ | ✅ `UI-OK`,`Completed in 6s`,19.1K tok,glm-5.3-flash | **PASS(全绿)** |
| **Antigravity** | ✅ | ✅ | ✅ | ✅ `UI-OK-AG`,`Completed in 5s`,17.6K tok,Gemini 3.8 Flash | **PASS(全绿)** |
| **Claude** | ✅(过 Preview Notice) | ✅ | ✅ | ❌ `API Error: 402 Insufficient Balance` | 链路 PASS / 账户 FAIL |
| **Pi** | ✅ | ✅ | ✅ | ❌ `Request quota exhausted`(QUOTA) | 链路 PASS / 账户 FAIL |
| **Hermes** | ✅ | ✅(boot 警告为暂态,见 F1) | ✅ | ❌ `Request quota exhausted`(QUOTA) | 链路 PASS / 账户 FAIL |
| **Codex** | ✅(RPC family 全 200) | ❌ `sessionController is unavailable` | ❌ 从未发生 | — | **FAIL(确定性缺陷,见 F1)** |

UI 基础面(6/6 全部通过):Hub 面板 roster 完整(6 runtime + 3 个默认 disabled 的 SDK 半)、seat 切换全部成功、每次切换的 `/hub/api/*?agent=<label>` RPC family 全 200、页面零 JS 错误(F2 的 burst 除外,见下)、`Reconnecting… → Connected` 指示灯(~1.4s)为 seat 切换的正常 mux 重建。

## 各 Agent 详情

### OMP — PASS
- Journey: Hub → Switch to OMP → New session → 输入 → Send。
- 面板终态文本:`Completed in 6s / UI-OK / Usage 19.1K tok / 1 turns 1 steps`;模型 glm-5.3-flash;Access mode Full access。
- 佐证:`POST /hub/api/session/prompt?agent=omp` → 200;workspace 树切为 `superd` 项目真实会话存储。

### Antigravity — PASS
- 面板终态:`Completed in 5s / UI-OK-AG / Usage 17.6K tok`;模型 Gemini 3.8 Flash(medium reasoning)。
- workspace `corti` 真实历史会话(13h/14h/1d + Show 3 more)正常列出。
- 佐证:`POST /hub/api/session/prompt?agent=agy` → 200。

### Claude — 链路通,上游 402
- seat 首切弹出 `Preview Notice` 模态,点击 Continue 正常进入。
- New session 成功、prompt 送达(`POST /hub/api/session/prompt?agent=claude` → 200)、turn 真实执行。
- 上游拒绝:`API Error: 402 Insufficient Balance (request_id: 791fc247-c06e-49ed-90c8-8acbb6758e45)`,UI 渲染 `Failed / This turn failed / Claude turn failed` 横幅 + 错误消息 —— **错误路径的 UI 呈现本身验证通过**。
- 结论:superd 桥接无责;Claude 侧账户余额问题。

### Pi — 链路通,上游 QUOTA
- 面板终态:`Failed / This turn failed / Request quota exhausted. / QUOTA`。
- 佐证:`POST /hub/api/session/prompt?agent=pi` → 200;模型 DeepSeek V4.1 Flash。
- 结论:与 Hermes 共用的上游账户配额耗尽,非桥接问题。

### Hermes — 链路通,上游 QUOTA
- 面板终态:`Failed / Request quota exhausted / QUOTA`;模型 deepseek-v4-pro (reasoning)。
- **重要**:boot 日志的 `superd-hermes: warning: 1 entry did not activate (session-controller pending: fileUploads)` 为**暂态** —— 会话创建、turn 执行均正常。与 Codex 的同文警告性质不同(见 F1)。
- 佐证:`POST /hub/api/session/prompt?agent=hermes` → 200,延迟 12s。

### Codex — FAIL(确定性)
- 现象:seat 切换成功(roster 高亮 `Codex is current`,`/hub/api/*?agent=codex` 全 200),但主区 composer 永不渲染;点击 New session 无效;Hub 面板 Escape 无法关闭(仅再点 Hub 可收起)。
- 页面控制台(in-page dev_console 精确错误):
  ```
  [error] [session-controller] control stream failed: RemoteError: typert gateway:
          session/control: active Service "sessionController" is unavailable
  [warn]  new session failed: SessionCreateError: session create failed:
          gateway/service-unavailable: typert gateway: session/create:
          active Service "sessionController" is unavailable
  ```
- 服务端 boot 日志(两次 boot 同文):
  `superd-codex: warning: 1 entry did not activate — session-controller (@deepseek-ai/dsh-api-session-controller): pending (waiting for service: fileUploads)`
- 复测:约 40 分钟后二次 journey 重试,**仍然失败**(非暂态)。

## 发现(Findings)

### F1 — Codex world 的 sessionController 永不可用(缺陷,当前现役)
- **症状**:codex world 内 `sessionController` 服务永不激活 → `session/create` 一律 `gateway/service-unavailable` → UI 无 composer,不可用。
- **依赖链**(上游 `packages/api/session-controller/src/index.ts`):`SessionController.inject` 含 `fileUploads`;boot 警告指明 pending 的正是 `fileUploads`(提供方 `packages/client/file-upload`)。
- **回归窗口**:boot 日志中 `superd-codex: warning` 仅出现在最后两次 boot(即 0.1.10-e 安装后,14:54);此前所有 boot 只有 hermes 同文警告。0.1.10-e 恰为加入 `agent-codex-sdk` 行的版本(2026-10-04 user ruling)。时间强相关,因果未证。
- **对照**:hermes 同文警告但功能完好(暂态、自愈);omp/claude/pi/agy 从无此警告。六个 world home 目录结构一致(`profiles/sessions/storages`),六个 adapter 的 `cordis.patch.yml` 近乎同构 —— 差异在 provider 插件自身的服务图,需后续在 codex world 树内排查 `client/file-upload` 行的激活条件。
- **影响**:Codex runtime 完全不可用(UI 不可发起会话)。

### F2 — `commands/list` 客户端重试风暴(缺陷,一次性)
- 17:58:52(Claude turn 失败瞬间),页面在 **~450ms 内**发起 >1243 次 `POST /hub/api/commands/list?agent=claude`,全部 `net::ERR_INSUFFICIENT_RESOURCES`(浏览器资源耗尽,客户端拒绝分配)。
- 特征:无退避的同步失败→立即重试循环;绑定 `agent=claude`(当时 seat);一次性爆发,此后零增长(观察至测试结束)。
- 影响:该窗口内页面网络面自伤;未观察到服务端或其它 seat 的持续损害。建议:为 seat 作用域的 client 轮询/重试加退避与上限。

### F3 — 上游账户面(环境,非缺陷)
- Claude:402 Insufficient Balance;Pi + Hermes:Request quota exhausted(共用账户)。
- 不影响 superd 桥接判定;这三个 agent 的「链路 PASS」以 turn 真实执行 + 错误正确渲染为据。

## 方法论备注
- 本轮即「harness 驱动 + 页面 WebMCP 评分」的组合首次实战:`dev_changes`(动作前后 DOM 有序 diff)、`dev_console`(in-page ring,拿到 `[object Object]` 背后的 RemoteError 全文)、`dev_network` 均出力;harness 侧负责导航、点击、键盘输入、CDP 级网络/错误与截图。
- 工具语义坑(供后续测试复用):`tab.type(text)` 是 selector 语义(会把文本当 CSS selector,抛 `SyntaxError`),contenteditable/Composer 一律用元素句柄 `.type()`;DSH 无 `<main>`,会话面板轮询用 `document.body.innerText` + 排除 composer(`[data-lexical-editor="true"]`)后再匹配标记。

### 追加(2026-10-04 晚):hermes × z-ai/glm-5.3-flash 尝试
- **UI 层全部打通**:清除 client 侧陈旧会话状态(`hermes:dsh.sessions.current` 等 9 键)→ reload → 新会话创建成功 → 模型菜单(534 项虚拟列表)滚动选中 `z-ai/glm-5.3-flash (reasoning)` 且芯片持久化 → prompt 发送(`POST /hub/api/session/prompt?agent=hermes` 200)→ turn 真实执行。
- **turn 仍失败**:`Request quota exhausted (QUOTA)` — 但这次与 deepseek 配额无关:该错误是 hermes 适配层(`agent-hermes/src/agent.ts` `wireFailure`)对 hermes CLI wire `stopReason:"error"` 的分类透传,拒绝来自 **hermes runtime 自己的 provider 凭据层**。
- **根因(凭据缺失,非模型层)**:`~/.hermes/config.yaml` 的 `zai-plan` provider 要求 `key_env: CUSTOM_ZAI_API_KEY`;hermes 进程 env 无此变量(shell 里只有名字不同的 `ZAI_PLAN_API_KEY`;systemd user env、`~/.hermes/auth.json` `.providers` 均为空)。UI 目录里的 `z-ai/glm-5.3-flash` 来自 models.dev 缓存,与 provider 配置脱节。
- **次要脱节**:`zai-plan` 配置的模型表没有 `glm-5.3-flash`(只有 glm-5.3/5.2/5.1/5-turbo/4.7)。
- **修复路径(待 user 裁决)**:① 以 `CUSTOM_ZAI_API_KEY` 注入 hermes 可见 env(`systemctl --user set-environment` + 重启 4999 线,或 hermes login 写 auth.json);② 或把 config.yaml `key_env` 改名为 `ZAI_PLAN_API_KEY`。两者都动 `~/.hermes`(原生家),不自决。

### 追加 2(2026-10-04 晚):deepseek 重试 ✅ / z-ai provider 钉死 ❌ / `.hermes/.env` 加载器已上线
- **pack 0.1.10-f**:`agent-hermes` spawn 前加载原生 `~/.hermes/.env`(dotenv 惯例:显式 env 优先),对齐 omp/pi 运行时各自加载自家 `.env` 的先例;零新依赖(`agent-hermes/src/hermes-client.ts` `parseDotEnv`/`loadHermesDotEnv`)。**实装验证**:gateway 子进程 `/proc/<pid>/environ` 现含 `CUSTOM_ZAI_API_KEY`/`DEEPSEEK_API_KEY`/`ZHIPU_API_KEY`(加载前为 0 —— harness env 刻意不带任何 provider key)。
- **F4(缺陷,已定位)**:world 侧遗留 `gatewaySessionId: null` 的会话记录 + hub `agent-status.json` 的陈旧 current 指针 → `session/create` 被 resume-on-create 劫持(`cannot resume session …; re-create the session`),UI "New session" 全灭。hub 会用 boot 时内存回写状态文件,清档必须在停线后(或清后再重启)。清 `dsh-sessions.json`/`workspace.json`/`agent-status.json` 三处 + 重启后恢复。
- **deepseek ✅**:`deepseek-v4-pro` 真实回复上屏(6s,`UI-OK-HM5`)。注意上游账户合法模型名只有 `deepseek-flash`/`deepseek-v4-pro` —— 目录里的 `deepseek-v4.1-flash` 系条目会 400(catalog 与账户 entitlement 脱节,models.dev 缓存)。
- **z-ai ❌(provider 钉死,上游于 .env)**:hermes gateway 会话上下文固定 `provider=deepseek`;UI 模型芯片只改模型 id 不改 provider。`z-ai/glm-5.3-flash`(models.dev 缓存项)与裸 `glm-5.3` 都被路由进 deepseek → 400/`-32602 Model … not served by provider 'deepseek'`。zai-plan 需 hermes 运行时侧切 provider(`active_provider`/credential pool),adapter 未露出该面;且 `zai-plan` 配置模型表无 `glm-5.3-flash`(仅 glm-5.3/5.2/5.1/5-turbo/4.7)。后续若要接通:adapter 需把 provider 选择透传给 gateway(hermes CLI 自身有 /provider 面)。

### 追加 3(2026-10-04 晚):provider 透传修复 ✅(pack 0.1.10-g)
- **修复**:hermes gateway 会话被钉死 provider=deepseek 的根因是 `agent.ts #materializeSession` 只传 `model` 不传 `provider` —— 而 `session.create` 本来就吃 `provider` 参数(gateway `methods_session.py` composer override 形状),`routeContext` 也早已从 catalog entry 解析出真实 provider slug。补一行透传即可;gateway 自带别名归一(`z-ai` → `zai`,auth.py `_PROVIDER_ALIASES`)。
- **路由真相**:目录里的 `z-ai/*` 系 id 是 OpenRouter 风格 id,hermes 把它们路由到 **provider=openrouter**(curated catalog;凭据 `OPENROUTER_API_KEY` 来自 `.env` 加载器)。`zai-plan`(api.z.ai 直连)是另一个 provider,配置模型表无 flash 变体 —— 用户侧选 `z-ai/glm-5.3-flash` 走 openrouter 即是正解。
- **验证(session.create + session/prompt,typert args envelope 经 /hub 族)**:create `{provider:"z-ai", model:"z-ai/glm-5.3-flash"}` → `session-0f46999f`;prompt 后 gateway 日志:`API call #1: model=z-ai/glm-5.3-flash provider=openrouter latency=3.0s` → `Turn ended: reason=text_response(finish_reason=stop) response_len=10`(= `API-OK-ZAI`)→ `status=complete duration=6.1s`。
- **已知限制**:芯片在**已建会话**上的切换不会透传到 gateway(adapter 未接 model 切换 RPC;hermes 网络面无独立 switch 方法,TUI 走内部命令)。正确流程 = **先选模型、再 New chat**(创建时选择随 session.create 下发)。另外 UI "New session" 与模型选择保存之间存在竞态窗口(选择后立刻新建可能回落默认),实机使用间隔天然安全。
- **环境注**:本机经 `test.pc.internal.test`(公网 A 记录 123.203.190.98)不可达(hairpin),localhost 直连正常;Caddy 本体健康(SNI 127.0.0.1 → 401 透传)。用户侧网络路径不受影响。

## 结论
6 个 foreign agent 的 seat 切换、roster、`/hub` fusion 数据面全部工作;**OMP 与 Antigravity 端到端全绿**(真实 prompt → 真实回复上屏)。Claude/Pi/Hermes 链路通、上游账户失败且错误路径 UI 呈现正确。**Codex 被服务端缺陷(F1)阻断,当前不可用**,回归窗口指向 0.1.10-e,建议作为下一个修复任务的输入。
