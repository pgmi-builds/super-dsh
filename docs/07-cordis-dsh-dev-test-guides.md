# Cordis / DSH 开发与测试指南（superd 移植版）

> **来源**：dashr 仓 [`Cordis-dsh-dev-test-guides.md`](/home/u1/workspaces/dashr/Cordis-dsh-dev-test-guides.md)（草案 v0，2026-09-24）。
> 本文件把其中**与本仓共用**的规范移植过来，并按 superd 现实（单 pack `super-dsh` = `superd-hub` + `agent-<runtime>`；测试 home `.tests/superd`；4999 交付形态线）改写落点。
> dashr 专有内容（better-dsh 插件、dashr distro、`.tests/test123`、供应链年龄门的具体 exclude 配置）不在此列——需要时去正本源读。
>
> **优先级**：user 指令 > 根 `AGENTS.md` §〇（发布与验收红线）> 本文件 > 各包/子目录 `AGENTS.md`。
> **状态**：2026-09-24 移植，同日**二轮修订**——按 0.1.7 实测重写 §5（进程内表 = 重定向+原生兜底而非白名单；HMR 连 `package.json` 都 watch，`plugin add`/`remove` **热生效**——移植初版照搬的「组合结构变化必须重启」**作废**，与 dashr 正本 `ec5d6c5` 同步）。标 ⚠ = 实测事实；标 ❗ = **本仓当前偏差**（见 §6）。

---

## 0. 范围与例外

**在范围内**：本仓 cordis 插件面（`superd-hub/` + `agent-<runtime>/`）的开发方式、依赖归属、组合（profile/world patch）能力、以及「真实用户视角」的本地测试流程。

**例外（另立守则）**：upstream harness 本体的本地 patch（属「改造 harness」）；`archive/` 存档线；dashr 仓的 distro 交付层。

---

## 1. 心智模型

### 1.1 一切皆 Cordis 插件行

运行的 DSH = 按层组合出来的 Cordis 插件树（bundles 列序 → profile patch → home patch → `--patch`）。**没有特权内核**：工具、模型、会话、沙箱、审批、UI 槽位全是插件行。

由此两条硬规则：

- **patch 行按 id 整行重述**，不是深合并——改一个字段也必须把该行所有字段写全（本仓先例：`world-provision` 里 webserver/hmr 的「零监听姿态」必须整行落进 profile 层，否则 hmr 重组合会把世界端口重新打开）。
- **插件顺序由 `inject` 依赖决定**，不是 YAML 位置（本仓先例：world 里 `modules` 行必须 inject 虚拟 `webServer`，否则 boot 顺序竞态）。

### 1.2 两个平面（先定平面，再写代码）

| 平面 | 装什么 | 判据 |
|---|---|---|
| **Host composition**（ctx0 / 世界 root） | 注册表（`tools`/`systemPrompt`/`agents`/`agent-loop`/`sessions`）、跨会话设施、沙箱与审批栈、模型路由、roster | **必须被共享** |
| **Agent preset** | 单个 session 贡献给上述注册表的东西：工具插件、persona/prompt 段、compaction 策略 | **一个 session 一份** |

**红线**：发布服务的行不能裸放在 preset 里——裸放 = 落进进程全局 realm，第二个 session 挂载即冲突（挂载直接拒绝）。preset 自己拥有的服务，必须把**提供者与所有消费者**包在同一个带 `isolate` realm 的 group 里。

### 1.3 供给三分桶（「我该 import 还是 inject」）

**唯一判据：运行期是谁提供这个东西。**

| 你要用的东西 | 机制 | 运行期谁提供 |
|---|---|---|
| **会被组合替换的服务实例**（`fs`/`llm`/`tools`/`sessions`/`settings`/`webServer`/`agentPresets`…） | **`inject`** + `ctx.get()` / `ctx.<svc>`；顶多 import **类型**做结构镜像 | 宿主组合 |
| **宿主 API 的库函数 / 类型 / 组件** | **`import`**（声明为 optional peer） | 宿主树 / 浏览器 module table |
| **你自带的真依赖** | **`import`**（写进 `dependencies`） | 你自己的包 |

