# Super D (superd) — 拓扑与 Dev/Test 约定

本文件是 agent 指引的一站式契约：操作红线、定位速查、上游基线与对齐纪律、dev/test 路径、规划工作流、当前仓状态。词汇表见 `CONTEXT.md`；设计正本见 `docs/`。

---

## 〇、Development Operation Contract — 红线

0. **生态即产品（Ecosystem-is-the-product；2026-09-22 user 裁决，最高优先）**：在 Node 生态里，写代码 ≠ 开发完成。依赖图、包管理器行为（npm pack 规则、pnpm store/linker/`file:` 语义）、解析算法（exports、node_modules 走查、symlink realpath）、交付通道（registry → 消费者安装），全部是产品本体的一部分。三条铁律：
   - a. **验收必须走交付形态、上目标环境**——本地源码树跑通只是冒烟；插件类改动一律目标机实装验证（dev3：tarball `corepack pnpm@10.33.2 add file:` → restart → journalctl `world failed` 计数 + mount 探针）。
   - b. **dev 脚手架不得含有交付物将不具备的任何机制**——凡是 farm、链接、硬编码路径曾替代码遮过丑的地方，就是埋雷清单；开发形态 = 交付形态（4999 线跑 pack 出来的 tarball，见 `super-dsh/AGENTS.md`）。
   - c. **业务代码永不迁就开发流程**——测试纪律（test home、禁碰 prod home）由 launcher/测试夹具强制执行；出现在 `src/` 里就是缺陷（先例：13 处 `assertNotProdHome` 守卫杀死 home 为 `~/.dsh` 的消费者，2026-09-22 已全数删除）。
1. **npm publish 前置条件，缺一不可，顺序不可换**（先例：npm 发了就发了，撤不回）：
   - a. **第一人称实测通过**：真实运行时里走通改动路径（起 4999 实例 + 浏览器/curl 实测）。进程没崩、单测绿、tsc 0——这些是构建卫生，**不是验收**。
   - b. 实测结果落报告（`docs/test-reports/` 惯例）。
   - c. **user 明确确认放行**（实测通过 ≠ 放行，两道独立闸门）。
   - d. **版本纪律（2026-09-22/23 user 裁决）**：测试/修复迭代一律字母后缀（`0.1.3-a/b/c…`，better-dsh 先例 `0.2.3-g`）；补丁号（`0.1.4`）与新 minor 只留给**真实 feature 发布**。pnpm 对同名同版本 `file:` 依赖静默 no-op——每次迭代必须换字母。**npm 不是 git（2026-09-23 user 裁决，最高优先）**：`npm publish` 只在 user 明确下令发版时执行；一切迭代经 tarball 通道（本地 4999 + dev3 `corepack pnpm@10.33.2 add file:`），registry 里的 `latest` 冻结在最近一次获准发版。
2. **验收标准与改动点同类**：改「运行时行为」就用「运行时行为」验收，不得降级为进程活性或静态证据。
3. **未经 user 单次明确同意，不得 `npm publish`**；授权粒度单次有效。
4. GitHub 侧（commit/tag/push）可逆，跟随上述节奏，不抢跑。
5. **上游源码零修改**：依赖全部 exact-pin，改动一律走 patch 层（`cordis.patch.yml`）/自有插件；vendor 保护机制（`superd vendor verify/restore`，蓝图 §5）落地后强制启用。

---

## 一、这是什么（定位速查）

- **superd = 独立 App（最小 cordis 宿主）**，不是 dsh 的插件/profile/fork。桥接层：把本机与远端已有 Agent 运行时映射到 DSH Web UI 可消费的数据面；**自己不跑 agent、不存原始会话**（唯一持久状态 = pairing 表）。
- 交付结构：**单一 pack `super-dsh`**（unscoped npm 包 = dsh plugin market 名；内含 `superd-hub` + 各 `agent-<runtime>` 兄弟目录；composite patch 自指 subpath `super-dsh/hub` / `super-dsh/agents/<label>` / `super-dsh/join`，另加一条裸名行 `super-dsh` 承载 client half）。per-runtime 对偶包命名：`@pgmi-builds/agent-*`（数据面）+ `@pgmi-builds/agent-ui-*`（呈现面）。根 `package.json` 仅占位（无 dependencies、无 scripts）。
- 命名纪律：App 名 Super Dash / 品牌 Super D / 代码与 CLI `superd`（无空格连字符）；上游 UI 内 DSH 字样原样保留（品牌原则：仅自研代码用 Super D 品牌）。
- 设计正本：`docs/00-blueprint.md`（v0.4a）+ `docs/01-component-boundaries.md`（v0.3）+ `docs/adr/0001–0007` + `CONTEXT.md` 词汇表。研究镜像 `docs/01–05` 簇**只读**（正本在 dashr 仓）。

---

## 二、上游基线与对齐（Upstream Baseline & Alignment）

