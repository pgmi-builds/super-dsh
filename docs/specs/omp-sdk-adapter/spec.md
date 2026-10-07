# OMP SDK 面 —— 可选 adapter（`omp-sdk`），默认 disabled + 惰性取依赖

- 日期：2026-10-03
- 状态：spec（待实现）
- 相关：`docs/specs/omp-rpc-transport/spec.md`（RPC 线，现役默认）、`super-dsh/agent-agy-sdk/src/sdk-venv.ts`（惰性取依赖的先例）

## 0. 动机（2026-10-03 user 裁决）

RPC 线（`agent-omp`）已被接受为默认：直接跑用户本机 `omp` binary，插件零自带 runtime（省 838 M），权限档位按 new-chat 选择在 spawn 时刻绑定。

代价是**内存形态**：RPC 面是「一个 Dash 会话 = 一个 `omp --mode rpc` 子进程」，实测每会话 private ≈ 240 MB、两会话 PSS ≈ 536 MB（`docs/test-reports/2026-10-03-agent-omp-permission-spawn-binding.md` §3）。旧 SDK 线是**一个 bun 进程承载 N 个会话**（`shared authStorage / modelRegistry across all sessions it hosts`），边际成本远低于此。

user 裁决：把旧 SDK 线**恢复成另一个可选 adapter（`omp-sdk`）**，在插件里**默认 disabled**，由 DSH plugin manager 逐项 on/off；真的 turn on 才走 SDK 路线。约束两条：

1. **不 declare 任何 dependency**（不写进 `package.json` 的 dependencies/optionalDependencies）；
2. **只有启用后、真正要 spin up adapter 进程时，才自己去 fetch 依赖**——安装插件时不得有任何 dependency/postinstall 阻碍。

## 1. Ground truth：所谓「SDK binary」就是同一个程序（2026-10-03 实测）

**结论：`@oh-my-pi/pi-coding-agent` 与用户本机的 `omp` binary 是同一套代码的两种打包，不是两个 binary；`omp` 已经提供了「SDK 面」（`--mode rpc` 就是其一面，和 TUI/headless 并列）。**

证据（全部本机可复现）：

| # | 事实 | 来源 |
|---|---|---|
| 1 | npm 包的 `bin` 就是 **`omp` → `dist/cli.js`**，`engines: { bun: ">=1.3.14" }` | `npm view @oh-my-pi/pi-coding-agent@18.4.9 --json` |
| 2 | 版本同源：本机 `omp --version` = **`omp/18.4.9`**，npm 对应版本号同族（latest 18.5.0） | `omp --version` |
| 3 | binary 内嵌该包名与 Bun：`strings omp` 含 `@oh-my-pi/pi-coding-agent`、`Bun v1.4.2 (Linux x64)`、以及内部路径 `modes/rpc/rpc-mode` | `strings /home/u1/.local/bin/omp` |
| 4 | 同一句 help 两侧都在：`Output mode: text (default), json, rpc, or rpc-ui`（binary 2 处；npm 包 `src/cli/args.ts`、`src/cli/flag-tables.ts`） | strings + grep |
| 5 | npm 包 `src/modes/rpc/rpc-mode.ts` 的命令表与我们 RPC client 发的命令逐一对应：`prompt / follow_up / steer / set_model / abort / new_session / get_state / get_messages / get_session_stats / get_subagents / compact` | grep `case "…"` |

同一个 binary 的**多个面**（与「TUI / headless」同构）：`--mode text｜json｜rpc｜rpc-ui`，外加扩展/插件（`--plugin-dir`、`-e`、hooks）。其中 `rpc` 面 = 我们现在用的那条。

**SDK 面唯一独有的是 in-process library 用法**：`import { createAgentSession, SessionManager, ModelRegistry, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent"` —— 一个 bun 进程里开 N 个会话、共享 authStorage/modelRegistry。RPC 面做不到这点：`rpc-mode.ts` 的命令表只有 `new_session`（**切换**当前会话），没有任何多会话 attach/pool 命令。

