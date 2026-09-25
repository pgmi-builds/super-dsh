# Native UI Fusion — `/hub` Single Route Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fuse foreign-agent runtimes into ctx0's single native Web UI: an in-page active-agent selector (Hub client state) retargets the data plane to a hub-owned `/hub` route family, with no browser navigation, no URL/history changes, and zero interference with native `/api`.

**Architecture:** Backend keeps multi-context worlds; hub adds ONE prefix route `/hub` + ONE upgrade route `/hub/api/remote.mux` on ctx0's webServer, demuxed by `?agent=<label>` (reusing carrier's envelope/mux/dispatchRpc forwarding). Frontend gets a page-level state atom (`__SUPERD_UI_STATE__`) installed before app boot (after web-trust); five call-time transport patches apply a single rewrite rule (`/api…` → `/hub/api…` + `?agent=`) when the active agent is foreign; RuntimeSeat switches agents in place (storage NS swap + session landing + `connection.reconnect()`).

**Tech Stack:** dsh 0.1.7-rc.1 (upstream checkout, zero modification), cordis 4.0.4, superd-hub TypeScript + client React bundle, node:test.

**Spec:** `docs/research/native-ui-fusion-plan.md` (v2, `/hub` family ratified 2026-09-26). Evidence: `docs/research/native-ui-fusion-survey.md`, `docs/test-reports/2026-09-26-p0-native-ui-fusion-probes.md`.

## Global Constraints

- 上游源码零修改（AGENTS §〇.5）；一切改动在 super-dsh 自有插件层。
- `@deepseek-ai` 单实例纪律：永不子包内 `npm install @deepseek-ai/*`；scope = `super-dsh/node_modules/@deepseek-ai`（farm，`scripts/sync-dsh-farm.mjs` 维护）。
- 测试 home 一律 `.tests/…` 或 tmpdir，绝不触碰 `~/.dsh`；daemon 一律 `systemd-run --user`；端口起线前 `ss` 预检（4999 整机共享）。
- 测试命令：`node --test --test-force-exit test/<file>`（superd-hub 目录下）；改动 src 后先 `npm run build`（tsc + client halves）再跑导入 `dist/` 的测试。
- 版本纪律：迭代一律字母后缀（当前 0.1.3-zg → 下一迭代 0.1.3-zh…）；构建/打包唯一入口 `node super-d-sh/scripts/pack.mjs`。
- 命名：hub 插件 `superd-hub`，路由家族 `/hub`，state global `__SUPERD_UI_STATE__`，flag global `__SUPERD_UI_FUSION__`；上游 UI 内 DSH 字样原样保留。
- 原生 `/api` 零接触：fusion 不在原生路由/handler 上挂任何观察者（waterfall 备选已记档不使用）。
- 每任务独立 commit；行为改动验收走运行形态（pack 线/浏览器实测），单测绿只是构建卫生。

---

### Task 1: ctx0 页挂上 hub client 半边（探针①结论 2 的跟进）

**Files:**
- Investigate: `super-dsh/cordis.patch.yml`（裸名行 `- id: superd-hub, name: 'super-dsh'`）、`super-d-sh/superd-hub/src/world-provision.ts`（worldMountPatches 里 world 侧 client 行如何成形）
- Modify: 视调查结论——可能 `super-dsh/cordis.patch.yml` 或 profile 层（`super-d-sh/test/start-4999.sh` 生成的 profile patch）
- Test: `super-dsh/superd-hub/test/ctx0-client-row.test.mjs`（新建）

**Interfaces:**
- Produces: ctx0 页 index 的 `__DSH_BOOT__` entries 含 `super-d-sh`（或 `@pgmi-builds/superd-hub`）client 行——Task 3/4 的 seat 与 fusion global 都依赖 ctx0 页加载 hub client bundle。

- [ ] **Step 1: 写失败测试**——pack 线（或 in-process boot 最小复刻）抓 ctx0 index，断言 `__DSH_BOOT__` entries 含 hub client 行。最小复刻优先：用 world-mount 测试的 host 投影配方 boot 一个只含 super-dsh composite 的树，renderIndex 后 grep。
- [ ] **Step 2: 跑测试确认失败**（现状：无该行，探针①已证）。
- [ ] **Step 3: 调查 + 修复**——对比 world 树（有行）与 ctx0 树（无行）的行扫描路径；client-modules 只认裸包名 row（`exactPackageSpecifier`）——确认 ctx0 组合里裸名行是否被吃掉/id 不符，修正 patch 行。
- [ ] **Step 4: 测试转绿 + clean rig 复核**——`SUPERD_PORT=4996 SUPERD_HOME_DIR=$PWD/.tests/superd-t1 bash super-d-sh/test/start-4999.sh`，curl ctx0 index 确认 client 行 + `client/super-dsh…` 资源可取。停 rig。
- [ ] **Step 5: Commit**（`hub: ctx0 composes the client half (probe-① follow-up)`）。

