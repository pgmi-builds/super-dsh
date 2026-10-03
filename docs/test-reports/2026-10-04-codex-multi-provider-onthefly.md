# Codex 多 provider：on-the-fly 重做 + 会话中段切换（2026-10-04）

- 线：worktree `.worktrees/codex-app-server`，分支 `codex-app-server`
- 触发：user 2026-10-04 四项指令（实现终极 feature；正本=自有 settings + 原生 config 同步；UI 不再维护 active；turn 边界与中断交给 DSH）
- 形态：**交付形态验收**（4999 pack 线）——`node super-dsh/scripts/pack.mjs` → tarball → 全新 profile `corepack pnpm@10.33.2 add file:` → repo build 的 dsh CLI boot
- 结论：**feature 成立**。provider 与 model 都可**按会话**自由切换，会话保持 live，历史完整，且**原生 `~/.codex` 零写入**。

---

## 一、先探测，后动手（两条 load-bearing 未知量）

两个会决定整个方案形状的问题，先在真 0.154 二进制上量掉，再写代码：

| 问题 | 结论 | 探针 |
|---|---|---|
| `-c model_providers.<id>.<key>=<val>` 能否接受 **hyphenated id**（`zhipu-cn`）？ | **能**。`thread/start` 回报 `provider=zhipu-cn`，且 turn 真跑通（说明 `base_url` 与合成 `env_key` 都被采纳） | `.scratch/provider-probe/probe5.mjs` |
| 生产序列（kill 旧 child → 新 `-c` 起新 child → `thread/resume` 同一 thread）是否成立？ | **成立**。turn 1 在 `deepseek`（config.toml），SIGKILL，新 child 只靠 argv 定义 `ghost`，`thread/resume {threadId, modelProvider:"ghost", model:"glm-5.3-flash"}` → 接受、`turns=1`（历史在）、turn 2 跑在 `ghost`；`config.toml` sha 前后相同 | `.scratch/provider-probe/probe4.mjs` |

顺带量到两条必须写进代码注释的约束：
1. `model_catalog_json` 作为 override 时按**进程 cwd** 解析（相对路径实测 `ENOENT`）⇒ 注入必须绝对路径；
2. `env_key` 是**唯一不经过 auth manager** 的形态 ⇒ 库里的 key 可以走子进程环境，`auth.json` 完全不碰。

## 二、设计（重做后的形状）

```
DSH 会话 ── model/selection（持久） ──┐
   │                                  ├─→ modelSelection 投影 {lastUsed, next}
   │  每轮 request/header（本轮真实路由）┘        （UI 选择器 + 转录重放的数据源）
   ↓
CodexAgent.#resolveRoute()  pending ?? logged ?? agentDefaultModel ?? options
   ↓ provider 变了？
kill child → 新 child（-c model_providers.<id>.* + 绝对 catalog 路径 + 合成 env_key）
           → thread/resume {同一个 threadId, modelProvider, model}
```

- **正本**：`$DSH_HOME/agents/codex/codex-providers.json`（0600）。
- **来源**：`~/.codex/config.toml`，启动时 + 每 10 分钟（`SYNC_INTERVAL_MS = 600_000`）读一次，**全部** `[model_providers.<id>]` 表按 endpoint URL 去重折进正本；新 endpoint 用 **URL 端点当名字**；非在役 provider 的模型清单无从得知 ⇒ 诚实地存 `models: []`。
- **零原生写入**：provider 由 argv 注入；per-provider 模型目录写 `$DSH_HOME/agents/codex/codex-catalogs/<id>.json`。原「外科改写 config.toml + 合并 auth.json」整块删除（死代码），cc-switch 仍可拥有那个文件，同步会把结果读进来。
- **路由 = DSH 的**：每个有模型的 provider 注册一条 `ctx.llm` 路由，于是 `session/modelCatalog` 天然按 provider 分组、`session/selectModel` 天然持久。
- **turn 边界 = DSH 的**：agent 每轮回写 `request/header` ⇒ 投影的 `lastUsed`/`next`、`consumeSelection`、转录重放全部由上游自洽。

删除的旧概念：store 的 `selected`、`codexProviders/select` RPC、面板的 active/switch 控件、单条 `codex` 路由、`models.ts`（旧目录读取器）、原生写入面。

## 三、验收证据（第一人称，4999 交付形态）

### 3.1 模型选择器就是 DSH 的，且按 provider 分组

`session/modelCatalog`（经 `/hub/api?agent=codex`）：

```
default: zhipu-cn/glm-5.3-flash
group deepseek -> [deepseek-flash]
group zhipu-cn -> [glm-5.3-flash, glm-4.7]
failures: []
```

### 3.2 会话中段切 provider，会话保持 live，历史完整

同一 `session-914f5db7-…`（**一个** Codex thread，**四次** turn）：

