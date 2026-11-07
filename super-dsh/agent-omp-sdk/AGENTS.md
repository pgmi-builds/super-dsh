# agent-omp-sdk — AGENTS.md

`@pgmi-builds/agent-omp-sdk` 的本地 AGENTS.md。上层为仓根 `AGENTS.md` 与 `super-dsh/AGENTS.md`；冲突时以本文件为准。

**本文件只记「坑」**——踩过一次、复发过、或反直觉的契约。改这里任何代码**之前先读本文件**；踩到新坑**当场回写**。

本目录是 RPC 转型**之前**那份 OMP 适配器的**完整独立拷贝**（源修订 = `c10ccc4`，即 `super-dsh/agent-omp/` 的 SDK 时代），再把 `@oh-my-pi/*` / `bun` 依赖从交付面剥掉、改成运行期惰性获取。RPC 线（`super-dsh/agent-omp/`）**是另一份代码**：两边不共享任何模块，改本目录**绝不允许**动那边。

---

## 〇、一句话架构

**一个 dsh 进程 = 一个 bun sidecar（`sidecar/main.ts`），sidecar 里养 N 个 OMP 会话**（共享 `authStorage`/`modelRegistry`）——这正是这条线存在的理由（RPC 线是「一会话一 `omp` 子进程」）。dsh 侧只做两件事：**当 producer**（把 sidecar 事件翻成 SessionEvent 经宿主 `ctx.sessionPersistence` 落盘）与**当 bridge**（把 OMP 的 identity/模型面接进 dsh 契约）。读侧（list/page/replay/workspace）全由 dsh 原生组件读 `<DSH_HOME>/sessions`。

**world 身份（与 RPC 线必须不同）**：世界 key `omp-sdk`、roster label `OMP (SDK)`、world home `<dshHome>/agents/omp-sdk`。hub 的 `registerAgent` 对重复 key 硬抛，且 `provisionWorldProfile` 用 `agent-<key>` 推导适配器目录 —— key 就是目录名。**preset id 仍是 `omp`**（能力就是 OMP；世界 key 才需要区分）。

---

## 一、两条铁律（违反即事故）

### 1. 首 prompt 之前零动作（构造函数 / 挂载 / 被动查询都算）

**用户没发第一条真 prompt 之前：没有 sidecar 子进程、没有 runtime 下载、没有 OMP 会话、没有 index 行。**

- `createAgent` / `resume` 两条分支都走 `LazyOmpRpc`（`src/lazy-rpc.ts`）：构造时不 spawn，第一次 `prompt`/`followUp`/`steer`/`ensureStarted` 才动。
- **`ensureSdkRuntime` 只允许出现在 `OmpSdkSidecar#start()` 里**（`src/sidecar-client.ts`），而 `start()` 只被 `LazyOmpRpc#ensure()` 调到。别在任何 module scope、`world-plugin.ts` 的 `apply()`、`OmpProvider` 构造函数、模型目录读、`session/list`、被动查询里调它——那会在「用户根本没开 omp-sdk」时下载 ~900 MB。
- `world-plugin.ts` 的 `diagnoseSdkRuntime` 是**报告**：只看 `<worldHome>/sdk-runtime/{sdk-runtime.json,bin/bun}` 在不在，不 fetch、不 spawn、不 import runtime。
- 回归锚点：`test/sdk-lazy.test.mjs`（构造不 fetch、被动查询不 fetch、两会话 fetch 恰一次）、`test/omp-rpc-decouple.test.mjs`（源级：`ensureSdkRuntime` 的唯一调用点必须在 `sidecar-client.ts`；`index.ts` 不得出现 `spawn(` / `new OmpSdkSidecar(`）。

### 2. 权限档位只在 spawn 那一刻绑定

OMP 的 `--approval-mode` 是 launch flag，**没有任何 RPC/SDK 调用能在中途改**。三档映射（`danger-full-access→yolo` / `workspace-write→write` / `read-only→always-ask`）的解析时刻必须是 **sidecar 真正为这个会话建会话的那一刻**：

