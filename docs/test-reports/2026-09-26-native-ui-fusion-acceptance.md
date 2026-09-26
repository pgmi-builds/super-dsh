# native-ui-fusion 整包验收报告（plan Task 6 / spec §7）

- **日期**：2026-09-26
- **分支**：`native-ui-fusion` @ `9b71b17`（+ 本报告的验收 commit），worktree `/home/u1/workspaces/superd/.worktrees/native-ui-fusion`
- **交付物**：`.scratch/superd-pack/super-dsh-0.1.3-zh.tgz`（`node super-dsh/scripts/pack.mjs` 于 worktree 根运行；版本 `0.1.3-zg → 0.1.3-zh` 字母迭代）
- **spec**：`docs/research/native-ui-fusion-plan.md` §7（八项）+ 评审 §4.8 五条中的服务器侧项

---

## 一、Rig 身份

### 主 rig（flag ON —— 交 user 亲手测，保持运行）

| 项 | 值 |
|---|---|
| 端口 | **4996**（起线前 `ss` 实测空闲；4999 = dashr 占用不碰，4995/4997 他线 relay） |
| home | `.tests/superd-t6`（fresh clean；脚本红线校验通过） |
| unit | `superd-4996-test` + LAN relay `superd-lan-4996-relay`（socat，只绑 192.0.2.130） |
| flag | `SUPERD_UI_FUSION=1` —— `systemctl --user show superd-4996-test -p Environment` 实证已进 daemon env |
| token URL (local) | `http://127.0.0.1:4996/?token=<redacted>` |
| token URL (LAN) | `http://192.0.2.130:4996/?token=<redacted>` |
| 关停命令 | `systemctl --user stop superd-4996-test superd-lan-4996-relay` |

### 对照 rig（flag OFF —— 证据采完即收）

| 项 | 值 |
|---|---|
| 端口 / home | 4998 / `.tests/superd-t6-off`（fresh）；unit `superd-4998-test` + `superd-lan-4998-relay`；**已 stop，4998 已释放**（复跑：`SUPERD_PORT=4998 SUPERD_HOME_DIR=$PWD/.tests/superd-t6-off bash super-dsh/test/start-4999.sh`，不带 flag 变量） |
| boot token（provenance） | `4iOPbVET1V1JnVn1SllICQsb0V366DbtGn_pCWlPNcI` |

### Boot 健康（flag ON rig）

- 认证链：无 cookie `GET /` → **401** `dsh web authentication required`；`?token=` → **303**（落 cookie）；带 cookie `GET /` → **200**。
- 六世界 mount 全 200：`/claude/` `/omp/` `/codex/` `/hermes/` `/pi/` `/agy/` 各 **200**。
- `journalctl --user -u superd-4996-test` 中 **`world failed` 计数 = 0**。

### 环境准备备注（非代码，记录在案）

- worktree 内 6 个 adapter 包缺 `node_modules`（Task 1-5 只装过 superd-hub）：已 `ln -s` 主 checkout 同名包的 `node_modules`（先 `diff` 证实两树 `package.json` 逐字节相同；主 checkout 零写入）。dev-env 事实，不随 commit。
- pack 首轮把 SDK 下载进 worktree 本地 `PNPM_STORE`（1m33s，consumer-parity 安装照旧）。

---

## 二、Step 0 — flag 旋钮透传

`super-dsh/test/start-4999.sh` 两处最小改动：

1. **flag 旋钮**：`SUPERD_UI_FUSION` 环境变量在操作者设置时经 `--property=Environment=` 透传进 daemon（`1/true/yes/on` = ON，见 `deriveFusionFlag`）；**未设置时保持未设置 = 出厂默认 OFF**。实证：flag-ON rig unit env 含 `SUPERD_UI_FUSION=1`；flag-OFF rig unit env 无此变量。
2. **REPO 锚定修正**（配套必需）：`REPO` 从硬编码 `$HOME/workspaces/superd` 改为按脚本自身位置解析（`BASH_SOURCE` 上溯两级）——否则从 worktree 调脚本会把**主线**的 super-dsh pack 进 rig（违反「run it INSIDE the worktree」）。主 checkout 调用路径行为不变（同一路径解析回同值）。

