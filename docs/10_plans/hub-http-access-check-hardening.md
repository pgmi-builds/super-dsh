# Hub HTTP 访问检查收口（待兼并计划）

> 日期：2026-11-15 · 状态：**backlog，待未来 feature 版本兼并**（user 2026-11-15 裁决：小瑕疵，不单独成轮、不塞进已收尾/已饱和的现存计划，单独成档供后续计划兼并）
> 来源：awesome-dsh-plugin 维护者 `fkysly` 在 [#15255](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15255) 合并时的源码复验（2026-11-14）。
> 承诺链：修复 + 发新版 → 市场条目收回 caveat 句（[yml](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/pgmi-builds__super-dsh--super-dsh.yml) 可自 PR，或请维护者收）。

## 1. 问题陈述

维护者复验结论（已并入 super-dsh 市场 entry 的 en/zh 描述）：

> *Its HTTP routes have no DSH access check, so a web page open in your browser could call them.*
> （它的 HTTP 路由没有 DSH 的访问检查，浏览器里打开的网页可以调用它们。）

攻击面：用户浏览器中**任意网页**可向 hub 的 HTTP 入口发起跨源调用（CSRF 类：目标为本机/局域网的 499x 测试口与 3081 生产口）。维护者建议修法：handler 入口调 `ctx.connection.requestRejection(req)`，或改用 `ctx.connection.fetch.register`，并要求 POST 携带 `Content-Type: application/json`（强制 JSON content-type 使跨源请求必须过 preflight，从而被拒绝；同源官方 UI 不受影响）。

## 2. 现状粗勘（2026-11-15，写档时快照）

hub **并非没有**访问检查管线——以下接线点已存在：

- `super-dsh/superd-hub/src/hub-route.ts`：入口调用 `options.requestRejection?.(req)`（两处）并把它透传给 `forwardApiCall`；
- `super-dsh/superd-hub/src/gateway.ts:101`：`requestRejection(req)` 声明为注入面；
- `super-dsh/superd-hub/src/remote-file-rpc.ts:72`：自带 `allowed ? opts.requestRejection?.(req) : status` 的门形态；
- `super-dsh/superd-hub/src/rpc.ts:5`（注释）：上游 `/api/*` feature mount 走 `ctx.connection.fetch.register(...)`。

**因此缺口是「特定入口未接线/未强制」，不是全面裸奔**；精确边界以 T1 审计为准，本档不预设结论。

## 3. 任务分解（兼并时整体带走）

- **T1 入口审计（先做，决定后续范围）**：枚举 hub 全部 HTTP 入口并逐条核对 `requestRejection` 是否实际生效——
  - `/hub/api/remote.mux`（`HUB_MUX_PATH`）与 `/hub/api/*` envelope 转发族；
  - WS upgrade 路径（PTY/长连接握手是否经过同一 gate——常见漏点）；
  - `remote-file-rpc`、`mesh-gateway` 的 native face（`/api/remote.mux`）与 hub face 双入口；
  - 监听面盘点：499x 测试口、3081 生产口各自暴露的入口集合。
  - 产出：入口清单 × gate 状态表；无 gate 的入口即 T2 收口对象。
- **T2 修法（先核上游官方判别式再动手，AGENTS 纪律：优先官方机制）**：
  - 方案 A：handler 入口统一补 `ctx.connection.requestRejection(req)`（现有管线的自然延伸）；
  - 方案 B：入口迁到 `ctx.connection.fetch.register`（上游 `/api/*` 的官方注册面，内建访问控制）；
  - 叠加：所有状态变更类入口强制 `POST` + `Content-Type: application/json`（浏览器侧 CSRF 挡板）；
  - 以 LSP/AST + dsh-docs 核对上游同类路由的官方写法后择一，禁止自创守卫形态。
- **T3 测试与验收**：
  - 单测：无 gate 模拟请求被拒（401/403 语义与 DSH 官方一致）；非 JSON content-type 拒绝；GET 形态的状态变更请求拒绝；
  - 浏览器视角：非受信 origin 发起的跨源调用被 preflight/rejection 挡下；同源官方 UI（Hub 面板、世界切换）零回归；
  - 走 4999 整包线第一人称验收（门检 + Hub 面板操作），报告落 `docs/test-reports/`。
- **T4 发版与市场收句**：随下一次 feature 版本发布（本项不单独发版，user 裁决）；发版后编辑 `data/plugins/pgmi-builds__super-dsh--super-dsh.yml` 移除 caveat 半句（维护者明示欢迎直接 PR）+ 同步 README 行（en/zh）。

## 4. 非目标

- 不重构路由层 / 不引入新的配置面或 env 旋钮；
- 不改变同源官方 UI 的调用路径与行为；
- 不为本次修复单独开版本号（并入 feature 版本）。

## 5. 关联

- 触发：[#15255](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15255)（维护者评论 2026-11-14T17:40Z）；后续 [#15423](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15423)（日期迁移，无关联仅时间线相邻）；
- 机制参考：`docs/07-cordis-dsh-dev-test-guides.md`（验收线）、上游 `ctx.connection` 面（`rpc.ts` 注释起点）；
- 兼并方式：未来 feature 计划在 `docs/superpowers/plans/` 立项时，把本档 T1–T4 作为其一个 workstream 收编，完成后在本档头部标记「已由 <计划> 收编」并留存原档。
