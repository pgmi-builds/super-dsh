# DSH 0.2.2-alpha.2 对齐 + better-dsh 0.3.2-f（2026-10-30）

本轮目标：将 upstream checkout 从 `dsh-v0.2.1-rc.3` 对齐到 `dsh-v0.2.2-alpha.2`，修复 dev3 生产在 022a2 上 better-dsh 整包失效（含移动端侧栏收缩 + 滑动手势失灵）的破坏面，双包发 0.3.2-f 同步字母版。

## 背景与根因（dev3 生产事故）

dev3 prod 升级 `@deepseek-ai/dsh@0.2.2-alpha.2` 后（10-29 00:26 boot），journal 出现：

```
dashr-repl (better-dsh): failed to import: .../better-dsh/lib/index.js:14
SyntaxError: The requested module '@deepseek-ai/dsh-tools' does not provide an export named 'TOOL_RUNTIME_SCHEDULER'
```

- **根因**：0.2.2 把 PTC staged scheduler 从 `@deepseek-ai/dsh-tools` 拆出（新包 `dsh-tool-executor-ptc` / `dsh-tool-executor-native`），`TOOL_RUNTIME_SCHEDULER` symbol 导出被移除，better-dsh 0.3.2-e 顶层 import 失败 → better-dsh 宿主半边整行失活。移动端侧栏收缩/滑动只是**症状**：mobile 行（web-trust/mobile/plugin 等独立 entry）虽仍加载（boot script 注入正常），但 dev3 报告的「整包 patch 失效」以 repl 行 import 失败为总根源；4999 线实测 0.3.2-e 在 022a2 上同样炸。
- 佐证：AppFrame 契约在 022a2 无破坏（`[data-sidebar-collapsed]` + inline `grid-template-columns` 三轨 + `data-rightbar-*` 全在，`ui-sidebar` CSS diff 仅 hover 门控/padding 类妆面改动）。

## upstream 对齐

| 项 | 结果 |
|---|---|
| fetch | GitHub 直取 `dsh-v0.2.2-alpha.2` = `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`（PR #7437；origin 镜像仍止步 0.2.0-rc.2） |
| 切换 | `checkout -f` + `clean -xdf` + sanctioned 单补丁重放（`pnpm-workspace.yaml` 尾部 `storeDir`/`verifyDepsBeforeRun` 两键，原样 3 行） |
| 构建 | `npx pnpm@11.28.5 install --frozen-lockfile && run build` → **10/10 gates PASS（145.8s）**；packageManager 仍 pin pnpm@11.28.5 |
| delta 规模 | rc.3 → 022a2 = 7,251 文件 +311k/−696k（含 website/snapshots 大头）；官方 upgrade-guide 覆盖 v0.2.1-rc.3/rc.4（attachment-read-access、cua-bundle-id、worktree 命名、independent forks、ptc-caller-cancellation、session-follow-activate、model-listing-refresh），无 0.2.2 专属 guide → 破坏面靠直接 diff |

## 破坏面清单与适配（better-dsh）

