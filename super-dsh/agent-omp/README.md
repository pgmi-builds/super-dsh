# @pgmi-builds/agent-omp（OMP adapter，RPC 线）

OMP provider for DeepSeek Harness（[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)）。

**不内嵌任何 OMP 代码副本**：适配器用操作员本机已在用的 `omp` binary，以 `omp --mode rpc` 子进程形态驱动，
stdio 上跑 OMP 的 NDJSON 协议（v1），把 OMP 的 RPC 面（prompt / follow_up / steer / abort / get_state /
get_messages / set_model / resume / compact）桥接进 Dash 的 Agent/Session 契约，标准 DSH Web UI 即可驱动 OMP 会话。
模型选择由 OMP 数据面的 `LlmAdapter` 承接（`config.yml` 的 `modelRoles`）。

## 集成形态

```
dsh 宿主 (Node 22, 本包 dist/)               操作员本机的 omp binary
  omp-web 衔接层（agent/adapter/       ←→     `omp --mode rpc`（NDJSON v1 over stdio）
  replay/store/supervisor）                    ~/.omp 是其唯一的 app home
```

- **没有 sidecar，没有 Bun，没有 SDK 依赖**：一会话一 `omp --mode rpc` 子进程，进程生命周期跟随会话。
- **binary 解析**（`src/rpc-client.ts` 的 `resolveOmpExecutable()`）：
  `$OMP_EXECUTABLE` → `PATH` 上的 `omp` → `~/.local/bin/omp` / `/usr/local/bin/omp` → 裸 `"omp"`（让 spawn 报 ENOENT）。
- **进程组隔离**：子进程 `detached` 自成进程组，teardown 走 SIGTERM + 2s 宽限后 SIGKILL，保证 `omp` 及其工具子进程不残留。

## 安装与启用

本包是 `super-dsh` 单一交付包内的兄弟目录，**不单独安装**（`dsh plugin --profile <name> add super-dsh`），
也不需要预装任何 OMP SDK。唯一的外部前置条件 = **操作员机器上有 `omp`**：

- 缺失时不静默回落：adapter 在 `apply()` 做一次二进制可解析性探测并打显式诊断，首轮 prompt 以 spawn 错误 fail loud 冒到会话。
- 启用由包内 `cordis.patch.yml` 承担（挂 OMP provider + 禁用原生 agent-loop / llm 路由），profile 无需手改。

## Home 布局（两个 home，别混）

| 名字 | 是什么 | 定义（`src/knobs.ts`） | 默认 |
|---|---|---|---|
| **`OMP_HOME`** | OMP runtime app home（`agent.db`/`models.db`/`sessions/` 的写入目标，也是数据面子进程的 cwd） | `$OMP_HOME ?? resolveOmpNativeHome()` | **原生 `~/.omp`**（`$OMP_HOME` 只作测试 / 适配器级隔离 knob） |
| **`OMP_NATIVE_HOME`** | 操作员的原生 OMP 安装（TUI/CLI）读面：`agent/config.yml`、`agent/models.yml`、原生 session store | `$OMP_NATIVE_HOME ?? join(homedir(), ".omp")` | `~/.omp` |
| `<DSH_HOME>/agents/omp/` | 该 world 的 **DSH** home（DSH 会话日志、storages、settings） | dsh 宿主解析 | 非 app home |

- spawn **零重定向**：不把 `OMP_HOME` 喂给子进程；`~/.omp` 是唯一 OMP app home。
- 绝不要把 `OMP_NATIVE_HOME` 指到空目录 / 测试 home——它是 models.yml 的读取来源，读空 ⇒ 适配器零 provider ⇒ `session/prompt` 报 `model-unavailable`。

## 数据面（`omp` 子进程）

`src/omp-cli.ts` 把操作员 binary 作为模型目录与 `modelRoles` 的**第一源**（不吃 RPC 帧）；原生 `~/.omp` 的文件只作失败回落与排序读面：

- `omp models --json` → 凭证解析后的可用模型目录（含 agent.db 里的 OAuth/login key 等配置面看不见的凭证）；子进程失败才回落磁盘 `models.db` ∪ `models.yml`（并打 stderr 提示）。
- `omp config get modelRoles --json` → role → `"provider/model[:effort]"` 映射（含持久化的 `default` 选择），每次现读。
- `omp config set modelRoles --json <obj>` → 整对象回写（拒绝点号 key），OMP 自己持久化 `modelRoles.default`。
- provider 排序与 boot 期默认模型仍首选 `agent/config.yml` 磁盘读（`omp-store.ts` 的 mini-YAML 扫描），`ompModelRolesSync` 兜底。
- 每次调用都按 `resolveOmpExecutable()` 现解析、`cwd = OMP_HOME`；**fail-soft**：binary 缺失/损坏/无响应 → 读 `undefined`、写 `false`，provider 永因 CLI 挂掉而 boot 失败。

