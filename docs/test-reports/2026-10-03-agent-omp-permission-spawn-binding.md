# agent-omp 权限档位绑定 —— 4997 pack-line 实机验收

- 日期：2026-10-03
- 改动提交：`b09effb`（spec：`docs/specs/omp-rpc-transport/spec.md` §2.5 / §3.6；坑录：`super-dsh/agent-omp/AGENTS.md` §一）
- 形态：**交付形态**（`node super-dsh/scripts/pack.mjs` → tarball `super-dsh-0.1.9.tgz` 628.4 kB / 2.2 MB / 256 files → pnpm `file:` 装进 profile → repo build 的 dsh CLI）
- 现场：`superd-4997-test.service`（+ `superd-lan-4997-relay.service`），home = `.tests/superd`
- 最后一次重启的 token：`http://192.0.2.130:4997/?token=<redacted>`

## 0. 被判定的缺陷

UI 在 **new chat**（draft 会话）选权限档位后**立刻回弹**，任何档位都停在 Full Access；中途再选同样无效。

根因（三段叠加，全部实测）：

1. OMP 的 `--approval-mode` 是 **launch flag**，没有 RPC 能改（上游命令表无入口；本机 v18.4.9 实测）；
2. 旧代码在 `createAgent` 处**把 launch flag 冻成构造期常量**，值取 `defaultPermissionPreset()`——而 Dash 会话的 `permission/preset` 是宿主 `pinInitialPermission` 在 **publish 时**才盖的（晚于 transport wrapper 构造），用户在 new chat 选的那一档更是**更晚**的一条事件；
3. `agent.ts` 的 `/permission` 影子命令**无条件**返回 `"Approval policy is fixed at OMP launch; runtime switching is not supported"`，所以连「把选择写进会话事件」这一步都不发生。

净效果：映射表（三档→三种 mode）在，但永远解析成默认档 `danger-full-access → yolo`，选择被丢弃且 UI 无感（命令返回 error → `permissions` projection 不变 → 回弹）。

## 1. 修法（`b09effb`）

- `lazy-rpc.ts`：`LazyOmpRpc` 接受 **spawn-args thunk**，在 `#ensure()` 里求值（与既有 `setModel` 的排队面同一缝）。
- `permission.ts`：`resolveSpawnPermission(events, fallback, envMode)` = 最后一条**有效** `permission/preset` → fallback（create=composition default；resume=bridge-index 行）→ `yolo`；`OMP_APPROVAL_MODE` 仍然覆盖。会话事件**优先于**索引行（索引行只在首次 spawn 写一次、从不更新）。
- `agent.ts`：`/permission` 按 child 状态分流——未 spawn → `permissionPresets.set()`（落 durable preset + knob 事件；**不用**全局 handler 的 `approval.setPolicy`，那会往 OMP 会话注入一条 narration user message）；已 spawn → 明确 error 拒绝（绝不接受运行中改不了的切换）。
- `index.ts`：create / resume **都在会话就位之后**构造 wrapper 并传入 resolver。

## 2. 探针与读数（全绿）

驱动面 = hub 信封 `POST /hub/api/<method>?agent=omp`，`{type:'client-request',rpcId:<string>,method,payload:{args}}`；`session/list`→`args._request`、`session/create`→`args.request`、`session/prompt`→`args.request`、`commands/execute`→`args.{agentId,line,submittedAttachments}`。

| # | 探针 | 期望 | 实测 |
|---|---|---|---|
| 1 | draft `session/create` 后的 `omp --mode rpc` 进程数 | 0（零 spawn 不变量） | **0** |
| 2 | draft 默认档（patch 钉的） | `danger-full-access` | **`danger-full-access`** |
| 3 | `commands/execute /permission workspace-write`（未 spawn） | `success: preset workspace-write` | **success**，`permission/preset` + `sandbox/mode: workspace-write` + `approval/policy: ask` + `command/done success` 落盘 |
| 4 | 选择后 `permissions.currentValue` | `workspace-write`（**不再回弹**） | **`workspace-write`** |
| 5 | 选择后进程数 | 0（仍 lazy） | **0** |
| 6 | 裸 `/permission` | 报当前档 + 可选集 | `current preset workspace-write (available: read-only, workspace-write, danger-full-access)` |
| 7 | 首 prompt → child argv | `--approval-mode write` | **`omp --mode rpc --approval-mode write`** |
| 8 | 该轮真模型回复 | 一轮完成 | assistant `"OK"`，`turn/end completed` |
| 9 | 已 spawn 后 `/permission read-only` | 明确拒绝 + projection 不变 | `error: the OMP session is already running with a fixed approval policy: pick "read-only" in a new chat, before the first prompt`；projection 仍 `workspace-write` |
| 10 | 第二档 `read-only` → child argv | `--approval-mode always-ask` | **`omp --mode rpc --approval-mode always-ask`** |
| 11 | **重启后冷 resume**（同 sessionId 再 prompt） | 从**会话日志**取档，并重挂 OMP 自己的 transcript | child = `omp --mode rpc --approval-mode write --resume /home/u1/.omp/agent/sessions/-workspaces-superd/2026-10-03T06-16-56-708Z_01a10068-….jsonl`；projection 冷读仍 `workspace-write` |