- **版本台账（动态；格式 = `值 [updated 日期, provenance]`，尾部 `[]` 为下次更新位）**：
  - **dev 时点的上游版本**（`upstream/deepseek-harness` checkout，本仓唯一测试基准）：`dsh-v0.1.7-rc.1` [updated 2026-09-24 对齐轮，**物理 checkout**：detached 到该 tag、浅克隆；npm dist-tag `next`（`latest` 冻结 0.1.5-rc.3，npm 不是 git）。三个 sanctioned 补丁重放顺利。**⚠️ 换 tag 前必须清旧构建产物**：残留 `lib/` 会以 stale 产物喂 rolldown（实证：settings-file 旧 lib 引已改名的 SettingsProvider → `Missing export` 崩 build）；`git clean -xdf` + `pnpm install && pnpm run build` 全绿。super-dsh 编译 farm（`super-dsh/node_modules/@deepseek-ai/*`，316 links）用 **`super-dsh/scripts/sync-dsh-farm.mjs`** 幂等同步（0.1.7: 51 relink / 20 removed；vendor/* 平铺 + packages/*/* 两层布局都要收割）。**0.1.7 破坏面（已移植，super-dsh 0.1.3-l；现役 **0.1.3-q = 品牌轮**）**：① **插件兼容门**（plugin-compatibility preflight，硬 enforcement）——每个 row/bundle 的 `@deepseek-ai/dsh-*` peerDependencies 过 `semver.satisfies(runtime, range, {includePrerelease: true})`，不满足 → row `disabled`（"dsh: disabling profile plugin …"）/ bundle skipped；双检查点 = `loadProfileDirectory` 判 bundle + `prepareProfileEntries` 判 row（含 Include 展开与 group 递归）；super-dsh 全部 packs 的 dsh-* pin 依 user 裁决换 **`>=0.1.5-0 <0.3.0-0`**（better-dsh 同款；13 个 semver 边界用例验证）。② **heal 家族全删**（`healProfilesModuleFallback`/`createProfileResolutionGeneration`/`healIsolatedProfileModuleFallback`/`unlinkProfileModuleFallback`）→ `createRuntimeResolution`（纯解析表、零磁盘写）+ `PluginPackages` 进程内拦截（`{ resolution }` 取代 `{generation, behavior}`）；launcher 不再维护 profiles 级 `@deepseek-ai` farm——**测试若走 `boot()` 直调或裸 URL farm，必须自己投影 resolution entries 到 farm**（spawn-world / world-mount / world-plugin 测试已改）。③ **`dsh-agent-presets` 拆包**：`dsh-agent-preset`（AgentPreset 类）+ `dsh-agent-preset-registry`（宿主 `AgentPresetRegistry`，service 名仍 `agentPresets`）——roster/selection/document RPC/`agentPreset` projection/`agent-preset/*` typed 错误与事件增广全归宿主；6 个 adapter 的 `Single*PresetRoster` + 自有 projection 退役 → `register{X}Preset(ctx)` 向宿主 registry 注册固定 `PresetDefinition {id,name,description,plugins:[]}`；patch 行 `agent-presets: disabled` → `agent-preset-registry` 保持挂载 + `config.default` 钉单 preset（副产：`pluginInventory/list` 的 `compositionInventory is not a function` 随 registry 挂载消失）。④ **流协议上行帧**（2026-09-24 补录，先漏掉的一处）：`RemoteStreamClientMessage` 新增 `item`（上行项）与 `end`（上行半关闭），mux 服务端须丢弃已出表 stream 的迟到帧、有界 uplink inbox（默认 256KiB）、心跳 2s——super-dsh 自有 wire-compatible mux（`world-mux.ts`）已全面对齐，且 carrier 对世界网关的调用必须用规范参数序 `openWireStream(endpoint, payload, uplink, peer, signal, control)`（0.1.3-j 曾 3-4 参错位 → 世界页永远 Reconnecting，报告 §七）。⑤ 小 drift：`MessageSourceMap` 废共享 `plugin` kind（producer 各自 declare；user-approval 有专属 kind）→ `source.kind === "user-approval"`；`createSystemMessage` 单参；`announce(agent, source: 'startup'|'resume'|'clear'|'compact')`；`resolveBundleDir` 只认 anchor + profile 自身目录（world provision 已补 profile-local `@pgmi-builds` links）；`browser-auth` 认证后重定向 `./` 且 token URL 保留 mount 路径、frontend-static `<base href="./">`（per-world mount 亲和）；vendored `@deepseek-ai/cordis` 4.0.2→4.0.4。**环境坑**：本 agent 会话 env 自带 `DSH_HOME=/home/u1/.dsh`（跑在 dsh.service 里）——读 `process.env.DSH_HOME ?? 测试home` 的测试会静默落 prod home（omp/hermes world-plugin 测试已加 prod 值视为未设的守卫）。**品牌轮 0.1.3-q（2026-09-24 user 裁决）**：`agent-worlds`/`aw` 临时名全剥——hub 包 `@pgmi-builds/superd-hub`（旧 `agent-hub`，目录 `super-dsh/superd-hub/`）、per-runtime 包 `@pgmi-builds/agent-<runtime>`（旧 `agent-adapter-*`）、主 pack exports `./hub` / `./agents/<runtime>`（旧 `./world/*`） / `./join` / `./web-trust`、cordis 插件名 `superd-hub` / `superd-web-trust` / `superd-join` / `agent-<runtime>`、服务键 `superd.world.*`、env 家族 `AW_*` → `SUPERD_*`、测试 home `.tests/aw` → `.tests/superd`、tarball 目录 `.scratch/superd-pack/`、unit `superd-4999-test`；`OMP_WEB`/`omp-web` 血统名同轮并入 `agent-omp`（浏览器 loader id、DOM tag、页面 global `__AGENT_OMP_MOBILE__`、sidecar 前缀）。`@pgmi-builds` scope（org 名）与 internal 概念「world」（mount/mux/provision 等）保留。报告：`docs/test-reports/2026-09-24-superd-rebrand.md`。原报告：`docs/test-reports/2026-09-24-dsh-0.1.7-rc.1-alignment.md`] []
  - 上游 checkout 的**产物边界与 sanctioned 补丁集**：源 = **纯 src**（`apps/cli/{src,config,reference,tests}`、`packages/*/*/src`、`vendor/*`）+ 配置；构建产物 `lib/`/`dist/`、`node_modules/` 都在 `.gitignore` 里，只有 `pnpm install && pnpm run build` 之后才存在。它是 **pnpm monorepo**（`packageManager: pnpm@11.7.0` + `pnpm-workspace.yaml` + `pnpm-lock.yaml`；无 package-lock）。**三个允许的本地补丁（2026-09-14 user 放行；镜像 dsh-omp/dashr，除此之外零修改）**：① `pnpm-workspace.yaml` += `storeDir: /home/u1/workspaces/superd/.npm-cache/pnpm-store` + `verifyDepsBeforeRun: false`（pnpm 11 不读 `.npmrc`，用户级 store 在沙箱外只读）；② 根 `package.json` devDeps += `unrun@^0.3.1`（tsdown 0.22 config loader 需要，上游未声明）；③ `packages/client/tsdown.client.ts` 的 `REPOSITORY_ROOT` 改 `resolveRepositoryRoot()`（锚 `pnpm-workspace.yaml`，cwd 回退；unrun 会改写 `import.meta.url`）。跑源码 = `pnpm install`（**不是 `npm install`**）→ `pnpm run build`（`tsx scripts/build.ts` = native-system + lib(host/client) + web）→ `pnpm run dsh`；build 后也可直接 `node apps/cli/lib/bin.js`。node 引擎用系统的（`/opt/node-v22.23.2/bin/node`）[updated 2026-09-14] []。
  - 声明 pin：**仓根 `package.json` 已无 dsh 依赖声明**（2026-09-22 housekeeping 后仅占位）；dsh 版 pin 的活体在 **super-dsh 各包的 `peerDependencies`**：`@deepseek-ai/dsh-*` = `>=0.1.5-0 <0.3.0-0`（2026-09-24 user 裁决 "v0.1.5 ~ v0.3.0"，0.1.7 兼容门-compatible）[updated 2026-09-24] []。
  - 框架伴生：`@deepseek-ai/cordis@4.0.4`（vendored，随 0.1.7 checkout）、`cordis-plugin-loader/include` 等 vendor 同 checkout、`schemastery@3.18.x`、`commander@15.0.0` [updated 2026-09-24] []。