### 成本（这就是「别在安装期拉」的理由）

- npm 包本体：**55 MB unpacked / 3083 files**（`@oh-my-pi/pi-coding-agent@18.4.9`）；
- 真实装树：`~/.dsh/profiles/web/node_modules/@oh-my-pi` = **448 MB**（transitive：`@oh-my-pi/pi-natives`（含 `pi-natives-linux-x64` 预编译）、puppeteer-core、`@huggingface/transformers`、`sherpa-onnx-node`、opentelemetry 全家…）；
- 另需 **bun 运行时**（本机现无 bun：`~/.bun/bin/bun` 已删，`command -v bun` 是断链）。
- 旧 pack 线实测：`@oh-my-pi` 762 M + bun 76 M ≈ **838 M**（这正是 RPC 轮省下的那笔）。

## 2. 设计

### 2.1 形态：兄弟目录 + 第二行，**整包复制**（2026-10-03 user 裁决改版）

user 裁决：不做共享桥接，**把转型前那一份 adapter 完完整整复制成一个独立包**（"让整个包作为一套完整独立的包…去查 git history，找到我们在 OMP 转型之前的那一份代码，完完整整地 copy 过来，然后再把那些 dependency 清除掉"）。

```
super-dsh/agent-omp/         ← 现役 RPC 线（不动）
super-dsh/agent-omp-sdk/     ← 新：完整独立 adapter（复制自 c10ccc4，即 RPC 系列之前的最后一份 SDK 线）
    src/*.ts                    全套桥接（agent/index/store/models/discovery/permission/…）
    src/sdk-client.ts           单例、多会话复用（SDK 传输）
    src/sidecar-client.ts       起 `bun run sidecar/main.ts`
    src/lazy-rpc.ts             首 dispatch 才 materialize（SDK 版）
    src/sdk-runtime.ts          ★惰性 get-ready（bun + pi 包 → world home）
    sidecar/main.ts             旧 sidecar（bun 里 import pi SDK）
    cordis.patch.yml            provider row（`@pgmi-builds/agent-omp-sdk`）
```

**源修订版 = `c10ccc4`**（`ec4e8a8` 之前一个 commit；实证 `c10ccc4:src/lazy-rpc.ts` 仍驱动 `OmpSdkClient`）。刻意**不带 client 半边**（precedent：`agent-agy-sdk` 也不带；重复注册会与 `agent-omp` 的 client 面撞）。

**授权偏离 3 处**（详见计划 T2）：① `world-plugin.ts` 身份改 `omp-sdk`/`OMP (SDK)`、RPC 专有的 binary 探测换成不 fetch 的 runtime 探测；② 数据面（`models.ts`/`omp-cli.ts`/`omp-store.ts`）取 **HEAD 版**（导出面逐字相同）——SDK 期数据面走共享 sidecar，会让 world 一 boot 就 fetch 900 MB，违反惰性约束；③ 移植 `b09effb` 的权限绑定（副本源早于该 fix，不移植会重演 new-chat 回弹）。

### 2.3 行/身份/开关

```yaml
# super-dsh/cordis.patch.yml
- id: agent-omp-sdk
  name: 'super-dsh/agents/omp-sdk'
  disabled: true          # 默认关：开 = plugin manager 的 setPluginEnabled()
```

- world key `omp-sdk`、roster label `OMP (SDK)`、world home `<dshHome>/agents/omp-sdk`（与 `omp` 并存不冲突，hub 的 `registerAgent` 不会撞 key）。
- 开/关机制**不需要新造**：DSH plugin manager 的 `setPluginEnabled(id, enabled)` 把行写进 **profile patch** 并 HMR 重载（`packages/boot/plugin-manager/src/index.ts:425` → `writePluginEnabled(profile.patchPath, …)`）；profile 层同 id 行覆盖 bundle 层行 —— 正是 composite patch 头部注释承诺的「每行都可单独 toggle」。
- row disabled ⇒ 该目录**一个模块都不 import** ⇒ 零网络、零 bun、零 fetch。