`import` 语句永远必须在源码里；被 import 的模块不必在你的包里。

---

## 2. 开发期主线

### 2.1 host half

三层职责各自独立：**服务/事件层**（`inject` + `ctx.on(...)`）、**能力注册层**（`defineTool`、prompt section、slot——必须放对平面）、**配置面**（0.1.7 起 settings namespace = **Loader entry id**；用 volatile 字段 + `settings.configure({auto:false})`，不得再用已删除的 `installSection`/`settings.get`）。

### 2.2 client half

| 层 | 干什么 | 注意 |
|---|---|---|
| **纯逻辑层** | 状态机、几何/阈值判定 | 写成纯函数，脱离浏览器可单测（本仓 `agent-omp/src/mobile/{gesture,zoom-guard}.ts` 即此形态：`Function.prototype.toString` 嵌入 boot script ⇒ 单测源即发布源） |
| **UI 注入层** | `ctx.slots.inject(...)` + React 组件 | **只许寻址官方表面**（服务方法 / 语义 `data-*` / 官方控件）；第三方插件 DOM 永不作为状态输入 |
| **构建期外部化层** | `CLIENT_EXTERNALS` 名单（本仓 = `superd-hub/scripts/build-client.mjs`，另附 **purity gate**：`@deepseek-ai/*` 的值导入不在名单内即报错） | ⚠ 名单**不是 `declare`**，它只决定「内联还是留 `require`」；`import` 一行都不能少 |

**客户端运行期 = 浏览器 module table**：名单里的裸 `require(...)` 由 shell 的 platform seed 解析 ⇒ 插件拿到的 UI 原语**与宿主 UI 是同一个模块实例**——这就是「dsh native 组件」的准确含义，也是**绝不能自己 vendor 一份**的原因。

### 2.3 依赖解析与发布面（开发内容的一部分）

| 归属 | 消费者会不会装 | 本仓现状 |
|---|---|---|
| `dependencies` | **会** | `ws`/`js-yaml`/各 runtime SDK/`zod`/MCP SDK 等真依赖；**子包不作为 npm 依赖发布**——它们内嵌在主 pack 的 `files` 里 |
| `peerDependencies` + `optional:true` | 不会，期望宿主提供 | 全部 `@deepseek-ai/dsh-*`（range `>=0.1.5-0 <0.3.0-0`，user 裁决） |
| `devDependencies` | 不会 | 只为开发/构建期存在（tsc/tsdown/tsx/types） |

**两个必须同时成立的门**（否则「本地能过、线上静默坏」）：

1. **`tsconfig` 覆盖门**：client 半边被 `exclude` 就等于**完全没有类型检查**，必须有一条 client lane。❗ 本仓当前两条 lane 都缺，见 §6。
2. **版本同源门**：dev 期解析到的类型必须与**运行期提供者**同源（服务端 = 宿主/install 树；客户端 = shell 构建产物）。⚠ 只要 dev 期解析到 registry 旧版本，类型检查就给假绿灯。

> ⚠ **预发布 tuple 坑**（正本实测）：`>=0.1.5-0 <0.3.0-0` 这类 npm-range optional peer 在 **pnpm 解析**时**不匹配** `0.1.7-rc.1`（0.1.7 的 tuple 没有预发布比较器），auto-install 会落到 `0.1.5-rc.3`。
> **与本仓的关系**：本仓该 range 只用于 **0.1.7 插件兼容门**的 `semver.satisfies(..., {includePrerelease:true})`（判 row/bundle 是否启用），**不是**用来解析安装版本的；harness 依赖由编译 farm（`super-dsh/node_modules/@deepseek-ai/*`，`scripts/sync-dsh-farm.mjs`）+ 运行期宿主树提供。因此**永远不要在子包里 `npm install @deepseek-ai/*`**（会物化物理副本 → 双模块实例 → `dsh-scope` `kScope` 分裂）。

