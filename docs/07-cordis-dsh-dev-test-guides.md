# 通用测试指引（Cordis / DSH 插件开发与测试）

> 本仓**唯一**的一站式 dev/test 指引。文档层级收敛为两层（2026-09-27 user 裁决）：**根 `AGENTS.md`** = 总纲与红线；**本文件** = 全部机制细节。各子目录 `AGENTS.md` 只放局部规则与指针，不另立规范、不复制本文件内容。
> 本仓与姊妹插件仓（如 dashr）是各自演化的 Dash 插件开发 repo，手法相似、互不隶属——本文件不指向任何外部「正本」。
> **优先级**：user 指令 > 根 `AGENTS.md` §〇（发布与验收红线）> 本文件 > 各子目录 `AGENTS.md`。
> **状态**：2026-09-27 大改版，user 四裁决落地：① 测试口无主化；② test home 复用不换场；③ seed 持久 ⇒ cookie 免重注入；④ per-agent 场景测试退役永续。标 ⚠ = 实测事实（upstream 源码或本机实证）。

---

## 0. 范围与例外

**在范围内**：本仓 cordis 插件面（`superd-hub/` + `agent-<runtime>/`）的开发方式、依赖归属、组合（profile/world patch）能力、本地与目标机测试流程。

**例外（另立守则）**：upstream harness 本体的本地 patch（属「改造 harness」）；`archive/` 存档线（冻结，不随本文件演化）。

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

1. **`tsconfig` 覆盖门**：client 半边被 `exclude` 就等于**完全没有类型检查**，必须有一条 client lane。⚠ 本仓已立（2026-09-24 reform 轮）：`superd-hub/tsconfig.client.json` + `agent-omp/tsconfig.client.json`，各自串进 build 脚本。
2. **版本同源门**：dev 期解析到的类型必须与**运行期提供者**同源（服务端 = 宿主/install 树；客户端 = shell 构建产物）。⚠ 只要 dev 期解析到 registry 旧版本，类型检查就给假绿灯。

> ⚠ **预发布 tuple 坑**（实测）：`>=0.1.5-0 <0.3.0-0` 这类 npm-range optional peer 在 **pnpm 解析**时**不匹配** `0.1.7-rc.1`（0.1.7 的 tuple 没有预发布比较器），auto-install 会落到 `0.1.5-rc.3`。
> **与本仓的关系**：本仓该 range 只用于 **0.1.7 插件兼容门**的 `semver.satisfies(..., {includePrerelease:true})`（判 row/bundle 是否启用），**不是**用来解析安装版本的；harness 依赖由编译 farm（`super-dsh/node_modules/@deepseek-ai/*`，`scripts/sync-dsh-farm.mjs`）+ 运行期宿主树提供。因此**永远不要在子包里 `npm install @deepseek-ai/*`**（会物化物理副本 → 双模块实例 → `dsh-scope` `kScope` 分裂）。

---

## 3. 测试环境规范

### 3.1 端口：测试口无主化（2026-09-27 user 裁决）

- 499x 一族**全是测试口，没有谁占用谁（4999 也一样）**。起线前 `ss -tln` 动态探测。
- 端口被占时的处置：经 `/proc/<listener-pid>/cgroup` 找到归属 user unit——属于**测试基建**（unit 名 `superd-*` / `*-test` / `*-relay`）→ 直接停掉接管；**非测试监听**（prod 3080/3081、未知进程）→ 拒绝并换口。`super-dsh/test/start-4999.sh` 已内置此逻辑。
- 4999 = Caddy `test.pc.internal.test`（wan 可见）是**通道事实**，不是占用特权；非 Caddy 端口由脚本自动拉 **socat LAN relay**（unit `superd-lan-<port>-relay`，只绑 LAN IP、绝不 0.0.0.0）。
- ⚠ webserver 只接受 `127.0.0.1` / `0.0.0.0` 字面量且**启动硬拒 `0.0.0.0`**（RCE 门）——LAN 直连只能走用户态中继，勿用 config `host: 0.0.0.0` 当 LAN 手段。
- **永不触碰 3080（Dash Agent prod）/ 3081（omp-web prod）**；prod 3080 的重启只凭 user 明确下令。

### 3.2 test home：复用，不换场（2026-09-27 user 裁决）