- **install 树 = 谁跑 launcher，谁就是解析源（2026-09-14 实测；0.1.7 改版）**：`apps/cli/src/profile-boot.ts` 的 `INSTALL_ANCHOR = <运行中 dsh 的 package.json>`；0.1.7 起 launcher 用 `createRuntimeResolution({installAnchor, profile})` 计算**纯内存解析表**，经 `PluginPackages` 进程内拦截导入——**不再写任何磁盘 symlink**（`healProfilesModuleFallback` 家族已从上游删除；launcher 也不再维护 `$DSH_HOME/profiles/node_modules/@deepseek-ai` farm）。**同一 DSH_HOME 换 installation 的三条路**：① **自包含 dev base**：在 checkout 里 `pnpm install && pnpm run build`（带三个 sanctioned 补丁）→ checkout 成为 installation（锚 = 其 `apps/cli/package.json`）；② 另一前缀装一份预编译包（`npm install -g --prefix ~/.local-dsh-<ver> @deepseek-ai/dsh@<ver>`）跑 `~/.local-dsh-<ver>/bin/dsh`；③ profile 本地 pnpm 树物理装 `@deepseek-ai/*`（解析更近，但**违反单实例纪律**，仅当清楚后果时用）。**注意**：一个 DSH_HOME 只服务一种 installation（拦截表按 anchor 算；**表 = 重定向 + 原生兜底、按 importer 生效、installation scope 进程内冻结、profile `node_modules` 物理包即装即解析**——实测语义见 `docs/07` §5.3；进程内 `boot()` 的 world **无表**，故世界树必须自带 farm）；super-dsh 世界树仍需裸 URL farm（`worldHome/profiles/node_modules`），由 `provisionWorldProfile` 自己维护（`@pgmi-builds` 逐包 links + profile-local links，`@deepseek-ai` 侧 sources = install tree scope ∪ 工作区枚举——**home farm 源料 2026-09-24 退役**：user 删 prod `~/.dsh/profiles/node_modules` 并重启 3080 实证无害，该层只是同一 install 树的冗余投影）。
- **版本事实（2026-09-14）**：alpha.2→rc.2 = 3170 文件、+104k/-18k（大周期）。`--host 0.0.0.0` 在 rc.2 被 CLI 硬拒（`packages/bundle/web-app/src/startup.ts`，RCE 安全门），但 webserver config schema 仍收 `0.0.0.0`（见 §三端口纪律）。
- **对齐轮程序（上游每发一版必跑）**：
  1. `git fetch --depth 1 origin tag <new-tag>` → checkout；
  2. diff 关键文件清单：`packages/boot/app-boot/src/{index,profile}.ts`、`packages/bundle/web-app/{cordis.patch.yml,src/*}`、`packages/boot/cmdline/src/index.ts`、`packages/client/connection/src/{browser-auth,rpc-host}.ts`、`packages/host/{frontend-static,webserver}/src/index.ts`、`packages/util/home-paths/src/index.ts`、`apps/cli/src/profile-boot.ts`、`vendor/*/package.json`；
  3. 无破坏 → 全仓 sed 换 pin（每包一行）→ `npm install --cache .npm-cache` → `npm test`；有破坏 → 更新受影响代码块与计划文档后再换 pin；
  4. 记录对齐结论（commit message 或 docs）；
  5. **对齐验收含 per-runtime 会话面（2026-09-23 教训）**：boot 级全绿（world-failed 0 / mount 200 / 零降级）只是入场券——每个 runtime 至少跑一次 create+prompt（+resume），否则 0.1.6 的 `announce(agent, source)` 类签名断裂只会在用户点开会话时爆炸（先例：codex "resume failed for session"，根因是 5 个 adapter 被 vendored rc.2 假类型遮蔽编译通过、运行时炸）。**vendored 类型存根（`agent-*/types/@deepseek-ai`）已全数拔除**——tsconfig `paths` 钉假类型 = 脚手架遮丑，永远禁止回潮。
  6. **换 pin / 装依赖后查 `@deepseek-ai` 单实例**：`npm install`（尤其子包内）会把 install 树符号链接重新物化为物理副本 → 双模块实例 → `dsh-scope` `kScope` 分裂（scope 全家桶症状）。检查命令见 §三（现役 scope = `super-dsh/node_modules/@deepseek-ai`，`scripts/sync-dsh-farm.mjs` 维护；旧 heal 修复脚本已随 2026-09-22 housekeeping 移除，出错时手工重链 symlink）。

