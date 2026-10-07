# P0 探针报告 — Native UI Fusion（R4 go/no-go + 模块图同构验证）

- 日期：2026-09-26
- 对象：[native-ui-fusion-plan.md](../research/native-ui-fusion-plan.md) §3.2（parameter 主案 go/no-go）与 §4（模块图同构不变量）
- 探针代码：worktree `.worktrees/p0-api-wrap`（branch `p0-api-wrap-probe`，commit `6a86b41`，`super-dsh/superd-hub/test/api-wrap-probe.test.mjs`）
- 上游基线：`dsh-v0.1.7-rc.1`（repo checkout）

## 探针 ① — world boot graph 模块图同构（实测，推翻评审 §3.2 的规则推导）

方法：clean rig（`SUPERD_PORT=4996 SUPERD_HOME_DIR=.tests/superd-p0probe`，pack 线 tarball `super-dsh 0.1.3-zg`）起整包，认证后抓 ctx0 与各 world 挂载页的 `__DSH_BOOT__`，比对 entries。

| 页面 | entries | `@pgmi-builds` 行 | `agent-omp` client 行 |
|---|---|---|---|
| `/`（ctx0 native） | 63 | **无** | 无 |
| `/claude/` | 63 | `@pgmi-builds/superd-hub` | 无 |
| `/codex/` | 63 | `@pgmi-builds/superd-hub` | 无 |
| `/omp/` | 63 | `@pgmi-builds/superd-hub` | **无** |

结论：

1. **评审 §3.2 的规则推导被实测推翻**：world profile 的 adapter 行（composite subpath `super-dsh/agents/omp`）**不是** client 行——`agent-omp/client`（mobile 侧栏+手势）**不在**任何 world 的 boot graph 里。六个 world 与 native 的模块图差异只有一条 `@pgmi-builds/superd-hub`。**模块图同构不变量今天已天然成立**，无需迁移 `agent-omp/client`（plan §4 的迁移规则降级为纯防御性条款）。
2. **新事实（fusion 的前置工作项）**：ctx0 native 页的 boot graph **不含** `@pgmi-builds/superd-hub` client 半边——现役 pack 的 client half 只出现在 world 页。融合（P1）需要让 ctx0 也挂上 hub client（裸名行已在 composite patch，是否被 profile 组合吃掉需 P1 复核）。

> **勘误（2026-09-26，Task 1 复核）**：上述结论 2 为**假阴性**。ctx0 页的 client 行 id 是**裸名 `super-dsh`**（composite 裸名行 `- id: superd-hub, name: 'super-dsh'` 经 `exactPackageSpecifier` 只能以裸包名入图），本探针只搜了 world 侧拼写 `@pgmi-builds/superd-hub`，故结构性看不见它。ctx0 **已经** compose hub client half——63 entries 的算术闭合（61 上游 + picker-surface + 一条 hub 行）与 in-process `runProfile()` 复现均证实。证明测试：`superd-hub/test/ctx0-client-row.test.mjs`（commit b9aca2a）；机制锚点：`upstream/.../packages/client/modules/src/client/manifest.ts:189-195`。

## 探针 ② — `/api` demux 接缝（in-process `boot()` 实测）

方法：worktree 内 `node --test`，boot 最小树（rows：webserver + client-connection + credentials-local + frontend-static；PluginPackages 投影 + profile-local farm link，world-mount 测试同款配方）。

| # | 问题 | 实测结果 |
|---|---|---|
| Q1 | hub 自注册 `/api` prefix 行（原生已注册后） | **throw** `webserver: duplicate prefix route "/api"`——路由表私有 + 重复即硬错，hub 永远不能拥有 `/api` |
| Q2 | 根级 `ctx.on('connection/request')` 观察者能否看到完整 query | **能**：观察到 `/api/some.endpoint?x=1`；无 cookie 时 401（`admit()` fence 在 waterfall **之前**，认证先行） |
| Q3 | 观察者 veto（应答且不调 `next()`）能否独占响应 | **能**：`?agent=codex` → 观察者应答 `forwarded-to-world:codex`（200），原生 bridge 不再执行 |

机制锚点：`packages/client/connection/src/index.ts:155`——`/api` handler 内 `webCtx.waterfall('connection/request', req, res, () => bridge(...))`，事件在 `connection/src/index.ts:67` 有公开类型声明（Events interface）。这是设计内的 per-request 观察面，不是私有表。

结论：

- **Parameter 主案（unary/API 面）GO**：hub 在 ctx0 树内挂一个 `connection/request` 观察者——带 `?agent=<label>` 且非 native 的请求由观察者消费（转发进对应世界 gateway，carrier 现有 `dispatchRpc`/`envelope` 机制复用），其余透传。认证顺序天然正确（fence 先于 demux）。
- **mux WS upgrade 面 NO-GO（parameter 无接缝）**：`packages/api/gateway/src/index.ts:261` 直接 `webServer.registerUpgrade({path:'/api/remote.mux'})`，无 waterfall、无公开拦截，重复注册 throw。⇒ 融合 transport 的 **WS 必须走 path 前缀**（`/<label>/api/remote.mux`，carrier 现成、battle-tested）。
- **最终分流形状（hybrid，写回 plan §3.2/§3.3）**：
  - WS mux → path 前缀（carrier 现有）；
  - unary API / 上传 / 下载锚 → `?agent=` 参数（`connection/request` 观察者 demux，Q2/Q3 实测路径）；
  - 控制面（`/api/agent-runtime`）→ 无参数恒 ctx0（天然）。

## 遗留 / 交接

- rig 已停（`superd-4996-test`）；`.tests/superd-p0probe` 为可弃 home。
- worktree `p0-api-wrap-probe` 保留（探针测试可复跑；后续 P1 可从此分支续）。
- P1 需复核：ctx0 页缺 hub client 半边的组合层原因（探针 ① 结论 2）。