| 事件 | 日志证据 | `modelSelection` |
|---|---|---|
| T1 | `request/header initial zhipu-cn/glm-5.3-flash` | lastUsed=zhipu-cn/glm-5.3-flash |
| `selectModel deepseek/deepseek-flash` | `model/selection deepseek/deepseek-flash` | next=deepseek/… |
| T2 | `request/header change deepseek/deepseek-flash`；assistant 答 **`BANANA`** | lastUsed=deepseek/deepseek-flash |
| **跑 T3 期间**切到 `zhipu-cn/glm-4.7` | T3 仍 `src=deepseek/deepseek-flash` 跑完（**不打断**） | lastUsed=deepseek/…，**next=zhipu-cn/glm-4.7** |
| T4 | `request/header change zhipu-cn/glm-4.7`；assistant 答 **`BANANA`** | lastUsed=zhipu-cn/glm-4.7 |

- **history 完整**：T2 与 T4 都答出 `BANANA` ⇒ 两次 child 重启后 thread 都是 `resume` 而非新起。
- **原生 rollout 是决定性证据**：`rollout-2026-10-03T17-40-17-01a10122-…jsonl` **一份**文件、`session_meta provider=zhipu-cn`（只记一次），随后 **四个 `turn_context`** 依次 `glm-5.3-flash` → `deepseek-flash` → `deepseek-flash` → `glm-4.7`。
- **`config.toml` 零写入**——但有个必须说清的细节：codex **自己**会在首次跑一个新 cwd 时追加一条 `[projects.<cwd>] trust_level = trusted`，所以「sha 不变」只在**已经 trusted 的 cwd** 里成立；用 `/tmp/...` 当会话 cwd 时文件会变，变的全是 codex 自己那几行。**干净复验**：cwd = 已 trusted 的 `/home/u1/workspaces/superd`，两轮 turn（含一次换 provider）前后 `config.toml` **逐字节相同**（`ae188f99…`）。本 adapter 自身只在自家 home 落 `codex-catalogs/{deepseek,zhipu-cn}.json`——代码里已无任何原生写入路径（原写入面整块删除）。
- 同时只有一个 `codex app-server` 子进程存活（`ps` 计数 1）。

### 3.3 面板：只剩列表，没有 active

`codexProviders/get` 返回 `{providers, native, protocols, paths{store,config,auth,catalogs}, syncedAt}`；`native` 只作**被动说明**（「你自己的 codex 跑的是 zhipu-cn/glm-5.3-flash」），无可点动作。

**删除是可持久的**（本轮新补）：`remove deepseek` → store `removed:["https://api.deepseek.com/v1"]`；再 `get`（**会重新同步 config.toml，而 deepseek 就在里面**）→ **不复活**，`session/modelCatalog` 分组同步消失；重新 `save` 同一 endpoint → 墓碑清除、路由回归。没有墓碑时删除会在十分钟内自我撤销——这是从「同步永不删」这条规则推出来的缺口，已在实现里补掉并单独建测。

### 3.4 线体健康

```
world failed : 0        shell(带 cookie) : 200      无 cookie : 401
6 个 world 经 /hub/api?agent=<a> 全部应答（session/modelCatalog）
```

## 四、测试

| 套件 | 结果 |
|---|---|
| `super-dsh/agent-codex`（186 tests） | **186 pass / 0 fail**（连跑 2 次同结果） |
| `super-dsh/superd-hub`（514 tests，含 client bundle 漂移门） | **514 pass / 0 fail** |
| `tsc -p .` / `tsc -p tsconfig.client.json` | 0 error |
| `node super-dsh/scripts/pack.mjs` | `super-dsh-0.1.9.tgz`（267 files） |

新增/重写的套件：
- `codex-route.test.mjs` — 路由优先级（pending > logged > default > options），以及半成品路由永不获胜；
- `codex-launch.test.mjs` — argv/env 注入的三种 auth 形态 + 目录必须绝对 + **零原生写入**；
- `codex-reattach.test.mjs` — **换 provider = 换 child + resume 同一 thread**（真 transport 打 programmable fake app-server，钉帧序列）；模型-only 切换不重启；
- `codex-native-providers.test.mjs` — 读**全部** provider 表；只有在役 provider 有模型；
- `codex-provider-tombstones.test.mjs` — 墓碑语义 + 「同步无变化即不写盘」；
- `codex-session-route.test.mjs` — 会话起始路由的**一致性属性**（下节缺陷 3 的回归）；
- `codex-providers.test.mjs` / `codex-provider-gateway.test.mjs` / `codex-provider-gateway-wiring.test.mjs` — 全部重写到新语义（`selected` 消失、写入面反转、`onChange` 覆盖三个动作）；
- 删除：`models.test.mjs` + `codex-native-config.test.mjs`（死代码的测试）；其中仍活的部分（`mergeModelCatalog`、`readNativeSelection`）重新落在 `codex-native-catalog.test.mjs`。