### Task 2: `/hub` 路由家族（server）

**Files:**
- Create: `super-d-sh/superd-hub/src/hub-route.ts`
- Modify: `super-d-sh/superd-hub/src/index.ts`（ctx0 侧挂载入口）、`superd-hub/src/carrier.ts`（抽取可复用的转发内核，label 来源参数化）
- Test: `super-dsh/superd-hub/test/hub-route.test.mjs`

**Interfaces:**
- Consumes: carrier 的 `CarrierGatewayFace`（dispatchRpc/openWireStream）、`world-host.ts` 的 `worldFetchHandlerOf`、envelope 解码（`envelope.ts`）。
- Produces:
  - `registerHubRoute(opts: { real: RealWebServerFace; authorize(req,res): boolean; gatewayOf(label: string): CarrierGatewayFace | undefined }): () => void`——注册 `/hub` prefix + `/hub/api/remote.mux` upgrade，返回 disposer。
  - 语义：`?agent=<label>` 且 label 已注册 → 消费请求转发该世界（envelope POST 走 dispatchRpc、非 envelope GET/HEAD 走 world fetch handler、WS 走 WorldMuxServer）；无 `agent` 参数或 `agent=native` → 404 JSON（提示该家族只服务 foreign）；未知/未 spawn label → 404 JSON `{error:'unknown-agent', label}`（静默退化，不锁死）。
- [ ] **Step 1: 写失败测试**——fakeReal 模式（world-web-server.test 同款）：注册 hub route → 断言 real.routes 有 `prefix:/hub`、real.upgrades 有 `/hub/api/remote.mux`；fake gateway 断言 dispatchRpc 收到解码 payload；`?agent=codex` 请求的响应即 fake gateway 的应答；无参/未知 label 404；authorize 返回 false 时不触 gateway。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**——从 carrier.ts 抽转发内核（envelope 分发 + mux upgrade 构造）为可参数化函数；hub-route.ts 组装；index.ts 在 ctx0 树 inject webServer 后注册（authorize 复用 world mount 的 ctx0 gate 来源）。
- [ ] **Step 4: 测试转绿**；`npm run build` 全绿。
- [ ] **Step 5: Commit**。

### Task 3: fusion transport（client 页面脚本 + state 原子）

**Files:**
- Create: `super-d-sh/superd-hub/src/fusion-transport.ts`（`renderFusionTransport(): string` 生成 head 脚本，形状仿 `client-shim.ts`）
- Modify: `superd-hub/src/index.ts`（ctx0 index 注入 row：位置在 web-trust 注入**之后**——`if(!window.__DSH_TRANSPORT__)` 不合并，先装会吃掉 ownsHost，评审 §4.3；flag 开启才注入）
- Test: `super-dsh/superd-hub/test/fusion-transport.test.mjs`

**Interfaces:**
- Produces:
  - global `__SUPERD_UI_STATE__ = { get activeAgent(): 'native'|string, setAgent(label): void, subscribe(fn): () => void }`（初始 `'native'`，不持久化）。
  - 五个 call-time patch（读 state，不看闭包常量）：
    1. `globalThis.fetch`：activeAgent 非 native 且 URL path 以 `/api` 开头（同源）→ path 前加 `/hub`、追加 `?agent=<label>`；
    2. `WebSocket`/`EventSource` Proxy + `XMLHttpRequest.open`：同规则；
    3. `__DSH_FILE_UPLOAD__ = { fetch }`：随 1；
    4. `HTMLAnchorElement.prototype.click`：`download` 锚 + 同源 `/api` href → 同规则（现窄规则形状）；
    5. `Storage.prototype` get/set/remove：NS = call-time 读 activeAgent（native 无前缀，foreign `<label>:`）。
  - 控制面豁免：`/api/agent-runtime` **永不重写**（恒 ctx0）。
  - 幂等守卫 + 不抛（best-effort 契约同现 shim）。
- [ ] **Step 1: 写失败测试**——node vm 沙箱执行生成脚本（client-shim.test 同款）：矩阵 native/foreign × fetch/WS/XHR/anchor/storage；断言 native 下全部原样透传；foreign 下重写正确（query 保留、hash 保留、异源不动）；`setAgent` 后同 request 对象走到新前缀（call-time 语义）；NS 切换后同 key 各读各的；豁免路径不重写。
- [ ] **Step 2: 确认失败**。
- [ ] **Step 3: 实现**。注意 `'\/api'` 字面量引号纪律（index-pass 会重写双引号 root-absolute 串——fusion 脚本走 index-inject row，同样受 HTML pass 影响，沿用单引号纪律）。
- [ ] **Step 4: 测试转绿 + build**。
- [ ] **Step 5: Commit**。

### Task 4: RuntimeSeat 融合分支 + 切换编排

