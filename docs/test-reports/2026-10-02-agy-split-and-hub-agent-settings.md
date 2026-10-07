# Anti-Gravity adapter 拆分 + Hub agent 设置面 — 4996 交付形态实测报告

- 日期：2026-10-02
- 被测版本：`super-dsh@0.1.9`（源码树）；tarball `.scratch/superd-pack/super-dsh-0.1.9.tgz`（253 文件 / 611.2 kB，shasum `26726be532d57b849ad508f08e64ca0fc3f8a1c1`）
- 形态：**交付形态**——`pack.mjs` 全组件构建 → `npm pack` → `corepack pnpm@10.33.2 add file:<tarball>` 装进 `superd-pub` profile → repo build 的 dsh CLI 启动
- 端口：**4996**（非 4999，理由见 §0）
- 结论：**P2b 与 P3 的交付面全部通过**；P2a 的 ADC 真 turn 未在本轮验收（§5）

---

## 用户实测反馈后的 debug 轮（2026-10-02 00:31–00:40）

用户在 4996 上亲手打了 3 个 prompt 全部失败，报了三类症状。逐条定位结果：

### 症状 1：UI 显示 medium，CLI 收到 `--effort low` —— **已修（我方缺陷）**

`index.ts:cliOptions` 的 effort 优先级链最后一段是 `CLI_DEFAULT_MODEL.thinkingLevel`，而那是 **3.6-flash 廉价对**的常量 `"low"`。于是**任何**没有显式 session effort 的模型都被塞 `low`，与所选模型无关；同时 `defaultEffortFor()`（每模型自己的默认）**存在于 models.ts 却从未被调用**——死代码。

修：新增纯函数 `resolveEffort(slug, explicit, legacyLevel)`，第三段改用**该模型自己**的 `defaultEffort`；声明了「无 effort 支持」的模型返回 `undefined`（宁可不发 flag，也不发一个会被拒的）。`test/models-effort.test.mjs` 6 例钉死（含「3.7 的 medium 不得退化成 3.6 的 low」）。

### 症状 2/3：`agy exited code=1` 只有「unknown error」 —— **已修（我方缺陷，且是最有害的一条）**

CLI 的拒绝理由是走 **stderr**（或 stdout 上的非 JSON 行）说的，而 `AgyCliClient` 把两者都只丢给 `trace`（`AGY_TRACE=1` 才可见），exit 时只 dispatch 一条固定的 `agy exited code=${code}`。**每一个失败都被抹成无信息**——这也正是「effort 传错」看起来像灵异事件的原因。

修：加了有界的诊断尾巴（stderr + 非 JSON stdout 行，12 行上限），exit 错误与 failed-result 错误都带上它，且**消费式**（一次失败用完即清，不会串到下一次）。`test/agy-cli-diagnostics.test.mjs` 6 例钉死两条通道与消费语义。

**红测**：把两处修复分别回退 → `not ok 1/2/3`（诊断）与 `not ok 7/8/9/10/12`（effort），恢复后全绿。

### 症状 2 的第二个成因：**模型目录已过期** —— **未修，待裁决（见下）**

`agy models`（账号面实测，CLI 1.2.14）实际服务：

```
gemini-3.8-flash-{high,medium,low}   gemini-3.7-flash-{high,medium,low}
gemini-3.6-flash-{high,medium,low}   gemini-3.1-pro-{high,low}
claude-sonnet-4-6                    claude-opus-4-6-thinking
gpt-oss-120b-medium
```

对照我们的目录：`3.7-flash / 3.6-flash / 3.5-flash / 2.5-pro / 2.5-flash`。即 **3.5-flash 与 2.5-\* 已下线**（用户「换 3.5 Flash → exit code 1」正是这个），**3.8-flash / 3.1-pro 缺失**，且 CLI 现在带非 Gemini 模型。

更关键：CLI 列出的 id **把 effort 编进了模型名**（`gemini-3.7-flash-medium`），**没有**朴素 `gemini-3.7-flash` 这一项。这与我方「纯 slug + `--effort`」的设计（及其 2026-09-18 用户裁决）冲突，故**不擅自改**——见「待裁决」。

### 顺带确认：P3 在浏览器里真的通了

用户点了 ADC，落盘证据齐全：`agy-adapter.json = {"authMode":"adc"}`（mtime 00:31:13）且原生 `settings.json` 的 `modelProvider` 被**删除**。**P3 的 set 端到端在真实浏览器 + 真实原生文件上成立。**