1. **`TOOL_RUNTIME_SCHEDULER` 移除**（src/index.ts）：改从 `@deepseek-ai/dsh-tools/pipeline` 构建 `new ToolExecutionPipeline(runtimeCtx)`，staged 语义对齐 —— `prepare`/`dispatch` 不变，旧 `finalize`/`finish` 合并为 `complete(exec, parked)`；`classify` 改 `pipeline.executionMode`。旧 dual-copy symbol 隐患随 symbol 消亡结构性消失（loud-fail 分支删除）。pipeline 在 inject wait（`replRuntime`）回调内构造，构造时点保证 `tools` 已挂载。
2. **PTC session 事件搬家**：`tool/ptc-dispatch{,-start}` 与 `tools/ptc-dispatch-log` 声明移入 `dsh-tool-executor-ptc` → 加 type-only import 拉取 augmentation；peerDependencies 增 `@deepseek-ai/dsh-tool-executor-ptc >=0.2.2-0 <0.3.0-0`（optional，沿全 optional house style）。
3. **`renderIndex(html, peer)`**（web-password.ts）：0.2.2 index 渲染按 Peer 计；登录前 admission 页取 `ctx.connection.browserPeer`（与 upstream frontend-static 的 `peer ?? connection.browserPeer` 同源，owner principal）。
4. **工具执行架构**：`tools.execute()` 改为 model-shaped batch（`ToolCallBlock[]`，raw JSON-string args）且需组合挂 executor；prompt assembly 也会解析 executor-owned sections（无 executor 即 throw）。测试线适配：单调用统一 `executeToolFixture`（`dsh-tool-testkit`，直接驱动 staged pipeline，保留全策略语义）；单测组合挂真实 `NativeToolExecutor`；`AgentRegistry` 0.2.2 新增 `static inject=['sessionProjections']` → harness 补挂 `SessionProjectionRegistry`（此前 10 用例 × 60s 超时挂死的根因）。cordis 0.2.2 行为变化：inject 插件 apply 可晚于 `await ctx.plugin()` → harness 的 host 捕获改 object plugin + `hostReady` promise 门。
5. **`Agent.model` 必选成员**（九个 adapter）：0.2.2 Web UI 换模型经 `session/selectModel` → `agent.model.select()`。superd-hub 新增共享模块 **`agent-model-face.ts`**（export subpath 经 index）：`recordedModelSelection()` 以事件扫描复刻原生 `modelSelection` 投影 fold（pending 存活至匹配 request/header 退休之；lastUsed=最后 header config），`createAgentModelFace()` 出 `current()`（pending→logged→deployment default→options）/`select()`（与原生同一 `model/selection` durable append，dedupe）。九个 agent（claude/codex/hermes/pi/agy + 三 SDK 线 + omp）统一接线；OMP/Pi 的 `#syncModelSelection` 增 fold tier-0（select 落下一轮 set_model）；claude/codex 原有 resolveRoute（投影 pending 优先）不变。
6. **`installModelSelection(agentCtx, ref)` → `(agentCtx)`**：rc.3 injected-ref 注入点删除。五处 pin 站点（hermes/pi/agy/agy-sdk/codex-sdk index.ts）改 `agent.model.select(selection)`（同一 durable 机制）。
7. **`approval/policy` augmentation 断链**（agent-claude）：rc.3 经 `hub-tool.d.ts → dsh-tools → dsh-user-approval` 的传递链在 0.2.2 断（上游把 augmentation import 移入 pipeline.ts 且 tsc 从 dts 洗掉 `import type {}`）→ permission.ts 直连 `import type {} from "@deepseek-ai/dsh-user-approval"`（本就是 peer）。

## 交付

- 版本：`npm run version:release -- 0.3.2-f`（根/better/super 同步）。
- 构建：`npm run pack` 全绿 —— `better-dsh-0.3.2-f.tgz`（c5f83e0e…）、`super-dsh-0.3.2-f.tgz`（e12bb32f…），independent-bundle 校验过（Super 无 Better 依赖/payload）。
- 单测：better-dsh **929 pass / 6 fail**（6 个全部为既有环境项：`/usr/bin/google-chrome-stable` 缺失，DASHR_BROWSER_BIN 指 chrome-for-testing 即过，非 0.2.2 回归）；hub node:test **647/0**。

## 4999 整包线验收