---

## 三、Dev/Test 约定

- **依赖解析 = 单一 install 树（2026-09-24 修订：home 级 farm 退役）**：0.1.7 起 launcher 解析走进程内表（§二），`<home>/profiles/node_modules` **不再被任何机制维护**——heal 已死、世界 provision 源料亦不再吃它（2026-09-24 user 裁决 + prod 实证）；历史残留属可清垃圾（`.tests/profiles/node_modules`、prod 同位树已由 user 手删）。dev base = **repo 内 checkout build**（`upstream/deepseek-harness/{packages,vendor}/*`）——2026-09-14 起；更早是全局 install（`/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/...`）。**仓根 `node_modules` farm 已于 2026-09-22 housekeeping 删除**（原 heal 维护的 symlink farm，`scripts/heal-modules.mjs` 亦已删）。**这是必需态，不是违规**（本文旧版「repo 本地 node_modules 是唯一依赖来源 / 禁止 symlink 全局树」已被 2026-09-10 实测推翻）。禁止的只是 NODE_PATH 顶替安装树。**单实例纪律**：任何 `npm install`（尤其子包内）都会把 `@deepseek-ai/*` 重新物化成物理副本 → 双模块实例 → `dsh-scope` `kScope` Symbol 分裂（症状：`file-upload: operation requires the Agent's own scope`、`agent-presets: refusing to compose an unscoped context`）。每次 install 后必查现存 scope：
  ```bash
  find super-dsh/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l   # 只应剩历史物理遗留，新条目应为 symlink
  ```
  **`~/.dsh` 的 scope 除非有意，绝不指**。**仓根 `package.json` 刻意不声明 dependencies**：各线依赖由各线自己的 `package.json` / `node_modules` 负责（super-dsh 各 adapter 包自包含）。仓内缓存安装用 `npm install --cache .npm-cache`（默认 `~/.npm` 在沙箱下 EROFS）；exact-pin，无 `^`。