---

## 3. 测试环境规范

### 3.1 端口

- 默认约定端口 **4999**（本线共用测试口，Caddy `test.pc.internal.test`）。
- ⚠ **候选端口表不能写死，归属也不能假定**：4999 是**整机共享**的（2026-09-24 起其他 agent 也在用；同日实测 `4990`/`4997`/`4999` 均在监听）。起线前必须**动态探测**：端口已被占用即拒绝启动（本仓 = `test/start-4999.sh` 的 `ss -tln` 预检；换端口 = 改脚本头部 `PORT`）。
- ⚠ webserver 只接受 `127.0.0.1` / `0.0.0.0` 两个字面量，且**启动时硬拒 `0.0.0.0`**（RCE 门）。LAN 直连只能加**用户态中继**（只绑 LAN IP 转发 loopback；本仓/仓根 AGENTS §三·端口纪律）。

### 3.2 目录布局：**种子**与**运行数据**必须分开

| 角色 | 内容 | 是否入库 | 本仓落点 |
|---|---|---|---|
| **种子 / 配置模板** | profile 的 `package.json`、`cordis.patch.yml`、启动脚本、复现步骤 | **入库**（可重生成） | `super-dsh/test/start-4999.sh`（幂等：每次重新生成 profile 与 `@pgmi-builds` links） |
| **运行 home** | `sessions/`、`storages/`、`snapshots/`、`profiles/*/node_modules`、`agents/*` | **gitignored** | `.tests/superd/`（根 `.gitignore` 覆盖 `.tests/`） |

好处：重置 profile 不动 user data；克隆仓库即得可复现种子。

**ground 0 对照（prod ↔ 测试；2026-09-24 user 澄清）**：prod 的物理 `@deepseek-ai/*` 节点在**全局安装**（`~/.local`）；**逻辑包树 ground 0 = `~/.dsh/profiles/<name>`**——dsh web app 入口从此解析，指向全局树的 symlink 与逐 profile / post-install 插件的**物理文件**都在这一层。测试与此同构：**repo checkout build 扮「全局」**（= installation anchor），`<test-home>/profiles/<name>`（如 `superd-pub`）= ground 0——整包 tarball **物理**装在这里（`dsh plugin add` 同形），harness 导入经 launcher 进程内表重定向到 anchor（§5.3）；世界树由 `provisionWorldProfile` 按生产形状自备。**测试代码不再自带 farm 投影 / `@pgmi-builds` 链接物流**——那套 per-agent 场景 rig 已于 2026-09-24 场景退役整体删除，场景级验证只走整包 pack 线。

### 3.3 持久化与格式兼容性

- 会话数据默认持久化在 `$DSH_HOME/sessions/`。长寿命 home 的价值 = **持续验证旧 session log 对未来版本可读**。
- ⚠ 长寿命 home 与「干净可复现」互相污染（迁移产物、历史 storages 残留）。**规范：两个 home 配对使用**——`home/compat/` 长期保留专测格式兼容；`home/clean/` 每次可弃专测干净启动。
- 每个 rig 的 README 记录它当前承载的 **session schema 版本**与最近一次兼容验证日期。
- 本仓格式教训（v4 session：system head 必须在开启的 turn+step 内且是 surface 首节点，见对齐报告 §九）在 `superd-hub/test/system-head*` 有 v4-reader 镜像校验器兜底。

---

## 4. 本地测试流程（真实用户视角）

**目标**：测试实例尽可能像真实用户部署——装的是**发布产物**，不是源码符号链接。本仓 4999 线已满足：`pack.mjs` → tarball → `corepack pnpm@10.33.2 add file:` → 启动（见 `super-dsh/AGENTS.md`「开发形态 = 交付形态」）。

### 4.3 命令语义（⚠ 正本源码实测事实）

