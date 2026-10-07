# Path Separation — master 0.1.4 archival release + worktree native-ui-only refactor

- 日期：2026-09-26（user 裁决，验收反馈后）
- 上游计划：`docs/superpowers/plans/2026-09-26-native-ui-fusion.md`（branch `native-ui-fusion`，保持 in-worktree）
- 性质：路线分离。master = multi-ctx-multi-webui 旧路的**终态归档发布**；worktree = native-ui-only 新路（不再有 per-agent URL 路线）。

## 验收反馈定性（本轮实测证据）

- 融合数据面全链 ✓：pi 会话列表 → resume → 模型回复 → download session log（文件名带 session id）全走 `/hub`；reconnect→Connected 正常；往返幂等（第 4 轮零瑕疵 = per-agent NS 落位生效）。
- **BUG（必修）**：无有效 NS 指针时落 new chat → `startSession` 经 `workspaceId ?? currentWorkspaceId ?? recent` 解析到**上一个 agent 的 stale workspace** → `workspace/not-found` toast + 旧会话视图挂在死 id 上（红行 + 标题变 raw id）。终审 Important-2 预警区的实证。修法方向：落位不得携带 stale workspaceId（重排 land/reconnect 次序或清 current-workspace 再落位，以实现调查为准）；spec §3.5 步序相应修订记档。

## Part 1 — master：剥 Hub UI，发 0.1.4（旧路终态）

**User 原话**："the main branch, strip off the `Hub` ui packs, git/npm commit and publish 0.1.4, as the last multi-ctx-multi-webui path final state."

- 范围：master（当前 b4ac3e4+46f99c7）剥除 **hub client 半边全部表面**——`superd-hub/src/client/*`（RuntimeSeat/HubPage/HubPanelIcon/roster/machines-store/glyph/runtime-icons/index）、烧录 bundle（`super-dsh/client/index.js`）与其 build 线（hub 的 `build-client`/`build-superd-client.mjs`/`tsconfig.client.json`/@types/react devDep）、composite patch 裸名行 `- id: superd-hub, name: 'super-dsh'`、pack.mjs 的 hub client 步。**保留**：hub host 半边全部（gateway/spawnWorld/carrier/world-web-server/web-trust/client-shim 烘焙脚本——世界页 transport 仍需）、世界页 multi-webui 挂载、roster host 服务。
- 版本：`0.1.4`（真实发布位；user 明示）。
- 验收：单测全绿（剥除相关测试同步删）+ pack 线 4999 形态 boot（shell 200 / 6 世界 mount 200 / world failed 0 / **served index 无 super-dsh client 行、无 seat/panel**）。
- 发布闸门（§〇.1）：① 本地实测 ✓ → ② 报告落 `docs/test-reports/2026-09-26-0.1.4-final-multi-webui.md` → ③ dev3 目标机实装（tarball add file: → restart → journalctl 计数 + mount 探针；不可达则问 user）→ ④ **user 已在本指令中明确下令 publish 0.1.4**（单次授权，执行时再打印一次目标与版本）。GitHub tag 随发布落。

## Part 2 — worktree（native-ui-fusion 分支）：native-ui-only 重构

**User 原话**："keep in worktree for now. fix the above, and strip off the old agent-selector (sidebar bottom), use the `hub` ui components, strip off the per agent url path, per agent ui client lines ("disable" their webui build if possible, just like disable their webserver), make it native-ui-only, no need the url path fallback (we have git history)."

任务序列（TDD，每任务独立 commit）：

1. **T-A 落位修复**：new-chat 落位不再解析/携带 stale workspaceId；修后矩阵 = 四场景（native↔foreign 往返、有/无 NS 指针）全绿；spec §3.5 修订记档。
2. **T-B 切换面迁移**：剥 `RuntimeSeat`（sidebar.bottom 旧行 + `sidebar.footer.action` 注册）；`HubPanelIcon`/`HubPage` 的 Agent Runtimes 行接 `attemptSwitch`（in-place；世界页语义随 T-C 消失）。Hub UI = 唯一切换面。
3. **T-C 剥 per-agent URL 路线**：ctx0 侧 `/<label>/` 页面挂载（carrier mountWorld 页面族 + open-in-app 桥）退役；`/hub` 家族成唯一入口（kernel 保留）。**世界数据面不动**（gateway/dispatchRpc/openWireStream 照旧）。
4. **T-D 剥世界 webui 行**：worldMountPatches 的 frontend-static/web 服务行 disable（世界零端口之后零 webui——"like disable their webserver"）；世界侧 client-shim 烘焙随行退役；相关测试收缩。
5. **T-E 收口**：flag 语义复核（无 fallback 后 flag-off = 无 foreign 入口——默认开与否交该路自己的验收/放行轮）；全量回归 + rig 交付。

约束沿袭原计划 Global Constraints（上游零修改、单实例、`.tests` home、glob 测试命令、字母迭代版本）。执行：SDD（实现者 glm-5.3-flash / 评审 glm-5.3）。