- **Test home / profile 路径**：dev/test 一律 `DSH_HOME=<仓根>/.tests`（gitignored；2026-09-22 由 `.superd-test` 改名）或 tmpdir。**绝不触碰 `~/.dsh`（Dash Agent prod）与 `~/.superd`**。profile 落位 `$DSH_HOME/profiles/<name>/`：`package.json`（`dsh.profile.bundles` 顺序 + `dependencies` 的 `link:` 本地包）、`cordis.patch.yml`（profile 用户层，**端口写在这里**）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`）。各线 bootstrap **自带在各自 `test/` 目录**（现役：`super-dsh/test/`；旧 `scripts/profiles/{ma,ctx0,ctx1-omp,m0}.mjs` 集中目录已随仓重排移除）；脚本幂等，**重跑即重建 profile 并重链 `link:` 本地包**。用户的 `DSH_HOME` 环境变量**永不被 superd 继承**（`src/home.ts` 契约）。
- **上游源码（upstream src）**：`upstream/deepseek-harness` @ **`dsh-v0.1.7-rc.1`**（gitignored checkout，见 §二）；需要 diff 上游行为时进入，跑源码 = `pnpm install && pnpm run build && pnpm run dsh`（pnpm monorepo，**不是 `npm install`**）。**repo-local home（现 `.tests`，旧名 `.superd-test`）的线自 2026-09-14 起吃 repo 内 build**（checkout 已 install+build，`apps/cli/lib/bin.js` 即 installation）；⚠️ 带 `DSH_HOME=$HOME/.dsh` / `$HOME/.omp/omp-web` 的线（`archive/ui-preact`、`archive/react-codemod-to-lit`、`archive/multi-agent/agent-omp-sdk`，均已入库 `archive/`）**必须继续用机器全局 dsh，绝不可指向 repo build**——那个 installation 会把 prod home 的 fallback 重写成自己（触碰 `~/.dsh`，红线）。
- **端口纪律（user 恒以非 loopback 实测）**：
  - **4999 = 共用测试口 + live Caddy `test.pc.internal.test → 127.0.0.1:4999`**（`header_up Host` 重写 + 剥 `Origin`，无 gate）：绑 4999 的实例**任何场合用户都能看到**（`https://test.pc.internal.test/?token=…`）。代价 = 同一时间只能一条线占 4999；现役占用方 = super-dsh 线（2026-09-16 user 裁决，详见 `super-dsh/AGENTS.md`），react-lit 线曾用 4998。
  - **非 4999 端口**：用户看不到，需补一条路——(a) Caddy 加域名段（**未经明确批准勿改 live Caddyfile**）；(b) **socat 中继**（dashr §二惯例）：`/usr/bin/socat TCP-LISTEN:<port>,fork,reuseaddr,bind=<LAN_IP> TCP:127.0.0.1:<port>`，只绑 LAN IP、**绝不绑 0.0.0.0**（同口碰撞 EADDRINUSE），并把 `--trusted-host <域名>` / `DSH_TRUSTED_HOSTS` 带上（LAN Host 才过 /api fence）；(c) 走别的线的反代域名。
  - **勿用 config `host: 0.0.0.0` 当 LAN 手段**：CLI `--host 0.0.0.0` 在 rc.2 被硬拒（RCE 门），patch 层字面量 `0.0.0.0` 虽能绕过（schema 仍收），但那是 off-label 的 RCE 暴露面——优先 Caddy / socat。
  - 端口族：4996-4999 为 superd 多线占用（ctx0 / m0 / ctx1-omp / ma），拉起前 `ss -tln | grep -E ':(499[6-9]|309[0-9])'` 查占用，冲突就换（4986 曾用）。
