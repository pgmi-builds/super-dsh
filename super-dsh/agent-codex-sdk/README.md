# @pgmi-builds/agent-codex-sdk

superd 外壳下的 **Codex adapter**（super-dsh 线，AW-E）：把 Codex CLI 经由
`@openai/codex-sdk` 接进 DSH —— 会话、事件、模型目录、持久化全部按 DSH 语义呈现，
WebUI 消费的是 DSH 服务提供的数据面。

> 通用规则（定位 / 两形态 / 测试准则 / 接线域 / per-agent 定制权 / home 与 profile 布局）
> 见上级目录的 `agent-adapter-dev-rules.md` —— 改本包前先读它。

## 它是什么

- 一个**普通 dsh plugin bundle**：`package.json` 的 `dsh.bundle.patch` 指向本目录的
  `cordis.patch.yml`（挂 codex provider、关掉它替代的原生行、重写权限三档表、pin 应用内目录选择器）。
- 一个 **AgentFactory**：`src/index.ts` 里的 `CodexProvider` 在 `ctx.agents` 注册工厂，
  每个会话一个 `CodexSdkClient`（真 `@openai/codex-sdk` 线程）；`src/agent.ts` 把 Codex 线程事件
  投影成 DSH 会话事件。
- **带自己的 world 入口**：`src/world-plugin.ts`（`./world`，world key `codex-sdk`）把它作为
  superd 世界挂载（`spawnWorld` + `worldMountPatches`），需要 hub 的 `@pgmi-builds/superd-hub`；
  同一份 adapter 代码也可作为普通 bundle 点亮一个完整 web app（两形态一条代码路径）。

## 零声明依赖与运行时自取（2026-10-04 user 裁决）

本包 **不声明任何运行时依赖** —— `@openai/codex-sdk` / `@openai/codex` / `zod` 既不在
`dependencies`、也不在 `optionalDependencies`、也不在 `peerDependencies`（`dependencies` 恒为
`{}`），安装期零下载、零 postinstall。SDK 树在**首个真 prompt** 时才被 fetch 进
`<worldHome>/sdk-runtime/`（`src/sdk-runtime.ts`）：

- marker `<worldHome>/sdk-runtime.json`（**最后写**：写不到就不算成功）、锁 `.lock`（mkdir 原子，
  30 min 判陈旧可夺）、失败留 `.error.log`；
- marker 身份 = 本包版本 + 两个 pin，任一变化即重取；命中且 entry 存在则零网络短路；
- 装完立刻 smoke `import()` entry 并要求 `Codex` 构造器存在 —— 坏树在 fetch 时报错，不留到首 prompt；
- 预热（dev/运维）：`npm run fetch-sdk-runtime [<home>]`（只接受仓内 `.tests` 下的 home）。

## 跑起来

本包默认 **disabled**（composite 行 `agent-codex-sdk`，打开该行即启用）：行为级验证只走整包
pack 线（`super-dsh/test/start-4999.sh` + dev3 实装），不另起 per-agent 场景 rig（2026-09-24
场景退役，见 `agent-adapter-dev-rules.md` §2）。`CODEX_TRACE=1` 开 provider/agent 追踪。
## Home 与 profile 布局（user 裁定）

| 位置 | 内容 |
|---|---|
| `$DSH_HOME`（测试 = `<repo>/.tests`） | 测试 DSH home |
| `<DSH_HOME>/agents/codex-sdk` | 该世界的 **world DSH home**（`dsh-sessions.json` 映射等 adapter 态）+ **自取 SDK 运行时** `<worldHome>/sdk-runtime/`；codex app home 仍是原生 `~/.codex`（绝不重定向） |
| `$DSH_HOME/profiles/codex-sdk` | 该世界的 dsh profile（bundles + `cordis.patch.yml`） |
| `$DSH_HOME/sessions/...` | **DSH 会话日志**（上游 `session-persistence-jsonl`，zstd）——list/replay 都由此提供 |

**禁止**自造 per-app home（如 `.tests/codex-app`）。

## 关键实现点

- **session 身份 = 一对一映射**：DSH session id 是权威；Codex thread id 在其物化后写入
  `<worldHome>/dsh-sessions.json`（`src/session-map.ts`）。resume 只经该映射重挂线程，查不到即
  fail-closed。**不自建 rollout 扫描做 list，也不自解析 JSONL 做 replay。**
- **DSH-native 持久化**：工厂按上游 agent-loop 的方式持有写通道（create `persistence.create` /
  resume `persistence.open(id,'write')` → `read` → `interruptedTurnClosers` → `prepare`），
  发布点刷未存后缀，dispose 时 `handle.close()` 排空。
- **每会话路由钉住**：工厂在 create/resume 时同步钉住本会话路由（追加 `model/selection` +
  `installModelSelection`），**不依赖全局默认模型的落盘时序**（共享 test home 里 settings 默认可能属别线）。
- **事件映射**：`system/message`（Codex 系统提示，rollout HEAD `base_instructions`）、
  `request/context`（provider/model/contextWindow）、`assistant/message`（reasoning 用
  `{type:'reasoning',text}`）、`tool/call`（原始 JSON 串）/`tool/result`、`step/start|end`、`turn/start|end`。

## 测试

```bash
npm run build                                   # tsc strict
DSH_HOME=<repo>/.tests \
SUPERD_DSH_ANCHOR=<repo>/upstream/deepseek-harness/package.json \
node --test test/*.test.mjs
```

## 已知边界（V1）

- 审批仅 launch-only 预设（SDK 无运行时审批；app-server 线才有 `*/requestApproval`）；
- 无 steer / 无运行时换模型（下一轮生效）/ usage 滞后一轮 / 无 fork；
- `compaction/*`、`todo/write`、`subagent/*` 未接（见规则文档 §9.4 backlog）；
- **world 入口**：`src/world-plugin.ts`（world key `codex-sdk`）已接线 `spawnWorld`；roster 条目
  fiber-scoped、行关闭时 dispose 世界（2026-10-03 omp-sdk 验收踩到的两条卸载契约）。