### 2.4 惰性 runtime fetch（`src/sdk-runtime.ts`）

语义照抄 `agent-agy-sdk/src/sdk-venv.ts`（世界 home 落地、幂等两段式、marker 判完整、lock 防并发、失败留 error log 且 fail loud），落地目标换成 node 世界：

```
<worldHome>/sdk-runtime/
  bin/bun                      ← ① GitHub release `bun-linux-x64.zip` 解出（curl + unzip）
  package.json / node_modules/ ← ② `<bin/bun> add --exact @oh-my-pi/pi-coding-agent@<pin>`
  sidecar/main.ts              ← ③ 从插件目录 copy（bun 的模块解析从 runtime 目录走 node_modules）
  dist/protocol.js             ← ③ 同上（sidecar 的 `../dist/protocol.js` 依赖）
<worldHome>/sdk-runtime.json   ← marker（插件版本 + pi pin + bun 版本）；失配 ⇒ 重取
<worldHome>/sdk-runtime.lock   ← mkdir 原子锁
<worldHome>/sdk-runtime.error.log ← 只在失败时写
```

- pin 默认 = **`18.5.0`**（env `OMP_SDK_PACKAGE_VERSION` 可覆盖）；bun 版本可覆盖 `OMP_SDK_BUN_VERSION`。
  **为什么不是本机 binary 同版的 18.4.9**：18.4.9 的 **源码面（`exports.import` → `src/*.ts`）是坏的**——`src/sdk.ts` 以无扩展名 `./ratchet/prelude` 导入，bun 解析到**模板文件** `src/ratchet/prelude.js`（不是模块）而不是真模块 `prelude.ts`，实测 `bun -e 'await import("@oh-my-pi/pi-coding-agent")'` 报 `SyntaxError: Export named 'createRatchetPrelude' not found`。18.5.0 上游已把真模块改名 `./ratchet/prelude-definition` 而修复（实测 12 个导入全在、`VERSION 18.5.0`）；18.1.14/18.2.11/18.3.x 无 ratchet，18.2.11 实测可加载（备选）。**包本体是预打包的 `dist/cli.js`（=本机 binary 的来源），所以这个坏只砸源码面，不砸 binary。**
- **安装后必须做 smoke check**：`<bun> -e 'await import("@oh-my-pi/pi-coding-agent")'`（cwd=runtime 目录，`PI_CODING_AGENT_DIR`/`OMP_HOME` 指到 runtime/scratch 内，绝不指 `~/.omp`）；失败 ⇒ 不写 marker、写 error log、抛错并提示 `OMP_SDK_PACKAGE_VERSION` 覆盖。上游类打包回归靠这道检查在 **fetch 时刻**抓住，而不是等到首轮对话炸。
- **安装行（slim，实测最优）**：
  ```
  <bun> add --exact --ignore-scripts --omit=optional \
    @oh-my-pi/pi-coding-agent@<pin> @oh-my-pi/pi-natives-<platform>@<pin>
  ```
  `<platform>` = `linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64`（由 `process.platform/arch` 纯函数映射）。
  **为什么必须显式补平台包**：`@oh-my-pi/pi-natives` 把平台绑定声明在 **optionalDependencies**，单用 `--omit=optional` 会让 `await import(…)` 直接炸（`Failed to load pi_natives native addon for linux-x64`）。
