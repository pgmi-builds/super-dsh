# 计划：`omp-sdk` 可选 adapter（SDK 面恢复 + 惰性取依赖）

- 日期：2026-10-03
- 规格：`docs/specs/omp-sdk-adapter/spec.md`（本计划的接口正本）
- 前置：`docs/specs/omp-rpc-transport/spec.md`（现役 RPC 线，本计划**不得**改变其行为）
- 方法：Superpowers（writing-plans → subagent-driven-development：每任务一个 fresh implementer + 任务评审 + 修复轮）
- 目标：把旧 SDK 线恢复成**默认关闭、可单独开启、开启后才自行取依赖**的第二条 OMP adapter 行

## 验收（全部满足才算完成）

1. `npm pack` 出来的 tarball 里 **没有任何 `@oh-my-pi/*` / `bun` 依赖声明或字节**（除了 `agent-omp-sdk/sidecar/main.ts` 这份我们自己的源码）；`package.json` 无 postinstall。
2. 行 `agent-omp-sdk` 默认 `disabled: true`；关闭时 roster 无 `omp-sdk`、零进程、零网络、世界 home 无 `sdk-runtime/`。
3. plugin manager 打开该行（`setPluginEnabled`）后：roster 出现 `omp-sdk`，**仍未**取依赖；首个真 prompt 才 fetch（bun + pi）+ 起 sidecar + 跑完一轮真模型对话。
4. **单例证明**：同一 dsh 进程两个 SDK 会话 ⇒ **一个** bun sidecar 进程（`pgrep -af 'bun.*sidecar'` 计数 1），内存读数记入报告。
5. RPC 线零回归：`agent-omp` 74 项测试全绿 + 4997 既有探针复跑读数不变。
6. 报告 `docs/test-reports/2026-10-03-agent-omp-sdk-adapter.md`（含上述读数），**不 publish**。

## 任务

### ~~T1 — 传输 seam~~（**2026-10-03 user 裁决作废**）

> user 改判：**不做共享 seam，改为整包完整复制**（"让整个包作为一套完整独立的包…去查 git history，找到我们在 OMP 转型之前的那一份代码，完完整整地 copy 过来"）。
> 因此 T1 的 seam 改动已从 `agent-omp` 全部回退（该线保持 74/74 绿、行为不变），`OmpTransport` 接口不再存在。
> 唯一保留自 T1 的产出：`test/package-contract.test.mjs` 的 sidecar 守卫改为「RPC 线不 ship sidecar；唯一例外是 `agent-omp-sdk/sidecar`」。
> 命名裁决（user，三选一已选）：目录 `agent-omp-sdk/` + npm `@pgmi-builds/agent-omp-sdk`（与 `agent-agy-sdk` 完全同构）。

### T2 — 整包复制 `c10ccc4:super-dsh/agent-omp/`（**真实源 = 转型前最后一份**）

**源修订版 = `c10ccc4`**（RPC 系列 `ec4e8a8` 的前一个 commit；实证 `c10ccc4:src/lazy-rpc.ts` 仍驱动 `OmpSdkClient`）。

**交付**：`super-dsh/agent-omp-sdk/` 拿到完整 adapter（`src/*` 除 client 半边、`sidecar/main.ts`、SDK 期测试），加上已建好的 `src/sdk-runtime.ts`。

**排除**（刻意）：client 半边（`src/client/`、`src/mobile*`、`scripts/build-client.ts`、`tsconfig.client.json`、`lib/`）——precedent = `agent-agy-sdk` 也不带 client 半边，且重复注册会与 `agent-omp` 的 client 面撞；RPC 期测试/文件（`rpc-client.ts`、`no-sidecar/lazy-rpc/rpc-client/resolve-executable/omp-cli-rpc/permission-spawn` 测试）。