---

## 三、§7 验收清单 · 逐项证据

> 探针全部打在 4996 flag-ON rig（交付形态：tarball 装入 fresh profile，repo build launcher 启动）。

### §7.1 每 runtime 至少 create + prompt (+ resume) — ✅ 全 6 个跑通（经 /hub 融合路径）

驱动方式：envelope POST `/hub/api/<endpoint>?agent=<label>`（`{type:'client-request',rpcId,method,payload}`），resume = 同 sessionId 第二次 `session/prompt`。全部 **create 200 + prompt-1 accepted + turn 落定（running=false, blank=false）+ prompt-2(resume) accepted + turn-2 落定**：

| runtime | agentPreset | sessionId | turn-1 | turn-2 (resume) |
|---|---|---|---|---|
| claude | `claude` | `session-f7bdaa99-…` | ✅ | ✅ |
| omp | `omp` | `session-8a50a2ff-…` | ✅ | ✅ |
| codex | `codex` | `session-7d15036e-…` | RPC 全 200，**turn 内容=环境失败**（见下） | 同左 |
| pi | `pi` | `session-0bd33911-…` | ✅ | ✅ |
| hermes | `hermes` | `session-b79f19b6-…` | ✅ | ✅ |
| agy | `agy` | `session-2bd2694f-…` | ✅ | ✅ |

**内容级证据**（mux `session/follow` 流经 `/hub/api/remote.mux?agent=<label>` 的 snapshot 帧）：omp / pi / hermes / agy / claude 五世界的 snapshot 均同时含两个回合的模型原话（`"Reply with exactly: OK"` → `"OK"`、`"Reply with exactly: RESUMED-OK"` → `"RESUMED-OK"`；claude 的 turnOutline 双回合 prompt/response 全对）。

**codex = 环境限制，非融合缺陷**：turn 以 `turn/end {kind:'error', message:"Reconnecting... waiting for network (Connection failed: error sending request)"}` 收场——其 provider `~/.codex/config.toml` 钉的 `base_url = http://127.0.0.1:15721/v1`（本机 plan 代理）**当前无监听**（`ss -tln` 实证）。**直接世界挂载 `/codex/api/...`（不经 /hub）复现同一错误** → 纯属该世界 runtime 的出网腿，与本特性无关；codex 经 /hub 的 RPC 面本身全绿（create/prompt/list/follow 全 200，mux 可流式读回该 session）。

### §7.2 双向切换 + 往返幂等 — 数据面半 ✅；页面 UX 半 → user（见 §五.2）

- **往返幂等（数据面）**：同一 rpcId 分别打 `/claude/api/<ep>`（直接世界挂载）与 `/hub/api/<ep>?agent=claude`（融合路径）：
  - `agentPresets/list` → **两路响应逐字节相同** ✅
  - `session/list` → **两路响应逐字节相同** ✅（且列出 §7.1 建出的会话）
  - 注：`settings/describe` 不可作字节级对照——该端点每次调用再生文档 uid（同路径连打两次都不同，uid 9142 vs 9237 实证），端点固有行为，与路由无关。
- **native 面 untouched**：ctx0 `/api/settings/describe` envelope → `ok:true`；`/api/agent-runtime` → 200（§7.6）。
- 浏览器内 native↔foreign / foreign↔foreign 点击切换与页内 NS/前缀往返 → user 亲手测（§五.2）；编排逻辑另有单测钉死（`client-switch.test.mjs`：happy path / native switch / revert）。

### §7.3 流进行中切换无串流 — 浏览器侧 → user；单测已钉

generation failAll/取代编排是 client 半行为（`switch-core.ts` 注入式编排；`client-switch.test.mjs` 全绿）。本轮服务器侧无新增证据面 → 归入 §五.2 user 清单。

### §7.4 失败回退 — 服务器半 ✅；页内 toast/revert UX → user

