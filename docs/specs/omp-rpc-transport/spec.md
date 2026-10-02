# OMP Adapter 退回 RPC 传输 —— 用用户本机 `omp` binary 替换内置 SDK sidecar

- 日期：2026-10-03
- 状态：已裁决（user 2026-10-03 下令：OMP 走回 RPC 老路，直接用用户本机 binary）
- 范围：`super-dsh/agent-omp/`（传输层 + 数据面 + 打包面）、根 `super-dsh/package.json`、`super-dsh/test/start-4999.sh`
- 相关：`agent-adapter-dev-rules.md` §3.3（readiness）/§5（home）/§13；`docs/07`

## 0. 动机（user 裁决）

> OMP 实在太重了，不得不退回以前的方案……OMP adapter 走回老路，直接用用户本地的 binary 走 RPC。

现行 OMP adapter 通过 **Bun sidecar 内嵌 `@oh-my-pi/pi-coding-agent` SDK**（一会话一 handle，单 sidecar 多路复用）。
它把 762M 的 `@oh-my-pi` 树 + 76M 的 `bun` 二进制拖进**每一个** super-dsh 消费者的 profile：

```
/home/u1/.dsh/profiles/web/node_modules/@oh-my-pi   762M
/home/u1/.dsh/profiles/web/node_modules/bun          76M
```

而用户机器上本来就装着在用的 `omp`（`/home/u1/.local/bin/omp`，v18.4.9，291M）。
结论：**OMP 归入「直接用用户本机已在用的工具」这一类**——插件不自带副本，`~/.omp` 仍是唯一 app home（§5 不变），
传输改回 `omp --mode rpc` 的 NDJSON stdio。

PI 不在此列（32M，给了 exception，维持现状）。

## 1. Ground truth（2026-10-03 实测 + 代码锚点）

### 1.1 旧代码（RPC 年代）完整可恢复

| 事实 | 锚点 |
|---|---|
| RPC 客户端原文 426 行 | `git show 6d2fbe1:apps/multi-agent/agent-omp/src/rpc.ts`（`97916b1` 删除，因 multi-agent 线切 `agent-omp-sdk`） |
| 类面 `spawn/on/onFailure/sendRaw/send/getState/getMessages/getSessionStats/getSubagents/prompt/followUp/steer/setModel/abort/newSession/close` | 同上 §`export class OmpRpcClient` |
| 子进程数据面 `OMP_BIN = process.env.OMP_BIN ?? "omp"`、`execFile("omp",["models","--json"])`、`omp config get/set modelRoles --json` | `git show 6d2fbe1:apps/multi-agent/agent-omp/src/omp-cli.ts` |
| spawn 调用点：`OmpRpcClient.spawn(["--approval-mode", approvalMode], cwd)`；resume `+ ["--resume", sessionFile]` | `git show 6d2fbe1:apps/multi-agent/agent-omp/src/index.ts:335,471` |
| 备份来源（未 checkout） | `github.com/pgmi-builds/omp-web` → `apps/omp-web/src/rpc.ts` |

**关键**：现行 `src/sdk-client.ts` 开头自述 *"Public surface mirrors `OmpRpcClient` (apps/omp-web/src/rpc.ts) **exactly**"* ——
SDK 迁移是原地换心，本次是同一把手术刀反向。

### 1.2 本机 binary 能力（v18.4.9）

| 面 | 实测 |
|---|---|
| `omp --mode=<text\|json\|rpc\|rpc-ui>` | ✅ 支持 |
| `omp models --json` | ✅（模型目录第一源） |
| `omp config get\|set <key> --json` | ✅（modelRoles 面） |
| `--session-dir` / `--no-session` / `--resume` / `--approval-mode` | ✅ |

### 1.3 协议漂移（spike 实测，2026-10-03，`.scratch/omp-rpc-probe.mjs`）

`ready` 帧：

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],
 "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

| 事实 | 结论 |
|---|---|
| `negotiate_protocol{protocolVersion:0}` | ❌ `Unsupported RPC protocol version: 0` —— **旧代码若硬编码 0 会失败** |
| `negotiate_protocol{protocolVersion:2}` | ✅ `{protocolVersion:2}`，随后**开启 >1MiB 分帧**（`maxFrameBytes=1MiB`，重组上限 64MiB） |
| 不协商（默认） | ✅ **停在 v1 = 纯 NDJSON**，与旧客户端的 `indexOf("\n")` 读法完全一致 |
| `get_state` / `get_available_models` | ✅ 未协商也照常应答 |
| 事件词表 `agent_start / turn_start / message_start / message_update / message_end / tool_execution_start / tool_execution_end / turn_end / agent_end` | ✅ 全部仍在（对得上现行 `agent.ts` 的 switch） |

