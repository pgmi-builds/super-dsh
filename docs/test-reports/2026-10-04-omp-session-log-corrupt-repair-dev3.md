# 2026-10-04 — dev3 prod 两个 omp session 档损坏诊断与修复（写侧 super-dsh bug 实锤两枚）

现场：**dev3** prod dsh `@deepseek-ai/dsh@0.2.0-rc.2`（2026-10-02 16:13 +0800 装机）+ **super-dsh 0.1.10**（profile web bundle）。
被修物：`~/.dsh/agents/omp/sessions/--home-u1-workspaces-base--/` 下两个 session 的 stored log。
执行者：dev3-deepseek-default（DSH session session-1ce08ba0…，2026-10-04 02:10–02:45 UTC+8 窗口）。**只动数据档，未动代码、未发包。**

---

## 0. 一句话结论

两个 session 打不开，**都是 super-dsh 写侧形状 bug 产物 + dsh 0.2.0-rc.2 读侧严格校验暴露**：

| session | 档 | 写入时代 | 触发器 | 违规 | 状态 |
|---|---|---|---|---|---|
| `session-7f65f71d-fc0d-4f91-a11a-d0f5cf0f2dc7` | `session.v4.jsonl.zstd` | 2026-10-04（**0.1.10 现行 writer**） | webui 重开报 `tool/call … does not match one advertised tool call` | `tool/call` 帧记录**执行期 args** ≠ `assistant/message` 帧的 **advertised args**（严格字符串比较） | ✅ 已修 |
| `session-ca5dea6c-a672-4ef1-bcb6-769f00ddd2a0` | `session.v3.jsonl.zstd` | 2026-09-23（旧版 era 化石） | webui 重开报 `Session migration from v3 to v4 refuses the transformed artifact: system/message does not match an open turn and step` | system 头戳在 `turn/start` **之前**；且头 source 是 `omp-web` 插件戳，v4 要求 `system-prompt` | ✅ 已修 |

暴露窗口的共同背景：**dsh 于 10-02 升 0.2.0-rc.2**（session-format v4 + 严格 v3→v4 迁移校验器装机）。9-23 时代能打开的 v3 档，升级后打开即迁移、迁移即拒（fail-closed，源档不动）。

---

## 1. 病例 A（v4）：`tool/call does not match one advertised tool call`

### 1.1 现场报错

```
Failed to load history: stored session "session-7f65f71d-…" is corrupt: … stored log is corrupt:
SessionFormatError: tool/call call_16c7502df89d4f4d95f5fb95 does not match one advertised tool call
(raw log: …/session-7f65f71d-…/session.v4.jsonl.zstd) (SESSION_QUERY_CORRUPT_SESSION)
```

### 1.2 根因链（全部实锚）

1. 模型 `glm-5.3-flashx`（zhipu-coding-plan）给 `read` 工具调用多带了一个意图字段：
   advertised args = `{"i":"Viewing linked webmcp demo page","path":"https://…"}`。
2. omp 运行时在执行前按 tool schema 解析 args，**剥掉了模型多给的 `i`**（zod 式 strip）。
3. super-dsh `agent-omp/dist/agent.js` **:957**（`agent-omp-sdk` 同构同行号）`tool_execution_start` 处 append `tool/call` 帧用的是
   `arguments: JSON.stringify(event.args ?? {})` —— **执行期 args**；
   而 `assistant/message` 帧走 `#appendAssistantMessage(message)` 保留**模型原文**。
   `toolCalls()` helper（**:175**）收集 `#pendingToolCalls` 时只留 `{callId, name}`，**把 advertised arguments 丢了**——这是 bug 的直接成因。
4. dsh 读侧 `dsh-session-persistence-jsonl`（worker.cjs **:8917**；同型逻辑在 `dsh-session-format-v3-to-v4/lib/index.js` **:644**）要求
   `lifecycle.arguments !== data.arguments` **字符串严格相等** → `SessionFormatError` → 整档拒载。

重启是**无辜的**：live 写入从不复检已写帧，坏档是 10-04 00:51–52 那个 turn 现场写出来的；重启后 webui 冷读全档才第一次撞上校验。

## 2. 病例 B（v3）：`system/message does not match an open turn and step`

### 2.1 现场报错