- `start-4999.sh` 全链拉起（pair-registry 14999 / test / lan-relay 三 unit active），pnpm 消费本轮 super-dsh 0.3.2-f。
- **companion 契约实测**：home 内既有 better-dsh 0.3.2-e 依约保留（coordinator 仅在缺失时装），profile 直依赖经 pair registry 手动升 0.3.2-f 并 restart 后：**boot 0 个 `failed to import`**（0.3.2-e 在同一 host 上稳定复现该行，0.3.2-f 清零），`dsh: warning: 1 entry did not activate` + 六 world `harness-dev-context pending webApp` 为 rc.1 起既有状态。
- 门检：`/` 密码页 200；匿名 `/api/` 401；登录 POST→303→cookie 生命周期正常。
- **移动端验证（服务器侧全链）**：served `/index.html` 携带 `__DASHR_MOBILE__`（含 zoom-guard 段）；组合 client bundle（2.4MB，`better-dsh/client.js`+`super-dsh/client.js` 在列）内 `data-sidebar-collapsed` 选择器、`grid-template-columns:0px minmax(0,1fr) 0px` 零宽轨规则、`toggleSidebar`、`data-sidebar-right-expand` 全部在位；AppFrame 022a2 DOM 契约（attribute + inline 三轨 grid + `data-rightbar-*`）逐项核对无漂移。真机滑动/收缩行为交 user 浏览器验收（`https://test.pc.internal.test/`）。
- 会话 wire 探针：`/api/session/prompt` 直打需完整 client-request envelope（Typert RPC），本轮以单测真实 pipeline 驱动（bridge/presentation 116 例）+ 浏览器验收覆盖。

## 遗留与决策点（user）

1. **dev3 prod 修复**：`0.3.2-f` 已具备修复条件（本地同 host 形态复现→清零）。dev3 `~/.dsh` 属生产，安装+重启 `dsh.service`（3080）需 user 明确下令后执行。
2. **publish**：未发布、未 commit/tag/push（红线）。放行后按 0.3.2-f 双包发 npm。
3. 4999 三 unit 保持运行供 user 验收（`systemctl --user stop superd-4999-test superd-lan-4999-relay superd-4999-pair-registry` 收线）。

## 追加（同日 12:30）：foreign world 模型选择器「正在加载模型」修复（0.3.2-g）

user 抽样 Hermes/OMP/PI：模型可选可对话，但 selector 标签恒显「正在加载模型」。根因链（上游源逐层读出）：`ui-model-selection` 的 trigger 以 `projected === undefined` 恒进 loading 分支（directory.ts `syncInputs`）→ 客户端经 `binding.session.projections.faceOf('modelSelection')` 读投影 → **上游唯一注册点是 `dsh-agent-loop` 行（agent-loop/src:334）**，而 `WORLD_WAVE1_DISABLED_ROWS`（2026-09-27 world 最小化）在所有 foreign world 禁用了 agent-loop → 世界投影注册表无 `modelSelection` → 客户端帧永不解析。catalog（`session/modelCatalog`）与选择 RPC（`session/selectModel`）走不同通道，故一直可用——与 user 观察逐点吻合（claude/codex world 同受影响，只是未抽样）。

**修复**（superd-hub `world-entry.ts`，单份共享、九 world 全覆盖）：world mount 行在 `sessionProjections` inject 内注册 `modelSelectionProjectionDefinition`（`@deepseek-ai/dsh-agent` 导出；纯事件 fold，无 loop 机器；register 引用计数且同 stateVersion 幂等，未来 agent-loop 行若回归也不冲突）。hub package.json 补 `@deepseek-ai/dsh-agent` optional peer 行。版本升 **0.3.2-g**（双包同步重打；better 内容不变，0.3.2-f 从未发布，血脉干净）。

**验证**（4999 线，0.3.2-g，boot 零 import 失败）：以 UI 同款 wire（`/api/<method>?agent=<world>`，client-request 信封 `{args:{request}}`）实测——omp world `session/create` → `session/projections` 含 `modelSelection:{lastUsed:null,next:null}`；`session/selectModel`（deepseek-official/deepseek-flash）→ 复读 `next` 即所选（正是 trigger 标签取值路径 `projected.next ?? catalog.default`）；pi、hermes world 同验在场。真机 UI 复验交 user。
