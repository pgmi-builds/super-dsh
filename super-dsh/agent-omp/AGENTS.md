# agent-omp — AGENTS.md

本文件是 `agent-omp`（`@pgmi-builds/agent-omp` 插件）的 AGENTS.md。上层为仓库根 `AGENTS.md`；其规则对本目录仍有效，冲突时以本文件为准。

**本文件只记「坑」**——踩过一次、复发过、或反直觉的契约。改这里任何代码**之前先读本文件**；踩到新坑**当场回写**（就地 inline comment + 本文件；计划层写进 `openspec/changes/<change>/`）。

---

## 〇、一句话架构（dsh-shape-session-log 之后）

操作员本机的 `omp` binary（`omp --mode rpc` 子进程）是 live runtime；**dsh 原生 session log 是 of record**；插件只做两件事：**当 producer**（把 OMP RPC 事件翻译成 SessionEvent 并经宿主 `ctx.sessionPersistence` 落盘）与**当 bridge**（把 OMP 侧的 identity/模型面接进 dsh 契约）。读侧（list/page/replay/workspace）全部由 dsh 原生组件读 `<DSH_HOME>/sessions`；OMP 自己的 runtime 数据在 **`OMP_HOME`**（默认原生 `~/.omp`，`$OMP_HOME` 只作测试/隔离 knob，OMP 格式），两者 1:1 但互不读；`<DSH_HOME>/agents/omp/` 只是该 world 的 DSH home（sessions/storages/settings），**不是** OMP app home。

---

## 一、生命周期：**永远 lazy creation**（复习坑，复发过两次）

**铁律：用户没有发出第一条真正的 user prompt 之前，后端不得存在任何 OMP session/子进程/落盘。**

- UI 的 new-chat 是**浏览器本地**的：workspace / agent preset / model 都还没 frozen，用户可能切来切去再回来（浏览器端自己缓存 draft）。**这段期间 OMP 侧必须零动作。**
- 实现入口 = `LazyOmpRpc`（`src/lazy-rpc.ts`）：构造时不 spawn，第一次 `prompt`/`followUp`/`steer` 才 spawn；`adoptSpawnedChild` 在那一刻写映射。
- **三个路径都必须 lazy（2026-09-16 扩展）**：`createAgent`（create）、`resume` 的「无 OMP 映射」分支，以及 `resume` 的「有 OMP 映射」分支（`--resume <ompFile>` 同样走 `LazyOmpRpc`）。2026-09-15 曾在 resume 分支误用 eager spawn（当时的 `OmpSdkClient.spawn`，该类已随 RPC 轮删除），当场造出一个空 OMP session —— **这是已知复发点，回归测试必查**（`test/no-sidecar.test.mjs` 源级断言：`index.ts` 内不得出现 `OmpRpcClient.spawn(`，且必须 `new LazyOmpRpc(`）。宿主对 cold session 的 follow-promote（打开即 resume）意味着：WebUI 只浏览/回放也绝不能拉起子进程。
- 为什么不 eager：dsh 原生 session 的 cwd/preset 由 UI 在 prompt 时才定稿；先建 OMP session 会把错误的 workspace 冻进 OMP 侧，与 dsh 的持久化产生分歧。

### 为什么 resume 会被叫到（反直觉）

宿主 `session-controller.createOrAdopt`：`session/create` **带了 `sessionId`** → `checkPersistedIdentity=true` → 只要该 id 在 dsh log 里已存在就**走 resume**。UI 的 new-chat 会先落一个空白会话，所以「点新聊天」也可能命中 resume。

**因此 resume 必须容忍空白会话**：无 OMP 映射 + log 无对话内容（无 `turn/start`/`user/message`/`assistant/message`）→ 视作全新会话，**lazy** 等首 prompt；有内容才 fail-loud（**绝不把 dsh transcript 喂回 OMP**）。

### 权限档位：**只在 spawn 那一刻绑定**（2026-10-03，复发坑）

OMP 的 `--approval-mode` 是 launch flag，**没有 RPC 能中途改**（v18.4.9 实测）。所以三档映射（`danger-full-access→yolo` / `workspace-write→write` / `read-only→always-ask`）的解析时刻必须是 **child 真正 spawn 的那一刻**，而不是 `createAgent`：