- 一个测试线一个**长寿命 home**（本仓整包线 = `<repo>/.tests/superd`；dev/test 一律 `DSH_HOME=<repo>/.tests/...`）。**测试现场不换 home、不重置 user data**。
- **隔离单位 = profile**：`<home>/profiles/<name>/` 自带 `package.json` + `node_modules`（tarball 物理安装）——被测插件的代码与依赖树和 home 其余部分天然隔离。换被测版本 = 重建 profile（launcher 每次 `rm -rf` 只动 profile 目录，这是安装新 tarball 的手段，不是清场）。
- **user data 是测试资产**：`sessions/`、`storages/`、`.credentials.yaml`、`agents/<label>/` 全部跨重置保留。已创建的会话记录直接拿来测（list / replay / resume / 跨版本读取兼容），不需要从零造数据。
- 全新 home 只在**专门验证首次行为**（first boot / world provision / 首会话）时经 `SUPERD_HOME_DIR=<path>` 临时指一个，用完即删——非常设配对要求（旧「compat/clean 双 home 常备制」废止）。
- **绝不触碰 `~/.dsh`、`~/.superd`（prod home）**。该红线由 **launcher 强制**（`test/start-4999.sh` 拒绝 `.tests` 之外的 home），业务代码零守卫。
- **ground 0 对照（prod ↔ 测试）**：prod 的物理 `@deepseek-ai/*` 节点在全局安装（`~/.local`）；逻辑包树 ground 0 = `~/.dsh/profiles/<name>`——dsh web app 入口从此解析。测试与此同构：**repo checkout build 扮「全局」**（= installation anchor），`<test-home>/profiles/<name>`（如 `superd-pub`）= ground 0——整包 tarball **物理**装在这里（`dsh plugin add` 同形），harness 导入经 launcher 进程内表重定向到 anchor（§5.3）；世界树由 `provisionWorldProfile` 按生产形状自备。测试代码不自带 farm 投影。

### 3.3 认证：seed 持久 + cookie 30 天，不搞 token 仪式（2026-09-27 user 裁决）

机制（⚠ upstream 实证：`packages/client/connection/src/browser-auth.ts` + `packages/credentials/credentials-local`）：

- 浏览器会话认证的**签名 secret（seed，32B）** = credentials 文档里 `client-connection/browser-session` 记录的 `payload.secret`，owner-only 600。**2026-10-04 user 裁决：seed 不再是「每 home 一份」，而是全机测试线共用一份**——`/home/u1/workspaces/.dsh-test-credentials.yaml`（可用 `DSH_TEST_CREDENTIALS` 覆盖）。原因：cookie 名与签名只取决于 **authority + seed**，而 499x 端口无主、任何 rig 都可能接管 4999；每 home 一份 seed 意味着每次换 rig 接管，用户手里那个 `test.pc.internal.test` 的 cookie 就被另一个 secret 判为无效，得重走 token。启动脚本做法：给 upstream 的 `credentials` 行（`@deepseek-ai/dsh-credentials-local`，schema 有 `path`）套一行 profile patch 指到共用文件；该文件不存在时先由本 home 自己的旧文档播种（所以采纳这个约定**不会**让用户已持有的 cookie 失效）。**跨仓纪律**：姊妹仓的 launcher 指同一个 path 即自动同源（dashr `.test/home` 与本仓 `.tests/superd` 本就是同一个 secret）。
- 浏览器 cookie = `v1.<payload>.<HMAC-SHA256(seed, payload)>`，payload 含 `{authority, issuedAt, expiresAt}`；有效期 = `connection.cookieMaxAgeDays`（schema 默认 **30 天**）；cookie 名绑定 authority（Host 头）——同一 seed 下，不同访问 authority（Caddy 域名 vs `LAN-IP:port`）各铸各的 cookie；反过来，同名同 authority 的 cookie 只要 seed 相同就到处都认（这正是共用 seed 的依据）。
- URL 里的 `?token=<launch token>` 是 **per-boot 进程内随机值**（`PROCESS_LAUNCH_TOKENS`，WeakMap），唯一职责 = 首次访问时铸 cookie。

**纪律**：

1. **重启测试线、换 rig 接管同一端口，都不需要换 token、不需要重注 cookie**——旧 cookie 只要还在 30 天窗口内、authority 没变、共用 seed 文件没被删，就直接过认证。`start-4999.sh` 在共用 seed 已存在时明说这一点（并打印它的路径），token URL 只标注为「首登 / 新 client 用」。⚠ 实测（2026-10-04）：同一个 cookie、同一个 home，只把 seed 源从共用文件换回该 home 自己的 `.credentials.yaml`（secret 不同）→ **401**；换回共用文件 → **200**。
2. 需要重新走 token 的只有三种情况：**共用 seed 文件**被删/换（重生成）、换了访问 authority、cookie 过 30 天窗口。换被测版本、重启 daemon、重建 profile、删掉某个 home **都不影响**。
3. 换被测版本、重启 daemon、重建 profile **都不影响** seed 与既有 cookie。