**授权偏离（3 处，报告须列）**：
1. `world-plugin.ts` 身份：`KEY='omp-sdk'`、label `OMP (SDK)`；`diagnoseOmpBinary()`（RPC 专有）换成**不 fetch** 的 SDK runtime 探测。
2. 数据面用 **HEAD 版**的 `models.ts` / `omp-cli.ts` / `omp-store.ts`（导出面逐字相同，drop-in）：SDK 期数据面走共享 sidecar，会让「world 一 boot 就 fetch 900 MB」，违反惰性约束；现代版走 `omp … --json` 子进程且不直写用户 config。
3. 权限绑定：把 `b09effb`（今天那份 permission fix）移植进副本（`resolveSpawnPermission` + `/permission` 按 child 状态分流 + `index.ts` spawn 时刻解析 + `lazy-rpc` argv thunk）；副本源 `c10ccc4` 早于该 fix，不移植会重新引入「new chat 选完回弹」。

**Phase B（依赖 → 运行时 get ready）**：删掉 `@oh-my-pi/pi-coding-agent` + `bun` 依赖声明；`sidecar-client.ts` 里走 `node_modules/.bin` 找 bun 的逻辑换成 `ensureSdkRuntime(worldHome, deps)`（用 `<runtime>/bin/bun` + `<runtime>/sidecar/main.ts`），**只在首个真实 dispatch 触发**（无 boot/mount/被动查询触发）；真 deps 构造器从 `scripts/fetch-sdk-runtime.mjs` 抽成模块共享；fetch 失败 fail loud（点名 `OMP_SDK_PACKAGE_VERSION`），绝不回落 RPC 线。

**测试**：SDK 期测试（singleton / lazy / protocol / store / modelroles …）复活并适配；新增：world 身份=`omp-sdk`、runtime 探测不 fetch、fetch 只在首 dispatch、两会话一次 sidecar start。全 fakes，零真 bun/omp/网络。

### T3 — 惰性 runtime fetch（可与 T2 并行）

**交付**

- `src/sdk-runtime.ts`：布局 + `ensureSdkRuntime(worldHome, deps)`（幂等、lock、marker、error log）；`deps` 注入 `{ download, run, copy, now }` 便于假实现测试。
- `scripts/fetch-sdk-runtime.mjs`：手动预热（照 `agent-agy-sdk/scripts/fetch-venv.mjs`）。

**实现要点（spec §2.4）**：bun release zip → `bin/bun`；安装行 = `bun add --exact --ignore-scripts --omit=optional @oh-my-pi/pi-coding-agent@<pin> @oh-my-pi/pi-natives-<platform>@<pin>`（**平台包必须显式补**，否则 import 炸；`OMP_SDK_KEEP_OPTIONAL=1` 退回全量）；copy sidecar + protocol 进 runtime dir；**smoke import**（失败即抛，不写 marker）；marker = `{pluginVersion, piVersion, bunVersion}`；pin 默认 **`18.5.0`**（`OMP_SDK_PACKAGE_VERSION` 覆盖）。缓存 `BUN_INSTALL_CACHE_DIR=<runtime>/.cache`，成功后删除。实测：slim 899 MB / 84 包，全量 1133 MB，bun zip 36.6 MB。

> **pin 事实（2026-10-03 实测）**：`18.4.9`（本机 binary 同版）的**源码面是坏的**（`src/ratchet/prelude.js` 遮蔽真模块 `prelude.ts` → `SyntaxError: createRatchetPrelude not found`）；`18.5.0` 上游已修（实测 12 个旧 sidecar 导入全在、VERSION 18.5.0）；`18.2.11` 亦可（无 ratchet）。bun zip 36.6 MB；安装后 node_modules 1133 MB + 缓存 1154 MB（缓存可删）。

**TDD**：纯函数（layout/marker/版本失配判定）+ 假 `download/run` 的流程测试（幂等第二次零下载、lock 冲突、失败写 error log 且抛出、marker 写最后）。

### T4 — world / row / pack 接线（大部分已由控制者完成）

**已完成**（2026-10-03，控制者）：根 `super-dsh/package.json` 的 `exports["./agents/omp-sdk"]` + `files` 四条；`super-dsh/cordis.patch.yml` 的新行 `agent-omp-sdk`（`disabled: true`，含 rationale 注释）；`scripts/pack.mjs` 的 `AGENTS` 列表加入 `agent-omp-sdk`。

