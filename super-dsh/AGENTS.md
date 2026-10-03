# super-dsh — 局部规则（Super D 主线）

- 本文件管辖本目录及子目录；上层为仓根 `AGENTS.md`（最近者胜，中间无其他层）。
- 第三路线：Multi-Context 拓扑 × M0-Fork 数据面哲学的融合线（foreign agent deep integration and detachment）。设计正本：`docs/superpowers/plans/2026-09-14-super-dsh-fusion-design.md`（S1–S6 裁决）；现役实现计划：`docs/superpowers/plans/2026-09-14-super-dsh-superd-a-plan.md`。
- **Agent Adapter 开发规则（必读）**：`agent-adapter-dev-rules.md`（本目录）——adapter 定位/两形态/测试准则/接线域、per-agent 定制权、home 与 profile 布局（`$DSH_HOME` / `agents/<label>` / `profiles/<label>`）、通用纪律。新写或改动任何 `agent-*` 前先读它。
- 本线 adapter 记录：`docs/superpowers/plans/2026-09-15-super-dsh-agent-codex-adapter-plan.md`（codex 轮次计划）、`docs/superpowers/plans/2026-09-15-agent-codex-4985-acceptance-report.md`（实现与验收实录）。
- **agent-codex 线别切换（2026-10-03 user 裁决）**：现役 adapter **整体从 `@openai/codex-sdk` 线改为 `codex app-server` 线**（`@openai/codex-sdk` 已从本包与主 pack 移除；**不另起 `agent-codex-gui`**，dev-rules §7/§9.4-10 的形态判断同步作废）。SDK 线登记的四项降级（无 steer / 模型切换下一轮生效 / 审批仅 launch-only / usage 滞后一轮）全部成为真实能力；新增真实审批回路（`*/requestApproval` → DSH `ctx.approval`）与运行时权限切换（每轮折叠会话日志 → `turn/start.approvalPolicy|sandboxPolicy`，`/permission` 因此可用）。**lazy spawn 铁律照旧**（`create()` 零 IO，子进程只在首个 prompt 物化）。记录：`docs/superpowers/plans/2026-10-03-agent-codex-app-server-migration.md` + `docs/test-reports/2026-10-03-agent-codex-app-server-migration.md`（含 pack 线交付形态验收）。
- **codex 多 provider 面（2026-10-03 引入 / 2026-10-04 重做）**：Agent Runtimes 里 codex 行展开承载 **provider 列表**（增删改：模型 ID / Base URL / API 协议 / key），但**不再有「active provider」概念**——「这个会话跑在哪个 provider 上」是 DSH 自带的 per-session 模型选择（`session/selectModel` + 持久 `model/selection` + `modelSelection` 投影），UI 与本仓其它 harness 完全一致。**分账（重做后）**：`$DSH_HOME/agents/codex/codex-providers.json`（0600）= **正本**（清单 + 被显式删除的 endpoint 墓碑 + API key）；`~/.codex/config.toml` 与 `auth.json` = **只读来源**（启动 + 每 10 分钟读一次，按 endpoint URL 去重折进正本；新 endpoint 直接**用 URL 端点当名字**）；per-provider 模型目录写 `$DSH_HOME/agents/codex/codex-catalogs/<id>.json`，经 **`-c model_catalog_json=<绝对路径>`** 注入。**provider 靠进程参数进子进程**（`-c model_providers.<id>.*`，`codex-launch.ts`），**原生文件零写入**——原「外科改写 config.toml / 合并 auth.json」两条保护规则随写入面一起删除（cc-switch 仍可拥有那个文件，同步会把它的结果读进来）。**实测约束**：hyphenated id 在 `-c` 点路径里合法；`model_catalog_json` override 按进程 cwd 解析故必须绝对路径；`env_key` 是唯一不经 auth manager 的形态 ⇒ 库里的 key 以合成变量名走**子进程环境**，顺带解决 `auth_mode=chatgpt` 遮蔽 `requires_openai_auth` 的老问题。**换 provider = 换子进程**：`turn/start` 无 provider 字段、对已加载线程的 `thread/resume` 是「接受但忽略」，故 agent 在**下一轮冷启动**时 kill 旧 child、新 `-c` 起新 child、`thread/resume` 同一 thread id（turn 中发起的切换落下一轮，不打断在跑的 turn；换模型走原生 `turn/start.model`）。RPC = `codexProviders/get|save|remove`（无 `select`；key 只写不读）。记录：`docs/superpowers/plans/2026-10-03-codex-multi-provider-hub.md` + `docs/test-reports/2026-10-04-codex-multi-provider-onthefly.md`。
- **agent-pi adapter（2026-09-17）**：`agent-pi/`（`@pgmi-builds/agent-pi`，in-process `@earendil-works/pi-coding-agent` SDK，无 sidecar）。**per-adapter home 裁决（2026-09-17 user）**：pi 运行时数据保持**原生 `~/.pi`**（不建 app home、不重定向 `PI_CODING_AGENT_DIR`——dev-rules §5/§13 对 pi 的运行时数据不适用）；`<dshHome>/agents/pi/` 只放 adapter 自己的 DSH 态（`dsh-sessions.json` 映射）；会话双份存储显式接受。记录：`docs/superpowers/plans/2026-09-17-agent-pi-adapter-plan.md` + `2026-09-17-agent-pi-adapter-acceptance-report.md`。（`file:../superd-hub` 物化坑已随 2026-09-22 转型消亡——adapter 对 hub 只有 optional peer，hub 由单包内嵌提供。）
- 本线记录：`docs/superpowers/plans/2026-09-16-compaction-tuning-native-only-acceptance-report.md`。**范围裁决（2026-09-16 user）**：本线纯粹是 multi-agent 功能，**不涉及 Native Dash Runtime 的 functionality**（compaction 等）——那属于 Dash 开发项目的 shipment 范畴；曾为验证 WebUI 世界分隔而临时挂入的 compaction-tuning 探针包**已拔除删除**。**留存结论（活体分隔证据）**：设置行只在原生 DSH WebUI 渲染、omp / codex 世界 UI 连节点都没有（该世界 ctx 未 compose 此 bundle → namespace 不在 → 行画 null）——同一浏览器壳、同一认证域，UI 内容按被寻址世界的 composition 投影，即**世界分隔连 WebUI 层也成立**（§4.1 + §12；证据细节见该报告，机制不可作为本线新增 native 功能的理由）。
- 姊妹线 `archive/multi-agent/`（2026-09-10 搁置）、`archive/multi-agent-ctx/`（冻结保留；2026-09-22 仓重排 apps/ 退役，姊妹线迁入 `archive/`）——**拷贝或引用，永不反向依赖；冻结线永不因本线被迫改动**。

