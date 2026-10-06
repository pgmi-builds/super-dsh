# Foreign Substrate Hub Implementation Plan

> 执行：当前 worktree 内逐任务执行；不定版提交，直至真实验收、报告和 user 放行。

**Goal:** PI / OMP 共享原生扩展、Codex 动态工具接入既有 Hub facility。
**Architecture:** hub 自有 session binding 复用工具执行；PI / OMP 增量扩展经 loopback capability 调用，Codex 经 app-server callback 调用。回信复用 live agent handles。
**Tech Stack:** TypeScript、Node HTTP、PI SDK、OMP RPC、Codex 0.160.0 app-server。
**Spec:** `docs/specs/foreign-substrate/spec.md`

## Global Constraints

单一 pack；零 MCP；上游源码零修改；安装期零 hooks / binary；runtime 原生 home 不重定向；draft 零 IO / spawn；不触碰生产 3080 / 3081；验收前不 commit / publish。

## Task 1 — Hub session binding 与共享扩展

Files: `superd-hub/src/foreign-hub.ts`, `foreign-extension.ts`, `a2a-row.ts`, `superd-hub/test/foreign-hub.test.mjs`；hub exports。
Interfaces: `bindForeignHub(runtime, sessionId, worldHome, getAgent)` 返回 `ForeignHubBinding`（definition / execute / extensionPath / dispose）；`registerForeignHubHost(home, deps)` 返回 disposer；`foreignAgentHandle(sessionId)` 给既有 delivery 查询。
- [x] baseline build / unit；实际 LSP / AST 追踪新接线依赖。
- [x] 写 failing unit：两个 caller 发送时不同 initiator、非法 capability 拒绝、关闭 capability 失效、wrapper 延迟写入。运行 `node --test test/foreign-hub.test.mjs` 验证 red。
- [x] 实现绑定、复用 schema 校验、内部 loopback POST、共享扩展 registerTool 与会话 wrapper。
- [x] build + 新 unit + hub suite；schema / description 共用，不复制业务 dispatch。

## Task 2 — PI / OMP 增量挂载

Files: `agent-pi/src/pi-client.ts`, `index.ts`；`agent-omp/src/lazy-rpc.ts`, `index.ts`；对应 client / lazy tests。
Interfaces: PI config 可携 binding；OMP lazy argv thunk 接受 Promise<string[]>，首次 prompt 调 binding.extensionPath() 加 `-e`。
- [x] failing client tests：async argv 才准备扩展、close 取消未 spawn、PI binding 被延迟到真实 session factory。
- [x] 用 SDK DefaultResourceLoader additionalExtensionPaths 合并 PI 资源，不关闭现有 discovery；OMP 只加 `-e`，不加 no-extensions。
- [x] 绑定 dispose 与 handle/client 生命周期；build + 相关 suites。

## Task 3 — Codex dynamic callback

Files: `agent-codex/src/app-server-client.ts`, `index.ts`, `app-server-events.ts`；client / event tests。
Interfaces: options.hub binding；thread/start 注入 definition；item/tool/call 优先按名称与 thread 绑定派发，再走既有 approval handler。
- [x] failing tests：新增 tool 定义到 thread/start；callback 成功 / 错误；陌生 thread 拒绝；既有 approval handler 保持；dynamicToolCall 投影。
- [x] 实现并保持 lazy / provider 重启 / resume 回调重连；build + Codex suite。

## Task 4 — 整包、目标机与报告

Files: `super-dsh/package.json` 字母后缀、受影响 README、报告。
- [x] 清理重建、pack manifest 校验、新 tarball suffix；launcher 复用长寿命 `.tests/superd` 与共用 credentials。
- [x] 4999 真模型三个 runtime create / prompt / resume、工具共存、exec / send / 自动回信；保留访问 URL。
- [x] dev3 实装同一 tarball，与源码基线对齐，运行同组行为验收。
- [x] 写 report 与局限；用户验收放行前保持 uncommitted，不 publish。

## 验收结果

实现及自动行为验收完成，详见 `docs/test-reports/2026-10-06-foreign-substrate.md`。人工 Web 验收与发布放行尚未发生；测试线保持运行。Codex DeepSeek 的 dev3 工具选择兼容差异明确记为未通过，不计入已通过矩阵。