- Dash session 的 `permission/preset` 由宿主 `pinInitialPermission` 在 **publish 时**才盖下（晚于 transport wrapper 构造），用户在 **new chat** 里选的那一档又是更晚的一条 `permission/preset`，而 sidecar 会话要等首 prompt 才 materialize。**三点叠加 ⇒ 在 create 时冻结 argv 必然把默认档（`danger-full-access`）冻进会话**。
- 修法 = `LazyOmpRpc` 接受 **thunk argv**（在 `#ensure()` 里调用）+ `resolveSpawnPermission(events, fallback, envMode)`（最后一条有效 `permission/preset` → fallback → `yolo`；`OMP_APPROVAL_MODE` 覆盖）。`index.ts` 的 create/resume 都在 session 准备好之后才 `this.transport.create({ spawnArgs: () => [...] })`。
- `/permission` 影子命令按 child 状态分流（`src/agent.ts` `#handlePermissionCommand`）：未 spawn → `permissionPresets.set()`（落 durable preset + knob 事件，**不**用全局 handler 的 `approval.setPolicy`——它会往 OMP 会话注入一条 narration user message）；已 spawn → 明确拒绝。**绝不接受中途切换**。
- 回归：`test/permission-spawn.test.mjs`（解析序 + 命令分流 + thunk 只在 spawn 时被调用）。

---

## 二、数据面为什么走 `omp … --json` 子进程，而不是 sidecar（授权偏离）

现代数据面（`src/omp-cli.ts` + `src/models.ts` + `src/omp-store.ts`，取自 HEAD 的 `agent-omp`，不是 `c10ccc4` 版本）**不**走 sidecar：模型目录读 `omp models --json`、`modelRoles` 读写 `omp config get/set modelRoles --json`。

**原因（这就是这条偏离的全部理由）**：SDK 时代的数据面经共享 sidecar 走，而 sidecar 的 `start()` 现在挂在惰性 runtime fetch 上——那样**光是 boot 这个 world 或打开一下模型选择器**就会拉起 sidecar，进而下载 ~900 MB。用户裁决是「只有真正启用、真正要起 adapter 时才取依赖」。走 CLI 子进程后，周期性 tick 与模型面只读盘/读 CLI，**零 sidecar**。

- `models.ts` 的 boot 目录：CLI 失败才回落磁盘 `models.db`∪`models.yml`。
- `omp-store.ts` 的 `foreignWriterPid` 仍然导出但**未接线**（RPC 轮的已知暴露，spec §3.4）。
- `src/omp-executable.ts` 是本包自带的 `omp` binary 解析器（逐字节拷自 RPC 线 `rpc-client.ts`，保持独立拷贝而不是共享代码）；env `OMP_EXECUTABLE` 仍是覆盖口，测试用 `FS_ISOLATION` loader hook 钉绝对路径分支。

---

## 三、两个 home（别混）

| 名字 | 是什么 | 定义（`src/knobs.ts`） | 默认 |
|---|---|---|---|
| **`OMP_HOME`** | **sidecar 的 OMP app home**（`agent.db`/`models.db`/`sessions/` + config；也是 `omp … --json` 子进程的 cwd） | `process.env.OMP_HOME ?? resolveOmpNativeHome()` | **原生 `~/.omp`** |
| **`OMP_NATIVE_HOME`** | 操作员原生 OMP 安装（TUI/CLI）：`agent/config.yml`、`agent/models.yml`、原生 session store | `process.env.OMP_NATIVE_HOME ?? ~/.omp` | `~/.omp` |

- 原生读取面一律走 `OMP_NATIVE_HOME`（模型磁盘回落、`OMP_SESSIONS_ROOT`、commands/skills 扫描根、workspace 排除表）。`OMP_HOME` 只作 app 写入目标与子进程 cwd。
- `<dshHome>/agents/omp-sdk/` 是**世界 DSH home**（sessions/storages/settings）**外加**惰性 SDK runtime（`sdk-runtime/`）；**不是** OMP app home。世界根用 `resolveDshHome()`（harness 解析器，env → `~/.dsh`），**绝不裸读 `process.env.DSH_HOME`**（消费者安装没有这个 env，裸读会落到完全不同的树）。
- 测试纪律：拉起 `OmpSdkSidecar` 时**必须**注入 `runtimeFetch` fake，或把 `worldHome` 指向 tmpdir；**绝不允许**任何测试真 fetch、真 spawn bun、写 `~/.omp` / `~/.dsh`。

---

## 四、patch 层（`cordis.patch.yml`）——YAML 也是源码