```
Failed to load history: failed to observe session "session-ca5dea6c-…":
Session migration from v3 to v4 refuses the transformed artifact: system/message does not match an open turn and step;
source v3 artifact remains unchanged (raw log: …/session-ca5dea6c-…/session.v3.jsonl.zstd) (SESSION_QUERY_PERSISTENCE_FAILED)
```

### 2.2 根因（13 帧全量核对）

原帧序（关键段）：

```
seq4  system/message  {turn:1, step:1}          ← 在 turn/start 之前，无 open turn/step
seq5  turn/start       {turn:1}
seq6  user/message     ("hihi")
seq7  session/title    {messageSeqs:[6]}
seq8  step/start       {turn:1, step:1}
seq9  assistant/message …
seq10 step/end / seq11 turn/end
```

违规点二连：

1. **顺序**：system 头必须落在 `turn/start → step/start` 脚手架**之内**（v4 校验器 `dsh-session-format-v3-to-v4/lib/index.js` **:574** `requireStep`）。这与 **2026-09-24 pc 机 wrapper "stamp 落在 opened step 之外" 事件同族**——dev3 prod 9-23 时代跑的还是旧写法，缺陷化石留在档里。
2. **身份**：头 source 是桥盖的 `{"kind":"plugin","plugin":"omp-web"}`。迁移器 `producerKind`（同文件 **:88**）只把 `@deepseek-ai/dsh-system-prompt`+role system 映射为 `system-prompt`，`omp-web` 变成 `plugin:omp-web`；v4 侧随后报 `session event at seq 6 message must have system-prompt source`（protected first surface head 硬校验）。

"之前看得见"= 列表可见：列表只读元数据**不跑迁移**，点开才 observe → 迁移。10-02 升级后它没被点开过，10-04 才第一次暴露——**与病例 A 的修复在时间上相邻、因果上无关**（该档 mtime 9-23 18:32 未动过，且修复前副本逐字复现了现场报错）。

---

## 3. 修复工艺（两例同法，先离线验证后落盘）

1. `zstd -dc` 解包 → 逐帧核对；
2. **只改必要帧**：A 例仅把 `tool/call` 帧的 `arguments` 改回 advertised 原文（16 帧中 1 帧，其余 round-trip 逐字节一致）；B 例重排帧序 + seq 密集重编号（迁移器要求源 seq 稠密且自行 `nextSeq` 重排）+ `session/title.messageSeqs` 改指 user/message 新位（[6]→[7]）+ 头 source 插件名改为 `@deepseek-ai/dsh-system-prompt`（让**迁移器自己**产出 system-prompt 身份，不手造 v4 帧）；
3. JSON 再序列化用 `ensure_ascii=False, separators=(',',':')`——对未动帧做逐字节 round-trip 断言后才允许它碰目标帧；
4. 重压缩必须 **multiframe：每行一个 zstd frame，首帧恰好只含 header 行**（`readZstdPrefix`/`assertZstdHeaderFrame`；单帧压整个文件会报 `first frame is not exactly one header line`）；
5. **用 prod 自己的 reader 离线验收**后才落盘：
   - A 例：`new JsonlSessionPersistence(new Context()（vendored cordis；一实例一 Context，否则 service 同名硬错）, {root, compression:'zstd'}).readStoredLog(path, id)` —— 原档逐字复现现场错误、修后 `OK events=15`；
   - B 例：走 webui 同款 `open(id,'read') → handle.read(0)` 完整路径（含迁移）—— 原档复现 refusal、修后 `OK events=12 headerVersion=4`；
6. 落盘 = 同目录备份原档（`*.corrupt-bak-20261004`，原权限 600）→ 临时文件 `chmod 600` → `mv -f` 原子替换 → prod 路径复测通过。**无需重启 dsh**（coldLogMemo 按 stat revision 失效）。

B 例备注：read-open 只做"解码+迁移+校验"**不发布** v4 代文件；v4 代在首次 write-open（resume）时才落盘。

## 4. 全库 sweep（`~/.dsh/agents/*/sessions`，prod reader 逐档）

- 36 个 v4 档：**34 OK**（含修复后的 A 例）；2 个已知损坏**未修**：
  - `hermes/--home-u1-workspaces-base--/session-aa6f7ef5-…`：`tool/call call_00_A1wlHw4cdpVwJnrQPvI08965 has no advertised lifecycle`（tool/call 无前置 assistant 广告）；
  - `pi/--home-u1-.dsh--/session-d6033e6f-…`：`turn/end does not match the open turn with no open step`。