### 3.4 种子（入库、可重生成）与运行 home（gitignored）分离

| 角色 | 内容 | 是否入库 | 本仓落点 |
|---|---|---|---|
| **种子 / 配置模板** | profile 的 `package.json`、`cordis.patch.yml`、启动脚本、复现步骤 | **入库**（幂等可重生成） | `super-dsh/test/start-4999.sh`（每次重建 profile 并装 tarball） |
| **运行 home** | `sessions/`、`storages/`、`snapshots/`、`profiles/*/node_modules`、`agents/*`、`.credentials.yaml` | **gitignored** | `.tests/superd/`（根 `.gitignore` 覆盖 `.tests/`） |

好处：重置 profile 不动 user data；克隆仓库即得可复现种子。会话 schema 版本（现役 **v4**）与 v4-reader 兜底校验器见 `superd-hub/test/system-head*`。

---

## 4. 本地测试流程（真实用户视角）

**目标**：测试实例尽可能像真实用户部署——装的是**发布产物**，不是源码符号链接。本仓整包线已满足：`pack.mjs` → tarball → `corepack pnpm@10.33.2 add file:` → 启动（见 §6 与 `super-dsh/AGENTS.md`「开发形态 = 交付形态」）。

### 4.1 命令语义（⚠ upstream 源码实测事实）

- **`dsh plugin --profile <name> <args…>` 是 pnpm 的参数透传**：只有 `allow-version` / `revoke-version` / `version-exemptions` 由 DSH 自己处理，其余原样交给 pnpm。
- **tarball / 本地路径是一等支持**，不是 hack：相对路径 spec 会**锚到调用者 cwd**（`anchorPathSpec()`），不是 profile 目录。
- **子命令是 `remove`，不是 `delete`**（pnpm 无 `delete`；别名 `rm` / `uninstall`）。
- **卸载/安装会自动维护 `dsh.profile.bundles`**：任何一次成功的 pnpm run 之后 `reconcile()` 会摘掉不在 `dependencies` 里的名字、补上新装的 bundle——**不需要手工编辑 bundles**。
- **安装失败会回滚** `package.json` + `pnpm-lock.yaml` 并打印 `dsh: installation rejected` ⇒ 「试装」安全。
- ⚠ **热生效有时延**：`add` / `remove` 后的刷新链（chokidar 写入稳定 → `loadProfileDirectory` 全量重载 → `reconcileProfilePatches` 异步 import/dispose）实测 **≈5–15s**——窗口期内 graph「还在/已不在」都是假象，勿据此下结论（测量纪律见 §5.2.6）。

---

## 5. 热插拔规范（Comply or Explain）

### 5.1 五类「热插拔」不是一回事（⚠ 0.1.7 实测边界，2026-09-24 二轮修订）

| 变更对象 | 现状 | 生效方式 |
|---|---|---|
| **profile 配置**（`cordis.patch.yml` / 行 config） | **默认开**（base bundle 的 `hmr` 行：`disabled: !!js "!ctx.get('profileContext')"`；`watch-config.ts` 精确监听 patch 文件） | **改文件即热生效**（秒级） |
| **profile 依赖面**（`package.json` manifest、`plugin add`/`remove` 装卸的包、增删 bundle 行） | **支持**——HMR entry 层同时监听 patch 文件**与 `package.json`**（`hmr/src/index.ts:235-236`），manifest 变化 → `refresh(true)` 全量重组 | **热生效，≈5–15s**（实测：`add` tarball ≈5s、`remove` ≈15s、YAML 加/去 disable 行 6–8s，daemon 零重启） |
| **插件 host 代码**（`node_modules` 内的 `dist/*.js`） | **不热**：module 层（`partialReload`，`hmr/src/index.ts:406-580`）只换**已加载过**的模块，且 watcher 默认 ignore `**/node_modules`（`index.ts:93`）、analyze 也跳过 `/node_modules/`；`root: []` 默认不 watch 任何模块根 | 重启；dev 免重启的缝见 §5.4 |
| **插件 client bundle** | **支持**：宿主按 artifact rev 提供 bundle | 重建产物后**刷新页面即生效，无需重启 daemon** |
| **installation-scope 解析表变更** | **冻结**：`ResolutionRouter.replace()` 对已存在条目的任何此类变化一律 `throw … requires a process restart`（`resolver.ts:380-405`） | 重启 |