**Files:**
- Modify: `super-d-sh/superd-hub/src/client/RuntimeSeat.tsx`（融合模式分支）、`superd-hub/src/client/roster.ts`（控制面取数不变）、可能新增 `superd-hub/src/client/switch.ts`（编排函数）
- Modify: `superd-hub/src/index.ts`（flag 开启时往 ctx0 index 注入 `__SUPERD_UI_FUSION__ = true` baked global，评审 §4.6 双半边通道）
- Test: `superd-sh/superd-hub/test/client-switch.test.mjs`（纯逻辑部分）；seat 分支走 pack 线浏览器验收（Task 6）

**Interfaces:**
- Consumes: Task 3 的 `__SUPERD_UI_STATE__`、`__SUPERD_UI_FUSION__`；Task 1 的 ctx0 client 行。
- Produces: `switchAgent(label: string): Promise<void>`（编排，见下）。
- 编排序列（spec §3.5，user 裁决 7/8）：
  1. `setAgent(label)`（state + NS 立即换，后续请求即分流）；
  2. 会话落位：读 `<label>:` NS 下 `dsh.sessions.current`——有值且经 `uiWorkspace` 可导航 → 导航到该 session；无值/失败 → 导航到 new chat（blank）。chat 区不清空、不插 loading 骨架；
  3. 触发 `connection.reconnect()`（经 `ctx.connection` 服务面或生成事件；具体入口以 ch18/survey §2 为准，执行时核对）；
  4. 失败兜底：reconnect 后 N 秒无 generation 建立或 roster 探活失败 → `setAgent('native')` + 提示 toast。
- [ ] **Step 1: 写失败测试**（switch.ts 纯逻辑：NS key 计算、落位决策表、兜底状态机——DOM/连接部分 mock）。
- [ ] **Step 2: 确认失败 → 实现 → 转绿 → build → Commit**（可拆 2-3 个 commit：编排逻辑 / seat 分支 / flag 注入）。

### Task 5: feature flag 双半边 + native 透传回归

**Files:**
- Modify: `superd-hub/src/index.ts`（`SUPERD_UI_FUSION` env/row config：开 → 注入 transport 脚本 + `__SUPERD_UI_FUSION__`；关 → 什么都不注入）、`super-d-sh/cordis.patch.yml`（若需 config 面）
- Test: `superdsh/hub/test/fusion-flag.test.mjs` + Task 3/4 测试全量回归

**Interfaces:**
- Produces: flag 关闭时 ctx0 页与现役行为**逐行为等价**（评审 §5：多一个 script 标签都不该有——关闭即不注入任何 row）。
- [ ] **Step 1: 测试**——flag off：index rows 无 fusion 脚本、无 `__SUPERD_UI_FUSION__`；flag on：rows 顺序 = […, web-trust, fusion（最后）]。
- [ ] **Step 2: 红 → 实现 → 绿 → build → Commit**。

### Task 6: 整包验收（spec §7 全项）+ 报告 + 放行闸门

**Files:**
- Modify: `super-d-sh/test/start-4999.sh`（如需 flag 旋钮透传）
- Create: `docs/test-reports/2026-09-XX-native-ui-fusion-acceptance.md`

- [ ] **Step 1:** `node super-d-sh/scripts/pack.mjs`（版本字母 +1）→ clean rig 起线（空闲端口）。
- [ ] **Step 2:** 验收清单逐项实测并记录（§7 八项）：每 runtime create+prompt(+resume)；双向切换 + 往返幂等；流进行中切换无串流；失败回退；trusted 域 `ownsHost`（Caddy test.pc 域回归——**须 4999 线，占用协调**）；控制面韧性（活动 world 掉线 roster 可用）；storage 串扰探针（同名 sessionId 两树各写各读）；会话落位（recent session / new chat / native refresh 恢复 session+draft 不受影响）。
- [ ] **Step 3:** 报告落 `docs/test-reports/`；起 4999 线交 user 亲手测（验收模式：保持运行，给 token URL）。
- [ ] **Step 4:** user 放行后 flag 默认开 + 收尾 commit；（per §〇.1）publish 另行请示。

---

## 交接注记

- 执行用 worktree（`using-git-worktrees`）；现有 `.worktrees/p0-api-wrap`（branch `p0-api-wrap-probe`）含 P0 探针测试与其 boot 配方（`api-wrap-probe.test.mjs` 的 PluginPackages 投影 + farm link + frontend-static distIndex 绝对路径四坑都已踩平，Task 2 集成测试直接抄）。
- `/hub` 与 frontend-static SPA fallback 共存次序（named prefix > fallback）已有 `/omp` 先例；如实测异常优先查 fallback 注册时序。
- `dsh.sessions.current` / `dsh.conversation.<id>` 恢复机制锚点：`packages/client/ui-workspace/src/client/navigation.ts:131`、`packages/client/ui-conversation/src/client/stores.ts:25`（survey §2.6）。