- 5 个只有 `session.v3.jsonl.zstd` 的目录（claude/codex/omp/pi × base，9-22~9-28 era）：旧代格式，**不是损坏**。
- B 例（ca5dea6c v3）修复并 prod 路径验收通过后不在上述计数内。

## 5. 给 super-dsh 上游的修复建议（未实施）

1. **agent-omp / agent-omp-sdk（现行 0.1.10 仍带病）**：`toolCalls()`（agent.js :175）把 advertised `arguments` 带进 `#pendingToolCalls`；`tool_execution_start`（:957）append `tool/call` 帧时优先用 pending 里按 callId 匹配的 advertised 原文，无匹配再回退 `event.args`。配一条回归单测：模型 tool-call 带未知字段（被运行时 strip）时，`tool/call` 帧 arguments 必须 ≡ advertised。
2. **foreign wrapper 通用**：system 头 stamp 必须在 `turn/start → step/start` 之后落；v4 时代头身份用 `system-prompt`（B 例 A 法已验证迁移器只认 `@deepseek-ai/dsh-system-prompt` 插件名映射）。
3. 其余 adapter（agent-pi/claude/codex/codex-sdk/hermes/agy）同一 `tool/call` append 形态，属**同族潜伏**：凡运行时在 advertise 与 execute 之间改动 args 的（omp 的 schema strip 是一例）都会触发。建议一并按 ① 修。

## 6. 备份与产物

| 物件 | 位置 |
|---|---|
| A 例原档备份 | `…/session-7f65f71d-…/session.v4.jsonl.zstd.corrupt-bak-20261004`（2175B） |
| B 例原档备份 | `…/session-ca5dea6c-…/session.v3.jsonl.zstd.corrupt-bak-20261004`（11839B） |
| 修复工作台（解包帧、修复脚本、验证脚本 val.mjs/valv3.mjs/sweep.mjs） | dev3 `~/workspaces/dashr/.scratch/omp-repair/` |

---

## 7. 追加（10-04 03:10 UTC+8）——病例 C：hermes `session-aa6f7ef5`（§4 遗留两档之一，已修）

### 7.1 现场报错

```
Failed to load history: stored session "session-aa6f7ef5-7944-40b7-b55d-15b021004a50" is corrupt: …
SessionFormatError: tool/call call_00_A1wlHw4cdpVwJnrQPvI08965 has no advertised tool lifecycle
(raw log: …/agents/hermes/sessions/--home-u1-workspaces-base--/session-aa6f7ef5-…/session.v4.jsonl.zstd)
(SESSION_QUERY_CORRUPT_SESSION)
```

报错文本来自 v4 关系校验器（`dsh-session-format-v3-to-v4/lib/index.js` **:650**，`pending === void 0` 分支）：
`tool/call` 的 callId 在**此前任何 assistant/message 里都没被广告过**——比病例 A 的"广告了但 args 不等"更早一步断链。

### 7.2 档内实况（67 帧）

两轮同型：`turn/start → request/context → step/start → system/message(system-prompt ✓) → user/message → titles →
**N 对 tool/call+tool/result（无任何前置广告）** → assistant/message（只有收尾 reasoning+text，**零 tool-call 块**）→ step/end → turn/end`。
turn1 = 5 对、turn2 = 17 对，共 22 个调用全部"裸奔"。

**根因（super-dsh `agent-hermes` 桥，第三类写侧 bug 家族）**：hermes CLI 的模型输出里，含 tool_use 的中间 assistant 消息从未被桥接落档
（adapter 只在收尾 assistant 消息上写了帧），而工具执行事件照单全收 → 执行帧失去了广告锚。与病例 A 同属"广告↔执行断链"，
但断法相反：A 是**广告错位**（args 被改），C 是**广告缺失**（帧没写）。

### 7.3 修法

每轮在**首个 tool/call 前**插入一条 advertisement assistant/message：

- `content` = 该轮全部 tool-call 块（`id`/`name`/`arguments` 从对应 `tool/call` 帧**逐字复制**——校验按构造必然相等）；
- `source` 复制同轮收尾 assistant 的 `{"kind":"model","provider":"deepseek","model":"deepseek-v4-pro"}`；
- `stream: []`、`surfaceOp: "append"`、`time` = 首个 tool/call 时刻、新 uuid；收尾 assistant 原帧不动；
- 全档 seq 密集重编号（67→69 帧）；titles 的 `messageSeqs:[9]` 指向 user/message，在插入点之前，不受影响。