- **`dsh plugin --profile <name> <args…>` 是 pnpm 的参数透传**：只有 `allow-version` / `revoke-version` / `version-exemptions` 由 DSH 自己处理，其余原样交给 pnpm。
- **tarball / 本地路径是一等支持**，不是 hack：相对路径 spec 会**锚到调用者 cwd**（`anchorPathSpec()`），不是 profile 目录。
- **子命令是 `remove`，不是 `delete`**（pnpm 无 `delete`；别名 `rm` / `uninstall`）。
- **卸载/安装会自动维护 `dsh.profile.bundles`**：任何一次成功的 pnpm run 之后 `reconcile()` 会摘掉不在 `dependencies` 里的名字、补上新装的 bundle——**不需要手工编辑 bundles**。
- **安装失败会回滚** `package.json` + `pnpm-lock.yaml` 并打印 `dsh: installation rejected` ⇒ 「试装」安全。
- ⚠ **热生效有时延**：`add` / `remove` 后的刷新链（chokidar 写入稳定 → `loadProfileDirectory` 全量重载 → `reconcileProfilePatches` 异步 import/dispose）实测 **≈5–15s**——窗口期内 graph「还在/已不在」都是假象，勿据此下结论（测量纪律见 §5.2.6）。
- ❓ 待验证：本地 tarball 是否触发 profile 的**供应链年龄门**（registry 安装有 ≈24h 门；本地 tarball 预期不触发）。pnpm 侧记录：版本号形式的 exclude 只作用于解析相位，**裸包名**才全相位生效（dashr 正本 A5–A7 实证）。

---

## 5. 热插拔规范（Comply or Explain）

### 5.1 五类「热插拔」不是一回事（⚠ 0.1.7 实测边界，2026-09-24 二轮修订）

| 变更对象 | 现状 | 生效方式 |
|---|---|---|
| **profile 配置**（`cordis.patch.yml` / 行 config） | **默认开**（base bundle 的 `hmr` 行：`disabled: !!js "!ctx.get('profileContext')"`；`watch-config.ts` 精确监听 patch 文件） | **改文件即热生效**（秒级） |
| **profile 依赖面**（`package.json` manifest、`plugin add`/`remove` 装卸的包、增删 bundle 行） | **支持**——HMR entry 层同时监听 patch 文件**与 `package.json`**（`hmr/src/index.ts:235-236`），manifest 变化 → `refresh(true)` 全量重组（重读 include → `loader.root.update(entries)` → 新行 import+apply、删行 dispose） | **热生效，≈5–15s**（实测：`add` tarball ≈5s、`remove` ≈15s、YAML 加/去 disable 行 6–8s，daemon 零重启） |
| **插件 host 代码**（`node_modules` 内的 `dist/*.js`） | **不热**：module 层（`partialReload`，`hmr/src/index.ts:406-580`）只换**已加载过**的模块，且 watcher 默认 ignore `**/node_modules`（`index.ts:93`）、analyze 也跳过 `/node_modules/`；`root: []` 默认不 watch 任何模块根 | 重启；dev 免重启的缝见 §5.4（symlink 真实源路径 + `hmr.config.root` 覆盖） |
| **插件 client bundle** | **支持**：宿主按 artifact rev 提供 bundle | 重建产物后**刷新页面即生效，无需重启 daemon** |
| **installation-scope 解析表变更**（改由 installation 提供 / 改版本 / 删 local 覆盖 / linkedRoot 改指） | **冻结**：`ResolutionRouter.replace()` 对已存在条目的任何此类变化一律 `throw … requires a process restart`（`resolver.ts:380-405`）；生产运行路径**不调用** `replace()`（全仓唯一运行时调用点 = `--dump-config` 独立进程） | 重启 |

### 5.2 条文

