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

### 2.4 发布认证（2026-10-10 user 补充）

本机 npm 发布凭证位于 `/home/u1/workspaces/base/secrets/npm.env`，变量名为 `NPM_ACCESS_TOKEN`。该文件不在本仓，也不会被 npm 自动读取；默认 `npm whoami` 失败不能据此判定本机没有 token。发布前仅在当前操作内读取，通过权限 `0600` 的临时 user npmrc 为 `//registry.npmjs.org/` 配置 `_authToken`，先验证 `npm whoami`，操作结束删除临时文件。不得打印 token、提交凭证或把认证文件打入 tarball。

`npm login` 是另一种配置本机 npm 认证的入口，会把凭证保存到用户 `.npmrc`；不是额外必需的独立登录层。参考 [npm login](https://docs.npmjs.com/cli/v11/commands/npm-login/) 与 [npm 自动化认证](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/)。仍须遵守本轮 user 发布放行、Better 先于 Super、验收归档原样发布与 registry 下载校验；认证可用不代表发布授权。

npm 可能在返回成功后提示 `Your package is being processed`，此时公开查询仍可返回404。每包只提交一次；等待公开 metadata、dist-tag 和 tarball，核对归档 SHA256/SHA1/SHA512 后才安装消费者或宣告发布完成。不得因处理延迟重复 publish、换字母或让消费者退回旧 latest。

该提示来自 registry 的 `npm-notice` 响应头；HTTP202 表示请求已接收，不代表包已公开。npm 已加入发布前扫描，包可能等待扫描、人工审核或被阻止，服务状态页正常不能排除单包延迟。参考 [官方发布前扫描说明](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)。

**排查触发点**：提交后15分钟仍不可见，就停止纯轮询并转入诊断；这是本仓操作阈值，不是 npm 的时限保证。检查原始 npm debug log 的目标 URL、PUT 状态和耗时；安全核对认证身份、包 owner、token 权限及有效配置；比较已成功的发布；用 PC/目标机、代理/直连、认证/匿名读取排除缓存与网络差异；检查 `npm stage list` 是否有显式待审批任务。不得输出 token 或完整认证配置。若仍只有202→404且 staging 为空，记录具体证据与待完成部署，查看维护者收到的 npm 延迟/审核通知；不要把404直接判为认证失败、扫描通过或恶意内容，也不要继续无期限轮询。npm 对扫描状态查询和延迟通知的说明见 [官方讨论](https://github.com/orgs/community/discussions/203413)。

---

## 3. 测试环境规范

### 3.1 端口：测试口无主化（2026-09-27 user 裁决）

- 499x 一族**全是测试口，没有谁占用谁（4999 也一样）**。起线前 `ss -tln` 动态探测。
- 端口被占时的处置：经 `/proc/<listener-pid>/cgroup` 找到归属 user unit——属于**测试基建**（unit 名 `superd-*` / `*-test` / `*-relay`）→ 直接停掉接管；**非测试监听**（prod 3080/3081、未知进程）→ 拒绝并换口。`super-dsh/test/start-4999.sh` 已内置此逻辑。
- 4999 = Caddy `test.pc.internal.test`（wan 可见）是**通道事实**，不是占用特权；launcher 使用原生 **`--host 127.0.0.1`**（2026-10-09 user 再修订）并自动拉 **socat LAN relay**（unit `superd-lan-<port>-relay`，只绑 LAN IP）。
- **LAN 测试依赖**：launcher 必须找到可执行的 socat，依次使用 `SUPERD_SOCAT_BIN`、PATH 中的 `socat`、本仓 `.scratch/socat-runtime/usr/bin/socat`；缺失则报错退出。4999 也保留 LAN relay，供直接内网访问。收尾同时停止测试 DSH、LAN relay 和该口的只读双包 registry；不通过 Better/Super patch 放宽宿主监听。
- **访问 authority（2026-10-09 user 裁决）**：每个测试口的 systemd CLI 默认 `--trusted-host <本机主IP>:<测试口>`；仅 4999 再声明 `--trusted-host test.pc.internal.test`，`SUPERD_TEST_TRUSTED_HOSTS` 只追加其它入口。生产 PC / dev3 各声明自己的 `dsh.<machine>.internal.test`。对应 Caddy 保留 Host/Origin 原样转发，取消旧 header 改写；flags 在 Better 缺席时仍支持原生信任检查，认证及监听 bind 仍是独立机制。
- **对外 URL（2026-10-09 user 补充）**：有实际域名入口的部署同时传官方 `--public-url`：生产 PC / dev3 分别使用 `https://dsh.pc.internal.test` / `https://dsh.dev3.internal.test`，4999 使用 `https://test.pc.internal.test`。测试 launcher 的 `SUPERD_TEST_PUBLIC_URL` 可声明其它 canonical URL；额外 trusted authority 不自动变成对外地址。此 flag 影响启动链接、Agent Web 上下文及 `DSH_WEB_URL`，不改变信任、认证和 bind。
- webserver 的 `host` config 接受且仅接受 `127.0.0.1` / `0.0.0.0` 字面量并按值直接 bind（0.1.x 时代的「启动硬拒 0.0.0.0」RCE 门在现基线已不存在；对非本机 Host 的防护改由 connection 的 trustedHosts fence 承担，而独立 Better Dash 的 `dashr-web-trust` 以 `trustAllHosts: true` 把它收敛为**认证唯一门**——cookie 不过仍然 401）。
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
- URL 里的 `?token=<launch token>` 是 **per-boot 进程内随机值**（`PROCESS_LAUNCH_TOKENS`，WeakMap），原生未替换的登录入口用它首次铸 cookie。2026-10-07 联合线启用了 Better Dash 的密码页，`/` 不再以 native token 铸 cookie；新客户端使用密码页，已有 cookie 继续有效。

**纪律**：

1. **重启测试线、换 rig 接管同一端口，都不需要重注 cookie**——旧 cookie 只要还在 30 天窗口内、authority 没变、共用 seed 文件没被删，就直接过认证。`start-4999.sh` 在共用 seed 已存在时明说这一点，并输出密码页的无 token URL。⚠ 实测（2026-10-04）：同一个 cookie、同一个 home，只把 seed 源从共用文件换回该 home 自己的 `.credentials.yaml`（secret 不同）→ **401**；换回共用文件 → **200**。
2. 需要重新登录的只有三种情况：**共用 seed 文件**被删/换（重生成）、换了访问 authority、cookie 过 30 天窗口。当前联合线使用密码页；仍保留原生门的其他 profile 才使用 token。
3. 换被测版本、重启 daemon、重建 profile **都不影响** seed 与既有 cookie。

### 3.4 种子（入库、可重生成）与运行 home（gitignored）分离

| 角色 | 内容 | 是否入库 | 本仓落点 |
|---|---|---|---|
| **种子 / 配置模板** | profile 的 `package.json`、`cordis.patch.yml`、启动脚本、复现步骤 | **入库**（幂等可重生成） | `super-dsh/test/start-4999.sh`（每次重建 profile 并装 tarball） |
| **运行 home** | `sessions/`、`storages/`、`snapshots/`、`profiles/*/node_modules`、`agents/*`、`.credentials.yaml` | **gitignored** | `.tests/superd/`（根 `.gitignore` 覆盖 `.tests/`） |

好处：重置 profile 不动 user data；克隆仓库即得可复现种子。会话 schema 版本（现役 **v4**）与 v4-reader 兜底校验器见 `superd-hub/test/system-head*`。

---

## 4. 本地测试流程（真实用户视角）

**目标**：测试实例尽可能像真实用户部署——装的是**发布产物**，不是源码符号链接。2026-10-07 起本地默认线为 `pack-pair.mjs` → 两包本地构建 → 自包含 Super Dash tarball → `pnpm add file:` → 仅启用 Super Dash 的原生 profile（见 §8）。

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
2. **整包 pack 线冒烟**（场景级验证**唯一入口**）：`bash super-dsh/test/start-4999.sh`（双包本地 pack → 独立 Better Dash 的 Super Dash tarball → 单入口原生 profile → repo build CLI 启动，详见 §8）。冒烟基线：认证后的 shell 200 + roster 全量 + `/hub` 家族语义 + `world failed` 计数 0。
3. **dev3 目标机实装**（根 AGENTS §〇.0.a）：tarball → restart → journalctl 计数 + 同组探针 → 报告落 `docs/test-reports/` → user 放行 → 才谈 publish。

### 6.1.1 跨机 SSH 测试对端 = DEV2（2026-11-02 user 裁决）

- 需要真机 SSH 对端的行为测试/模型第一人称验证（`ssh:<host>` 目标、跨机 transfer、MUX、PTY 长连接等）一律指向 **DEV2**；不再把 DEV3 当 SSH 对端反复折腾。DEV3 保留两个既有角色：目标机 rig（tarball 实装 + 4998 测试线 + 4996 review 转发）与生产环境本身。
- 单元测试不受影响：继续用本地 sshd fixture / 127.0.0.1（不涉真机）；只有「真机对端」场景换 DEV2。

### 6.2 per-agent 场景测试：退役且不回潮（2026-09-24 裁决，2026-09-27 重申）

- **不做 per-agent（单 adapter）的场景测试——即使本次改动是 per-agent 的**。行为级验证一律把**整个 superd app** 拉起来测（整包线 + dev3）。
- **理由**：单 adapter 场景测试要求把它变成**独立 Dash 插件形态**——自有 test rig、patch、yaml 全套重写——而交付物是整包；这笔投入与交付形态不符，毫无意义。
- 已删除、不得回潮的 rig 清单：per-agent standalone app 启动线（`start-{codex,claude,hermes,pi}-app.sh`、`start-world-4998.sh`）、world-plugin 集成测试 ×2、verify/live/spike/smoke/probe 脚本、真 sidecar spawn 测试、standalone bootstrap 脚本、配套一次性 home（`.tests/plugin-acc2` 等已物理删除）。

### 6.3 整包线现状基线（2026-09-27）

交付形态运行（无手工 composition / 无链接 farm / 无库式 boot）；端口无主化 + 测试 unit 接管（§3.1）；长寿命 home 复用 + user data 保留（§3.2）；seed-cookie 免重注入（§3.3）；client lane 两条已立（§2.3）；产物面启动（repo build `apps/cli/lib/bin.js` + 裸 node；禁 tsx 源码启动——双平面 symbol split）。

---

## 7. 整包线的测试准备（写死在 `test/start-4999.sh`，缺一不可）

> 2026-09-24 user 裁决：测试线必须「看到被测者看到的世界」，否则测的是别的东西。三条：

1. **provider keys（2026-10-10 测试隔离修订，替代旧生产文件复制规则）**：复用 `$DSH_HOME/.env`；仅当缺失时从显式 `SUPERD_TEST_ENV_FILE` 测试文件播种，二者均无则 fail-loud。launcher 不读取生产 home。文件权限为 0600，不打印内容。禁止空 API-key 环境变量透传：继承层的已设置空串会挡住 home `.env`。现有测试凭据不得在重启时被覆盖。 `SUPERD_TEST_BIN_DIR` 可为本轮夹具提供透明 native SSH host-trust wrapper；仅添加官方 host-trust 参数并 exec 真 `/usr/bin/ssh`，禁止替代路由/传输/取消行为或写全局 SSH 配置。
2. **原生 Web 策略（2026-10-09 user 修订）**：Better 不替换 WebServer，也不修改监听地址；`dashr-web-trust` 仍通过公开事件提供认证及 browser ownership 策略。launcher 使用官方 `--host 127.0.0.1`、`--port` 和独立 LAN relay；systemd CLI 声明本机主 IP 加测试端口，仅 4999 再声明 `test.pc.internal.test`，并传递相应 `--public-url`。`SUPERD_TEST_TRUSTED_HOSTS` 可追加访问 authority。独立关闭或卸载 Better 后，原生认证及 CLI 的 trusted-host 声明仍生效；生产域名由既有 Caddy 代理到 loopback。
3. **环境自身觉察**：agent 会话 env 自带 `DSH_HOME=~/.dsh`（跑在 prod dsh.service 里）——任何「我看到的环境变量」都是 **prod instance 的**，不是测试线的；拉线脚本必须显式设置全部 env（`DSH_HOME` / `SUPERD_DSH_ANCHOR` / `SUPERD_KEEP` / `PATH` / `UnsetEnvironment`），不依赖继承。

---

## 8. Better Dash 双构建与两包独立交付（2026-11-02 再修订）

两包同仓、同步版本、独立 npm 发布与原生 bundle，互不安装、互不提升（[ADR 0016](adr/0016-two-independent-packages-no-companion.md)；companion 协调器、`superdCompanions` 服务与 Hub Settings 安装入口已于 2026-11-02 移除）。Super 不声明任何 Better dependency/optional/peer，也不内嵌其整包或归档；canonical `better-dsh/src/remote/` 经生成器产出的 Super `remote/` 闭包收窄为 **hub 内部私有依赖**——无公开导出、无 `superd-remote` 组合行，仅由 hub exec/PTY/task/file lanes 引用其进程原语（`PtySession`、oneshot/binary process 等），SHA-256 provenance 与逐叶子核验不变；模型侧 `remote`/`remote_transfer` 工具只由 Better Dash 注册，两包同装时 Better 的 remote 工具仍自动把 Super hub 列为 `hub:<m4>` target（检测逻辑在 Better 侧，未改动）。Pi 的 bundled dependency 不变。双构建核验同步版本、独立 YAML、browser exports、无 Better 依赖边与 payload、无 `./remote`/`./setup` 导出与 remote 组合行，`pair.json` 记录 SHA256 和 `independentPackages`。

- DSH 上游兼容范围统一为 `>=0.2.0-0 <1.0.0-0`（2026-11-02 user 裁决），覆盖两包及全部子 manifest 的 `@deepseek-ai/dsh*` peers；发布以真实最低支持版本验收为准。
- 装哪个包由用户自己决定：Super 不自动安装、不手动安装、不升级、不重装 Better，也不保留卸载意图 receipt。旧 `$DSH_HOME/superd/companions/` 残留文件惰性无害，可手删；`companion-registration` 迁移随读取方一并退役。
- 测试 launcher 使用同轮未改 tarball 的只读 registry：Better/Super 的 exact 与 latest 都来自本轮产物，其它包转发正常 registry。保留 profile 已有独立安装/关闭选择；launcher 不预装 Better、不写测试专用业务补丁。
- Better 不替换原生 WebServer 或 HMR，不改变 bind 默认值。WebTrust/mobile 继续使用原生公开事件；测试 CLI 明确 `--host 127.0.0.1`，LAN 通过既有 test-only relay。生产 Caddy 及 domain flags 独立于插件启停。
- `dashr-welcome-notice` 是前端策略的生命周期 marker。客户端在官方 `settings.onboarding` 中以相同 `welcome-notice` ID、较低 priority 遮蔽原生贡献，调用 owner `complete()` 跳过每次选中的欢迎步骤；首次访问、新 chat 和显式打开都覆盖。关闭对应 component/Better 后撤销贡献；其它 onboarding 步骤保留。无 server ack、private state、localStorage 或 DOM 自动点击。
- dev WebMCP 仅由测试 profile 附加，不进入正式 tarball。共用 credential seed、user data 和原生认证保留。
- 发布仍先 Better 后 Super，须本轮真实验收、报告和 user 单次放行；本地测试字母版本不构成发布授权，公开版本按本轮 user 指令和 registry 已有版本确定。

### 8.1 合仓版本、文档与独立消费者

- 根 `npm run version:release -- 0.3.0-a` 同步 private 根、两包、锁文件元数据，不增添两包依赖边。正式目标0.3.0；测试轮后缀同步递增，真实发布仍需本轮放行。
- 根 `npm run pack` 强制本仓双构建。Better Dash 文档副本按 `docs/package-catalog.json` 选择原生/共享资料，旧冲突文档可映射到原包路径；不把整棵 Hub 资料扫进小包。
- 单独小包验收：`SUPERD_TEST_CONSUMER=better-dsh SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/better-dsh bash super-dsh/test/start-4999.sh`。构建仍是双产物，消费仅 Better Dash，没有 Super Dash override、Hub bundle 或 foreign agent。
- dev3 使用同一个 launcher、实际宿主安装锚与保留的测试 home。将两 tarball + `pair.json` 传到目标后设置 `SUPERD_TEST_PACK_DIR=<received-directory>`；`scripts/read-pack-pair.mjs` 重定位产物路径，核验 SHA256、同步版本、独立 YAML、无 Better 依赖与 payload 与 browser exports 后才安装。目标端不重建；其只读测试 registry 仅提供同一双产物。本机默认入口仍每轮双构建。
- Git 历史保留两个原始根和全部旧 SHA；原 Better 分支/tag 以 `legacy/better-dsh/` 标记，避免与旧 Hub v0.1.x tag 重名。正式合并以 Better 历史为第一父、Hub 历史为第二父；旧 npm 版本不改写。


### 8.2 dev3 review transport

当前dev3测试服务4998宽绑定，但现有UFW未开放此公网端口。目标机实际安装/模型验证走SSH访问原生服务。浏览器review可用独立测试SSH转发unit `superd-4996-dev3-review`，从PC4996转发到dev3的127.0.0.1:4998；它访问同一交付物、profile与CLI，原生密码/cookie认证继续生效。该入口不修改目标防火墙或Caddy，也不提供替代bundle/peer解析。具体本轮URL和已核验边界见 `docs/test-reports/2026-10-08-monorepo-030.md`。review结束停止该unit即可；本机4999与4997消费者各自保持。

## 9. 合仓后的上游 alignment

对齐同时走源码轨与消费者轨。先查询 `@deepseek-ai/dsh` 的 registry dist-tags、上传时间和精确版本，再将本仓 `upstream/deepseek-harness` 切到对应官方发布 tag。最新上传的 alpha 可以晚于 `latest`；两者分别记录，不能默认同一版本。备份既有授权构建补丁，检查新 tag 是否已经提供官方替代机制；清理旧生成产物、按上游 lock 与 packageManager 完整重建，然后同步两个编译 farm。当前源码与官方接口核查必须实际使用 LSP/AST。

审计覆盖 Hub/adapters 和 Better 的原生工具、客户端、重述 YAML、包内 coordinator。先在 4999 整包 tarball 线上验证真实工具 Surface、会话和插件开关，再进行小包消费者与 dev3 精确 registry 宿主安装验收。目标测试使用独立安装锚，不更新生产共享安装树；两 tarball 与 pair.json 原样传输，目标端沿现行 launcher 核验安装。测试轮同步字母版本，报告归 docs/test-reports；没有本轮发布放行，不 publish 或 Git 定版。

DSH `0.2.1-alpha.1` 的 `PluginPackages.refresh()` 要求可重算的官方 `ProfileRuntimeResolution`。Hub 扩大 host 表时保留该真实类及其重算能力，并在每次重算后重新加入 world 映射；旧宿主没有该类时仍走其原有数据表契约。原生映射删除和重启冲突检查仍由宿主负责。

历史 `0.3.0-c` 至 `0.3.0-e` 的依赖式交付中，在 refresh-capable 宿主上首次由包内 coordinator 将已经进入 host 表的传递依赖 Better 提升为直接依赖，属于原生 resolver 明确要求的冷重启窗口。本轮独立 companion 交付已退役该提升机制，普通启停/卸载的现行契约与验收以 §8.1 为准。coordinator 明确报告重启；保持已经写好的 profile，冷重启一次该测试服务后，再验证两包独立启停。不得修改 resolver、预先由 launcher 提升 Better，或重新生成 profile 来掩盖这条消费者行为。后续实际代码替换也继续要求重启。该窗口不适用于普通 bundle 开关、首次安装无既有映射的普通插件或旧宿主的首次登记。


### Task8 container oneshot ownership correction (Rulings23–24)

Actual installed Docker/Incus native job cancellation reported killed while receiving children remained live. Canonical oneshot foreground/background/script/stdin therefore share the SSH portable receiving gate/control/work barrier through native container exec argv, not local CLI termination. Each command requires three native exec startups (clock, owner, literal-stdio work), remote Bash4.1+, Python3.7+, Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep. Linux containers additionally require stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER before business admission; the work helper reaps only its own/adopted children and stays alive until its work group is absent. This supports ordinary non-reaping PID1 containers without forcing --init, privilege/capability, image/config mutation, rsync, pidfd or origin Python. PTY/BYOPTY stay unchanged; SSH portable prerequisites are not broadened. The same eight-second counted lease, gate recovery, actual cleanup barrier and 2500ms honest final-output drain apply, with no enlarged grace, second job registry or availability polling. Consumer iteration N must prove real native killed status together with owned process/group/helper/state absence; M failures remain historical evidence.

Ruling25 supersedes the original two-remote source -R/private-master/sshd-FD/pidfd design after actual default dev3 source failed its permission requirement. A task-owned portable Python loopback proxy, inside the existing receiving helper/group/lease, carries bounded binary frames over authenticated SSH work stdio to an origin TCP bridge into the destination -L tunnel. A real full-route @RSYNCD greeting precedes business admission. No source Linux /proc, pidfd, privileged sshd access or source forwarding permission is required; native find, native rsync and the existing portable Bash/Python/fcntl/shared-monotonic prerequisites remain. No origin Python, credentials on peers, copy fallback, lease increase or second registry. Five-byte type/length frames cap data at64KiB and Python queues at256KiB; one active connection, real backpressure and half-close, prior reader/socket close before next OPEN. Ordinary two-remote transfer measures12 SSH startups: source preflight+inspection clock/work3, relay source/destination preflight2, destination clock/daemon+tunnel2, source proxy clock/owner/work3, native source rsync clock/work2. Fault recovery adds only task-owned authenticated cleanup reconnects, never transfer retries. Same real helper/listener/group/metadata/tunnel/socket cleanup barrier; receiving progress remains an explicit assumption. Historical M permission failure remains in the acceptance report; current default-dev3-source source test passes, installed next-artifact proof is separate.


### CLI binary receiving ownership (consumer correction, Ruling26)

Actual N native SSH copy cancellation settled while the remote import process and its unnamed staging file remained live under a finite work-channel EOF hold. CLI export/import/digest now reuse the canonical portable receiving owner, with raw binary work streams and the same counted lease, admission gate and authenticated recovery. Cancellation/failure waits for receiving helper/group/temp cleanup before local transport teardown/settlement. Normal success must completely drain the binary stream; the oneshot text lane's 2500ms incomplete-output rule does not apply. Archive validation, selected manifest digests, merge/no-delete behavior and canonical SSH identity/ProxyJump are unchanged. Local and Hub file lanes are unchanged.

This intentionally replaces the former Python-only minimum for CLI peers: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep; Linux containers also need stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER. No rsync or origin Python requirement, auto-install, second registry, fallback, peer polling or increased lease. Minimal Python-only peers no longer support this CLI lane; use a supported peer or authenticated Hub.

Each remote export/import/digest costs three native transport starts: clock, independent owner/control, literal binary work. Thus verified local→CLI or CLI→local costs six; CLI→CLI twelve. verify:false skips digest operations, reducing counts to three/three/six. Local/Hub operations do not contribute CLI starts. Fault recovery may add same-identity authenticated cleanup starts and may remain pending until genuine cleanup observation is possible. Artifact O must re-prove installed cancellation and complete binary integrity; N failures remain historical evidence.