- 未注册/未 spawn label 经 `/hub`：**404 `{"error":"unknown-agent","label":"nope"}`，0.9ms 干净失败**——静默降级、绝不锁页（hub-route.ts 语义）。
- 未认证 WS upgrade：raw **401** 回写（无 ws 交接）；未知 label upgrade：raw **404** JSON。
- 页内超时回 native + toast：单测钉死（`'timeout with no generation → revert: native + reconnect + toast'`）；浏览器实测归 user。

### §7.5 trusted 域 `ownsHost`（Caddy 域回归）— ⚠️ 部分完成（fence 腿全绿；Caddy 域回归 deferred）

- **/hub family 的 fence 腿实证存活**（与兄弟挂载同强度）：
  - 不可信 Host（`Host: evil.example.com`，带认证）：/hub → **401**（family 次序 = authorize 先于 fence，authorize 腿先答）；兄弟挂载 `/claude/api` → **403 `{"error":"forbidden"}`**（kernel fence-first）。两族都拒绝，差别只是门的先后（family 文档化次序：auth first）。
  - 可信 Host + 不可信 Origin（`Origin: https://evil.example.com`）：/hub → **403 `{"error":"forbidden"}`**，与兄弟挂载**完全一致** → `requestRejection` 腿在 family 上真实存活。
- **Caddy `test.pc.internal.test` 域回归 → DEFERRED**：须 4999 线，现被 dashr `dsh-4999-test123` + 其 relay 占用（非本线所有，红线不碰）。组合级等价物已存在：`fusion-flag.test.mjs` 的 served-order pin（`web-trust` row 先于 fusion pair、`trustAt < fusionAt`）+ web-trust 默认 authorities（`SUPERD_TRUSTED_HOSTS=test.pc.internal.test 192.0.2.130 …` 已喂 rig 两侧）。**4999 空出后补一轮域名实测**。

### §7.6 控制面韧性 — ✅（服务器侧）

同一时刻：`/api/agent-runtime`（ctx0，**无** agent 参数、永不被改写）→ **200 in 2.0ms**（roster 列全 7 项：native/claude/omp/codex/pi/hermes/agy）；同刻 `/hub/api/session/list?agent=nope` → **404 unknown-agent in 0.9ms**；`/claude/` `/omp/` mount 照常 200。目标世界失败不影响控制面与切换面。

### §7.7 localStorage 串扰探针 — 单测钉死；DevTools 实测 → user

单测：`fusion-transport.test.mjs` `'NS switch: the same storage key reads its own value per namespace'`、`'the atom is not persisted'`；`client-switch.test.mjs` `'storageNamespace: native is bare, foreign is <label>:'` 等。同名 sessionId 两树各写各读的浏览器 DevTools 探针 → §五.2。

### §7.8 会话落位 — 服务器半 ✅；页内落位 UX → user

- 各世界会话持久且经 /hub 可列可流读：`session/list?agent=claude` 返回 §7.1 建出的会话；`session/follow` snapshot 经 /hub 完整还原历史（records + turnOutline + projections）。
- 落位决策表单测钉死：`'landing: a persisted session id is navigable'`、`'landing: no value / empty / garbage → new chat'`、subagent 地址优先（upstream restore order）。
- 页内 recent-session 恢复 vs new-chat 的实测 → §五.2。

---

## 四、Step 3 探针原始记录（命令 + 观察值）

