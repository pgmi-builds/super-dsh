# DSH 0.2.2-rc.3 上游对齐报告（2026-11-15）

**范围**：`upstream/deepseek-harness` rc.1 → rc.3（跳过 rc.2，一次对齐到位）；本仓双包源码适配；4999 测试线重启验收。dev3 / PC prod 升级不在本轮（待 user 下令）。

## 一、Tag 与 delta

| 项 | 值 |
| --- | --- |
| fetch | GitHub 直取 `https://github.com/deepseek-ai/deepseek-harness`；rc.2 = `ddac96760b6`（PR #8277），rc.3 = `38a6a5c965a`（PR #8397）；origin 镜像仍止步 0.2.0-rc.2。fetch 顺带带入 0.2.1-rc.4/rc.5（维护线）与 0.2.2-alpha.3 tag，未采用 |
| rc.1→rc.2 | 4,645 文件 +160.8k/−58.4k（吸收整窗 merge） |
| rc.2→rc.3 | 515 文件 +11.0k/−0.7k |
| **rc.1→rc.3（本轮基线跳变）** | **4,721 文件 +171.4k/−58.6k** |
| pnpm pin | 仍 `11.28.5`（未变）；node engines `>=24.9.0`，本机 node v26.12.0+ 满足 |
| pnpm-workspace.yaml | 尾部（patchedDependencies + 追加点）**未变**；改动全在 `minimumReleaseAgeExclude`（libreoffice-kit 0.1.5→0.2.3、新增 stagehand 4.4.0）→ 单补丁原样重放（3 行）零冲突 |

## 二、构建

- `checkout -f` + `clean -xdf`（清产物重摆，stale lib/ 红线）+ 补丁重放 → `npx pnpm@11.28.5 install --frozen-lockfile`（17s，store 复用）+ `run build` → **10/10 gates PASS（177.75s）**，`--version` = `0.2.2-rc.3`。
- farm 同步 `sync-dsh-farm.mjs`：**kept=372 relinked=11 removed=9 total=383**（窗内 9 包移动/改名，farm 增 30 条）。

## 三、契约漂移分析（68 peer 中 31 个 src 变更）

### 真实漂移四处（全部已修）

1. **`SubagentActivationSpec` 拍平**（`dsh-subagent`）：nested `request: Omit<SubagentStartRequest,…>` 字段删除，任务字段（`prompt`/`parent`/`maxDepth`/`cwd?`/`agentPreset?`）提为顶层，新增可选 `name?`。修复：`better-dsh/src/subagents-surface.ts` 的 `DASHRActivationSpec` 改镜像 rc.3 flat 形态，同时保留**可选 legacy `request?` 载体**；`bridges/index.ts` 调用点双形态传参（`...request, request`）——flat host 忽略 nested、0.2.1–rc.2 host 读 nested，声明的 peer range `>=0.2.0-0 <1.0.0-0` 在 reshape 两侧都诚实（与既有 start/startContinuable feature-detect 同型纪律）。
2. **运行时 ownership 家族移除**（`dsh-agent`）：`CreateAgentOptions.parentAgent` / `ResumeAgentOptions.parentAgent` 删除、`AgentRegistry.enter(agent, owner)` → `enter(agent)`、`AgentEntry.owner` 及 ownership 查询法移除。修复：10 个调用点全清——`better-dsh/test/remote/real-harness.ts`（1）+ 9 个 adapter（omp/omp-sdk/codex/codex-sdk/claude/pi/hermes/agy/agy-sdk 各自 `setupAndPublish` 签名去参 + `enter(agent)`）。
3. **`LlmError` code 收紧**（`dsh-llm`）：constructor 只收 `BuiltinLlmFailureCode`（闭合 union，外域 code 走 `LlmError.fromFailure`）；新 `LLM_FAILURE_CODES` registry。修复：9 个 adapter 的自定义 code 映射——`MODEL_NOT_FOUND`→**`UNKNOWN_MODEL`**（registry 内语义等价项）、`UNSUPPORTED_STREAM`→**`UNSUPPORTED_OPTION`**。
4. **`Menu` 锚定 API 重塑**（`dsh-client-ui-primitives`）：`getAnchorRect` 回调删除 → `anchorRef`（元素 ref 作 CSS anchor）+ `anchorPoint`（context menu）。修复：`superd-hub/src/client/HubPanelIcon.tsx` 药丸菜单 `anchorRef={selectorRef}`（与上游自身 JsonTree 迁移式一致），`anchorRect` 回调删除。

### 未消费的上游新增（备案，零改动）