1. **默认要求**：插件的**行为改动**应能通过「client bundle 重建 + 刷新」「配置热重载」或「`plugin add`/`remove` 热装卸」验证，**不重启实例**。
2. **Comply or Explain**：做不到 1 的，必须在插件 README 或报告里给出**具体原因**（「开发不到位」是默认结论）。
3. **允许重启的情形**：涉及 boot / loader；`node_modules` 内**代码替换**；installation-scope 表变更。⚠ 增删 bundle、插件首次安装/卸载**不再属于此列**（2026-09-24 实测热生效——移植初版与 dashr 正本旧稿的「组合结构变化必须重启」作废）。
4. **允许重启 ≠ 允许停实例**：卸载走 `dsh plugin remove`，**不得**用「把 4999 停掉」代替清理。⚠ 4999 是整机共享端口——**他人/其他 agent 在用时不碰**。
5. 重启后必须**复验**：端口、boot graph（`--dump-config` 看行真挂上）、以及认证/挂载探针（不是「进程活着」就算数）。
6. **测量纪律（2026-09-24 新增，先例即本轮）**：热插拔结论必须在刷新链窗口（**≥15s**）之后下，且先用**每请求信号**（如 web-trust 注入脚本的在场性）证明「boot graph 是活树渲染、非 boot 快照/缓存」再读数——remove 后 2s 看到 graph 仍在，曾被误判为「artifact 缓存假在场」，实为刷新前窗口期。

### 5.3 进程内解析模型（0.1.7 实测语义——修正「白名单」误解）

**表 = 重定向表 + 原生兜底，不是白名单。** 启动时 `composeProfile()` 调一次 `createRuntimeResolution({installAnchor, profile})`（`profile-boot.ts:204`），`PluginPackages` 构造时把它装成 Node 补丁（`service.ts:68`，同时补 ESM resolver 与 CJS `Module._resolveFilename`）。表内容 = installation scope（从 install anchor 的 package.json BFS 依赖图，含 peer）+ profile scope（profile `node_modules` 实际在装的直接依赖）+ linkedRoots；**拦的是「谁在 import」**——`findInterceptionLayer` 只对 importer 位于 profile 树 / active profile / linked root 之下的请求生效，installation 自身代码走 native。

`routeScoped()` 三分支（`resolver.ts:468-513`）：

1. profile `node_modules` **物理存在**同名包 → `native` 用磁盘那个（`statSync` **每请求查盘** ⇒ 即装即解析）；
2. 表里有 installation-scope 条目 → `interception` 重定向到 install tree 的包；
3. 都没有 → `native-after-interception`，从 profile 位置走 Node 原生祖先链。

推论：表里没有的名字**不会**被拦（落原生兜底）；运行时装进 profile `node_modules` 的新包**无需重启**即可解析（前提 YAML 有行引用它）；想让包改由 **installation** 携带 → 只能重启（installation scope 进程内冻结，见 §5.1 末行）。

### 5.4 对 super-dsh 的直接含义

- **ctx0**（launcher 起，吃拦截表）：`@pgmi-builds/*` 必须启动前就进 profile scope（profile `dependencies`/bundles → pnpm 装）或在 profile `node_modules` 物理在场。
- **六个 world**（`spawnWorld` 进程内 `boot()`，**不经 launcher → 没有表**）：裸 URL 解析 ⇒ 世界树必须自带 farm（`provisionWorldProfile` 的 `@pgmi-builds` links + `@deepseek-ai` scope 并集；scope sources = **安装树 scope ∪ 工作区枚举**——home farm 源料 2026-09-24 退役，user 删 prod `~/.dsh/profiles/node_modules` 实证无害）——这就是台账「测试走 `boot()` 直调须自己投影 resolution entries」的根因。
- **改 adapter 源码 → 世界页要重启才生效**。dev 免重启的两条路：① YAML 加/改行（entry 层，零重启）；② 让插件以**非 node_modules 路径**被加载——Node ESM 默认 realpath，symlink 进 `node_modules` 但真实文件在仓内的包，其模块 URL **不带** `/node_modules/`，若落入 `hmr.config.root` 监视范围（roots 按 profile dir 相对解析）即可真热替换（可实测验证）。
- **「文件即 composition」与 HMR 一致**：配置刷新 = 重读 include 文件再 `update()`，所以把 spawn 期事实（如 world 零监听姿态）**持久化进 profile 层文件**后，refresh 重算出的树与启动时一致——这正是 `world-provision` 把零监听 posture 写进 `cordis.patch.yml` 的机制原因。