- **拉起 / 关停（sandbox-safe）**：**勿从 agent 沙箱 bash 直拉 daemon**（继承嵌套沙箱 → bwrap 探测失败 `SANDBOX_UNAVAILABLE`）。一律 `systemd-run --user`（沙箱内连 user bus 被拒，单命令 `danger-full-access` 升级）。配方：`WorkingDirectory`=仓根、`Environment=DSH_HOME=<仓根>/.tests`、`UnsetEnvironment=DISPLAY WAYLAND_DISPLAY`、日志 append 到 `.scratch/<unit>.log`、unit 名 `<线名>-<port>-test`。ExecStart 的 launcher：**repo-local home 的线 = repo build**（`/opt/node-v22.23.2/bin/node <仓根>/upstream/deepseek-harness/apps/cli/lib/bin.js --profile <name> --no-open [--trusted-host <h>]`）；**prod-home 的线 = `/home/u1/.local/bin/dsh`**（见上条红线）。**优先复用既有脚本，勿手搓**：现役模板 = `super-dsh/test/start-4999.sh`（唯一；端口预检 + token 提取 + rig 旋钮——per-agent standalone 线已随 2026-09-24「场景退役」删除，场景级验证只走整包 pack 线）；历史模板在 `archive/*/test/`。关停 `systemctl --user stop <unit>`（**勿 kill**）。
- **典型启动链（历史参考：`archive/multi-agent/test/start-4999.sh`，ma 线已存档；现役以 `super-dsh/test/start-4999.sh` 为准）**：`bash start-<port>.sh` → ① `ss` 预检占用即拒 → ② 线自带 bootstrap 幂等生成 `.tests/profiles/<name>/`（`package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml` 端口/host + `pnpm-workspace.yaml`）并 `pnpm install`（hoisted；`@deepseek-ai/*` 靠 fallback 不在 profile 树里）→ ③ `systemd-run --user --unit=<线>-<port>-test -p WorkingDirectory=<仓根> -p Environment=DSH_HOME=<仓根>/.tests -p Environment=PATH=… -p StandardOutput/Error=append:<log> <node> <dsh> --profile <name> --no-open [--trusted-host …]`——argv = **`node <dsh launcher js>`**（`node=/opt/node-v22.23.2/bin/node`；`dsh` = **repo build** `$REPO/upstream/deepseek-harness/apps/cli/lib/bin.js`，`SUPERD_DSH` 可覆盖，缺 build 才回落 `/home/u1/.local/bin/dsh`；shebang 被显式 node 调用绕过）→ ④ 轮询 `ss` 等监听 + 只取本次日志水位后的 token → 打印 local/lan/wan URL。（历史链中的 `scripts/profiles/ma.mjs` 与 `scripts/heal-modules.mjs` 重链步骤已随 2026-09-22 housekeeping 移除。）**进程内接着**：`runCli()` → `runProfile()` → `loadProfile()`（读每个 bundle 的 `dsh.bundle.patch`；0.1.7 起此处**零磁盘写**——`createRuntimeResolution({installAnchor, profile})` 算纯内存表，`PluginPackages` 进程内拦截导入；旧 `healProfilesModuleFallback` 钉 `$DSH_HOME/profiles/node_modules` 的步骤已随该家族消亡）→ `composeEntries()`（bundle patch 依序拍平 + profile patch + `--patch`）→ `boot()` 挂**唯一的 `cordis:include` 根** → Loader 按 `name` 逐个 import/apply → `webserver` 行绑定端口并打印 token（`--no-open` 抑制开浏览器）。
- **token / 认证**：token 每次启动轮换；从 append 日志取时先记 `wc -l` 水位，只在水位之后 grep `?token=…`（否则抓到上一轮）。curl 冒烟 `curl -c jar -L '<token-url>'`（303 靠 cookie 保认证）。存活探针：GET `/` 无 token/cookie → 401 `dsh web authentication required`。
- **验收模式（2026-09-09 user 裁决）**：起了 Web 服务器就停下来交给用户——给出 token URL（+ LAN/WAN URL）、**保持运行**，等用户亲手测完再收尾；不得自行 kill 完才报告。
- 测试/调试：各线 `npm test`；组合查看 `dsh --profile <name> --dump-config`（与 boot 共用同一 patch 算法）。**插件开发/测试的通用规范（组合平面、供给三分桶、依赖归属、client 半边、命令语义、热插拔）见 §七**，机制细节与本仓 adoption 偏差见 [`docs/07-cordis-dsh-dev-test-guides.md`](./docs/07-cordis-dsh-dev-test-guides.md)。

---

## 四、规划与执行工作流（Superpowers）

- **入口纪律（2026-09-24 与 dashr 同源）**：任何任务开始前先读 `.agents/skills/superpowers/using-superpowers/SKILL.md` 并遵循其路由——**只要存在可能适用的技能（哪怕 1% 可能），先调用再行动**。常用路由：「做/设计 X」→ `brainstorming` 先行；「修 bug」→ `systematic-debugging` 先行；带计划执行 → `writing-plans` → `executing-plans`（配 `test-driven-development` + `verification-before-completion`）；分支收尾 → `finishing-a-development-branch`；评审 → `requesting-code-review` / `receiving-code-review`。**优先级：user 指令 > 本仓 AGENTS.md > 技能 > 默认行为**。
- **规格落盘**：变更规格写 `docs/specs/<topic>/spec.md`（纯文档、格式自明，按需创建）；历史提案底稿在 dashr 仓 `openspec/changes/archive/`。
- 流程链：brainstorming（已完成：grilling 4 轮 → 蓝图 v0.4a + ADR 0001–0007）→ **writing-plans**（当前）→ executing-plans / subagent-driven-development。
- 计划落位：`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`；TDD bite-size 任务，每任务独立可测交付 + commit。
- M1 计划序列：**P1 骨架+宿主（计划就绪）** → P2 Machine/Pairing/Selector → P3 DSH adapter 全透传 → P4 OMP adapter → P5 DEV3 remote + 半构建验收。
- 决策落档纪律：设计裁决进蓝图 §9 决策表/ADR；开放问题关闭用蓝图 §11 划掉格式；计划内决策记录在任务 Interfaces。