1. **Boot graph**：served ctx0 index（`GET /`）含 `__DSH_BOOT__`；combo 列表含 `super-dsh/client.js`（hub client row）。
2. **Fusion rows**（字节偏移）：web-trust 脚本（`__DSH_TRANSPORT__`）@32147 **<** fusion transport 脚本（`__SUPERD_UI_STATE__`）@32410 **<** flag global（`<script>globalThis["__SUPERD_UI_FUSION__"] = true</script>`）@41635 —— 顺序契约 ✅。世界页 `/claude/`：`__SUPERD_UI_STATE__` 0 处、`__SUPERD_UI_FUSION__` 0 处、`__DSH_TRANSPORT__` 2 处（web-trust 在，融合双半边不在）——§5 双半边 ✅。**Flag-off rig（4998）served index：`__SUPERD_UI_FUSION__` 0 处、`__SUPERD_UI_STATE__` 0 处，web-trust 与 hub client row 照常** —— flag-off 等价在真 rig 上实证（flag 只关页面行；`/hub` family 照常注册：`?agent=nope` → 404 unknown-agent，`?agent=claude` 非信封 GET 转发进世界答 `not found`）。
3. **/hub family 语义**：
   - 无 agent / `agent=native`：`404 {"error":"foreign-only","message":"the /hub family serves ?agent=<label> foreign traffic only; native belongs to /api"}`
   - `agent=nope`：`404 {"error":"unknown-agent","label":"nope"}`
   - 无认证：`401 dsh web authentication required; reopen the URL printed by dsh web.`
   - 信封 POST `session/list?agent=claude`：`200 {"type":"server-response",…,"result":{"ok":true,"value":{"items":[]}}}`，与直连挂载逐字节相同
   - 非信封 GET 转发：`GET /hub/api/__t6_nope__?agent=claude` → `404 not found`，与 `/claude/api/__t6_nope__`、native `/api/__t6_nope__` 同形（世界 rpc-host 自己的 GET 应答）
   - WS upgrade `/hub/api/remote.mux?agent=claude`（带 cookie）：**101 Switching Protocols** + 正确 `Sec-WebSocket-Accept`；`open {endpoint:'session/list'}` → 世界网关真实 wire 错误 `gateway/signature-invalid: unary Remote methods cannot be opened through the stream carrier`（unary 不走流载体 = 协议正确）；`open {endpoint:'session/follow', payload:{args:{request:{address:{kind:'session',sessionId},maxMessages:20,assistantStream:true}}}}` → **`{type:'item',streamId,value:{type:'snapshot',…}}` 真帧流出**（§7.1 内容级证据即出自此流）。
4. **Per-runtime create+prompt(+resume)**：见 §7.1 表（6/6 RPC 面全绿；5/6 模型内容双回合实证；codex 环境失败已归因）。
5. **控制面韧性**：见 §7.6。
6. **前缀卫生**：`GET /hubapi/session/list?agent=claude`（带认证）→ **404 空体**（content-type 空）——不进 /hub family（无 foreign-only JSON），按普通未知路径处理。
7. **Fencing**：不可信 Host → /hub 401（authorize 腿先答）/ 兄弟挂载 403；不可信 Origin → **两族同答 403 `{"error":"forbidden"}`**。见 §7.5。
8. **数据面往返幂等 + native untouched**：见 §7.2（两 RPC 逐字节相同 ✅；native envelope + agent-runtime 照常 ✅）。

**单测**：`superd-hub` 全套 `node --test` → **174/174 pass**（打包态 dist）。

---

## 五、KNOWN DEFERRALS

### (a) trusted 域 Caddy 回归（test.pc → 4999）— deferred

4999 被 dashr 线占用（`dsh-4999-test123` + relay，非本线所有，不碰）。组合级次序 pin 已存在（`fusion-flag.test.mjs`：web-trust 先于 fusion pair、served-order 断言），本轮补齐了 fence 两腿在 /hub family 上的活体证据（§7.5）。**待 4999 空出：`bash super-dsh/test/start-4999.sh`（4999 = Caddy 背书）后以 `https://test.pc.internal.test/?token=…` 复测 ownsHost 与页面信任。**

### (b) 浏览器-only 项 → user 亲手测清单（flag-ON rig：4996）

1. 页内切换 UX：seat 点击 native↔foreign、foreign↔foreign；切换不清空当前聊天；
2. 流进行中切换：旧代次流 failAll、无旧 agent 事件串入；
3. 失败回退：断网/未 spawn 目标 → 回 native + reconnect 指示 + toast；
4. 会话落位：有历史 agent 落其 recent session；无历史/读取失败落 new chat；native 侧 refresh 恢复 session+draft 不受影响；
5. DevTools storage 串扰探针：同名 sessionId 两树（bare vs `<label>:`）各写各读；
6. modifier-click 行为（中/ctrl/cmd 点击的导航语义不被动）；
7. flag-ON 下 native 附件上传（`__DSH_FILE_UPLOAD__` 钩子路径）。

---

## 六、结论

