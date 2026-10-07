# `omp-sdk` 可选 adapter —— 惰性 runtime + 4997 pack-line 验收

- 日期：2026-10-03
- 规格：`docs/specs/omp-sdk-adapter/spec.md`；计划：`docs/superpowers/plans/2026-10-03-agent-omp-sdk-adapter.md`
- 形态：**交付形态**（`node super-dsh/scripts/pack.mjs` → tarball → pnpm `file:` 装进 profile → repo build 的 dsh CLI）
- 现场：`superd-4997-test.service`（+ `superd-lan-4997-relay.service`），home = `.tests/superd`

## 0. user 裁决（2026-10-03）

RPC 线（`agent-omp`）保持默认；把转型前的 SDK 线恢复成**第二个可选 adapter `omp-sdk`**：

1. **包名与现有命名同构**：目录 `agent-omp-sdk/`、npm `@pgmi-builds/agent-omp-sdk`、world key `omp-sdk`、roster label `OMP (SDK)`、pack 子路径 `super-dsh/agents/omp-sdk`。
2. **整包完整复制**（不是共享桥接）：源 = `git` 里 OMP 转型前的最后一份（**`c10ccc4`**，实证其 `lazy-rpc.ts` 仍驱动 `OmpSdkClient`）。
3. **不 declare 任何依赖**；被移除的 `@oh-my-pi/pi-coding-agent` + `bun` 转成**运行时的 get-ready 步骤**（启用后首次真正使用才 fetch）。
4. 默认 **`disabled: true`**，由 DSH plugin manager 逐项开关。

## 1. 探测：所谓「SDK binary」就是同一个程序

| # | 事实 |
|---|---|
| 1 | `@oh-my-pi/pi-coding-agent` 的 `bin` = **`omp → dist/cli.js`**，`engines: { bun: ">=1.3.14" }` |
| 2 | 版本同源：本机 `omp --version` = `omp/18.4.9`，npm 同族 18.4.9（latest 18.5.0） |
| 3 | 本机 291 MB binary 内嵌 `@oh-my-pi/pi-coding-agent`、`Bun v1.4.2 (Linux x64)`、内部路径 `modes/rpc/rpc-mode` |
| 4 | 同一句 help 在两侧都在（binary 2 处；`src/cli/args.ts`、`src/cli/flag-tables.ts`） |
| 5 | `src/modes/rpc/rpc-mode.ts` 的命令表与本项目 RPC client 发出的命令逐一对应 |

⇒ 「SDK 面」= 同一个程序的**另一种打包**（bun 单文件 binary ↔ npm JS 包），`--mode rpc` 本就是它的面之一。
SDK 面**唯一独有**的是 in-process library（`createAgentSession`/`ModelRegistry`/…）——一个 bun 进程承载 N 会话、共享 authStorage/modelRegistry；
RPC 面做不到：命令表只有 `new_session`（切换），无多会话 attach。

## 2. 依赖 → 运行时 get-ready（实测配方）

`agent-omp-sdk/src/sdk-runtime.ts`（19/19 单测绿，零真网络/零真 bun）：解 bun release zip → `bun add --exact --ignore-scripts --omit=optional @oh-my-pi/pi-coding-agent@<pin> @oh-my-pi/pi-natives-<platform>@<pin>` → 拷 `sidecar/main.ts` + `dist/protocol.js` 进 runtime 目录 → **smoke `await import(…)`** → 最后写 marker；lock 防并发、失败写 `<worldHome>/sdk-runtime.error.log` 并 fail loud、缓存 `<runtime>/.cache` 装完即删。

| 变体 | node_modules | smoke |
|---|---|---|
| 全量 18.5.0 | 1133 MB（114 包） | ✅ |
| `--omit=optional` 单用 | 535 MB | ❌ 缺平台 native（`pi_natives` 平台包是 optionalDependency） |
| **slim（采用）** | **899 MB（84 包）** | ✅ |
| 全量 **18.4.9**（=本机 binary 同版） | 1132 MB | **❌ `createRatchetPrelude` 找不到** |
| 18.2.11 | — | ✅（无 `src/ratchet/`，备选 pin） |

- **18.4.9 源码面是坏的**：`src/sdk.ts` 无扩展名导入 `./ratchet/prelude` → bun 解析到模板文件 `prelude.js`（非模块）而非 `prelude.ts`；18.5.0 上游改名 `prelude-definition` 已修。预打包的 `dist/cli.js`（本机 binary 的来源）不受影响。
- bun release zip **36.6 MB**；安装 **~5 s**；缓存目录 ~1.15 GB（装完删除）。
- 操作员 `~/.bun` 缓存与 `~/.omp` 在探针前后**未变**。

