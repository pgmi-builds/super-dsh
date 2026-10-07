# 0.1.10-h Browser Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 修复 F1/F2/F3 并在整包交付形态复验。

**Architecture:** 继续使用现有 world composition、DSH 日志及 control/follow 投影。修复已证明的接线和写入缺陷；F2 在确认根因后补入具体实施任务。

**Tech Stack:** TypeScript, Cordis, DSH, node:test, pnpm tarball, Codex Browser Use.

**Spec:** `docs/specs/h10-browser-bugfix/spec.md`

## Global Constraints

- 上游源码零修改；禁止触碰 prod 3080/3081 及 prod homes。
- 起始未提交改动已经按 user 新指令提交为 `f3d94ef`（0.1.10-h）；本轮修复以此为基线。
- 只走 tarball 字母迭代，不 npm publish。
- 测试先红后绿；行为验收走整包线，保留测试资产。
- 实施子代理不再派生子代理。共享源码上的实施任务顺序执行。

### Task 1: 保留 world 的 fileUploads host 服务

**Files:** `super-dsh/superd-hub/src/world-mount.ts`, `super-dsh/superd-hub/test/world-mount-patches.test.mjs`，关联 composition spec/README 注释。

**Interfaces:** `worldMountPatches(key)` 返回 patch layers；`WORLD_WAVE2_DISABLED_ROWS` 不得禁止提供 `fileUploads` 的 file-upload row。upstream SessionController 必需该服务。

- [x] 在既有 KEEP 测试中增加 `assert.equal(disabled.has('file-upload'), false)`；构建 hub 后运行该测试，确认因实际 disabled:true 失败。
- [x] 从 wave2 移除 `'file-upload'`，修正文档中“所有 dsh-client 都纯UI”的错误分类；更新计数为45。
- [x] hub build + world-mount-patches 测试通过；检查 connection / modules 保持既有状态。
- [x] 将完整命令、红绿证据与 diff 范围写 `.scratch/h10-fix/task-1-report.md`；由独立 reviewer 检查 spec 和质量。

### Task 2: Hermes 每轮持久化用户消息

**Files:** `super-dsh/agent-hermes/src/agent.ts`, `super-dsh/agent-hermes/test/agent.test.mjs`。

**Interfaces:** `session.append('user/message', message, {surfaceOp:'append'})` 每轮调用；`#titleSourceSeq` 只保留首条返回 seq。

- [x] 使用既有 fake client 驱动同一 HermesAgent 两个完整 prompt/turn，断言两个 user/message 存在且各自先于对应 assistant，title messageSeqs 保持首条 seq。先构建并确认第二条缺失导致失败。
- [x] 将有副作用 append 与 nullish assignment 分开：`const event = this.session.append(...); this.#titleSourceSeq ??= event.seq;`，避免新增公共API与历史回填。
- [x] 构建 hermes 并运行完整 agent.test.mjs；记录红绿结果。
- [x] 将报告写 `.scratch/h10-fix/task-2-report.md` 并独立评审。

### Task 3: Codex rig 的第三方 provider 准备

**Files:** Create `super-dsh/test/seed-codex-providers.mjs`, `super-dsh/test/seed-codex-providers.test.mjs`; modify `super-dsh/test/start-4999.sh`。

**Interfaces:** 使用已存在的 `readProviderStore / upsertProvider / writeProviderStore`，参数为显式 `<lineHome>/agents/codex`，不继承 DSH_HOME，不读写原生 Codex 配置。密钥取 launcher 从测试 home .env 喂入的 DEEPSEEK_API_KEY / ZAI_PLAN_API_KEY；只打印 id/模型数/skip，不打印密钥。

- [x] 先写真实临时 worldHome + child script 测试，DEEPSEEK_API_KEY='test-only-key' 后 readProviderStore 应含 deepseek 的 responses route；无 key 时不创建 store；重跑幂等且保留已有其它 provider。脚本缺失时先确认失败。
- [x] 仿照 seed-claude-providers：DeepSeek entry `{id:'deepseek',label:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',protocol:'responses',auth:{kind:'apiKey',value},models:[{id:'deepseek-flash'},{id:'deepseek-v4-pro'}],origin:'user'}`；可加 ZAI entry `{id:'zai-plan',label:'ZAI Plan',baseUrl:'https://api.z.ai/api/coding/paas/v4',protocol:'responses',auth:{kind:'apiKey',value},models:[{id:'glm-5.3-flash'},{id:'glm-5.3'}],origin:'user'}`。DeepSeek 地址沿用已有实测记录；ZAI 是否支持 Responses 由真 turn 判定，不将目录可见算生成通过。
- [x] 在 launcher 已有 SEED_ENV block 后调用 codex seeder，缺 key skip；整个 rig 不把 key env 透传给 systemd 业务实例，只把 secret 写到已有0600 adapter store，由合成 child env 使用。
- [x] `node --test super-dsh/test/seed-codex-providers.test.mjs` 通过；`bash -n super-dsh/test/start-4999.sh` 通过；报告 `.scratch/h10-fix/task-3-report.md` 与单独 diff。
- [x] 独立评审确认没有原生 auth/config 写入、没有凭据输出、新 seeder 不进产物。

### Task 4: Codex 首次冷启动使用选定模型（i 实测发现）

**Files:** `super-dsh/agent-codex/src/agent.ts`, `super-dsh/agent-codex/test/codex-reattach.test.mjs`。

- [x] 使用生产 CodexAgent / CodexAppServerClient 和 fake app-server transport，构造原生默认模型与 UI pending route 不同的首轮；RED 确认 thread/start 仍用原生默认。
- [x] 在 ensureStarted 前调用 setModel，保持懒启动与 provider reattach 语义。GREEN 5/5；不改原生 auth/config。
- [x] j tarball 实装，DeepSeek 首次创建和切 world 后续聊均获得真实回复。最终独立代码评审 PASS。

## Verification and handoff

- F2 调查报告 `.scratch/h10-fix/projection-investigation.md` 确认终态 control 失败污染；优先修 F1 解除触发源，fresh 页面全切换复验，不擅改 upstream 生命周期。
- 版本增加为未使用的下一字母；`node super-dsh/scripts/pack.mjs` 唯一构建入口，全包测试。
- `bash super-dsh/test/start-4999.sh` 交付形态安装，Browser Use 复验六条路线本版本 new → 切 world → 回来重放/resume；模型即时更新及 Hermes 双轮重放。Codex 显式选择 rig 的第三方模型。
- dev3 实装：先完成本地验证和具体部署清单；prod restart 若无本次明确授权须最后向用户请求。
- 报告落 docs/test-reports，测试线保持运行，给出 WAN/LAN URL 供用户亲测。


2026-10-04 完成状态：j 整包 build/pack/file: 安装通过；12 组 1579 pass / 0 fail / 0 skipped；六路线同版本 new → DSH → 返回重放 → resume 均 PASS，四条 F2 路线模型芯片及统计即时更新。实测报告：`docs/test-reports/2026-10-04-superd-hub-0.1.10-j-browser-bugfix.md`。旧指针、旧空会话 durable-id 与控制流终态恢复作为独立兼容性事项保留。dev3 尚未实装；本地实例继续运行交用户，未发布。
