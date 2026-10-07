# Hub roster identity + machine-row UI 调整 — 实现计划（2026-10-07）

Spec：`docs/specs/hub-roster-identity/spec.md`。四部分：runtimeId + 图标资产包、token URL、UI 清理（后缀 / 大写中间态 / 图标化 / 排序）。

## Task 1 — runtimeId 贯穿（host）

- `superd-hub/src/roster.ts`：`RosterEntry.runtimeId?: string`；导出纯函数 `runtimeIdOf(key)`（`native` → `native`，否则 `agent-${key}`），doc 写明「roster key 必须等于 adapter 包名 `agent-` 后缀」契约。
- `agent-roster.ts`：`AgentLink.runtimeId: string`；local 行 `runtimeIdOf(agent.key)`；federated 行取 roster 行存储值。locals 排序：native 恒首、其余 label 字母序（key 决胜）；federated comparator 组内 native 优先（见 Task 6）。
- `mesh-link.ts`：`ProbeAgent.runtimeId?: string`；`coerceAgent` 读入。
- `mesh-federate.ts`：`FederatedAgent.runtimeId?`；desired 行 `runtimeId: agent.runtimeId ?? runtimeIdOf(agent.key)`（旧 peer 兼容只在 parse 边界）；收敛比较含 runtimeId。

## Task 2 — 图标资产包 + 生成器 + 渲染层

- `superd-hub/assets/icons/`：ORCA 38 枚 PNG（`.scratch/orca-probe/src/shared/agent-icons/` → 拷贝正本，注明来源 commit）+ `agent-{claude,codex,omp,pi}.svg`（自既有 inline base64 解码落盘）+ `agent-{hermes,agy}.png`（= orca hermes/antigravity）+ `dsh-fish.svg`（自 DshFish 几何）+ `manifest.json` + `README.md`（来源与规则）。
- `superd-hub/scripts/build-icon-assets.mjs`：manifest + 文件 → `src/client/icon-assets.gen.ts`（`RUNTIME_ICON_ASSETS: Record<string,{uri,tile?}>` + `DSH_FISH {uri,width,height}`）；只内联 manifest 引用的资产；生成物 commit。
- `superd-hub/src/client/runtime-icons.tsx`：查表按 runtimeId；`RuntimeMark({runtimeId?, key?, size})`；`native` → fish（img + 原始宽高比）；miss → `SubagentGlyph`。
- `superd-hub/package.json`：`build-client` 前置 `node scripts/build-icon-assets.mjs`；`files` += `"assets"`。
- `HubPanelIcon.tsx`：menu/selector mark 经 roster 行解析 runtimeId（activeKey → AgentLink → runtimeId）。

## Task 3 — client wire（runtimeId + 无 label 视图）

- `client/roster.ts`：`AgentLink.runtimeId?`；coercion 透传。
- `client/mesh-api.ts`：`MeshMachineView` 去掉 `label`（coercion 用 name）；去 `lastProbeAt` 消费面；新增 `fetchPairingUrl(origin)`（POST op tokenUrl）；`AddMachineInput` 去掉 label。

## Task 4 — token URL op（host）

- `mesh-rpc.ts`：`MeshDeps.tokenUrlOf?`；`registerMeshRpc` 从 connection face 取 `authenticatedUrl`；POST op `{op:'tokenUrl', origin}` → `{tokenUrl}`；origin 校验（绝对 http(s)、无 path/query/hash/userinfo）；face 缺方法 → 400。
- `client/HubPage.tsx`：self 行加 copy 按钮（`IconCopyOutlineRegular`）→ fetchPairingUrl(location.origin) → clipboard → toast；失败走 meshError。

## Task 5 — 后缀 / 大写中间态退役

- `mesh-federate.ts`：label 不再拼 `· <name>`。
- `machines.ts`：`MachineRow` 去 `label`（isMachineRow tolerant：缺 label 可读，字段丢弃）；`saveMachines` 校验同步；`pairMachine`/mesh-rpc/mesh-api 输入去 label。
- `agent-roster.ts` machineLabels、`client/mesh-groups.ts machineLabelsFrom` 改用 name；`HubPage.tsx` 去掉 label chip。

## Task 6 — 排序统一 + 图标化动作

- `agent-roster.ts`：locals native 恒首 + label 字母序；federated sort 键 = (machineLabel, native优先, label, key)。
- `client/mesh-groups.ts`：组内 native 恒首 + label 字母序（key 决胜）。
- `HubPage.tsx`：status chip → 自绘 signal mark（四态色 + title）；refresh → `IconRefreshOutlineRegular`；remove → `IconTrashOutlineRegular`；删 `lastFetchLabel`/`ageStyle` 行。
- `client/mesh-api.ts`：删 `lastFetchLabel`（wire `lastProbeAt` 保留在 host 投影，UI 不读）。

## Task 7 — 测试与验收

- 更新：roster / rpc / mesh-link / mesh-federate / machines / mesh-rpc / client-mesh-view / client-mesh-groups / hub-page-row-shape（RuntimeMark 断言保持）。
- 新增：`client-runtime-icons.test.mjs`（资产包：manifest 全覆盖 9 adapter id + native、引用文件存在、生成器输出确定性）+ runtimeIdOf 约定用例。
- `npm run build && npm run build-client && node scripts/build-superd-client.mjs`（commit client bundle）→ `node --test test/`。
- 整包验收：`node super-dsh/scripts/pack.mjs` → `test/start-4999.sh` → 4999 冒烟（shell 200 / roster / /hub 家族语义 / world failed 计数）+ UI 手验四部分行为；dev3 实装后报告。

## 不做 / 边界

- 不改上游源码；connection face 只经既有 inject 读取。
- `.tests/superd` 在役 home 与 3080/3081 prod 零触碰；测试走 4999 pack 线。
- npm publish 不在本轮（发布须 user 单次放行）。
