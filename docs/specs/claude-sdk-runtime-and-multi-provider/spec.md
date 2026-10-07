# Claude Adapter：SDK 依赖出包（runtime 自取）+ Multi-Provider

- 日期：2026-10-04
- 状态：已裁决（user 2026-10-04 三连裁决：① SDK wrapper 线维持主线；② 本地 binary 优先、无 binary 才首 prompt 自取装包；③ Multi-Provider 照 Codex 做，DeepSeek + GLM 测试种子）
- 范围：`super-dsh/agent-claude/`（新增 sdk-runtime + provider 面）、`super-dsh/superd-hub/`（settings 面板映射）、`super-dsh/package.json`（dependencies + exports 不变名）、`super-dsh/test/`（种子）
- 相关：`docs/superpowers/plans/2026-09-16-agent-claude-adapter-study.md`（SDK vs CLI 原始比对）、`agent-codex-sdk/src/sdk-runtime.ts`（自取形态蓝本）、`agent-codex/src/codex-{providers,route,native-config,provider-gateway,launch}.ts`（provider 五模块蓝本）

## 0. 动机（user 裁决，2026-10-04）

> 既然确认 SDK 包只有 ~5MB、官方 wrapper 正是我们想要的分工，那重新评估的结论就是：**调用官方 SDK wrapper 这条线**（维持主线）。
> 默认肯定是用本地的 binary。如果本地没有 binary，首次（真 user prompt 时）才自动装包。
> 这样一来，整个所谓的官方 SDK 包，就完全从我们的 package 依赖里面消失了。
> 其他就 1、2、3 点：① SDK 依赖出包；② Multi-Provider 面；③ `agent-claude` 名字/key/home 全部不动。

本 spec 取代同日早前「主线改非 SDK 直连线 + 双线拆分」的方向（该方向基于「SDK 会拖 206MB 载荷」的过重估计；
实测 SDK JS 本体 4.9MB、零 runtime deps，载荷全是 optionalDependency 且 R5 裁决后从不使用）。
**CLI 直连线不实现**，降级为 fallback 知识登记（§7）。

## 1. Ground truth（2026-10-04 实测）

| 事实 | 锚点 |
|---|---|
| SDK JS 本体 4.9MB（npm unpacked 5,433,401 B）、`dependencies: None` | `node_modules/@anthropic-ai/claude-agent-sdk/package.json`（pinned 0.3.263） |
| 8 个平台载荷全在 `optionalDependencies`（每个 ~206MB，例：`claude-agent-sdk-linux-x64`） | 同上 |
| 现行 R5：`pathToClaudeCodeExecutable` 指宿主二进制，载荷从不执行 | `agent-claude/src/claude-client.ts`（`resolveClaudeExecutable`：`CLAUDE_EXECUTABLE` > PATH > `~/.local/bin/claude` > `/usr/local/bin/claude`） |
| 主 pack `dependencies` 现挂 `@anthropic-ai/claude-agent-sdk: 0.3.263` → 每次消费者安装拖下 206MB 死载荷（本机树实证 206M 目录存在） | `super-dsh/package.json` |
| 换 provider 的注入面 = `Options.env`（REPLACE 子进程 env，须自带 spread `process.env`——现有注释已钉死） | `agent-claude/src/claude-client.ts` 头注 |
| 换 model 的注入面 = `Query.setModel()`（live 即时；首 prompt 前的调用缓冲重放） | 同上 |
| 二进制内 env 注册表（`strings ~/.local/bin/claude`）：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`(+`_NAME`/`_DESCRIPTION`) / `ANTHROPIC_CUSTOM_HEADERS` / `CLAUDE_CODE_MODEL_CATALOG(_URL)` | 本机 claude 2.1.261 |
| 现场原生配置形态：`~/.claude/settings.json` `env` 段 = 在用 DeepSeek 端点（`https://api.deepseek.com/anthropic` + `ANTHROPIC_API_KEY` + 模型别名）；`settings.json.bak-*` = cc-switch 式手动切换层（GLM/ZAI、Ark、DeepSeek 各一份） | `~/.claude/settings.json{,.bak-*}` |
| GLM（Z.AI GLM Coding Plan）Anthropic 端点（官方 devpack 文档）：`https://api.z.ai/api/anthropic`，auth = `ANTHROPIC_AUTH_TOKEN`（Bearer），国内镜像 `https://open.bigmodel.cn/api/anthropic` | docs.z.ai/devpack/tool/claude、devpack/quick-start |
| DSH 在用 ZAI Coding Plan key：`ZAI_PLAN_API_KEY`（`~/.dsh/.env`）；模型目录 glm-5.3 / glm-5.3-flash / glm-5.2（ctx 1M） | `~/.dsh/settings.yaml.imported` `llm-pi-ai.providers.zai-plan` |
| DeepSeek 在用 key：现场 settings.json 的 `ANTHROPIC_API_KEY`（与 `DEEPSEEK_API_KEY` 为两把不同 key；种子用现场那把） | `~/.claude/settings.json` |