## 职责分界（2026-09-14 定案）

- cordis/dsh patches（UI 或后端）、存储适配、adapter runtime **一律 per agent**（`agent-*` / `agent-ui-*` 包自持）。
- **本线自身只建设 switch 与 gateway**：`superd-hub/`（selector + V5 实例委托导流门 + roster + spawnWorld）。mostly, at least now；adapter 专属物永不上提到线。

## 核心不变量（违反即设计缺陷，详见设计文档 S1–S6）

1. **S1**：selector 一跳 handoff；dispatcher 从不在请求路径寻址 sessionId；错误 sessionId 由当前世界 sessionController 独占应答（原生 not-found 语义），零跨 context 探测。
2. **S2**：roster = adapter 插件加载态投影，无配置文件；spawn 由插件自带 composition（引用上游 bundle 名）在 CTX0 树上 `boot()` 派生——**绝不经 `runProfile()`**（ADR 0008 约束 1）。
3. **S3/S7**（2026-09-17 改版）：`<dshHomePath>/agents/<runtime>/` = 该 agent world 的 **DSH home**（DSH 会话日志副本、storages、adapter 自有 DSH 态）；native app 数据留在**原生 home**（`~/.omp` / `~/.codex` / `~/.claude` / `~/.pi`），spawn 零重定向、零 config 拷贝；原生 session log 留原生格式，DSH log 与之 duplicate 显式接受；单向阀 = 不回读。
4. **S4**：零端口 ctxN（不喂 bind 参数 / disable web 行）；委托 = `typertGateway` 实例两方法进程内委托，零 HTTP、零字节代理；单一认证域（ctx0 cookie）。
5. **S5**：行表深度 agent-specific；standalone 形态起步不 suppress `ctx.llm`；数据路径归 adapter 所有；会话 log 单一主笔仅在采纳转译时为准入判据。
6. **S6**：router 是哑的——只管 consumer 切换 + 新会话 generator 指向；生命周期归 owner context；零 HMR / 零 Drain。

