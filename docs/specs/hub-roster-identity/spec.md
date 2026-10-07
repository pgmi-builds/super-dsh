# Hub roster identity + machine-row UI 调整（remote runtime 图标 / token URL / 后缀与排序清理）

2026-10-07 user 需求（原话见会话）：SuperD Hub 接入 remote machine 后，remote 的 agent runtime 没有专属图标（显示 generic fallback）；要求 local/remote 图标全部匹配；同时清理 machines 行与 roster 行的若干 UI 形态。本 spec 是四部分的正本。

## 1. Agent runtime 统一标识（runtimeId = adapter 包名）

**裁决**：统一标识 = adapter 的包名（去 `@pgmi-builds/` 构建作用域的 unscoped 形态，即 pack 内兄弟目录名）：`agent-omp`、`agent-omp-sdk`、`agent-agy`、`agent-agy-sdk`、`agent-codex`、`agent-codex-sdk`、`agent-hermes`、`agent-pi`、`agent-claude`；native DSH 不是 adapter，恒为 `native`。

- 约定 codified 于 hub roster 核心一个纯函数 `runtimeIdOf(key)`：`key === 'native'` → `'native'`，否则 `` `agent-${key}` ``。前提契约：**adapter 的 roster key 必须等于其包名 `agent-` 后缀**（现行 9 条线全部成立；mount label / world home 同源同值，S2「roster = adapter 加载态投影，无配置文件」不受影响）。
- `RosterEntry` / wire `AgentLink` / `ProbeAgent` 全链路携带 materialized 字段 `runtimeId: string`——hub 间 probe 的每一行显式传递包名 ID + label（「两个 Hub 之间传递的数据字段包含 runtime 的 label 或 ID」）。
- **旧 peer 兼容**：federation 入口处，peer 行缺 `runtimeId` 时由其 runtime `key` 归一（`agent-<key>`；`native` 照旧）——兼容路径只在 mesh-federate 的 parse 边界，不是主路径。
- **未知 ID 回退**：本地没有对应图标资产的 runtimeId（如 remote 版本更新带了本地没有的 adapter）→ fallback 图标（subagent artwork）。SDK 半线（`agent-omp-sdk` 等）与主线路**映射到同一图标资产**（manifest 多对一）。

## 2. 图标资产包（icon asset pack）

- 位置：`superd-hub/assets/icons/`——源码仓内的正本资产目录（git 持有；npm pack 经 `files` 随包交付）。
- 内容：ORCA（stablyai/orca `src/shared/agent-icons/`，38 枚 agent PNG，已验证与本线既有 hermes/agy 资产 byte-identical）**全量采集** + 本线既有 4 枚 SVG（claude / codex / omp / pi，其中 omp/pi 与 ORCA `agent-icon-glyphs.tsx` 内联手稿同源）+ DSH fish（本线自绘 FishLogo 几何，非 ORCA 资产）。
- `manifest.json`：`runtimeId → { asset, tile? }` 多对一映射（`agent-omp`+`agent-omp-sdk` → `agent-omp.svg`；tile = 深底上需不透明衬底的资产）。
- `scripts/build-icon-assets.mjs`：读 manifest + 资产文件 → 生成 `src/client/icon-assets.gen.ts`（base64 data URI + tile 表 + fish 几何），由 `build-client` 前置运行；生成物 commit（构建确定性由 client-bundle-drift 守卫兜底）。**只内联 manifest 引用到的资产**（bundle 保持精瘦）；全量资产仍在 assets/ 供后续映射。
- 渲染层 `runtime-icons.tsx` 改为按 `runtimeId` 查表；`native` → fish；查无 → subagent fallback。旧 baked-global（无 runtimeId 的 key）走 `runtimeIdFromKey` 兼容归一。侧栏 selector 的 active mark 经 roster 行解析 runtimeId（修复 active federated 行一直是 fallback 图标的问题）。

## 3. Local machine token URL（pairing 入口）

- **机制事实（upstream 源码核实）**：launch token **不是**从 `.credentials.yaml` seed 派生的——seed（`client-connection/browser-session` grant record）只是 cookie 的 HMAC 签名密钥；token 是进程启动时 `randomBytes(32)` 的内存值（`BrowserAuth.processLaunchToken`，WeakMap 持有）。因此「自己从 seed 生成 token」不可行；正确入口是 connection service 的**公共方法** `authenticatedUrl(baseUrl)`（把进程现役 token 附到给定 URL）。本线经 `ctx.inject(['connection'])` 取该 face，零 log 抓取、零自制 token。
- API：`POST /api/superd/machines` 新 op `{op:'tokenUrl', origin}` → `{tokenUrl}`。`origin` 校验：绝对 http(s)、无 path/query/hash/userinfo；connection face 缺 `authenticatedUrl`（老宿主）→ 明确 400。GET 答案**永不**携带 token（public-projection 纪律不变）。
- UI：self 行加 copy 图标按钮（`IconCopyOutlineRegular`）——点击 → 以当前 `location.origin` 调 op → 写剪贴板 → toast 确认；用户复制 `<origin>/?token=…` 到另一台机器的 Add machine 即完成 mutual pairing。

## 4. Machines 行与 roster 行 UI 清理

1. **后缀**：`federateAgents` 不再把 `· <machineName>` 拼进 label——分组 UI（Hub 页 section head、侧栏菜单分组标题）已提供 machine 语境。 federation 收敛按新 label 重登记一次（幂等替换，已有机制）。
2. **大写中间态（如 DEV3）**：machine 的展示标识收敛为两个——用户自定 `name`（dev3）+ 内部 `id`（m4）。`MachineRow.label` 字段退役：wire/客户端视图/分组/排序全部改用 `name`；machines.json 读取兼容旧文件的 label 字段（tolerant load，下次写盘自然消失），pairing 输入不再接受 label。代码里依赖 label 的只有展示/分组/排序三处，无业务逻辑依赖——确认可砍。
3. **行内动作图标化**：status 文案 chip → in-bundle 自绘 Wi-Fi/signal 式 mark（上游 ui-primitives 目录核实无 wifi/antenna 图标；按本线「官方原语优先，否则 bundle 内重绘」先例），四态着色 + `title` 保留文字语义；`Updated … ago` 行删除（`lastFetchLabel` 退役；wire 的 `lastProbeAt` 保留为事实字段、UI 不再消费）；`refresh` 文案 → `IconRefreshOutlineRegular`；remove 的裸 ✕ → `IconTrashOutlineRegular`（aria-label 保留）。
4. **排序统一**：任何 machine 组内（local 与 remote 一致）native/DSH 恒第一，其余按 label 字母序（key 决胜）。落点：host `agentLinks`（locals 排序 + federated 组内 native 优先）、client `groupByMachine`（组内同规则重排，flat fallback 也吃到 wire 序）。