- §7 八项：**1、2（数据面）、4（服务器半）、6、8（服务器半）全绿带实证；3、7 单测钉死 + 浏览器实测移交；5 的 Caddy 域回归 deferred（(a)）**。
- flag 双态在真 rig 上对照实证：ON = 三行齐备且次序正确；OFF = 零融合行、其余照旧；服务器路由面 flag 无关（设计如此）。
- 交付形态全链（pack → tarball → fresh profile pnpm → repo build launcher → systemd-run）自始至终，无脚手架遮丑。
- **flag 出厂默认保持 OFF**，待 user 放行（§〇.1 两道闸门）；publish 另行请示。

## 附录：0.1.3-zi 复验（终审修复波）

终审（whole-branch）判定 Ready to merge，修复波 commit `752c776` 落地三项（唯一 `agent` 参数手术 + 裸 `?` 折叠；download 锚 href 点击后还原；delivered bundle 漂移守卫——179/179 全绿，delivered bundle 字节不变证明修复全在 host 半边）。本节落档时以 0.1.3-zi 重新 pack 并重启 4996 rig 供 user 亲手测——user 轮测试对象为 **zi**（transport 脚本含锚还原与参数手术；server 面与 zh 等价）。

---

## 附录二：T-E 验收增补（path-separation Part 2 收口轮，2026-09-26 晚）

### 状态基线

path-separation Part 2 五任务全部 landed 且评审干净：T-A `1cefd30`（落位修复）→ T-B `223e6c4`（Hub UI 唯一 switch 面，RuntimeSeat 退役）→ T-C `a751eb2`（per-label URL 族退役，`/hub` 唯一入口）→ T-D `9986942`（世界 webui 行 disable，世界=纯数据面；勘误：保留 roster 行部分为 `/hub` fetch 通道所承重，勿裁）→ **T-E 本轮**（flag 语义收口 + 全量回归 + rig 交付）。

### Flag 语义收口（native-ui-only 现实）

- **代码**：`fusion-transport.ts` `deriveFusionFlag` 区新增语义注块——无 fallback 路线后，flag-OFF = **零 foreign 入口**（`/<label>/` 页与世界 webui 均已从产品退役，非被 flag 门控）；flag-ON = `/hub` 唯一面 + 页内切换。出厂默认维持 OFF（默认翻 ON 属 user 放行轮，§〇.1 两道闸）。
- **flag-OFF Hub 行为调查结论**：T-C 后两处 switch 面（HubPage 行、HubPanelIcon chevron 菜单）均已无 `href`（无死链、无导航臂），但 flag-OFF 下仍渲染 "switch"/chevron 死控件（点了无响应、无提示）。**选定最小正确形态 = 纯函数决策 `switchAffordance(fusion)`（switch-core.ts）**：flag-ON → 可用；flag-OFF → 不渲染 affordance，行保留 roster 信息并挂 `fusion off — no foreign entry` 提示 chip（HubPage）；chevron 整体不渲染（HubPanelIcon——其菜单唯一用途是切换）。UI 零 href 的红线由**交付 bundle** 上的守卫承载（剥离块注释后探测；守卫覆盖四种语法形态——引号对象键 `"href":`/`["href"]`、无引号 JSX prop 键 `{href:`/`, href:`（本 unminified 构建的复现向量）、`.href=` 直写、`setAttribute('href',…)`；块注释中的合法 `href` 提法不触发守卫）。
- **测试**：`client-switch.test.mjs` +2（affordance 双态）；`fusion-flag.test.mjs` flag-OFF served-index 测试增补断言（零融合行 + trust/boot 照常 + **hub client row 照常 compose**——降级发生在 client 半边而非组合缺席）+ 新增交付面测试（hint literal 在交付 bundle、flag discriminator 门控、零 href prop）。hub 套件 157→**160**。

### 全量回归（0.1.3-zj）

| 套件 | 结果 |
|---|---|
| superd-hub（含 drift guard：delivered client bundle 字节新鲜） | **160/160** |
| agent-agy / claude / codex / hermes / omp / pi | 32 + 140 + 70 + 133 + 47 + 56 = **478/478** |
| builds（hub host tsc + 两 client lane；pack 全量重建） | ✅ |