67 个原帧 round-trip 逐字节断言后重排；multiframe zstd 重压（每行一帧）。

### 7.4 验证与落盘

| 步骤 | 结果 |
|---|---|
| 修复副本 `readStoredLog` | `OK — events=68` |
| prod 路径复测（安装后） | `PROD(after): OK — events=68` |
| 原档备份 | `…/session-aa6f7ef5-…/session.v4.jsonl.zstd.corrupt-bak-20261004`（74400B） |

§4 sweep 计数更新：36 v4 档 → **35 OK / 1 未修**（`pi/--home-u1-.dsh--/session-d6033e6f-…`，`turn/end does not match the open turn with no open step`，待 user 点头）。

### 7.5 上游修复建议追加

4. **agent-hermes**：桥必须在工具执行事件落档**之前**，把含 tool_use 的 assistant 消息（至少其 tool-call 块）桥接为 `assistant/message` 帧；
   回归单测：一轮内 N 次连续工具调用时，每个 `tool/call` 帧之前必须存在广告其 callId 的 assistant 帧。
   （与 §5-① 同一验收口径：广告↔执行链完整。）

---

## 8. 追加（2026-10-04 晚）：§5/§7.5 修复建议已实施（pack 0.1.10-h，4999 线实装）

**修复映射（8 个 adapter 全部覆盖）**：

| adapter | 修法 | 对应病例 |
|---|---|---|
| agent-omp / agent-omp-sdk | `toolCalls()` 携带广告 args 原文（与 `convertContent` 同一归一化）；`tool_execution_start` 按 callId 优先取广告 args，`event.args` 仅兜底 | 病例 A |
| agent-hermes | `#advertisedToolCalls` 集合跟踪真实 assistant 帧的广告；`tool_execution_start` 对未广告 callId 先合成最小广告 assistant 帧（args 与 tool/call 帧逐字相同） | 病例 C |
| agent-pi / agent-codex / agent-codex-sdk | 同 hermes 模式（集合 + 兜底合成）；codex 系合成 source 沿用 open-turn 路由回退链 | §5-③ 同族 |
| agent-claude | **合并形状**（非独立广告帧）：tool-call 块并入该 step 的 assistant/message（与文本+usage 同帧）——独立无 usage 广告帧会破坏 token-meter fold（`turn-usage.ts`：每 step 的 assistant 帧必须带 usage 样本，否则整 turn usage → undefined） | §5-③ 同族 |
| agent-agy | 同 hermes 合成（onToolEvent tool_call 分支内） | §5-③ 同族 |

**回归测试**：`agent-omp/test/tool-args.test.mjs`（3 条：广告 args ≡ assistant 帧 args；剥离后执行 args 必须落选；对象形 args 归一化一致）+ `agent-hermes/test/agent.test.mjs` case C 测试（合成广告先于 tool/call、args 严格相等、真实广告抑制合成）。全套件：8 adapter 共 **1026 测试 0 fail**（omp 77 / omp-sdk 76 / hermes 134 / pi 56 / codex 190 / codex-sdk 170 / claude 249 / agy 74；pi bridge 与 claude lifecycle 两处测试钉子按新不变式更新）。

**实装验证（0.1.10-h @ 4999）**：hermes 工具轮（deepseek-v4-pro，shell 工具真实执行，`tool_turns=1`）→ dsh 自己的 `JsonlSessionPersistence.readStoredLog` 离线验收：`OK events=16`，0 裸 tool/call、0 args 错位。

**新发现（上游 wire 保真度，非 adapter 可修）**：本机 hermes gateway 的 RPC wire **不发任何工具生命周期事件**（`prompt_turn.py` 只 emit message.start/delta/interim/complete、status.update、error；`tool_execution_start` 字符串在整个 hermes 树中不存在）→ 工具轮在 DSH 档中只落最终 assistant 帧，tool/call、tool/result 不落档（§7 病例 C 的 22 对帧来自当时 gateway 版本的事件，vintage 差异）。后果：hermes 工具轮的执行轨迹在 Web UI/档中不可见（会话可正常加载；框架合成代码对该 vintage 是死代码安全网，对会发事件的 gateway 版本即生效）。如需补齐，须 upstream gateway 在 wire 上加工具生命周期通知。