### 5.2 条文

1. **默认要求**：插件的**行为改动**应能通过「client bundle 重建 + 刷新」「配置热重载」或「`plugin add`/`remove` 热装卸」验证，**不重启实例**。
2. **Comply or Explain**：做不到 1 的，必须在插件 README 或报告里给出**具体原因**（「开发不到位」是默认结论）。
3. **允许重启的情形**：涉及 boot / loader；`node_modules` 内**代码替换**；installation-scope 表变更。⚠ 增删 bundle、插件首次安装/卸载**不属于此列**（2026-09-24 实测热生效）。
4. **允许重启 ≠ 允许停 prod**：测试 unit 之间的端口接管按 §3.1 无主化规则由脚本处理；**prod 3080/3081 永不碰**，prod 3080 的重启只凭 user 明确下令。
5. 重启后必须**复验**：端口、boot graph（`--dump-config` 看行真挂上）、以及认证/挂载探针（不是「进程活着」就算数）。
6. **测量纪律**：热插拔结论必须在刷新链窗口（**≥15s**）之后下，且先用**每请求信号**（如 web-trust 注入脚本的在场性）证明「boot graph 是活树渲染、非 boot 快照/缓存」再读数——remove 后 2s 看到 graph 仍在，曾被误判为「artifact 缓存假在场」，实为刷新前窗口期。

### 5.3 进程内解析模型（0.1.7 实测语义）

**表 = 重定向表 + 原生兜底，不是白名单。** 启动时 `composeProfile()` 调一次 `createRuntimeResolution({installAnchor, profile})`（`profile-boot.ts:204`），`PluginPackages` 构造时把它装成 Node 补丁（`service.ts:68`，同时补 ESM resolver 与 CJS `Module._resolveFilename`）。表内容 = installation scope（从 install anchor 的 package.json BFS 依赖图，含 peer）+ profile scope（profile `node_modules` 实际在装的直接依赖）+ linkedRoots；**拦的是「谁在 import」**——`findInterceptionLayer` 只对 importer 位于 profile 树 / active profile / linked root 之下的请求生效，installation 自身代码走 native。

`routeScoped()` 三分支（`resolver.ts:468-513`）：

1. profile `node_modules` **物理存在**同名包 → `native` 用磁盘那个（`statSync` **每请求查盘** ⇒ 即装即解析）；
2. 表里有 installation-scope 条目 → `interception` 重定向到 install tree 的包；
3. 都没有 → `native-after-interception`，从 profile 位置走 Node 原生祖先链。

推论：表里没有的名字**不会**被拦（落原生兜底）；运行时装进 profile `node_modules` 的新包**无需重启**即可解析（前提 YAML 有行引用它）；想让包改由 **installation** 携带 → 只能重启（installation scope 进程内冻结，见 §5.1 末行）。

### 5.4 对 super-dsh 的直接含义

- **ctx0**（launcher 起，吃拦截表）：`@pgmi-builds/*` 必须启动前就进 profile scope（profile `dependencies`/bundles → pnpm 装）或在 profile `node_modules` 物理在场。
- **世界**（`spawnWorld` 进程内 `boot()`，**不经 launcher → 没有表**）：裸 URL 解析 ⇒ 世界树必须自带 farm（`provisionWorldProfile` 的 `@pgmi-builds` links + `@deepseek-ai` scope 并集；scope sources = **安装树 scope ∪ 工作区枚举**，且每次运行自清 stale links）。
- **改 adapter 源码 → 世界页要重启才生效**。dev 免重启的两条路：① YAML 加/改行（entry 层，零重启）；② 让插件以**非 node_modules 路径**被加载——symlink 进 `node_modules` 但真实文件在仓内的包，其模块 URL 不带 `/node_modules/`，若落入 `hmr.config.root` 监视范围即可真热替换。
- **「文件即 composition」与 HMR 一致**：配置刷新 = 重读 include 文件再 `update()`，把 spawn 期事实持久化进 profile 层文件后，refresh 重算出的树与启动时一致（`world-provision` 零监听 posture 写进 `cordis.patch.yml` 的机制原因）。

---

## 6. 验收层级与「per-agent 测试退役」

### 6.1 三层验收