## 运维红线

- 上游源码零修改；`@deepseek-ai/*` 单实例纪律——任何 install 后 `find <scope>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` 检查（2026-09-22 housekeeping：仓根 `node_modules` farm 已删除；现存 scope = `super-dsh/node_modules/@deepseek-ai` 编译/测试 farm，`scripts/sync-dsh-farm.mjs` 维护；home 级 farm 已退役，见「锚与解析契约」）。
- DSH 侧 dev/test 一律 `DSH_HOME=<仓根>/.tests`（agent world DSH home = `$DSH_HOME/agents/<label>`、agent profile = `$DSH_HOME/profiles/<label>`；foreign runtime app home = 原生 `~/.omp` / `~/.codex` / `~/.claude`，spawn 不重定向——见 dev-rules §5/§13；`.tests/superd` = 交付形态线（4999 pack 线）专属 home，`.tests/hub-test-home` 等为测试隔离 home）；**绝不触碰 `~/.dsh`、`~/.superd`（DSH prod home）**——该红线由 **launcher 强制**（`test/start-4999.sh` 拒绝非 `.tests` home），**业务代码零守卫**（2026-09-22 转型：13 处 `assertNotProdHome` 已全数删除，教训见根 AGENTS §〇.0.c）。
- **agent-omp 的 OMP home 属 adapter 级自由**（2026-09-15 user 裁决保留）：`OMP_HOME` env 重定向仍是 adapter 的可选项（隔离微调），但**默认已改为原生 `~/.omp`**（2026-09-17 裁定，见 dev-rules §5）。
- **端口（2026-09-27 user 裁决：测试口无主化）**：499x 一族全是测试口，没有谁占用谁（4999 也是）；4999 有 Caddy `test.pc.internal.test` → 127.0.0.1:4999（WAN 可见，通道事实非特权），非 Caddy 口由 `test/start-4999.sh` 自动拉 socat LAN relay（只绑 LAN IP）；拉起前 `ss` 预检，占用者属测试 unit（`superd-*` / `*-test` / `*-relay`）脚本自动停掉接管，非测试监听才拒绝换口；**避开 3080/3081（prod），prod 3080 重启只凭 user 明确下令**；daemon 一律 `systemd-run --user`，关停 `systemctl --user stop`。当前 4999 在役 unit：`superd-4999-test`。
- **测试约定**：单元测试 `node --test test/*.test.mjs`（先 build 后 test，测试导入 `dist/`），隔离 home 用 `.tests/hub-test-home` 等，**绝不写进在役线 home**。**场景级验证只走整包**（`start-4999.sh` pack 线 + dev3 实装；2026-09-24 场景退役裁决、2026-09-27 重申——**不做 per-agent 场景测试，即使改动是 per-agent 的**，理由与已删 rig 清单见 `docs/07` §6.2）。
- **通用开发/测试规范**：唯一指引 = `docs/07-cordis-dsh-dev-test-guides.md`（两层文档制的第二层；本文件只放局部规则，不复制其内容）。client lane 已立（`superd-hub/tsconfig.client.json` + `agent-omp/tsconfig.client.json`，串进 build）；测试 rigs 速查见 `test/README.md`。