## 五、本轮从「跑起来」里抓出的三个真缺陷

1. **assistant 消息的 provider 归属是假的**。Codex 的 wire 消息不带 attribution，旧代码回落到 `this.options`——而 options 在 create/resume 时冻结，于是 T2 实际跑在 `deepseek/deepseek-flash`，消息却署 `zhipu-cn/glm-5.3-flash`。UI 与「模型已切换」提示都读这个字段，属于用户可见的谎言。修法：新增 `#turnRoute`，在 turn 开始时捕获，作为归属回落。**修后复测**：T2/T4 的 `source` 与 `request/header` 一致。
2. **同步每 10 分钟重写一次 0600 密钥文件**。`next.auth !== entry.auth` 拿的是**每次重新解析**出来的新对象，引用比较恒为真 ⇒ 「没变就不写」这条契约对 env 形态 provider 永不成立。修法：结构化比较（kind + name/value）。
3. **会话起始路由可以是一个「没有 provider 服务它」的组合**。种 `model/selection` 时 provider 取自原生 config（`nativeProviderId()`）、model 取自 deployment default（`agentOptions.model`）——**两个独立来源拼一对**，实测种出 `zhipu-cn/deepseek-flash`（zhipu 不服务这个 model），而且那一轮真的跑出去了。同一条路上还有第二个入口：上游会把「上次选的模型」持久成 world default，而面板此后可能把那个 model 从 provider 的清单里删掉，于是新会话会拿着一个已不可服务的组合去起。修法两条：① 种路由**只接受一个来源**（`seedRoute(agentOptions)`，而 `agentOptions` 已由 `sessionAgentOptions` 收敛成一对），把「两个来源拼一对」变成不可表达；② `sessionAgentOptions` 只在 provider **确实服务**该 model 时才采纳请求，否则回落到用户自己 config.toml 的那一对。**live 前后对比**：修前新会话种出 `zhipu-cn deepseek-flash`，修后 `zhipu-cn glm-5.3-flash`；把 world default 弄成 `zhipu-cn/glm-4.7` 再从面板删掉 `glm-4.7` 后新建会话，种出回落对 `zhipu-cn glm-5.3-flash`（修前会是那个不可服务的 `glm-4.7`）。

三个都不是设计问题，是**只有真跑才会露头**的那一类——尤其第 3 个：单测全绿、类型全绿，只有把 `lastUsed` 读回来才看得见。这正是本仓「验收与改动点同类」那条红线的直接收益。

## 六、边界与遗留

- **跨 provider resume 的 history 语义**：第三方 provider 留下的 `reasoning.encrypted_content` 对 OpenAI 是不透明 id，方向安全的是「第三方 → OpenAI」；反向未验（ChatGPT 登录本机被地区封锁）。这是上游数据现实，不是本线能修的。
- **`apiKey` + `auth_mode=chatgpt`**：库里持有 key 的形态现在走合成 `env_key`，**完全绕开** auth manager，老问题解决。仍会告警的只剩「seeded」形态（key 在 `auth.json` 里、库里 value 为空）。面板文案已相应收窄到这一种。
- **非在役 provider 的模型清单**：Codex 的 catalog 是 per-provider-in-force，所以从 config.toml 折进来的非在役 provider 必然是 `models: []`，需要用户在面板补；这类 provider **不注册路由**（不占选择器位置），面板逐行提示。
- **dev3 目标机实装**：未做（根 AGENTS §〇.0.a 的第二步），需要 user 放行才算完整验收链。
- **`npm publish`**：未做，也未请求。版本仍是 `0.1.9`（本地 tarball 线每次 `rm -rf` profile，无 pnpm 同名 no-op 问题）。

## 七、文件账

**新增**（agent-codex/src）：`codex-launch.ts`、`codex-route.ts`（含 `seedRoute`：会话起始路由的单一来源入口）
**重写**：`codex-providers.ts`（正本 + 同步 + 墓碑）、`codex-provider-gateway.ts`（去 select、加 sync）、`adapter.ts`（多路由）、`agent.ts`（路由解析/应用 + `request/header` + turn 归属）、`app-server-client.ts`（launch 注入 + `reattach` + transport 世代）、`index.ts`（同步循环 + 多路由注册 + `launchFor` + 只在新会话种 `model/selection`）
**删除**：`models.ts`（死代码）、`codex-native-config.ts` 的原生写入面（`applyProviderToConfigToml` / `mergeAuthJson` / `writeNativeSelection` / `backupOnce`）
**hub**：`src/client/{agent-settings,runtime-settings-api,HubPage}.tsx` + 重建的交付产物 `super-dsh/client/index.js`
**文档**：`super-dsh/agent-codex/README.md`、`super-dsh/AGENTS.md`
