# apps/agent-worlds — 局部规则（Agent Worlds 第三路线）

- 本文件管辖本目录及子目录；上层为仓根 `AGENTS.md`（最近者胜，中间无其他层）。
- 第三路线：Multi-Context 拓扑 × M0-Fork 数据面哲学的融合线（foreign agent deep integration and detachment）。设计正本：`docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`（S1–S6 裁决）；现役实现计划：`docs/superpowers/plans/2026-09-14-agent-worlds-aw-a-plan.md`。
- 姊妹线 `apps/multi-agent/`（2026-09-10 搁置）、`apps/multi-agent-ctx/`（冻结保留）——**拷贝或引用，永不反向依赖；冻结线永不因本线被迫改动**。

## 职责分界（2026-09-14 定案）

- cordis/dsh patches（UI 或后端）、存储适配、adapter runtime **一律 per agent**（`agent-adapter-*` / `agent-ui-*` 包自持）。
- **本线自身只建设 switch 与 gateway**：`aw-routing/`（selector + V5 实例委托导流门 + roster + spawnWorld）。mostly, at least now；adapter 专属物永不上提到线。

## 核心不变量（违反即设计缺陷，详见设计文档 S1–S6）

1. **S1**：selector 一跳 handoff；dispatcher 从不在请求路径寻址 sessionId；错误 sessionId 由当前世界 sessionController 独占应答（原生 not-found 语义），零跨 context 探测。
2. **S2**：roster = adapter 插件加载态投影，无配置文件；spawn 由插件自带 composition（引用上游 bundle 名）在 CTX0 树上 `boot()` 派生——**绝不经 `runProfile()`**（ADR 0008 约束 1）。
3. **S3/S7**：嵌套 home `<dshHomePath>/agents/<runtime>/`；native app 原生自填充；原生 session log 留原生格式，DSH log（AW-C1 起）与之 duplicate 显式接受；单向阀 = 不回读。
4. **S4**：零端口 ctxN（不喂 bind 参数 / disable web 行）；委托 = `typertGateway` 实例两方法进程内委托，零 HTTP、零字节代理；单一认证域（ctx0 cookie）。
5. **S5**：行表深度 agent-specific；omp-web 形态起步不 suppress `ctx.llm`；数据路径归 adapter 所有；会话 log 单一主笔仅在采纳转译（AW-C1）时为准入判据。
6. **S6**：router 是哑的——只管 consumer 切换 + 新会话 generator 指向；生命周期归 owner context；零 HMR / 零 Drain。

## 运维红线

- 上游源码零修改；`@deepseek-ai/*` 单实例纪律——任何 install 后 `find <scope>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` 检查（仓根 farm 现指向 `.superd-test/profiles/node_modules/@deepseek-ai`，heal 目标 = repo build）。
- dev/test 一律 `DSH_HOME=<仓根>/.superd-test/aw`；**绝不触碰 `~/.dsh`、`~/.superd`、`~/.omp`**。
- 端口 4998（本线默认）；避开 3080/3081（prod）与 4999（multi-agent-ctx 线现役）；拉起前 `ss` 预检；daemon 一律 `systemd-run --user`，关停 `systemctl --user stop`。
- 测试约定：`node --test test/*.test.mjs`；测试导入 `dist/`，先 build 后 test。