（另注：原生 `settings.json` 在 00:37:34 又被写回 `modelProvider: "gemini"`，而写入者**不是** `set`（state 未变）也不是 `applyAgySettings(adc)`（那会删键）——归属未定，疑似用户 TUI/手工。已记录待查。）


## 0. 为什么不是 4999

4999 起线前预检发现占用者不是本仓的线：

```
127.0.0.1:4999  node  → cgroup dsh-4999-test123.service
                         cmdline: /home/u1/workspaces/dashr/upstream/.../bin.js web --no-open --port 4999
192.0.2.130:4999  socat → test123-lan-4999-relay.service
```

属**姊妹仓 dashr** 的在役测试线，且 live Caddy `test.pc.internal.test → 127.0.0.1:4999` 当前正指向它。按端口纪律（499x 无主、测试 unit 可接管）本可停掉接管，但那是**跨仓**影响 + 改变一个 WAN 可见 URL 的指向——不由 agent 单方面决定。故本轮走空闲测试口 **4996**（脚本自动拉 `superd-lan-4996-relay` socat），4999 保持原样。

---

## 1. 启动

```
SUPERD_PORT=4996 bash super-dsh/test/start-4999.sh
```

- `pnpm add file:` 装进 profile：`+ super-dsh 0.1.9`，20.4s
- unit：`superd-4996-test.service` + `superd-lan-4996-relay.service`
- 唯一 peer 警告为**既有**项：`@anthropic-ai/claude-agent-sdk` 要 `@anthropic-ai/sdk@>=0.93.0`、实得 `0.91.1`（与本次改动无关，历史遗留）
- 无新增 build-script 审批项

## 2. 探针

| 探针 | 结果 |
|---|---|
| `GET /`（带 token cookie） | **200** |
| `GET /`（无 cookie/token） | **401** `dsh web authentication required` |
| `/api/agent-runtime` roster | 7 行：`native, claude, omp, pi, codex, hermes, agy`，全部 `ready:true failed:false` |
| roster 是否含 `agy-sdk` | **不含** ← P2b 的 `disabled: true` 行在交付形态确实未 compose |
| 日志 `world failed` 计数 | **0** |

**P2b 验收（规格 §6）**：全新 home + 默认 composition → roster **不含** SDK 行 ✅（首次使用触发 fetch / 第二次复用已在单测层钉死：`test/sdk-venv.test.mjs` 8 例，含幂等短路与失败留痕；实测 fetch 需在真机上开行，见 §5）。

## 3. P3 数据面端到端（真实 HTTP，非模拟）

在**交付形态**的活实例上直接打私有 RPC：

```
POST /hub/api?agent=agy
{"type":"client-request","rpcId":"probe-1","method":"agyAuth/get","payload":{"args":{}}}
```

```json
{"type":"server-response","rpcId":"probe-1","result":{"ok":true,"value":{
  "methods":[
    {"key":"apiKey","label":"Gemini API key","available":true,"placeholder":false,
     "hint":"A key is available (saved for this runtime or GEMINI_API_KEY)."},
    {"key":"oauth","label":"OAuth (account sign-in)","available":false,"placeholder":true,
     "hint":"Not selectable yet: the next round characterises the sign-in fields."},
    {"key":"adc","label":"ADC (Vertex)","available":true,"placeholder":false,
     "hint":"Application Default Credentials found on this machine."}],
  "selected":null,"effective":"apiKey",
  "settingsPath":"/home/u1/.gemini/antigravity-cli/settings.json"}}}
```

这一条同时证明了整条链：hub 信封解析 → `envelope.method` 原样转发 → 世界 `typertGateway` 按 SRC 标记认领 `agyAuth/get` → adapter 现场探测（key ✅ / ADC ✅ / oauth placeholder）→ ladder 给出 `effective: apiKey` → 返回值回填信封。**`@Remote` 机制在交付产物里确实活着**（这是本改动最大的未知项）。

对照探针：

```
POST /hub/api?agent=agy-sdk  →  404 {"error":"unknown-agent","label":"agy-sdk"}
```

再次确认 SDK 行未 compose（世界不存在 ⇒ 无 gateway ⇒ 404，而非 500）。

## 4. 唯一未被 agent 执行的动作：`set`

`agyAuth/set` 会**立即改写用户真实的 `~/.gemini/antigravity-cli/settings.json`**（2026-10-02 基调裁决的设计意图）。上机前的只读快照：