## 2. 设计

### 2.1 SDK runtime 自取（`agent-claude/src/sdk-runtime.ts`，新写）

**零依赖声明**：`@anthropic-ai/claude-agent-sdk` 从 `agent-claude/package.json` 与主 pack `super-dsh/package.json`
的 `dependencies` 双双摘除（不进 optional/peer；零 postinstall）。安装期零下载。

**布局**（照 `agent-codex-sdk/src/sdk-runtime.ts` 同款形态）：

```
<worldHome>/sdk-runtime/            npm 树（--ignore-scripts）
  node_modules/@anthropic-ai/claude-agent-sdk/
<worldHome>/sdk-runtime.json        marker — 最后写；记录 {sdkVersion, mode, createdAt}
<worldHome>/sdk-runtime.lock        mkdir 原子锁
<worldHome>/sdk-runtime.error.log   仅失败时写
```

**两种取包模式（user 裁决的 binary 优先级）**：

| 模式 | 触发条件 | 安装命令 | spawn 面 |
|---|---|---|---|
| `host-binary`（默认） | 二进制解析命中（`CLAUDE_EXECUTABLE` > PATH > `~/.local/bin/claude` > `/usr/local/bin/claude`） | `npm install @anthropic-ai/claude-agent-sdk@<pin> --omit=optional --ignore-scripts --no-audit --no-fund`（≈4.9MB） | `Options.pathToClaudeCodeExecutable = <宿主 binary>` |
| `bundled-payload`（兜底） | 本地无任何 binary | 同上但**不带** `--omit=optional`（SDK 自带平台载荷 ~206MB，一次性） | 不设 `pathToClaudeCodeExecutable`（SDK 解析自己的载荷） |

- 触发时机 = **首次真 prompt**（`ensureStarted()` 内；`create()` 零 IO，lazy spawn 铁律不变）。
- marker 记录 `mode`；再次启动时**重新解析 binary 现场**：模式与 marker 不符 → 幂等重装成新模式（换 flag 重跑）。
- 失败路径：error.log 留痕 + agent 首轮报错响亮，禁静默假成功。
- import 一律**按解析路径**（`pathToFileURL(<runtime>/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs)`），禁裸说明符。
- 预热：`npm run fetch-sdk-runtime`（CI/线上可提前拉）。
- pin：SDK 版本写死在 `sdk-runtime.ts` 常量（初始 `0.3.263`，与现役一致）。

### 2.2 Multi-Provider 面（codex 五模块同构，新写）

- **`claude-providers.ts`** — 正本 `<worldHome>/claude-providers.json`（0600；fail-soft 读；无效条目丢弃不毒化全表；
  墓碑记显式删除）。条目：
  `{ id, label, baseUrl, auth: {kind: 'authToken'|'apiKey', value}, models: [{id, displayName?, contextWindow?}], aliases?: {sonnet?, opus?, haiku?}, origin: 'native'|'user' }`。
  `aliases` 由 native fold-in 从 `ANTHROPIC_DEFAULT_*_MODEL` 派生，手写条目可省略。