**设计裁决**：MVP **不协商**，停在 v1（纯 NDJSON，旧读取器即正确）。
v1 无分帧、无 1MiB 硬上限（`encodeFrames` 只在该连接协商到 2 时才分帧）。
v2 分帧列为**已知 gap**（大工具输出 >1MiB 时才需要），登记不阻塞。

### 1.4 SDK 线独有的四个面（RPC 需补）

| SDK 线调用 | RPC 等价物 | 证据 |
|---|---|---|
| `session.systemPrompt` | `get_state.systemPrompt` | v18 `get_state` 载荷含 `systemPrompt` |
| `session.contextUsage` | `get_state.contextUsage` | 同上 |
| `session.compact` | `{type:"compact", customInstructions}` | rpc-mode `case "compact"` |
| `onTitle` | `session_info_update.title`（`PI_RPC_EMIT_TITLE=1` 时另有 `setTitle`） | rpc-mode `notifyTitleChanged` / `jca()` |

## 2. 设计

### 2.1 传输

```
lazy-rpc.ts  ──drives──▶  OmpRpcClient  ──spawn──▶  $OMP_EXECUTABLE ?? PATH "omp"  --mode rpc [args]
   (不变)                   (新/移植)                    │
                                                         └─ NDJSON v1，ready 握手，per-command deadline，
                                                            detached 进程组 + SIGTERM→SIGKILL
```

- **binary 解析**（`resolveOmpExecutable()`，照 claude 先例 `claude-client.ts:67-80`）：
  `$OMP_EXECUTABLE` → PATH 上的 `omp` → `~/.local/bin/omp` / `/usr/local/bin/omp` → 裸 `"omp"`（让 spawn 报 ENOENT）。
- **ready 容忍**：只要求 `type === "ready"`；`protocolVersion` / `supportedProtocolVersions` / `maxFrameBytes` / `maxReassembledFrameBytes` 全部**记录不校验**（旧代码只看 type，天然容忍）。
- **不协商**：不发 `negotiate_protocol`（停在 v1）。代码注释写明原因 + v2 gap 指针。
- **进程模型**：回到「一会话一 `omp --mode rpc` 进程」，`LazyOmpRpc` 的 lazy 铁律不变（构造零 spawn）。

### 2.2 数据面

`omp-cli.ts` 回到子进程实现（`git show 6d2fbe1:.../omp-cli.ts`），**导出面不变**
（`ompAvailableModelsSync/Async`、`ompModelRolesSync`、`ompModelRoles`、`ompSetModelRoles`），
binary 用同一个 `resolveOmpExecutable()`，cwd = `OMP_HOME`。

### 2.3 删除面

`src/sdk-client.ts`、`src/sidecar-client.ts`、`src/protocol.ts`、`sidecar/`、`scripts/build-client.ts`（若仅服务 sidecar）、
测试 `sidecar-*.test.mjs`、`modelroles.test.mjs`（改 RPC 版）。

### 2.4 打包面

根 `super-dsh/package.json`：`dependencies` 去掉 `@oh-my-pi/pi-coding-agent`、`bun`；`files` 去掉 `agent-omp/sidecar`。
`agent-omp/package.json`：deps 去掉 `@oh-my-pi/pi-coding-agent`、`bun`。
`test/start-4999.sh` 的 `pnpm-workspace.yaml`：去掉 `onlyBuiltDependencies: [bun]` 与 bun postinstall 回填段。

**预期收益：profile 少 ~838M。**

## 3. 不变量（违反即缺陷）

1. `~/.omp` 仍是唯一 OMP app home，spawn **零重定向**（不喂 `OMP_HOME` 给子进程；`OMP_HOME` 只作测试 knob）。
2. `LazyOmpRpc` 仍是唯一 spawn 点；**create/resume 都不得 eager spawn**（旧回归点，见 `sidecar-decouple.test.mjs`）。
3. DSH 会话日志仍是唯一 WebUI 读面，OMP 原生会话文件仍是 runtime 权威，双份存储照旧。
4. `omp` 与用户 TUI **不得**在同一 session file 上并发写（旧的 L1/L2/L3 独占持锁段必须保留）。
5. 插件不自带 OMP 代码副本：**用户机器上必须有 `omp`**。缺失时**不得静默回落**——readiness 语义照旧（= world mount 成功，与 hermes/claude 先例一致），但 adapter 在 `apply()` 做一次二进制的可解析性探测并打显式诊断，首轮 prompt 时以 spawn 错误 fail loud 冒到会话。

## 4. 已知 gap（登记，不阻塞）

- **协议 v2 分帧未实现**：单帧 >1MiB（超大工具输出/图片回显）在 v1 下靠大行承载；若实测出现性能或内存问题，再协商 v2 + 重组。
- **`omp` 版本门**：本方案对 18.4.9 实测；更老版本（v0 协议年代）会 `negotiate_protocol` 失败——但本方案不协商，故只依赖 ready + 基本命令，向前兼容面待 dev3 实装时观察。