```json
{"allowNonWorkspaceAccess": …, "modelProvider": "gemini", "permissions": …, "trustedWorkspaces": …}
```

即该文件**当前带着 key 模式的 pin**。因此：

- 面板此刻应显示 `apiKey` 为 in force（`effective: apiKey`，与探针一致）；
- 点 **ADC** 会**删除** `modelProvider`（这正是防「用户回 TUI 卡在 Gemini API key 却没有 key」的设计），点 **Gemini API key** 会重新写回 `modelProvider:"gemini"`；
- **agent 未代按**：这是用户的真实使用环境，改与不改应由用户自己点、自己看 TUI 结果。

`set` 的语义在单测层已对**真文件系统**全覆盖（13 例）：pin 写入、pin **删除**、无关键存活、清选择仍去 pin、点了机器上没有的形态按 ladder 走 native、未知 mode 拒绝且不落盘。

## 5. 未验收项（明确不在本轮）

- **P2a 的 ADC 真 turn + 端点实证表**：上一轮已取证 `AGY_ADC_AUTH=1 agy -p …` 通过资格门（`adc_auth.go:73 authenticated successfully` / `ChainedAuth: effective adc`），随后卡在 `plan model not specified`——即 ADC 路径需要显式 `--model`/自定义模型声明。留在 P2c 一并处理。
- **SDK 行的真机首用 fetch**：需在 plugin 页把 `agent-agy-sdk` 打开后在会话里打第一个 turn（会真下 189M 级 venv）。单测已覆盖幂等/失败留痕/锁语义，但「真机 + 真网络」属用户手测范围。
- **UI 的浏览器手测**：轮播展开/收起、右侧 switch 按钮、三选项渲染与切换后刷新保持——需在浏览器里点（agent 已验的是同一份 `client/index.js` 里含 `Sign-in method`/`No settings for this runtime yet`/`agyAuth`，且 502 项 hub 测试含 13 项 panel/transport 单测）。

## 6. 全仓回归

8 包 **1048 pass / 0 fail**（改动前 1022）：

| 包 | pass | 备注 |
|---|---|---|
| superd-hub | 502 | +13（client-agent-settings 7 / client-runtime-settings 6） |
| agent-agy | 60 | +13 agy-auth-gateway；另有 P2a 的 56 |
| agent-agy-sdk | 40 | 新包；含 sdk-venv 8 + bridge frame 1 |
| agent-omp / codex / claude / pi / hermes | 47 / 70 / 140 / 56 / 133 | 未受影响 |

红测（证明测试有牙）：① 把 `dist/sdk-venv.js` 的「等待者不释放同伴锁」修复回退 → `not ok 7`；② 抽掉 `dist/agy-auth-gateway.js` 的 `[Remote("get")]` → `not ok 1`（+2）。均恢复后绿。

## 7. 如何看

```
local: http://127.0.0.1:4996/?token=…
lan:   http://192.0.2.130:4996/?token=…
停：   systemctl --user stop superd-4996-test superd-lan-4996-relay
```

Hub 页 → Agent Runtimes → **点行体**展开 Antigravity 的登录方式（右侧 `switch` 仍是切换按钮）。

---

## ADC 面的决定性结论（2026-10-02 00:45，混淆项已排除）

早先对 ADC 的探测**被一个陈旧 pin 污染**：`~/.gemini/antigravity-cli/settings.json` 里带着 `modelProvider: "gemini"`，于是带 `AGY_ADC_AUTH=1` 的调用其实落在 **key 模式**。清掉该 pin 后重测（已备份为 `settings.json.bak-p2c`），结论才干净：

| 探测（pin 已清，`AGY_ADC_AUTH=1`） | 结果 |
|---|---|
| `agy models` | **`Error: timed out waiting for available models`**（200s 仍超时） |
| 不带 `--model` | `failed to construct executor: plan model not specified; you must specify a valid model` |
| `--model=gemini-3.7-flash`（朴素 slug） | `model gemini-3.7-flash is not recognized as a known model or custom model in settings` |
| `--model=gemini-3.7-flash-medium`（`agy models` 原样 id） | 同上，**也不认** |
| `--model=gemini-3.8-flash-high` / `gemini-3.1-pro-high` | 同上 |
| `gemini-for-google-3.1-flash` / `snowball` / `gemini-pro-agent` / `gemini-2.5-pro` / `gemini-3-pro` | 全部 not recognized |

⇒ **ADC 面不提供任何模型目录，且不认任何消费级 id**。错误信息自己给了出路：「known model **or custom model in settings**」。