- Dash session 的 `permission/preset` 由宿主 `pinInitialPermission` 在 **publish 时**才盖下（晚于 transport wrapper 构造），用户在 **new chat** 里选的那一档又是更晚的一条 `permission/preset`，而 child 要等首 prompt 才 materialize。**这三点叠加 ⇒ 在 create 时冻结 argv 必然把默认档（`danger-full-access`）冻进 child**——旧代码正是如此，症状是 new chat 选完立刻回弹成 Full Access。
- 修法 = `LazyOmpRpc` 接受 **thunk argv** + `resolveSpawnPermission(events, fallback, envMode)`（最后一条有效 `permission/preset` → fallback → `yolo`；`OMP_APPROVAL_MODE` 覆盖）。**不要再把 spawn 参数当构造期常量。**
- `/permission` 影子命令按 child 状态分流：未 spawn → `permissionPresets.set()`（落 durable preset + knob 事件，**不要**用全局 handler 的 `approval.setPolicy`——它会往 OMP 会话注入一条 narration user message）；已 spawn → 明确拒绝。**绝不接受中途切换**（接受 = UI 显示一档、运行中的 `omp` 跑另一档）。
- 回归：`test/permission-spawn.test.mjs` + `test/lazy-rpc.test.mjs`（mock fixture 的 `MOCK_OMP_ARGV_FILE` argv dump 是唯一能看到 child 真实 argv 的面）。

---

## 二、写路径：dsh 原生 session log（producer 角色）

- 取写句柄：`ctx.sessionPersistence.create(header)` / `open(id,'write')`（与 agent-loop 同通道）。**handle 由插件自己持有与关闭**（`setupAndPublish` 的 dispose）。
- live `session.append` → `session/event` → 原生 jsonl backend 按 session id 路由进 handle。**插件不要手搓 append 循环**。
- **`appendUnstoredSuffix` 必须补**：publish **之前** append 的事件（constructor seed、resume 的 `session/end-seed`）**不 emit `session/event`**，必须用 `handle.append(session.snapshotEvents(offset))` 手动冲进 handle —— 否则 writer 看到序号断档（`expected N, got N+1`）→ `drainPaused=true` → **之后所有批次永久卡在 buffer**（症状：文件只有 header + 前几条）。
  - `opts.stored.written` 记录已写偏移；resume 分支要把 `written` 初始化成 `coldRead.events.length`。
- **v3 坐标必须为正**：surface 事件（`system/message` 等）的 `turn`/`step` **不得为 0**（`session-format-v2-to-v3` 校验 `turn must be positive`）。native fresh 会话实测用 `{turn:1, step:1}`。写成 0 会**整批被 writer 拒绝**，症状同样是 drain 卡死。

> 排查这类问题的最快路径：临时在插件里 `ctx.on('session/event')` 打点 + dump jsonl writer 的 `buffered/cursor/drainPaused` + 在 `turn/end` 调一次 `handle.drainLive().catch(log)` —— **错误消息即根因**（我们就是这样拿到 `turn must be positive` 与 `append seq mismatch`）。

---

## 三、bridge index（`bridge-store.sqlite`）：**只存 dsh↔omp 映射**

- 表的唯一职责 = `dsh_session_id ↔ omp_session_id ↔ session_file`，首次 spawn 时由 `upsertCreated` 写入；`resolveEntryById` 用它把 dsh id 翻成 app-home 的 OMP 文件（resume 要 `--resume` 它）。
- **禁止再做 OMP 原生目录扫描 + `prune`**（union 时代遗产）：扫描目标是 `~/.omp/agent/sessions`，而 app-home 产出的映射不在其中 → **每次 reconcile 都把映射删掉** → resume 报 `no OMP session is recorded for this Dash session id`。2026-09-15 已退役（`prepareIndex` 只保 ungrouped workspace）。
- workspace 归组靠 `#attachScannedSessions` 读这张映射表，不再是 OMP 扫描。

---

## 四、patch 层（`cordis.patch.yml`）——**YAML 也是源码**

- **`name` 覆盖被拒**：同一 id 改 `name` 不会重新 import，boot 直接 `patch: name mismatch for "<id>" (expected "<旧>", got "<新>"), skipping`（`--dump-config` 可见）。**整插件替换只能 `disabled: true` 旧行 + `insert` 新行（新 id）。**
- **`directory-picker-auto` 不是普通别名**（踩过：删了它 → UI 的「add workspace」按钮消失）：
  - 该行 boot 时**解析一次**（loopback bind + 非 SSH + linux + 有 `DISPLAY`/`WAYLAND_DISPLAY` + PATH 有 zenity/kdialog ⇒ **native**，否则 browse），然后经 loader **同时挂两面**：host backend 包 + **对应 client surface 包**（`dsh-client-ui-directory-picker-<kind>`）。
  - client surface 占住 workspace picker 的 **directory-flow hole**；`ui-workspace/WorkspacePicker` 是 `flowAvailable ? [ADD_WORKSPACE] : []` —— **hole 空 ⇒ 「add workspace」入口整体消失**（侧栏与 new-chat 两处同时）。
  - 要钉 browse：`insert` **两个**包（backend 在前，surface 在后，顺序即依赖）+ `disabled: true` auto。**只挂 backend 会毁掉按钮。**