- **`name` 覆盖被拒**：同一 id 改 `name` 不会重新 import，boot 直接 `patch: name mismatch for "<id>" … skipping`。整插件替换只能 `disabled: true` 旧行 + `insert` 新行（新 id）。
- 本包 patch 的 provider 行 id = `omp-sdk-provider`、name = `@pgmi-builds/agent-omp-sdk`；**super-dsh 复合 patch 里的行 id 是 `agent-omp-sdk`**（默认 `disabled: true`），二者不是同一个 id，别改错。
- `directory-picker-auto` 不是普通别名（删了它 → UI 的「add workspace」消失）；要钉 browse 必须**同时**挂 backend + surface 两个包再 disable auto。细节见 RPC 线 AGENTS.md 同名章节（两边 patch 完全同构）。
- 标题归 OMP：本文件的 `session-title-llm` 保持 disabled；标题只能从 sidecar 帧被动接收。
- `agent-preset-registry.config.default` 钉 `omp`（preset id，不是 world key）。

---

## 五、SDK runtime 契约（spec §2.4）

- 布局：`<worldHome>/sdk-runtime/{bin/bun,package.json,node_modules,sidecar/main.ts,dist/protocol.js}`；marker `<worldHome>/sdk-runtime.json`（**最后写**）；锁 `<worldHome>/sdk-runtime.lock`（mkdir 原子，30 min 判陈旧可夺）；失败留 `<worldHome>/sdk-runtime.error.log`。
- `sidecar/main.ts` 里 `import … from "../dist/protocol.js"` 是**相对 runtime 目录**解析的：所以 fetch 必须把 `dist/protocol.js` 也拷进 runtime（`sdkRuntimeProtocolEntry`），否则 sidecar 一启动就 import 崩。
- 安装行固定 slim：`bun add --exact --ignore-scripts --omit=optional @oh-my-pi/pi-coding-agent@<pin> @oh-my-pi/pi-natives-<platform>@<pin>`。**平台包必须显式补**（`pi-natives` 把绑定声明在 optionalDependencies，单用 `--omit=optional` 会让 import 炸）。`OMP_SDK_KEEP_OPTIONAL=1` 退回全量。
- 安装后 **smoke import**（`PI_CODING_AGENT_DIR`/`OMP_HOME` 指到 runtime 内的 scratch，绝不指 `~/.omp`）；失败 ⇒ 不写 marker、写 error log、抛错并点名 `OMP_SDK_PACKAGE_VERSION`。
- pin 默认 **18.5.0**：18.4.9 的源码面是坏的（`./ratchet/prelude` 无扩展名 → 解析到模板 `.js` → `createRatchetPrelude` 找不到）。`18.2.11` 是最后已知可用兜底。
- **失败 fail loud，绝不静默回落到 RPC 线**（那是另一行，用户没开）。
- 生产 deps builder = `createSdkRuntimeDeps(pluginDir)`（模块内，不是脚本里）：`scripts/fetch-sdk-runtime.mjs` 与首 prompt 的 `start()` **共用同一个实现**，防止两条路漂移。

---

## 六、测试锚点（全 fakes，零真 bun / 零网络 / 零真 home）

`npm test`（先 `npm run build`，测试 import `dist/`）：

- runtime 引导：`sdk-runtime.test.mjs`（布局、slim argv、幂等、半成品自愈、identity 失配重取、锁冲突/夺锁、失败写 trace、smoke 失败、manifest 无依赖）；
- 惰性 + 单例：`sdk-lazy.test.mjs`（构造零 fetch；被动查询零 fetch；两会话 fetch 恰一次；fake runtime 布局被 spawn 使用）；
- 源级不变量：`omp-rpc-decouple.test.mjs`（`ensureSdkRuntime` 唯一调用点在 `sidecar-client.ts`；`index.ts` 只经 transport 建 wrapper）；
- 权限：`permission-spawn.test.mjs`；
- 其余纯函数/磁盘面：`omp-store`、`omp-model-roles-disk`、`omp-disk-discovery`、`agent-preset-roster`、`store`、`sidecar-singleton`。

**已删除、不要恢复**：`modelroles` / `sidecar-decouple`（真 spawn sidecar 的真 runtime 测试）、`mobile-boot`（2026-11-08 mobile 全退役：world webui 已于 2026-09-26 T-D 裁决退役，「没有任何地方渲染 world page」，`__AGENT_OMP_MOBILE__` 注入成死代码）、`mobile-gesture`（client half 的纯函数）、RPC 时代的 `lazy-rpc` / `rpc-client` / `resolve-executable` / `no-sidecar` / `omp-cli-rpc` / `package-contract`（覆盖改由 `omp-rpc-decouple` + `sdk-lazy` + 本目录的 manifest guard 承担）——它们要么测的是 RPC 传输，要么需要真 runtime。
