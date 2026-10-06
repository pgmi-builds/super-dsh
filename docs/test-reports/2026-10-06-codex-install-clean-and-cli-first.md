# 2026-10-06 — codex CLI-first + 安装面零二进制 验证报告

对应计划：`docs/superpowers/plans/2026-10-06-codex-cli-first-runtime-fetch.md`。
状态：**代码/测试/整包完成；4999 重启与 dev3 实装待安排；未 publish。**

## 验证矩阵

| 层 | 结果 |
|---|---|
| agent-codex 单元/契约 | 260/260（含新 `codex-runtime-fetch.test.mjs` 9 项、`package-contract.test.mjs` 4 项、发现顺序改写后 12 项） |
| superd-hub | 526/526 |
| 其余组件回归（omp 77 / omp-sdk 76 / agy 74 / agy-sdk 40 / claude 248 / pi 56 / hermes 135 / codex-sdk 205） | 全绿（codex-sdk 含 `--save-exact` 同修后的 sdk-runtime 套件） |
| pack 级契约 `test/pack-contract.test.mjs` | 3/3（全 pack 无 install hook、无 codex binary/SDK 依赖声明、root 无 optionalDependencies） |
| 整包 pack（唯一入口 `scripts/pack.mjs`） | `super-dsh-0.1.11-a.tgz`；tarball `dependencies` = `['@earendil-works/pi-coding-agent','zod','@modelcontextprotocol/sdk']`，无 optionalDependencies、无 scripts |
| **真路径探针 ①**（本机有 PATH CLI） | `npm run fetch-codex-runtime` → `source:"cli"`，`command:/home/u1/.local/bin/codex`，**零下载**（CLI 优先实证） |
| **真路径探针 ②**（PATH 置空 + desktop 清空，模拟裸机用户） | 真实 `npm install --save-exact --ignore-scripts --omit=dev @openai/codex@0.160.0` → 4s 完成；marker `{packageVersion:"0.160.0", smokeVersion:"codex-cli 0.160.0"}`；smoke 真跑 `codex-cli 0.160.0`；复跑 1ms 零网络（幂等） |

## 探针抓出并修复的两个真 bug

1. **npm 12 移除 `--exact` 别名**（`EUNKNOWNCONFIG`）：`codexInstallArgv` 与
   `agent-codex-sdk` 的 `sdkInstallArgv` 同改 `--save-exact`（`agent-omp-sdk` 用
   `bun add --exact`，bun 原生旗标，不受影响）。此前两条 codex 线的真 fetch 在
   npm ≥12 的机器上会直接失败。
2. **smoke 步相对路径陷阱**：entry 在 cwd 切换到 runtime dir 后 re-resolve。
   生产 worldHome 恒为绝对路径，但按 `model_catalog_json` 同款教训改为
   `resolve(layout.entry)` 显式绝对化。

## 边界与遗留

- fetch 属 last-resort：仅当 `CODEX_BIN`、PATH CLI、desktop 三层全空才发生；
  本机探针①证明有 CLI 时零下载。fetch 只在首个 prompt 的 start 路径（lazy spawn 铁律不变）。
- 0.1.11（已发布版）的安装期下载行为随本次修复消除；**用户侧升级到含本修复的
  下一个字母迭代后**，新装/升级不再拖 binary；旧安装树里已落盘的
  `@openai/codex*` 目录属 pnpm/npm install 树，随消费者重装自然收敛。
- 验收流水（4999 形态冒烟 → dev3 实装 → 报告 → 放行）待 user 指令后执行；
  `npm publish` 按 §〇.1.c 需单次明确放行。