- **标题归 OMP，而且是 OMP 真的会生成的**（2026-09-15 修正：此前记录「OMP 侧 title 恒为空」是错的——不是没能力，是我们从没触发它）：
  - OMP session 文件首行是 `{"type":"title","v":1,"title":…,"source":"auto"|"user","updatedAt":…,"pad":…}`：创建时**写空**，之后**原地重写**（`pad` 是预留宽度的填充）。
  - 标题由 OMP 自己生成（受 `PI_NO_TITLE` 门控；`omp --mode rpc` 时上游主动 `PI_NO_TITLE=1`，但 RPC 面仍会发标题帧）；对桥而言标题**唯一到达面** = RPC 帧 `session_info_update.title`（另有 `setTitle`），见 `rpc-client.ts` 的 `onTitle`。
  - 我们的接线（`rpc-client.ts` `onTitle` → `agent.ts` `#applyOmpTitle` / `#mirrorOmpTitle`）：标题帧到达即 mirror，并在每轮结束后用 `getState().title` 复查（生成是**异步模型调用**，可能晚于本轮结束才落地）→ 写 `session/title`（`source:{kind:"provider",provider:"omp"}`）。
  - **不要**启用 dsh 的 `session-title-llm`（那条会走 dsh 侧 LLM，属于擅自加功能），它现在保持 disabled。
  - 已知副作用：base `session-title` 的 **fallback**（首条 user message 文本、无 LLM）仍会先发一条 `session/title`，随后被 OMP 标题覆盖 —— UI 上可能有一瞬先 fallback 后 OMP 标题。是否停用 fallback 待裁决。
- 标题只能被动接收：`getState()` 的 `title` 键是标题帧之外的唯一复查面，没有主动索要标题的 RPC 命令。
- `agent-loop` / `agent-presets` / `llm-deepseek` / `llm-pi-ai` disabled；`session-persistence-jsonl` **保持挂载**（唯一的 `sessionPersistence`）。
  - 副作用已知：`agent-presets` disabled ⇒ `pluginInventory/list` 报 `presets.compositionInventory is not a function`（插件清单页不可用），与运行无关。

---

## 五、两个 OMP home（**别混**）

| 名字 | 是什么 | 定义（`src/knobs.ts`） | 默认 |
|---|---|---|---|
| **`OMP_HOME`** | **OMP runtime app home**（`agent.db`/`models.db`/`sessions/` 的写入目标；也是 `omp` 数据面子进程的 cwd） | `process.env.OMP_HOME ?? resolveOmpNativeHome()` | **原生 `~/.omp`**（2026-09-17 原生 home 裁决；旧的 `<DSH_HOME>/agents/omp/.omp` 派生已退役）——`$OMP_HOME` 仍是测试 / 适配器级隔离 knob，但**默认绝不指向 DSH 树** |
| **`OMP_NATIVE_HOME`** | **操作员的原生 OMP** 安装（TUI/CLI）：`agent/config.yml`、`agent/models.yml`、原生 session store | `process.env.OMP_NATIVE_HOME ?? join(homedir(), ".omp")` | `~/.omp` |

- 〔历史〕2026-09-15 曾把 app home 派生为 `dshHomePath("agents","omp",".omp")`，且当时裸读 `process.env.DSH_HOME` 得到 `undefined` → 实测落到 `~/.omp/omp-web/...`，而 dsh 在 `~/.dsh`（app home 与 session log 分家）。2026-09-17 原生 home 裁决后该派生整体退役：`OMP_HOME` 默认 = `OMP_NATIVE_HOME`（`~/.omp`），与 DSH_HOME 不再相干——裸读 `DSH_HOME` 的坑随之消失（历史教训保留在案）。
- **原生读取面一律走 `OMP_NATIVE_HOME`**（不是 `OMP_HOME`）：模型目录的磁盘回落（`models.ts` 的 `OMP_AGENT_DIR`）、`OMP_SESSIONS_ROOT` 与 `agent/config.yml`（`omp-store.ts`）、commands/skills 扫描根（`omp-disk-discovery.ts`）、以及 workspace 排除表（`index.ts`）。`OMP_HOME` 只作 app 写入目标与 `omp` 子进程 cwd。
- **绝不要把 `OMP_NATIVE_HOME` 指到 app home / 测试 home**：它是 config/models.yml 的**读取来源**，指到空目录 → 模型磁盘回落读空 → 适配器零 provider → `session/prompt` 报 `model-unavailable`（看着像代码 bug，其实是 env 配错；2026-09-15 真踩过）。反过来，`OMP_HOME` 是**写入目标**，别让它等于 `~/.omp`。
- `OMP_HOME` 是 OMP app 数据的**写入目标**（也是 `omp-cli.ts` 子进程的 cwd）；spawn `omp --mode rpc` 时**不显式注入 / 重定向 home**，子进程用操作员自己的原生 `~/.omp`。
- config 桥（`modelRoles` 双向同步）**写走子进程**：`omp config set modelRoles --json`（`omp-cli.ts`，cwd = `OMP_HOME`；OMP 自己持久化 `modelRoles.default`），不再直接写 `agent/config.yml`；读侧 provider 排序首选磁盘 `agent/config.yml`、CLI 兜底。