`LLM_FAILURE_CODES`/`RETRY_CODE_CHOICES`、`ToolContextUnavailableError`、`ToolGuard` 返回宽化（`string | ToolGuardDenial`；`checkGuards()` 返回类型变更——本仓两包零消费）、slot `hoc` kind、session 批量 append（数组提交 + `currentBatchPublication`）、`SessionEventInput` 导出、`known-event-types` 增 `team/mode`、subagent `SubagentMemberNames`/`SubagentRunInfo.parentSessionId`/事件 carrier 改 tree-root、jobs `JobError`/`JOB_ERROR_CODES`、api-remotes remote view 重排（account-controller→deepseek-account、office-to-pdf→office-kit 等纯 re-export 重命名）。上述经 grep 零消费确认 + tsc 双包通过佐证。

## 四、测试与验收

| 套件 | 结果 |
| --- | --- |
| upstream build gates | **10/10 PASS**（177.75s） |
| better-dsh typecheck（host+client） | clean |
| 根 `npm test` | **32/32** |
| better-dsh vitest | **971 pass / 0 fail / 9 skipped**（980） |
| superd-hub `node --test` | **640/0/1 skipped** |
| adapter ×9 | omp 71/0 · omp-sdk 69/0 · codex 265/0 · codex-sdk 205/0 · claude 254/0 · pi 58/0 · hermes 146/0 · agy 87/0 · agy-sdk 40/0 |
| pack 双包 | `0.3.5-a`（letter 测试轮，registry 0.3.5 不动）：better `e9b3ae70…`、super `3e49a7c1…`，pair verify（独立同步、Super 无 Better 依赖/payload）过 |
| 4999 线 | `superd-4999-test` + `superd-lan-4999-relay` 重启于 0.3.5-a：**0 world failed / 0 import 失败 / 0 pending-activate 警告**（优于 rc.1 轮 f/g 的 6+6 同型警告），门检 shell **200** / 匿名 API **401**；浏览器验收交 user（wan 入口见 launcher 输出） |

### Chrome 环境项翻案

历轮记录的「better-dsh 6 项既有 Chrome 环境失败」实为**测试 shell 未带 `DASHR_BROWSER_BIN`**（本机 `/usr/bin/google-chrome-stable` 已不存在）。本轮以 `DASHR_BROWSER_BIN=/home/u1/.local/lib/chrome-for-testing-156.0.8078.80/chrome-linux64/chrome` 跑 browser-device.spec → **10/10**，全套 971/0。后续轮验收建议带此 env。

### 顺带修复：leak-scrub 误伤两处（与本轮上游无关的既有损坏）

`scripts/leak-patterns.local.txt` 的 `token=[A-Za-z0-9_-]{25,}` 洗掉了测试文件里的**合成** token，令断言自相矛盾（且静默解除了被测性质）：

- `test/scoped-docs.test.mjs`：seed token（26 字符字母串）被洗成 `<redacted>` → 目标侧 redact 断言恒真、源侧 untouched 断言恒假。改用 **20 字符** `synth-token_01234567`（≥ copyDocs 重订阈值 20、< leak 阈值 25），两条断言恢复实效。
- `superd-hub/test/mesh-rpc.test.mjs`：GET face 的 token 被洗成 `<redacted>` 而 preview 断言仍期望 `LIVE-TOKEN…`。改用 **22 字符** `LIVE-TOKEN-0123456789`（同理两阈值之间）。

两处均加注释说明阈值边界，防复发。**行动项**：leak-scrub 跑测试文件时需区分「真实令牌」与「合成 fixture」——建议后续把 scrub 工具改为跳过 `test/` 内的显式合成串或引入 marker（另立任务，本轮未动工具）。

## 五、版本与后续

- 本地 tarball `0.3.5-a`（super-dsh/better-dsh/根 三处同步，`release-version.mjs`）；registry `latest=0.3.5` 不动；发布与否、版本号、GitHub tag 待 user 放行。
- dev3（3080 线现 0.2.2-alpha.2）与 PC prod 升 rc.3：待 user 下令后走 tarball 实装流程。
- 改动面清单：`better-dsh/src/{subagents-surface,bridges/index}.ts`、`better-dsh/test/remote/real-harness.ts`、`super-dsh/superd-hub/src/client/HubPanelIcon.tsx`、9×`agent-*/src/{adapter,index}.ts`、`test/scoped-docs.test.mjs`、`superd-hub/test/mesh-rpc.test.mjs`、`docs/dev-test-environment-notes.md`、本报告。