## 开发形态 = 交付形态（2026-09-22 转型，user 裁决）

- **单一交付物**：`super-dsh`（unscoped npm 包，better-dsh 模型）。全部组件内嵌为兄弟目录（`superd-hub/dist+lib`、`agent-*/dist`、`sidecar`、`bridge`、各子 `package.json` + `cordis.patch.yml`）；composite patch 行自指 subpath（`super-dsh/hub`、`super-dsh/agents/<label>`、`super-dsh/join`），**外加一条裸名行 `super-dsh` 承载 client half**（client-modules 只认裸包名 row；client bundle 的注册 id 必须 build 时烧成 `super-dsh`——见 `superd-hub/scripts/build-superd-client.mjs`）。adapter 对 hub 的 import 走相对路径 `'../../superd-hub/dist/index.js'`（repo 与内嵌布局同构）。
- **构建/打包唯一入口**：`node super-dsh/scripts/pack.mjs`（全组件 tsc + client halves + `npm pack` → `.scratch/superd-pack/`）。禁止手搓 dist 或 tarball。
- **4999 线 = 交付形态运行**：`test/start-4999.sh` = pack → tarball `corepack pnpm@10.33.2 add file:` 装进全新 profile（`dependencies: {super-dsh: file:<tarball>}`，manifest 与消费者 `dsh plugin add` 同形）→ repo build 的 dsh CLI（`upstream/.../apps/cli/lib/bin.js --profile superd-pub`）启动。**无手工 composition、无 @pgmi-builds 链接 farm、无库式 boot 脚本**（`smoke.mjs`/`plugin-acc-boot.mjs` 已退役删除）；worlds 由包内 `provisionWorldProfile` 自举。
- **锚与解析契约**：`SUPERD_DSH_ANCHOR` env 优先（repo 线 = checkout build 的 `apps/cli/package.json`，launcher 设置）；缺省从宿主 `@deepseek-ai/dsh-app-boot` 的 **realpath** 上溯到名为 `@deepseek-ai/dsh` 的包根（消费机安装形态两跳即中；0.1.3-d 实证）。world 树的 `@deepseek-ai` scope = 真目录逐包链接的并集（**安装树 scope ∪ 工作区枚举**——home farm 源料 2026-09-24 退役：user 删 prod `~/.dsh/profiles/node_modules` 实证无害，该层只是同一 install 树的冗余投影；历史根因 0.1.3-a/c 实证：显式 bare base 的 world 没有安装锚回退，ctx0 靠 app-boot 回退活着）。
- **验收（根 AGENTS §〇.0.a；0.1.5 native-ui-only 形态）**：本地 4999 形态冒烟（shell 200 + roster 7 agents + `/hub` 家族语义（无参 404 foreign-only / envelope 转发 / WS upgrade）+ 旧 `/<label>/` 全 404 + `world failed` 计数 0）→ **dev3 目标机实装**（tarball → restart → journalctl 计数 + 同组探针）→ 报告 → user 放行 → publish（版本纪律：字母迭代，见根 §〇.1.d）。**时代注记（2026-09-27 user 裁决）**：0.1.4 = multi-ctx-multi-webui 时代终态（hub ui 已剥、世界页整页路线）；0.1.5 起 = native-ui-only（`/hub` 唯一入口、世界纯数据面、Hub UI 唯一切换面；世界页/webui 行/旧 URL 路线已退役，git 历史可查）。**融合面的开关 = 行组合（2026-09-27 user 裁决）**：`superd-fusion-transport` 行被 compose 即开；要关就整行重述 `config: {enabled: false}` 或 `disabled: true`，或把该行从组合里移除——**不再有 env 旋钮**（env 派生的 release gate 是补丁层看不见的部署态，已删除）。
- **测试准备（2026-09-24 user 裁决，写死在 `test/start-4999.sh`，缺一不可）**：测试线必须「看到被测者看到的世界」。三条 = ① prod `.env` copy 进线 home（禁 API-key env 透传）② `SUPERD_TRUSTED_HOSTS` 喂世界 fence + page-trust 两腿 ③ 全部 env 显式设、不依赖继承。机制细节：`docs/07` §7；认证免重注入（seed 持久）见 `docs/07` §3.3。
- **page-trust 组件（2026-09-24，移植自 better-dsh `web-trust` authorities leg）**：`superd-hub/src/web-trust.ts`，ctx0 经 composite 行 `super-dsh/web-trust`、各世界经 worldMountPatches 行 `@pgmi-builds/superd-hub/web-trust`（世界页在自己的 root 上 emit `webserver/index-inject`，ctx0 一条行覆盖不到）。作用：operator 声明的非 loopback 页面 authority（Caddy 域 / LAN IP）上，页面在应用 bundle 物化前设 `window.__DSH_TRANSPORT__ = { ownsHost: true }` → connection client 的 `isLoopback` 判定为真，恢复 trusted authority 的 upstream 文档行为（否则 Host 设置持久化呈终端 `memory` 不可用）。开关两级：行级 `disabled: true`；config 级 `trustedPageAuthorities: []`（全惰性）。默认值从 `DSH_TRUSTED_HOSTS ?? SUPERD_TRUSTED_HOSTS` 派生（schema 级 default，穿透所有 overlay 层；显式配置恒胜）。
- ~~`test/start-{codex,claude,hermes,pi}-app.sh` = standalone legacy 线~~ **已删除**（2026-09-24 场景退役，见「测试约定」）；场景级测试唯一入口 = 4999 pack 线（+ dev3 目标机实装）。