---

## 五·五、零 spawn 窗口（原「Sidecar 解耦」，2026-09-16 裁决）：**tick 永不 spawn；`omp` 子进程只活在会话窗口**

- **不变量**：`STORAGE_RECONCILE_INTERVAL_MS` 的 tick（workspace attach + default-model sync）绝不 spawn `omp`。周期性刷新的唯一入口 = `liveOmpSessionExists(this.liveSessions)`（`index.ts` 导出的 gate）：集合为空、或会话只是未 spawn 的 draft（`LazyOmpRpc`）→ 直接跳过，**零进程**；集合由 `registerHeld` 在会话真正 publish 时 `liveSessions.add(rpc)` 填充、dispose 时删除。回归 = `test/no-sidecar.test.mjs`：源级断言「tick 的 `refreshOmpModelsCli()` 必须挂在 `liveOmpSessionExists` 上」+ 对编译后 `dist/index.js` 跑行为真值表（gate 的输入集必须被 publish 路径填充，否则刷新是死代码）。**数据面另算**：`omp models --json` / `omp config get` 都是真实子进程，任何周期性调用都必须先过这道 gate。
- **数据面真源**：模型目录第一源 = `omp models --json`（boot 走 `ompAvailableModelsSync`，失败才回落磁盘 `models.db` ∪ `models.yml` 并打 stderr）；provider 排序的 modelRoles 首选 `agent/config.yml` 磁盘读（`readOmpModelRolesFromConfig`，mini-YAML 扫描，零 YAML 依赖），`ompModelRolesSync` 兜底。tick 的 `refreshOmpModelsCli` 只在 live gate 为真时搭便车换 memo。
- **skills + slash commands 全磁盘**：`discovery.ts` 不再 import sdk-client；`readSlashCommands`/`readSkills`（`omp-disk-discovery.ts`）扫 omp+claude 的 user/project 根。v1 保真度边界（已裁决接受）：无 embedded 内置命令、无 codex/opencode/cursor 等外来 provider、无 capability 语义（at-imports/managed skills）。命令 boot 挂一次 + `OMP_DISCOVERY_REFRESH_INTERVAL_MS`（knobs，默认 1h，0 禁用）重挂（dispose-then-register，先卸旧集再挂新集）。
- ~~**已知环境坑**：真 spawn sidecar 的测试~~（2026-09-24 场景退役 + 2026-10-03 RPC 轮）：SDK 线的 `sdk-client.test.mjs` / `sidecar-smoke.test.mjs`、以及 `sidecar-*.test.mjs` 全部已删；现行 lazy / 零 spawn 不变量由 `test/lazy-rpc.test.mjs` 与 `test/no-sidecar.test.mjs` 把守（全 fakes + 源级断言，零真 runtime、零真 `omp`）。

---

## 六、测试锚点（2026-09-24 场景退役后）

**场景退役（user 裁决）**：本目录不再有 per-agent 场景 rig——standalone 线、真 sidecar spawn 测试（`sdk-client`/`sidecar-smoke` 已删）、下方旧冒烟清单一律退役；**整包验证只走 superd 的 4999 pack 线 + dev3 实装**（`super-dsh/AGENTS.md`）。原「冒烟九查」的覆盖面（fresh create 全事件落盘 / resume 含 blank draft / eager-spawn 禁令 / idle-exit / tick 零 spawn / 磁盘扫描菜单）由 **pack 线上的 per-runtime 会话面验收**承载（根 AGENTS §二.5 对齐验收程序）。

保留的单元测试面（`npm test`，全 fakes、源级断言，零真 runtime、零真 `omp`）：session log 生产者契约（`appendUnstoredSuffix`/v3 坐标）、bridge 映射（`store`）、模型面与 home（`omp-store`/`omp-model-roles-disk`）、lazy 与零 spawn 不变量（`lazy-rpc`/`no-sidecar`）、RPC 传输与 binary 解析（`rpc-client`/`resolve-executable`）、数据面（`omp-cli-rpc`）、菜单发现（`omp-disk-discovery`/`omp-discovery-mount`）、preset roster、mobile 纯函数、交付清单（`package-contract`）。