- **`claude-native-config.ts`** — 只读来源：`~/.claude/settings.json` 的 `env` 段（`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
  + `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_*_MODEL` 别名）按 URL 去重折进正本；启动 + 周期（10min）重读；
  **原生文件零写入**（cc-switch 仍拥有该文件）。`.bak-*` 手动切换层不折（非活体文件）。
- **`claude-route.ts`** — 与 `codex-route.ts` 同一优先级：pending → logged → preferred（`agentDefaultModel`）→ fallback（factory options）。
  DSH 侧模型 id = 合成键 `<providerId>/<modelId>`（跨 provider 去歧义）；launch 时拆出裸 `modelId` 走 wire。
- **`claude-launch.ts`** — 由 route + provider 条目产出 SDK `Options` 片：
  `env = { ...process.env, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY, ANTHROPIC_MODEL: <裸 model>, ANTHROPIC_DEFAULT_*_MODEL: <条目别名?> }`
  + `model` + `pathToClaudeCodeExecutable`（§2.1 解析）。子进程 env 是 provider 的唯一进进程通道。
- **`claude-provider-gateway.ts`** — RPC `claudeProviders/get|save|remove`（无 select；对齐 codex 面）。

**切换语义（SDK 线上的 codex 同款分账）**：

- **provider**：env 冻结于 `query()` spawn ⇒ **换 provider = 换子进程**——下一轮冷启动时 dispose 旧 client、
  以新 provider env 起 Query、`options.resume = 同一 session id`；turn 中发起的切换落下一轮，不打断在跑 turn。
- **model**：同 provider 内 `setModel(<裸 id>)` **live 即时切**（现有缓冲重放机制不变）。
- 无「active provider」概念：会话跑在哪个 provider 上 = DSH 自带 per-session 模型选择
  （`session/selectModel` + `model/selection` 投影），UI 与其它 harness 一致。
- **迁移注记**：本线之前发布的模型 id 是裸 id（`sonnet` 等）；引入合成键后，旧会话的 logged selection
  不再完整匹配 ⇒ 按 route 优先级自然落 preferred/fallback，不迁移历史 selection。

**模型目录（observed-only 不变量保持）**：live 会话目录仍来自 `initialize`/`supportedModels()` 实测；
provider 条目的 `models[]` 是用户 curated 的 DSH 选择器条目（合成键），两者不互相伪造。
实测到的模型归入**当轮 provider** 名下铸合成键。

### 2.3 hub 面（小改）

- `SETTINGS_PANELS` += `claude: { namespace: 'claudeProviders', kind: 'providers' }`（主线单线，无 `-sdk` 对偶）。
- `FALLBACK_LABELS`：`claude: 'Claude'` 不变。runtime-icons `-sdk` 归一与本线无关。
- 世界 key / world home / preset id / route id / join 行：**全部不动**（user 裁决 ③）。

### 2.4 测试种子（DeepSeek + GLM）

- 种子属**测试装配**，不进交付默认：`test/` 下 seed 脚本在 4999 pack 线启动前把两条 provider 写入
  `.tests/superd/agents/claude/claude-providers.json`：
  - `deepseek`：`https://api.deepseek.com/anthropic`，`auth.kind='apiKey'`（现场 settings 同款 key，经线 home `.env` 注入），models `deepseek-flash` / `deepseek-v4-pro`；
  - `glm`：`https://api.z.ai/api/anthropic`，`auth.kind='authToken'`（key = `ZAI_PLAN_API_KEY`），models `glm-5.3` / `glm-5.3-flash` / `glm-5.2`（ctx 1,000,000）。
- key 来源 = 线环境（prod `.env` copy 惯例），种子代码零硬编码 key。

## 3. 红线与不变量

- lazy spawn 铁律：`create()` 零 IO；runtime 自取只发生在首个真 prompt。
- 原生 `~/.claude` 零写入（fold-in 只读；provider 注入只走子进程 env）。
- observed-only：不伪造模型 id；降级目录不落盘、不外流。
- 单实例纪律：`npm install` 后查 `@deepseek-ai` scope symlink（§根 AGENTS 三）。
- 验收 = 运行时行为：4999 pack 线交付形态 + 真 turn（§5），单测绿只是构建卫生。

## 4. 不做（显式登记）

- CLI 直连传输线（stream-json 自写协议客户端）——fallback 知识，见 §7。
- OAuth / Bedrock / Vertex / Foundry 认证族。
- `settings.json.bak-*` 折入（非活体）。
- `CLAUDE_CODE_MODEL_CATALOG` 注入（provider models 走 DSH 选择器合成键即可；除非实测发现 CLI 侧 /model 面需要）。

## 5. 验收（运行时行为）

1. 单测：sdk-runtime 布局/marker/mode 重装幂等（fake npm）；providers store 0600/fail-soft/墓碑；native fold-in 去重；
   route 优先级；launch env 注入形状；RPC 脱敏。
2. pack 线（4999）交付形态：tarball 安装后 `agent-claude` 依赖面零 SDK（`node_modules` 无 `@anthropic-ai`）；
   world boot 零解析错误；roster `Claude` 现身；面板展开 `claudeProviders`。
3. 真 turn：DeepSeek provider 下 create + prompt + resume；live 换 model（`set_model` 生效）；
   轮间切 GLM provider 再发一轮（新子进程 + 同 session 续答上下文）；审批桥真卡一次。
4. 自取双模式：host-binary 模式在装有 claude 的机器验证；bundled-payload 模式用 `CLAUDE_EXECUTABLE=` 指空 + 独立 CLAUDE_CONFIG_DIR 验证一次装通。
5. 重启线：会话 list/replay/resume 不变；provider 归属随 logged selection 正确。

## 6. 交付

- 版本纪律：字母后缀迭代（根 AGENTS §〇.1.d）；tarball 通道 + dev3 实装；实测报告落 `docs/test-reports/`。
- 实施计划：`docs/superpowers/plans/2026-10-04-claude-sdk-runtime-and-multi-provider-plan.md`。

## 7. Fallback 知识（不实现，登记）

CLI 直连线 = spawn `claude --print --input-format stream-json --output-format stream-json --verbose
[--permission-prompt-tool stdio]` + NDJSON `control_request/control_response`（`initialize` 返回
models/commands/agents；`set_model`/`set_permission_mode`/`interrupt`/`can_use_tool` 同词表）。
2026-10-04 已对本机 2.1.261 实机验证握手。仅当 SDK 线因协议漂移或 registry 不可达成为实际问题时复启。