## 实现要点

- **传输**：`src/rpc-client.ts` 的 `OmpRpcClient` —— NDJSON 读取（按 `\n` 切帧）、`ready` 握手（默认 120s 上限，`OMP_READY_TIMEOUT_MS`）、
  per-command 响应 deadline（默认 30s，`OMP_COMMAND_TIMEOUT_MS`）、`on`/`onTitle`/`onFailure` 事件分发。
- **不协商协议**：不发 `negotiate_protocol`，停在 v1 = 纯 NDJSON（旧读取器即正确）。协商到 v2 会切换到 >1MiB 分帧，需要重组器——列为已知 gap。
- **lazy 铁律**：`src/lazy-rpc.ts` 的 `LazyOmpRpc` 是唯一 spawn 点，构造零 spawn；`prompt`/`followUp`/`steer`/`ensureStarted` 才拉起子进程，
  被动查询（`getState`/`getSubagents`/`getSessionStats`/`getSystemPrompt`/`abort`/`sendRaw`）合成应答、绝不 spawn。
  `createAgent` 与 `resume` 两条路径都走它（resume 有映射时加 `--resume <ompFile>`），生成参数 `--approval-mode <mode>`。
- **两平面**：dsh 原生 session log 是 WebUI 唯一读面（插件当 producer：OMP RPC 事件 → SessionEvent → `ctx.sessionPersistence`）；
  OMP 原生会话文件是 runtime 权威（插件当 bridge：`bridge-store.sqlite` 只存 dsh↔omp 映射）。双份存储显式接受，单向阀 = 不回读。
- **已删除面**（本 RPC 轮，2026-10-03）：`src/sdk-client.ts`、`src/sidecar-client.ts`、`src/protocol.ts`、`sidecar/`，以及 SDK/Bun 依赖与 `test/sidecar-*.test.mjs`；`scripts/build-client.ts`、`src/client/`、`src/mobile/` 亦于 2026-11-08 随 mobile 全退役删除（world webui 自 2026-09-26 T-D 起零渲染，client 面无任何加载方）。

## 协议与实测记录（2026-10-03）

`ready` 帧实测：

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],
 "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

- 只要求 `type === "ready"`；`protocolVersion` / `supportedProtocolVersions` / `maxFrameBytes` / `maxReassembledFrameBytes` 记录不校验。
- 不协商的路径实测停在 v1；`get_state` / `get_available_models` 未协商也照常应答；事件词表
  （`agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_end` / `turn_end` / `agent_end`）与 `agent.ts` 的 switch 对齐。
- 已知 gap：v2 分帧未实现（单帧 >1MiB 靠大行承载）；对 `omp` 版本门仅实测 v18.4.9。

## 测试

```bash
npm run build                  # tsc -p tsconfig.json
node --test test/*.test.mjs    # 全 fakes / 源级断言，零真 runtime、零真 omp spawn
```

- `test/no-sidecar.test.mjs` = RPC 轮的删除面 + tick 门双重把守（源级断言：`src/` 不得再出现 SDK/sidecar client；
  `index.ts` 只能 `new LazyOmpRpc(`；tick 的目录刷新必须挂在 `liveOmpSessionExists` 上，并对编译后的 `dist/index.js` 跑行为真值表）。
- `rpc-client` / `lazy-rpc` / `omp-cli-rpc` / `resolve-executable` / `package-contract` 覆盖传输、lazy 不变量、数据面与交付清单。
- **场景级验证只走整包**：`super-dsh` 的 4999 pack 线（`test/start-4999.sh`）+ dev3 目标机实装；本目录不再有 per-agent 场景 rig。

## 历史

本包在 2026-10-03 前是内嵌 SDK + Bun 子进程（sidecar）线（SDK 事件 → SessionEvent，单进程多路复用）；该线连同
762M SDK 树 + 76M bun 二进制一起从交付面删除，改用操作员本机 binary 的 RPC 传输（设计正本：
`docs/specs/omp-rpc-transport/spec.md`）。