**T2 负责**：`agent-omp-sdk/src/world-plugin.ts` + `dist/world-plugin.js`（key `omp-sdk`、label `OMP (SDK)`）；包内 `cordis.patch.yml`（provider row `@pgmi-builds/agent-omp-sdk`）；包内交付清单守卫测试（dependencies 空、manifest 无 `@oh-my-pi`/`bun`、无 postinstall）。

**验收前需复核**：`node super-dsh/scripts/pack.mjs` 能构建 `agent-omp-sdk`（tsc）并在 tarball 里带上 `agent-omp-sdk/{dist,sidecar,package.json,cordis.patch.yml}`，且 tarball 内**无** `@oh-my-pi`/`bun` 依赖声明与字节。

### T5 — 4997 实机验收（dev3 实装属后续放行轮）

按「验收」六条逐项探针化并落报告；内存读数与 RPC 线两会话（536 MB PSS）对照。

## 顺序与并行

```
T3（已完成，19/19 绿）──┐
                        ├──► T2（整包复制 + Phase B 接线 + Phase C 权限移植）──► T4（复核 pack）──► T5（4997 实机）
T4 的 manifest/row/pack 清单（已完成）┘
```
T1 作废（seam 不需要）；`agent-omp` 已回退到 74/74 绿且行为不变。

## T4 接线事实（2026-10-03 复核，实现者直接照此走）

- `superd-hub/src/world-provision.ts:139-144` 用 **约定推导** adapter 目录：`join(lineRoot, \`agent-${key}\`)`，并要求该目录有 `package.json`；world profile 的 bundles = `[...WORLD_BASE_BUNDLES, opts.adapterPkg]`。⇒ **world key 必须是 `omp-sdk`**（对应兄弟目录 `agent-omp-sdk/`），adapterPkg = `@pgmi-builds/agent-omp-sdk`。
- 世界树里只链接 `@pgmi-builds/{agent-omp-sdk, superd-hub}`（`world-provision.ts:21`）。SDK 包对 `agent-omp` 的复用一律走**包内相对路径** `../../agent-omp/dist/index.js`（tarball 里两目录平级，解析成立，与各 adapter 引 `../../superd-hub/dist/index.js` 同例）。同一 world 内只有一条加载路径 ⇒ 无 `kScope` 双实例风险。
- 行开关（user 侧）：plugin manager `setPluginEnabled('agent-omp-sdk', true)` → `writePluginEnabled(profile.patchPath, …)` 写 profile 层同 id 行覆盖 bundle 层 + HMR reload（`packages/boot/plugin-manager/src/patch.ts:14`）。

## T5 探针 API（2026-10-03 在役 4997 上实测，直接照抄）

- 列行：`POST /api/pluginManager/listPlugins`，信封 `{"args":{}}`（ctx0 原生口，非 `/hub`）。
  行形如 `{entryId:"include:agent-omp-sdk", moduleName:"super-dsh/agents/omp-sdk", enabled:false, patchId:"agent-omp-sdk", fiberPhase:null}`。
- 开关：`POST /api/pluginManager/setPluginEnabled`，`{"args":{"id":"include:agent-omp-sdk","enabled":true}}`
  → `{stage:'enable', changed:true, application:'applied', warnings:[]}`；写进 **profile patch**（`<home>/profiles/<p>/cordis.patch.yml` 追加 `- id: agent-omp-sdk` + `disabled: false|true`）并 **HMR 热挂/热卸**。
- **已在役验证（用 `agent-agy-sdk` 行做对照，随后已还原）**：on → `listPlugins.enabled=true` / `fiberPhase=active` / roster 多出 `agy-sdk`；off → 行回 `disabled: true` / roster 掉回 7 项；全过程 `world failed` 计数 **0**、无需重启。
- 结论：user 说的「每一项都能在 plugin manager 里 on/off」成立，**我方无需新造任何开关机制**。
