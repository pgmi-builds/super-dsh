# 2026-10-06 — codex CLI-first 发现顺序 + 安装面零二进制

## 背景（user 指令）

1. Foreign Agent Adapter Codex：**Desktop Codex 优先 → CLI Codex 优先**。
2. registry `latest` v0.1.11：user 安装 `super-dsh` 时**随包下载 Codex SDK/binary**，
   有时一次落多个平台版本（Linux / macOS / Windows / Linux ARM）。
3. 规则重申：SDK 退居二线；凡 SDK/binary 一律**运行时自行 fetch**；插件安装必须干净
   ——不允许 post script / post install / allow-build 等任何安装期钩子或随包二进制。

## 根因

2026-10-05 OAuth/核心发现裁决的「包内 exact-pin `@openai/codex@0.160.0`」fallback
被实现成了**真依赖**：

- pack root `super-dsh/package.json` `dependencies` 含 `"@openai/codex": "0.160.0"`；
- `agent-codex/package.json` 同样声明；
- `codex-runtime.ts` 经 `createRequire().resolve("@openai/codex/bin/codex.js")` 消费。

`@openai/codex` 是 CLI binary 包，其六个 optionalDependencies 是**alias 平台包**
（`@openai/codex-linux-x64 → npm:@openai/codex@0.160.0-linux-x64` 等，无 os/cpu 过滤），
装一个拖六个平台 binary —— 即 user 看到的现象。OMP / Claude / Antigravity 主线
adapter 均无此形态（ogy-sdk/omp-sdk/codex-sdk 三条 SDK 线早已是运行时 fetch 形态），
属 2026-10-04 规则确立一周后的回归。

## 改动

| 面 | 改动 |
|---|---|
| 发现顺序 | `codex-runtime.ts`：`CODEX_BIN` → **PATH 用户 CLI** → desktop 核心 → world home 运行时 fallback（2026-10-06 起生效） |
| 安装依赖 | pack root + `agent-codex` 两处 `dependencies` 摘除 `@openai/codex`；`agent-codex` `package-lock.json` 再生（不含 codex） |
| 运行时 fetch | 新增 `agent-codex/src/codex-runtime-fetch.ts`：三层全落空时，首个 prompt 把 `@openai/codex@0.160.0` fetch 进 `<worldHome>/codex-runtime/`（`npm install --exact --ignore-scripts --omit=dev`；marker/lock/error-log 同 omp-sdk/codex-sdk 形态；fetch 后 smoke-run `node bin/codex.js --version` 验证平台 binary 可跑；pin 变更自动重取；fresh lock 拒绝并发、stale lock 回收） |
| 接线 | `CodexAppServerTransport.start()` 变 async，新 option `worldHome`；`CodexAppServerOptions.worldHome` 透传；`index.ts` 两处 `CodexAppServerClient.create` 传入 `this.home`（`<dshHome>/agents/codex`）。lazy spawn 铁律不变：`create()` 零 IO，fetch 只发生在首个 prompt 的 start 路径 |
| 预热 | `agent-codex/scripts/fetch-codex-runtime.mjs`（`npm run fetch-codex-runtime`；拒绝 `.tests` 之外 home，同 codex-sdk 脚本红线）；`files` 增加 `scripts` |
| 防复发守卫 | 新增 `agent-codex/test/package-contract.test.mjs`（本包禁任何 `@openai|codex` 依赖声明、禁 postinstall/preinstall/install/prepare、dist 禁 bare import `@openai/*`、fetch 命令在册）+ `super-dsh/test/pack-contract.test.mjs`（**全 pack** 每个 package.json 禁 install hook、禁 codex binary/SDK 依赖声明、root 禁 optionalDependencies） |
| 文档 | `super-dsh/AGENTS.md`（2026-10-06 修订 + 新裁决条目）、`docs/specs/codex-official/spec.md`、`agent-codex/README.md`、`app-server-wire.ts` / `app-server-protocol.ts` 头注 |

## 不变式核查

- lazy spawn：`create()` 仍零 IO；`resolveCodexRuntime` 纯同步；只有 `worldHome` 存在
  且三层全落空时才进入 async fetch（`agent-codex` 与 fake transport 的测试路径不走 fetch）。
- S7：fetch 落点 = `<dshHome>/agents/codex/codex-runtime/`（adapter 自有 DSH 态根内），
  原生 `~/.codex` 零触碰。
- 安装面：干净（tarball `dependencies` 仅 pi-coding-agent / zod / mcp-sdk，无 scripts、无
  optionalDependencies）。`@earendil-works/pi-coding-agent` 为纯 JS in-process SDK，
  无平台 binary、无生命周期脚本，不在本裁决范围。