---

## 五、Repo 状态（2026-09-22 快照，apps/ 退役重排）

- **主线 + 存档布局（2026-09-22 housekeeping，user 四项裁决落地）**：`super-dsh/` = **主线**（原 `apps/agent-worlds`；单一 pack `super-dsh` = `superd-hub` + `agent-{agy,claude,codex,hermes,omp,pi}` adapter 兄弟目录 + `test/` 启动脚本族；局部规则见 `super-dsh/AGENTS.md` 与 `agent-adapter-dev-rules.md`）；`archive/` = **存档线**（`multi-agent/`（git-tracked）、`multi-agent-ctx/`（冻结）、`ui-preact/`、`ui-lit-compile/`、`react-codemod-to-lit/`）——**`apps/` 目录退役删除**（连带清除 `apps/.npm-cache` 469M 旧缓存）；`.tests/` = **dev/test home**（原 `.superd-test` 改名，809M，gitignored；其中 `superd/` = 4999 pack 线专属 home，内含 `agents/<label>/` world home 与 `profiles/<label>/`）；`.worktrees/` = 未来 dev worktree 落位（git 排除）；`upstream/` = 上游 checkout（dev base）；`docs/` 设计正本齐备（blueprint / boundaries / adr / superpowers plans / test-reports）。**已删**：根 `node_modules/`（heal farm 1.2M）、`scripts/`（profiles bootstrap + heal-modules.mjs，bootstrap 回归各线 `test/`）。根 `package.json` 仅占位（无 dependencies、无 scripts）。git 排除分工：`.gitignore` = `.tests/`、`node_modules/`、`upstream/`、`.npm-cache/`、`.dsh_better_edit/`；`.git/info/exclude` = `.scratch/`、`.worktrees/`、`archive/`、`super-dsh/`（exclude 不影响已 tracked 的 `archive/multi-agent`）。
- **运行态（2026-09-22 快照）**：housekeeping 时点 ps 未见本仓 dsh/bin.js 实例（4990/4999 端口有监听、归属未确认；起线前照旧 `ss` 预检）；3080 = Dash Agent prod、3081 = omp-web prod（同机其它仓，勿动）；4999 的 Caddy `test.pc` 指向保持。
- **上游 checkout @ `dsh-v0.1.7-rc.1` 为 dev base**（2026-09-24 对齐轮，清产物重建全绿）：`upstream/deepseek-harness/apps/cli/lib/bin.js` 即 installation。**`@deepseek-ai` 现役 scope = 编译/测试 farm**（`super-dsh/node_modules/@deepseek-ai/*`，`scripts/sync-dsh-farm.mjs` 维护）+ 测试夹具自投影的 home farm（`.tests/hub-test-home`——world-mount 测试自己 project resolution entries，属夹具不属于拓扑；home 级 farm 源料 2026-09-24 退役，`.tests/superd/profiles/node_modules` 已清）；launcher 级 farm 已随 heal 家族消亡。参考源 dsh-omp（OMP adapter 蓝本）与 dashr 仓在同机 `~/workspaces/`。
- 待决：`.agents/`（superpowers 技能目录）入库与否——user 裁决搁置（ignore）。

---

## 六、嵌套 AGENTS.md 约定（Nested AGENTS.md Convention）

子目录可放置自己的 `AGENTS.md` 承载局部规则；本节约定其组织、作用范围与优先级。

- **嵌套（Nesting）**：支持层层嵌套，但**每一层并非都必须有**——只在有实质内容的子目录放置（源码子项目，如 `super-dsh/`、`archive/multi-agent/dsh-multi-agent-registry/`）。根目录本文件是总纲（base），子目录只补充/覆盖本目录相关规则；中间层级无 `AGENTS.md` 则跳过，沿用最近上层。
- **作用范围（Scope）**：每个 `AGENTS.md` 只管辖其所在目录及所有子目录（subtree），不约束兄弟目录、不反向影响上层。
- **优先级（Precedence）**：对某文件，生效规则 = 从根到该文件路径上所有 `AGENTS.md` 的叠加；冲突时离文件最近的胜出（nearest wins）；用户在会话中显式给出的指令优先级高于任何 `AGENTS.md`。
- **定位写法（不写层级号）**：子目录 `AGENTS.md` 声明自身路径并指向上一层（无中间层则直指根目录），不写绝对层级号；后续更深的子模块若有本地需要，由其自行创建。

---

## 七、通用插件开发 / 测试规范（与 dashr 同源，2026-09-24 移植）

> 规范母本 = dashr 仓 `Cordis-dsh-dev-test-guides.md`（user 提供的现行规范）。本仓移植版（含落点映射、源码锚点、**adoption 偏差记账**）见 [`docs/07-cordis-dsh-dev-test-guides.md`](./docs/07-cordis-dsh-dev-test-guides.md)。本节只放**必须照做**的条目；§〇 红线优先于本节。