> #11 同时把上一轮报告里挂着的「人工腿」自动化了一半：`--resume <app-home file>` 出现在 argv 里，证明 `adoptSpawnedChild` 记录的 `get_state.sessionFile` 映射成立且被 resume 用上（协议漂移风险点消掉）。

### 探针方式的一条坑（下次直接照抄）

**斜杠命令行经 `session/prompt` 发出去不是命令**：它作为普通 `user/message` 进 inbox，并把 child 拉起来（实测：日志里只有 `user/message` 没有 `command/run`，且 `/permission workspace-write` 被原样投给 OMP）。Web UI 的面是 `live.command(line)` → RPC **`commands/execute`**（信封参数 `agentId`/`line`/`submittedAttachments`）。第一版探针就是踩这个坑得出「没生效」的假象。

## 3. 附带排查：两个 OMP session 的 RPC 内存模型（user 点题）

**结论：N 个 session = N 个 `omp --mode rpc` 子进程，没有任何 daemon/broker 共享。** `LazyOmpRpc` → `OmpRpcClient.spawn`（每会话一份，`detached: true`），唯一的「共享」是 291 MB/`omp` 二进制自身的 **file-backed 页**（页缓存一份，被两个进程按比例计入 PSS），**不是**第二份 291 MB。

### 3.1 隔离实测（`OMP_HOME`/`PI_CONFIG_DIR`/`HOME` 全指 tmp，真 `~/.omp` 零写入；单 child 与双 child）

| 读数 | child A（唯一） | 双 child 时 A | 双 child 时 B |
|---|---|---|---|
| VmRSS | 370 MB | 353 MB | 362 MB |
| PSS | 367 MB | 293 MB | 302 MB |
| private | 367 MB | 236 MB | 245 MB |
| PSS(file) | 108 MB | 55 MB | 54 MB |
| shared | 2.8 MB | 117 MB | 117 MB |

单 child ≈ **367 MB PSS**；两个 child 合计 **596 MB PSS** → **边际成本 ≈ 303 MB／会话**。第一个进程独占文件页时那部分被记成 `Private_Clean`，第二个进程一映射就翻成 `Shared`（所以 A 的 private 从 367→236）。真 `~/.omp` 的 config.yml/sessions 计数前后**逐字节未变**；凭据副本在 700 tmp 目录内、探针结束即删。

### 3.2 实机实测（4997 真会话，原生 `~/.omp` home，一轮对话之后）

```
pid=824993 rss=300MB pss=268MB private=238MB pss_file=29MB  argv=omp --mode rpc --approval-mode write
pid=831425 rss=300MB pss=268MB private=238MB pss_file=30MB  argv=omp --mode rpc --approval-mode always-ask
2 children: RSS=600MB  PSS(sum)=536MB          边际 ≈ 268MB／会话
```

（同一时刻实测，二进制 291 MB 的 file-backed 部分只有 ~60 MB 常驻、**一份**。）

### 3.3 与退回前的 SDK/sidecar 线对比

旧线（`c494bab` 删掉的 `sidecar/main.ts` 自述）：「**One sidecar = one OMP 'app instance': shared authStorage / modelRegistry across all sessions it hosts**」——**一个 bun 进程承载 N 个 session**，边际成本 ≈ 会话上下文本身（远小于 300 MB）。所以 user 的直觉成立：**RPC 线换掉了「多会话共享一个 runtime」这一条**，买回来的是「不自带 838 MB 的 `@oh-my-pi` + bun、直接跑用户本机 binary」。

### 3.4 现有的三个缓解面

1. **idle-exit**：`OMP_IDLE_EXIT_MS`（默认 600 s，五重静默复核后 teardown child）——成本随**同时在役**的会话数封顶，不随历史会话数累积；
2. 二进制 file-backed 页天然共享（~60 MB 一份，非每进程一份）；
3. 若要把旧的内存形态找回来，唯一路径是**多会话复用同一 child**（协议里有 `new_session`；是否支持**并发**多会话未探），属独立设计议题，本轮未动。

## 4. 测试与遗留

- `super-dsh/agent-omp`：**74/74 pass**（新增 `test/permission-spawn.test.mjs` 6 例；`test/lazy-rpc.test.mjs` 增 1 例，靠 mock fixture 新增的 `MOCK_OMP_ARGV_FILE` argv dump 钉住「spawn 用的是那一刻的 argv」）。`super-dsh/scripts/pack.mjs` 全量 tsc（host + client lane）零错。
- 本轮在 `.tests/superd`（**测试 home**）留下 6 个探针会话（标题多为 `Reply with exactly: OK`）与 1~2 个在役 child；child 会在最后一次 turn 之后 ~10 min 被 idle-exit 回收，会话可直接删。
- 未动：`OMP_APPROVAL_MODE`（headless 覆盖）语义不变；本 bug 与「模型清单 wire up 到哪个字段」（OpenRouter/Bedrock 数百模型）无关，后者仍待裁决。