- **实测成本（2026-10-03，`.scratch/omp-sdk-fetch-probe-results.md` 有全表）**：bun release zip **36.6 MB**；全量 = **1133 MB**（114 包）；`--omit=optional` 单用 = 535 MB 但 **import 失败**；**slim = 899 MB（84 包）且 import 通过**。丢掉的是 `@huggingface/transformers` + `onnxruntime-{node,web}`（234 MB），而 `onnxruntime-node` 的 native 安装脚本本来就被 `--ignore-scripts` 挡下（**死重**）。`OMP_SDK_KEEP_OPTIONAL=1` 可退回全量。`BUN_INSTALL_CACHE_DIR` 重定向后缓存 **1154 MB**，安装成功后**删除**。
- `bun add` 用 `--ignore-scripts`（`pi-natives` 有 `build` 脚本，但平台预编译包 `@oh-my-pi/pi-natives-linux-x64` 已覆盖，无需跑构建）；
- **失败 fail loud**：首轮 prompt 以明确错误冒到会话（"omp-sdk runtime fetch failed: …"），并在世界 home 留 error log；**绝不静默回落到 RPC 线**（那是另一行、用户没开）。
- 触发点 = 该 world 的**首个真实 dispatch**（首 prompt），与 RPC 线同一条零 spawn 不变量：draft/浏览/被动查询一律不动。

### 2.5 不变量

1. **安装期零依赖**：`agent-omp-sdk/package.json` 不出现 `@oh-my-pi/*`、`bun`；无 postinstall / allow-scripts 钩子；`npm pack` 出来的 tarball 里没有这些包的任何字节。
2. **disabled 即不存在**：行关着 ⇒ roster 无 `omp-sdk`、零进程、零网络、零磁盘（除既有 home）。
3. **不污染 RPC 线**：RPC 行的 roster/进程/行为不变（74 项 agent-omp 测试 + 4997 探针复跑）。
4. **零 spawn 窗口**：SDK 线同样「首 prompt 之前零动作」——fetch 与 sidecar start 都挂在首 dispatch 上。
5. **单例**：SDK 线**一个 dsh 进程一个 sidecar**（多会话复用），这正是启用它的理由；回归测试必须能证伪（两会话 ⇒ 一个 bun 进程）。

## 3. 已知风险 / 开放问题（2026-10-03 更新）

1. ~~**帧词汇兼容**~~ **已消解**：改为整包复制后，sidecar 与其客户端（`protocol.ts` + `sdk-client.ts`）成套来自同一修订版，词汇按构造成立。
2. **bun 版本门**：包声明 `engines.bun >= 1.3.14`；marker 记录 bun/pi 版本，失配即重取。
3. ~~**`--ignore-scripts` 边界**~~ **已实测排除**：`@oh-my-pi/pi-natives` 的平台绑定以 **optionalDependencies** 发布（`@oh-my-pi/pi-natives-linux-x64` 等），slim 配方显式补装平台包即可；被挡下的两个 postinstall 是 `onnxruntime-node`（`node ./script/install`）与 `protobufjs`，前者属被 `--omit=optional` 丢掉的 transformers 树。集成预探（`.scratch/omp-sdk-sidecar-integration-probe.md`）证明 sidecar 在 18.5.0 + bun 1.4.2 上 boot 1.1 s、`models.list` 5 providers/46 models、**`session.create` 构造出真实 AgentSession**。
4. **磁盘占用**：slim runtime 实测 **899 MB**（+ bun 二进制；缓存装完即删），落在 world home，仅用户主动开启并首次使用时产生。
5. **首次使用的等待**：首 prompt 会阻塞在 fetch 上（实测 bun zip 36.6 MB + install ~5 s，网络差时更久）。当前设计是 fail loud 而非静默降级；若体验不佳，后续可加"下载进度"事件或预取命令（`npm run fetch-sdk-runtime` 已提供手动预热）。
6. **权限语义与 RPC 线的差异**：SDK 面把 `--approval-mode` 作为**会话创建参数**交给 sidecar（不是进程 launch flag），因此"中途切换"在这个面上技术上也许可行——本轮按 user 要求与 RPC 线保持一致的 UX（未 spawn 可切、已 spawn 拒绝），未探索中途切换。