**custom model 声明（从 binary 提取）**：scheme `gemini-api://<base_url>/models/<model_name>`、`beyond-api://<base_url>/<model_name>`，另有 `evergreen://`、`blade:`；settings 键 `customModels` / `custom_model_api_providers` / `allowCustomModels`；候选字段 `baseModel` / `baseUrl` / `displayName` / `modelId` / `apiClient`。**确切 schema 与 base_url（Vertex project/location/模型名）尚未落地**——这是 ADC 可用的唯一路径。

## 对早先判断的两处更正

1. **我从未用过 Gemini API key**。那份模型清单来自**账号登录面**（用户的 TUI 账号），不是 key 面。我把「账号面」误报成了可以「专攻 API key」，这是我的表述错误。
2. **`agy models` 本就不该作为来源**。dev-rules §16a 已裁决：*model list/默认模型 = 磁盘读（`~/.gemini/antigravity-cli/settings.json`）+ catalog 静态捕获，零认证*。我绕道 `agy models` 属于无谓重开已解决的问题。

## 本轮的形态修复（已入 pack）

- effort 词汇表补上 **`max`**（`agy --help` 实报 `low|medium|high|max`）——按「slot 是 DSH 的、取值是 Antigravity 的」。
- 保持**朴素 slug + 独立 effort**，**未**把 effort 拼进模型 id（那会让清单从 5 条膨胀到 ~12 条）。
- `agent-agy` 72/72；`resolveEffort` / 诊断尾巴各有红测。

---

## dev3 实测：链路打通，卡在计费（2026-10-02，决定性）

key 在 **`dev3:/home/u1/.gemini/antigravity-cli/.env`**（本机 `~/.gemini/.env` 只有 Vertex 变量——早先找错路径）。dev3 上把该 .env 导入并设 `modelProvider: "gemini"`：

```
$ agy --model=gemini-3.1-pro --effort=low --print "reply with exactly: OK"
error: agent executor error: generating and executing: Error 402,
  Your prepayment credits are depleted ... Status: RESOURCE_EXHAUSTED
AGY_ERROR: {... "error_code":402,"code_kind":"http","retryable":false ...}
```

**认证 ✅、模型选择 ✅、effort ✅ —— 唯一失败是 key 余额耗尽（402）**。即 CLI 传输面本身可用；缺的不是代码。

顺带证伪：dev3 上**账号面 headless 不行**（`authentication required. Run 'agy' to log in`），而 TUI 可以——headless 与 TUI 是两条不同判据，用户截图里跑通的是 TUI（`mespeaking@gmail.com (Agent Platform)`）。

## 每模型 effort 词汇表（CLI 自己就是 oracle）

**省略 `--effort` 时 CLI 会直接报出该模型接受什么** —— 这是权威且零成本的取值来源：

| 模型 | CLI 实报 |
|---|---|
| `gemini-3.1-pro` | **`available: low, high`**（**没有 medium**） |
| `gemini-3.7-flash` | `available: low, medium, high` |
| `gemini-3.6-flash` | `available: low, medium, high` |
| `gemini-3.8-flash` | `available: low, medium, high`（目录里缺这一条） |
| `gemini-2.5-pro` | `not recognized as a known model`（**已下线**） |
| `gemini-2.5-flash` | 同上（**已下线**） |

⇒ **effort 词汇表是 per-model 的**，单一全局列表是错的：`3.1-pro` 若给 `medium` 必定被拒。正确形态 = 每个模型各自 `efforts`，取值照抄 CLI 报的。这也正面印证 user 裁决「slot 是 DSH 的、取值是 Antigravity 的」。

**待做（下一轮，范围已明确）**：① 按上表重写 `AGY_MODEL_CATALOG`（补 3.8-flash、删 2.5-\*、`3.1-pro` 的 efforts 收成 `[low, high]` 且 default `low`）；② 同步 `upgrade.test.mjs` 里钉死的 5 条与 `2.5-*` 断言；③ ADC 面另有一套模型解析语义（同一 `--model` 在 key 面被认、在 ADC 面报 `--effort is not supported for model`），仍需 `customModels` 声明。

## 对早先结论的第三次更正

我在本机 ADC 上得到的 `gemini-3.1-pro` 结论（"requires --effort" / "not supported"）与 dev3 key 面的结论**互相矛盾**，因为**两者不在同一平面**。把两个平面的观测混在一张表里是我的错误；现已分开记录。