**组合与插件面**

- **一切皆插件行**：patch 行按 id **整行重述**（非深合并）——改一个字段也要写全该行；插件顺序由 **`inject`** 决定，不看 YAML 位置。
- **两个平面**：跨会话共享的东西放 **host composition**；单 session 贡献放 **agent preset**。**发布服务的行不得裸放 preset**（进程全局 realm，第二个 session 挂载即硬错）；preset 自有的服务必须把**提供者与所有消费者**包进同一个 `isolate` realm group。
- **供给三分桶**：会被组合替换的服务 = **`inject`**（顶多 import 类型做结构镜像）；宿主 API 的库函数/类型 = **`import`** + optional peer；自带真依赖 = **`import`** + `dependencies`。
- **override 三条硬边界**：① 浏览器 module table 同 id = 双侧硬错（无 last-wins）；② cordis 同 scope 同名 service = 硬错（仅祖先 / `isolate` 可遮蔽）；③ 官方 UI 组件遮蔽 = slot 同 cell **更低 priority** 注册（同 priority 报错）。

**client 半边**

- 纯逻辑层写成**可脱离浏览器单测的纯函数**；UI 注入层**只寻址官方表面**（服务方法 / 语义 `data-*` / 官方控件）——**第三方插件 DOM 永不作状态输入**。
- 运行期 = 浏览器 module table：`CLIENT_EXTERNALS` 名单只决定「内联 or 留 `require`」，**不是 `declare`**；官方 UI 原语与宿主**同一模块实例**，**绝不自行 vendor**（本仓名单 + purity gate 在 `superd-hub/scripts/build-client.mjs`）。
- **client lane 门**：client 半边不得被 tsconfig `exclude` 到零类型检查。（已立：`superd-hub/tsconfig.client.json` + `agent-omp/tsconfig.client.json`，串进各自 build 脚本——hub devDep `@types/react` exact 与 shell react 同主版本；见 `docs/07` §6。）

**依赖与版本**

- 归属三分：消费者会装 = `dependencies`；宿主提供 = `peerDependencies` + `optional:true`；仅开发期 = `devDependencies`。
- **版本同源门**：dev 期类型解析源必须与运行期提供者同源。⚠ 预发布 tuple 坑：`>=0.1.5-0 <0.3.0-0` 在 pnpm 解析时**不匹配** `0.1.7-rc.1`，auto-install 会回落三代前的 `0.1.5-rc.3`——**永不子包内 `npm install @deepseek-ai/*`**（物化物理副本 → 双模块实例 → `kScope` 分裂）。

**命令与热插拔**

- `dsh plugin --profile <n> …` = **pnpm 透传**（仅 `allow-version` / `revoke-version` / `version-exemptions` 由 DSH 处理）；tarball / 本地路径**一等支持**（相对路径锚**调用者 cwd**，不是 profile 目录）；子命令是 **`remove`** 不是 `delete`；成功后 `reconcile()` **自动维护 `dsh.profile.bundles`**（勿手改）；失败自动回滚（试装安全）。
- **热插拔 Comply or Explain（2026-09-24 实测修订）**：行为改动应能用「client bundle 重建 + 刷新」「配置热重载」或「`plugin add`/`remove` 热装卸」验证**而不重启**——profile 依赖面（manifest / bundle 增删）**热生效 ≈5–15s**（HMR 连 `package.json` 都 watch）；**不热的只有**：`node_modules` 内**代码替换**（module 层显式 ignore `**/node_modules`）与 installation-scope 表变更（`replace()` throw，进程内冻结）。结论必须在刷新链窗口（**≥15s**）后下、用每请求信号验证活树再读数。**允许重启 ≠ 允许停实例**——4999 整机共享，他人/其他 agent 在用时不碰；重启后必须复验端口 + boot graph（`--dump-config` 看行真挂上）+ 挂载/认证探针。解析表语义（重定向+兜底）与 world 树含义见 `docs/07` §5.3–5.4。
- 启动一律走**产物面**（`apps/cli/lib/bin.js` + 裸 node；tsx 源码启动 = 双平面 symbol split，根因见 §三）；daemon 一律 `systemd-run --user`。

**测试环境**

- 端口**候选表不得写死、归属不得假定**（4999 整机共享）：起线前 `ss` 动态探测，占用即拒。
- **种子（入库、可重生成）与运行 home（gitignored）分离**：本仓 seed = `super-dsh/test/start-4999.sh`，home = `.tests/superd/`。
- **compat / clean 双 home 配对**：长寿命 home 专测「旧 session log 对新版本可读」，可弃 home 专测干净启动；rig README 记 session schema 版本。（已立：`super-dsh/test/README.md`——compat 默认 + `SUPERD_PORT/SUPERD_HOME_DIR` 起 clean rig。）