### Pack 与 rig 交付（交付形态，port 4999）

- Tarball：`.scratch/superd-pack/super-dsh-0.1.3-zj.tgz`（399.6 kB，shasum `62b8a789`）。
- 旧 fusion rig units `superd-4996-test` + `superd-lan-4996-relay` 先行 stop（本线自有单位）。
- Rig：`SUPERD_PORT=4999 SUPERD_HOME_DIR=<worktree>/.tests/superd-t-e SUPERD_UI_FUSION=1 bash super-dsh/test/start-4999.sh` → unit **`superd-4999-test`**（保持运行，user 验收）。fresh home，worlds 自举：`agents/{agy,claude,codex,hermes,omp,pi}/` 六 NS 齐。

### 探针证据（命令 + 观察，2026-09-26 22:4x UTC+8）

1. **Shell**：`GET /?token=…`（带 cookie 跳转）→ **200**；无 token → **401**。flag global ×1、transport script ×4 处标记、boot graph ×1、`super-dsh/client.js` hub row ×1。
2. **次序钉**（served index 字节偏移）：web-trust@32147 < fusion-script@32410 < flag-global@43363 ✅。
3. **Roster**：`GET /api/agent-runtime` → 200，**7 项**（native/claude/omp/codex/pi/hermes/agy，带 `path` 字段）。
4. **/hub 语义**：无参 → `404 {"error":"foreign-only",…}`；`?agent=nope` → `404 {"error":"unknown-agent","label":"nope"}`；信封 POST `session/list?agent=pi` → **200 `{"ok":true,"value":{"items":[]}}`**；WS upgrade `/hub/api/remote.mux?agent=pi` → **101 + Sec-WebSocket-Accept 校验通过**。
5. **退役族负探针**：`/pi/ /omp/ /claude/ /codex/ /hermes/ /agy/` 及 `/pi/api/agent-runtime` → 全 **404**（零 foreign 入口实证）。
6. **create+prompt(+resume) 经 /hub**（`session/create` + `session/prompt` ×2）：
   - pi：`session-56af9c6d…` — create 200 / prompt-1 accepted / turn-1 落定（running=false,blank=false）/ prompt-2(resume) accepted / turn-2 落定 ✅
   - omp：`session-5c755435…` — 同上全绿 ✅
7. **per-agent NS 落位**：两个 sessionId 均落 `<home>/agents/<label>/sessions/.../session.v4.jsonl.zstd`（fresh T-E home）；pi 的 `dsh-sessions.json` 正确指回原生 `~/.pi`（per-adapter home 裁决）✅。
8. **Caddy 可信域回归（§7.5 deferred 项本轮补齐）**——`https://test.pc.internal.test/?token=…`：
   - 认证 shell **200**（44,903 B，与 local 字节同量）；无认证 401；
   - served index：web-trust@32147 **<** fusion-script@32410 **<** flag-global@43363，`__SUPERD_UI_FUSION__` 在；
   - page-trust `__DSH_TRANSPORT__={ownsHost:true}` 脚本在，authorities 数组含 `test.pc.internal.test`（浏览器侧 trusted authority 行为）；
   - native `/api` 信封 POST 经 Caddy → **200 `{"ok":true,"value":{"items":[]}}`**（fence 过）；
   - 对照腿：显式 `Host: evil.example.com` + 认证 POST `/api/session/list` → **403 forbidden**（fence/reject 腿活体）；`Host: test.pc.internal.test` 直打 loopback → 401 unauthorized（authorize 腿先答，域 Host+非 Caddy 链路的既有次序语义，非本轮回归项）。

### 遗留给 user 浏览器轮

- 页内切换 UX（chevron 菜单 + HubPage 行、native↔foreign 往返、流中切换、失败回退 toast、落位 new-chat/recent）——服务器面与单测已全绿，浏览器手感归 user；
- flag-OFF 页面的 Hub 行视觉形态（inert 行 + hint chip；本轮以交付 bundle 字节级钉死，浏览器目验待 user）；
- flag 出厂默认翻 ON 的放行裁决（§〇.1 两道闸门）与 publish 另行请示。