## 3. 开关机制：plugin manager 实机验证

在役 4997 上用**已 disabled 的 `agent-agy-sdk` 行**做对照（随后还原）：

| 步骤 | 读数 |
|---|---|
| `POST /api/pluginManager/setPluginEnabled {"id":"include:agent-agy-sdk","enabled":true}` | `{stage:'enable',changed:true,application:'applied'}` |
| profile patch | 追加 `- id: agent-agy-sdk` + `disabled: false` |
| `listPlugins` | `enabled=true`, `fiberPhase='active'` |
| roster | 多出 `agy-sdk`（**HMR 热挂，无需重启**） |
| 关闭 | 行回 `disabled: true`、roster 复原、`world failed` 计数 **0** |

⇒ user 的「每一项都能在 plugin manager 里 on/off」成立，本项目**零新增开关机制**。

## 4. 集成预探：复制回来的 sidecar 在 pin 的栈上可运行

`.scratch/omp-sdk-sidecar-integration-probe.md`（隔离 scratch，操作员 home 零写入）：18.5.0 + bun 1.4.2 下
boot **1.1 s** → `sys.ping` ok → `models.list` **5 providers/46 models** → `settings.modelRoles.get` ok → **`session.create` 构造出真实 AgentSession**（handle/sessionId/model/thinkingLevel）→ `session.state`/`session.dispose` ok。
即 18.1→18.5 的 API 漂移**不存在**，无需适配。

## 5. 4997 实机验收（T5）

tarball `super-dsh-0.1.9.tgz`（710.7 kB packed / 2.6 MB unpacked / **320 files**，比 RPC 轮 +84 文件 —— 交付面只多了 adapter 源码，**运行时不在包里**）；
`superd-4997-test.service`，home `.tests/superd`；探针 `.scratch/omp-sdk-acceptance.mjs`（信封 + cookie 全部照 UI 走）。

| 腿 | 探针 | 实测 |
|---|---|---|
| A | 默认关：roster / runtime / 行态 | roster 7 项无 `omp-sdk`；`<worldHome>/sdk-runtime` **不存在**；行 `enabled:false, fiberPhase:null` |
| B | plugin manager 开启 | `{stage:'enable',changed:true,application:'applied'}`；roster → 8 项（+`omp-sdk`，**HMR 热挂**）；profile patch `disabled:false`；**runtime 仍不存在**（未用不取依赖） |
| C | 首 prompt | `session/prompt accepted` → **fetch 9 s 完成**；marker `{pluginVersion:"0.1.0",packageVersion:"18.5.0",bunVersion:"1.4.2",bunPath:…/sdk-runtime/bin/bun}`；runtime **975 MB**（bin/bun.lock/dist/node_modules/package.json/sidecar）；**一轮真模型对话落定**（`turns=1`）；sidecar = `<runtime>/bin/bun run <runtime>/sidecar/main.ts` |
| D | 两会话单例 | 第二会话再次真对话落定；**sidecar 进程恰 1 个**；内存 **rss 430 MB / pss 427 MB（承载 2 个会话）** —— 对照 RPC 线两会话 536 MB PSS，且会话数增长时近亚线性（这正是启用它的理由） |
| E | 关闭 | `applied`；roster 回落 7 项；**sidecar 被回收**（`pgrep sidecar/main.ts` 空）；`world failed` 计数 **0**；975 MB 运行时**保留在盘上**（下次开启幂等复用） |

### T5 抓到的两个真 bug（都已修 + 复验）

1. **再次开启必失败**：`roster: duplicate agent key omp-sdk`。根因 —— world 插件 `registerAgent()` 没有 disposer；`/api/agent-runtime` 按 host mount 过滤（所以 UI 上看不出残留），但重复 key 检查仍命中。修法 = 条目 fiber-scoped（`ctx.effect` 里 register、dispose 时 `unregisterAgent`）。
2. **关掉行后 sidecar 不死**：435 MB 的 bun 进程越过自己的行继续跑。根因 —— world 插件从不 dispose `spawnWorld()` 返回的世界 fiber。修法 = 卸载时 `ctxW.fiber?.dispose()`（世界 → provider → transport → 子进程连锁回收）。

两条同样落在 `agent-omp`（同族潜在缺陷，此前只因该行从不被开关而不可见），并写进 `super-dsh/AGENTS.md`「世界行/adapter 的卸载契约」。复验：开启 → 关闭 → **再次开启**全绿，关闭后 `pgrep` 无 sidecar。回归：`agent-omp` **74/74**、`agent-omp-sdk` **76/76**。

## 6. 遗留