---

## 6. 本仓 adoption 状态（实测，2026-09-24）

**已符合**：交付形态测试（tarball 而非 symlink farm）；端口动态预检 + 外来占用拒绝；**产物面启动**（repo build 的 `apps/cli/lib/bin.js` + 裸 node；禁止 tsx 源码启动——双平面 symbol split，仓根 AGENTS §三有根因）；种子/运行 home 分离；LAN 只走用户态中继；daemon 一律 `systemd-run --user`（沙箱内直拉 = `SANDBOX_UNAVAILABLE`）；**client lane**（hub + omp 各一条，串进 build——见下）；**compat/clean 双 rig**（`super-dsh/test/README.md`）；**场景级测试唯一入口 = 整包 pack 线**（2026-09-24 user 裁决「场景退役」：per-agent 场景 rig 全删——world-plugin 集成测试 ×2、standalone app 线 ×5、verify/live/spike/smoke/probe、omp 真 sidecar spawn 测试、standalone bootstrap 脚本；adapter 侧只留单元测试）。

**修复记录（2026-09-24 reform 轮，user 指令 "reform the repo to align the guidelines"；原两条 ❗ 偏差关闭）**：

1. **client lane 已立**：`superd-hub/tsconfig.client.json`（`lib: DOM` + `jsx: react-jsx` + noEmit；devDep `@types/react@18.3.31` **exact**，与 shell 的 react ^18.2 同主版本——版本同源门）+ `agent-omp/tsconfig.client.json`（`lib: DOM`）。接线：hub `build-client` = `typecheck:client && build-client.mjs`；omp `build` = host tsc + client tsc（`pack.mjs` 路径全覆盖）。lane 揪出的 3 处一并修掉：hub `'./RuntimeSeat.tsx'` → `.js`（TS5097）、omp `'../gesture.ts'` → `.js`、`MobilePageConfig.enabled` 改**可选**（`resolveMobileConfig` 本就按 `!== true` 判定、缺省即未启用——类型对齐运行时语义）。**产物字节级零 diff**（md5 复核 `lib/client` + `dist`），无交付影响；omp 49+1skip、hub 106/106 全绿。
2. **clean rig 已立**：`start-4999.sh` 参数化（`SUPERD_PORT` / `SUPERD_HOME_DIR` / `SUPERD_PROFILE`；默认值 = 原 compat 行为逐字节不变，unit/log/profile patch 端口/trusted-hosts 端口形 entry 全部派生；`bash -n` + 参数化点复核）。rig 说明 + session schema 版本（v4）+ 最近兼容验证日期见 `super-dsh/test/README.md`。

---

## 附录 A：本仓事实锚点

- 组合/patches：`super-dsh/cordis.patch.yml`（ctx0 复合）、`super-dsh/agent-*/cordis.patch.yml`（standalone 面）、`superd-hub/src/world-mount.ts`（world 挂载 patch 层）
- client 外部化 + purity gate：`superd-hub/scripts/build-client.mjs`
- world 自举与 home 布局：`superd-hub/src/world-provision.ts`
- 启动/交付：`super-dsh/test/start-4999.sh`、`super-dsh/scripts/pack.mjs`
- 上游对齐程序与破面台账：根 `AGENTS.md` §二；报告 `docs/test-reports/`

## 附录 B：正本指针（dashr 仓）

- 规范正本：`/home/u1/workspaces/dashr/Cordis-dsh-dev-test-guides.md`
- 仓契约与 prod 拓扑：`/home/u1/workspaces/dashr/AGENTS.md`