1. **单元测试**（adapter / hub 侧唯一存留形态）：`node --test test/*.test.mjs`，测试导入 `dist/` → **先 build 后 test**；只测 fakes / 映射 / 事件转译 / lazy 不变量；**fake 不作行为验收证据**。
2. **整包 pack 线冒烟**（场景级验证**唯一入口**）：`bash super-dsh/test/start-4999.sh`（pack → tarball → 消费者同形 profile → repo build CLI 启动）。冒烟基线：shell 200 + roster 全量 + `/hub` 家族语义 + `world failed` 计数 0。
3. **dev3 目标机实装**（根 AGENTS §〇.0.a）：tarball → restart → journalctl 计数 + 同组探针 → 报告落 `docs/test-reports/` → user 放行 → 才谈 publish。

### 6.2 per-agent 场景测试：退役且不回潮（2026-09-24 裁决，2026-09-27 重申）

- **不做 per-agent（单 adapter）的场景测试——即使本次改动是 per-agent 的**。行为级验证一律把**整个 superd app** 拉起来测（整包线 + dev3）。
- **理由**：单 adapter 场景测试要求把它变成**独立 Dash 插件形态**——自有 test rig、patch、yaml 全套重写——而交付物是整包；这笔投入与交付形态不符，毫无意义。
- 已删除、不得回潮的 rig 清单：per-agent standalone app 启动线（`start-{codex,claude,hermes,pi}-app.sh`、`start-world-4998.sh`）、world-plugin 集成测试 ×2、verify/live/spike/smoke/probe 脚本、真 sidecar spawn 测试、standalone bootstrap 脚本、配套一次性 home（`.tests/plugin-acc2` 等已物理删除）。

### 6.3 整包线现状基线（2026-09-27）

交付形态运行（无手工 composition / 无链接 farm / 无库式 boot）；端口无主化 + 测试 unit 接管（§3.1）；长寿命 home 复用 + user data 保留（§3.2）；seed-cookie 免重注入（§3.3）；client lane 两条已立（§2.3）；产物面启动（repo build `apps/cli/lib/bin.js` + 裸 node；禁 tsx 源码启动——双平面 symbol split）。

---

## 7. 整包线的测试准备（写死在 `test/start-4999.sh`，缺一不可）

> 2026-09-24 user 裁决：测试线必须「看到被测者看到的世界」，否则测的是别的东西。三条：

1. **provider keys**：把 prod home 的 `~/.dsh/.env` **copy 进线 home**（`$DSH_HOME/.env`；launcher 的 env 分层 = 继承 env > 调用目录 `.env` > home `.env`，接受值不覆盖继承值）。**禁止** `--property=Environment="DEEPSEEK_API_KEY=…"` 形式的透传——从 agent shell 拉起时该值是**空串但已设置**，继承层会**挡掉** home `.env` 层的值，比不传更糟（2026-09-24 实证：create+prompt 拿不到模型回复的根因）。`.env` 缺失时脚本 fail-loud 拒绝起线。
2. **trusted authorities**：一条 `SUPERD_TRUSTED_HOSTS` 声明同时喂两侧——世界 fence 腿（spawnWorld 的 `--trusted-host`，收端口形 entry）与 page-trust 组件的默认 authorities（`super-dsh/web-trust`，只收 bare hostname，端口形自动丢弃）。CLI 另带 `--trusted-host` ×2 喂 ctx0 的 /api + /hub fence。当前值：`test.pc.internal.test 192.0.2.130`（+ 端口形）。
3. **环境自身觉察**：agent 会话 env 自带 `DSH_HOME=~/.dsh`（跑在 prod dsh.service 里）——任何「我看到的环境变量」都是 **prod instance 的**，不是测试线的；拉线脚本必须显式设置全部 env（`DSH_HOME` / `SUPERD_DSH_ANCHOR` / `SUPERD_KEEP` / `PATH` / `UnsetEnvironment`），不依赖继承。

---

## 附录 A：事实锚点

- 组合/patches：`super-dsh/cordis.patch.yml`（ctx0 复合）、`super-dsh/agent-*/cordis.patch.yml`、`superd-hub/src/world-mount.ts`（world 挂载 patch 层）
- client 外部化 + purity gate：`superd-hub/scripts/build-client.mjs`
- world 自举与 home 布局：`superd-hub/src/world-provision.ts`
- 启动/交付：`super-dsh/test/start-4999.sh`、`super-dsh/scripts/pack.mjs`
- 认证机制：`upstream/deepseek-harness/packages/client/connection/src/browser-auth.ts`、`packages/credentials/credentials-local/src/index.ts`（`.credentials.yaml`）
- 上游对齐程序与破面台账：根 `AGENTS.md` §二；报告 `docs/test-reports/`