## 世界行 / adapter 的卸载契约（2026-10-03 omp-sdk 验收踩到，两条都复发过）

world 插件（`agent-*/src/world-plugin.ts`，含 `world-join`）**不是**「挂上就完事」：plugin manager 的 `setPluginEnabled` 会把行写进 profile patch 并 **HMR 热卸/热挂**，所以卸载路径必须真的干净。两条硬规则：

1. **roster 条目必须 fiber-scoped**：`registerAgent()` 没有 disposer 就会留下裸 map 条目。`/api/agent-runtime` 的视图按 **host mount** 过滤（`agent-roster.ts` 的 `takeHostMount`），所以行卸掉后 UI 里**看不到**它，但 `registerAgent` 的重复 key 检查仍然会命中 —— 症状是**再次开启该行必然失败**：`roster: duplicate agent key <key>`（4997 实测复现）。正确写法：
   ```ts
   ctx.effect?.(() => {
     registerAgent({ key: KEY, label: LABEL, ready: false })
     return () => unregisterAgent(KEY)
   }, `agent-${KEY}: roster`)
   ```
2. **卸载必须 dispose world**：`spawnWorld()` 返回的世界 context 带 `fiber`，插件必须在自己被 dispose 时把它一起 dispose，否则世界（以及它里面 provider 持有的传输子进程：`omp --mode rpc` 子进程 / bun sidecar）会**越过自己的行继续活着**（实测：关掉 `omp-sdk` 行后 435 MB 的 sidecar 仍在跑）。正确写法：
   ```ts
   ctx.effect?.(() => () => { void ctxW.fiber?.dispose() }, `agent-${KEY}: world teardown`)
   ```
   （dispose world → dispose 其 provider → 释放各自 transport → 子进程随之回收。）

两条已同时落在 `agent-omp` 与 `agent-omp-sdk`（`agent-agy*`/`world-join` 尚未补，属同族遗留）。
