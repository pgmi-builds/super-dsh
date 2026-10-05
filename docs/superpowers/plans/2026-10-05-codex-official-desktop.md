# Codex official / desktop binary 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 按已批准方向实现 OpenAI OAuth selector 与 desktop 优先、CLI fallback。
**Architecture:** 在现有 app-server transport 旁新增纯 binary 发现单元，明确 JS/native 两种启动方式；现有 provider 正本持久化 native identity，launch argv 覆盖 builtin provider。既有 Hub provider UI 展示 native readonly identity。
**Tech Stack:** TypeScript、Node child_process、Codex app-server JSONL、DSH/Cordis、tarball + pnpm。
**Spec:** docs/specs/codex-official/spec.md

## Global Constraints

- 沿用 user 已授权当前 checkout，不新建 worktree；现有待定 diff 不覆盖或丢弃。
- 原生 config/auth 零写入；token 不复制、不打印；prod DSH home/3080/3081 不碰。
- create() 零 spawn；启动选择按 override→desktop→CLI→package；生成失败不触发 provider fallback。
- 仅 scripts/pack.mjs 构建打包；0.1.10-l → m → n → o 字母迭代；4999 sole launcher；不 publish。
- 不把 desktop identity 当作模型权限或工具能力开关。

## Task 1: Binary 发现与 transport 启动

Files: agent-codex/src/codex-runtime.ts（新增）、app-server-wire.ts、test/codex-runtime.test.mjs、test/app-server-wire.test.mjs。
Produces: resolveCodexRuntime(): {command:string, nodeScript:boolean, source:string}; resolveCodexCommand 保留兼容 string 接口。可注入 discovery dependencies 以隔离平台、环境、exists/access/which/package lookup。

- [x] 写失败测试：override 优先、可执行 desktop 优先、desktop 缺失/不可执行走 CLI、CLI 缺失走 pinned package、缺失 actionable error。假 native executable 被直接启动且 app-server argv 保留；JS mock 仍用 Node。
- [x] 运行 node --test，确认 RED；build 前测试可用 source-loader 或既有 dist 针对新增导出缺失产生正确 RED。
- [x] 实现平台候选 Linux /usr/lib/chatgpt/resources/codex、Codex 安装资源候选与 macOS .app/Windows LocalAppData 约定；显式路径候选由变量/env 可注入，查到实际 executable 才选。禁止递归扫整个磁盘。
- [x] transport.start() 才解析/检查；根据 nodeScript 调用 spawn(process.execPath,[command,...args]) 或 spawn(command,args)。修订源码中 pin-faithful 注释与测试断言。
- [x] 经唯一 pack build 后 targeted tests GREEN，说明无法单独 build 的 RED/GREEN 依赖；不提交其他 worker 文件。

## Task 2: OAuth 健壮性与双 adapter 一致

Files: 两条 adapter 的 codex-oauth.ts、OAuth tests；agent-codex-sdk/src/index.ts 与对应 route regression tests；共享模块复制保持 byte parity。
Consumes: 已有 openai-oauth alias，真实 token 留原生 auth。

- [x] 写失败测试：logged OAuth logout 后 SDK launchFor 抛错；缩进/quoted model_catalog_json 缺 cache 不泄漏；空 slug、缺字段、混合无效 cache 不注入。
- [x] 验证 RED，修复 cache validation（按实际 binary required metadata shape）、native config catalog 判断（接受合法缩进/quoted keys）、SDK missing-auth guard。将 test cache fixture 改成真实可消费 metadata shape。
- [x] 官方 provider identity 的持久 shape 保持 {id,label,kind,origin}；读取有效 models 不生成虚构列表，官方没目录时显示 actionable hint。
- [x] 唯一 pack 后测试 GREEN，读取 native config/auth 指纹保持不变。

## Task 3: 集成与桌面能力核对

Files: README / adapter contracts、Hub 已有 OAuth UI、package 版本、test reports。

- [x] 确认 transport 只启动自有 app-server，不复用/控制在役 desktop child；browser/computer use 需要的额外协议/pipe/helper 只记录现有证据，不绕接在役服务。
- [x] 版本升 0.1.10-l，评审隔离修复再迭代 0.1.10-m，修正文档旧“只用 pinned entry”说明；如 package fallback 仍 0.154.0，明确官方模型跟实际 selected binary。对 alias→runtime provider 冷启动、provider 切换、SDK 缺认证作独立 review。
- [x] 按 approval 的 case 实测 desktop 核心 + 自有 clientInfo + official SOL，第三方选择共存；识别原生 custom catalog 冲突并修复已测根因。

## Task 4: 交付形态验证

- [x] node super-dsh/scripts/pack.mjs，记录 tarball；targeted adapter/Hub suites 全绿；已有全面 tests 合理复用。
- [ ] SUPERD_TEST_HTTP_PROXY=http://dev3.internal.test:7474 bash super-dsh/test/start-4999.sh；sole launcher 用 tarball 实装，保存日志水位和 URL。
- [ ] 浏览器同版 NEW→prompt official→switch third-party→return official（实测真实 generation 与 next-turn routing）→切其他 world→回来 replay/resume。检查 child 实际 executable 是 desktop 核心与无 native config/auth 写入。
- [ ] 落 docs/test-reports；保持 4999 运行供 user 测试。需要 dev3 实装交付时遵守 tarball + restart + mount/journal 策略；本轮优先 4999，跟 user 本轮指令。

## 实测新增修正（n / o）

- [x] 普通官方配置不强制 static catalog，让 selected binary 维护 version/identity/TTL cache；保留原生官方配置的默认 model ID。RED→n GREEN，独立 review 通过。
- [x] 移除第三方合成 catalog 中未经验证的 OpenAI comp_hash；旧生成条目再生也去除，原生 template 不改、context window/auto-compaction 参数保留。4 条 RED→o 两条 Codex 全部 451 GREEN；独立 review 通过。
- [ ] o tarball 4999 同版新会话跑全 official→third-party→official→world handoff→replay/resume。
- [ ] 更新验收报告与原生 config/auth 指纹核对，保持 4999，commit 最终阶段。

## 阶段收尾（用户最新裁决）

用户确认当前测试通过，明确要求停止 4999、清理现场并 push / publish 0.1.11。
本次交付 OAuth selector、desktop 优先发现与已验证的 catalog 修复；保留测试记录中第三方历史回官方的失败，自动 compact 作为下一阶段候选，未实现。
此前“不 publish / 保持 4999”约束由这次明确指令覆盖。未勾选的完整双向 provider 链不冒充通过。
发布构建与全套回归、停机和发布结果见 docs/test-reports/2026-10-05-super-dsh-0.1.11-release.md。
