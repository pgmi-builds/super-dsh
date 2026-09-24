# Cordis / DSH 开发与测试指南（superd 移植版）

> **来源**：dashr 仓 [`Cordis-dsh-dev-test-guides.md`](/home/u1/workspaces/dashr/Cordis-dsh-dev-test-guides.md)（草案 v0，2026-09-24）。
> 本文件把其中**与本仓共用**的规范移植过来，并按 superd 现实（单 pack `super-dsh` = `superd-hub` + `agent-<runtime>`；测试 home `.tests/superd`；4999 交付形态线）改写落点。
> dashr 专有内容（better-dsh 插件、dashr distro、`.tests/test123`、供应链年龄门的具体 exclude 配置）不在此列——需要时去正本源读。
>
> **优先级**：user 指令 > 根 `AGENTS.md` §〇（发布与验收红线）> 本文件 > 各包/子目录 `AGENTS.md`。
> **状态**：2026-09-24 移植。标 ⚠ = 实测事实；标 ❗ = **本仓当前偏差**（按 §5 的 Comply-or-Explain 记账，见 §6）。

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
- ❓ 待验证：本地 tarball 是否触发 profile 的**供应链年龄门**（registry 安装有 ≈24h 门；本地 tarball 预期不触发）。pnpm 侧记录：版本号形式的 exclude 只作用于解析相位，**裸包名**才全相位生效（dashr 正本 A5–A7 实证）。

---

## 5. 热插拔规范（Comply or Explain）

### 5.1 三种「热插拔」不是一回事（⚠ 正本实测边界）

| 变更对象 | 现状 | 生效方式 |
|---|---|---|
| **profile 配置**（`cordis.patch.yml` / 行 config） | **默认开**（base bundle 的 `hmr` 行：`disabled: !!js "!ctx.get('profileContext')"`；`watch-config.ts` 精确监听 patch 文件） | **改文件即热生效** |
| **插件 host 代码**（`dist/*.js`） | **默认关**（`root: []` = 不 watch 任何模块根，模块监听是显式 opt-in） | 把模块根加进 `hmr.config.root`，或重启 |
| **插件 client bundle** | **支持**：宿主按 artifact rev 提供 bundle | 重建产物后**刷新页面即生效，无需重启 daemon** |
| **组合结构变化**（增删 bundle、新增 package、依赖树变化） | **不支持进程内热插拔** | **必须重启 profile** |

### 5.2 条文

1. **默认要求**：插件的**行为改动**应能通过「client bundle 重建 + 刷新」或「配置文件热重载」验证，**不重启实例**。
2. **Comply or Explain**：做不到 1 的，必须在插件 README 或报告里给出**具体原因**（「开发不到位」是默认结论）。
3. **允许重启的情形**：涉及 boot/loader；涉及组合结构（增删 bundle/依赖树）；插件首次安装或卸载。
4. **允许重启 ≠ 允许停实例**：卸载走 `dsh plugin remove`，**不得**用「把 4999 停掉」代替清理。⚠ 4999 是整机共享端口——**他人/其他 agent 在用时不碰**。
5. 重启后必须**复验**：端口、boot graph（`--dump-config` 看行真挂上）、以及认证/挂载探针（不是「进程活着」就算数）。

---

## 6. 本仓 adoption 状态（实测，2026-09-24）

**已符合**：交付形态测试（tarball 而非 symlink farm）；端口动态预检 + 外来占用拒绝；**产物面启动**（repo build 的 `apps/cli/lib/bin.js` + 裸 node；禁止 tsx 源码启动——双平面 symbol split，仓根 AGENTS §三有根因）；种子/运行 home 分离；LAN 只走用户态中继；daemon 一律 `systemd-run --user`（沙箱内直拉 = `SANDBOX_UNAVAILABLE`）。

**❗偏差 1（client lane 缺失）**：`superd-hub/tsconfig.json` `exclude: ["src/client"]`、`agent-omp/tsconfig.json` `exclude: ["src/client","src/mobile/client"]` ⇒ 两个 client 半边**零类型检查**。本轮探针实测代价：hub client **22 错**（全部源自缺 `react` 类型）、omp client **2 个真实错误**（`index.ts` 的 `.ts` 扩展名 import；`MobilePageConfig.enabled` 必填 vs 页面 global `__AGENT_OMP_MOBILE__` 可选）。
**修复路径**（未执行，待 user 放行）：每包加 `tsconfig.client.json`（`lib: DOM`、`jsx: react-jsx`、`noEmit`）+ 把 typecheck 串进 `build-client`；hub 另需 devDep `@types/react`（types-only，不进 farm、不碰 `@deepseek-ai`）。

**❗偏差 2（clean home 角色缺失）**：现只有长寿命 `.tests/superd`（= compat 角色）；「每次可弃」的 clean rig 未立。修复路径：给 `start-4999.sh` 加 home 覆盖（或另起 `start-clean.sh`），并在 rig README 记 session schema 版本。

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
