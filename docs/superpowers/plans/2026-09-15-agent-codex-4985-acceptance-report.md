# AW-E agent-codex 验收报告（Task 9）与拷回清单

- **日期**: 2026-09-15
- **实例**: `aw-codex-4985-test.service`（systemd-run --user，SUPERD_KEEP=1，**保持运行待 user 亲测**）
- **入口**: `http://127.0.0.1:4985/?token=<redacted>`
- **端口变更说明**: 计划默认 4987 被另一线占用（`react-codemod-to-lit` 的 vite preview，pid 127421，非本线不动）→ 按仓端口纪律改 **4985**（`AW_PORT` 已接入 start 脚本与 unit Environment）。LAN 中继（可选）：`/usr/bin/socat TCP-LISTEN:4985,fork,reuseaddr,bind=192.0.2.130 TCP:127.0.0.1:4985` + unit 加 `Environment=SUPERD_LAN_HOST=192.0.2.130` 后重启。

## 前置验证（agent 侧已完成）

- 全套测试 **62/62 绿**（60 移植集 + e2e 2）；tsc strict 0；单实例检查 0。
- curl 冒烟：token 303→200；`GET /api/agent-runtime` → `{"runtime":"native","available":["native","codex"]}`（selector RPC 面正常，Codex 在册）。
- smoke 日志：`roster=[{"key":"codex","label":"Codex","ready":true}] codexWorld=true`；world 临时回环 listener 出现（port 0 姿态，46621 仅本机回环）。

## 验收点（user 亲测清单）

1. 打开 token URL → CTX0 原生世界照常（native 会话、模型选择器无异常）。
2. RuntimeSeat/Runtime 切换到 **Codex** → 世界切换零刷新（S1/S6）。
3. 新会话 → 模型选择器应见 **codex 路由**（zhipu_glm_en / GLM-5.2，来自嵌套 home 的 config.toml + cc-switch catalog）。
4. Prompt 一条 → 真 glm-5.2 turn（cc-switch 网关）→ 流式回复、tool 调用可见。
5. Abort → 流中断、状态回 idle。
6. 重启实例（`systemctl --user restart aw-codex-4985-test`）→ resume → 历史复原、续聊正常。
7. 切回 native → 原生世界全程无感；`~/.codex` **零写入**（全部落在 `.superd-test/aw/agents/codex/`）。

## 已知边界（V1，SDK 线）

- steer = 队列 followUp 近似；setModel = 下一 turn 生效；审批 = launch-only preset；usage 在 assistant/message 上有一 turn 滞后显示。

---

## 拷回主 checkout 收尾清单（finishing-a-development-branch）

worktree：`.scratch/aw-codex`（branch `aw-codex-adapter`；docs 已按任务 commit 至该分支）。`apps/agent-worlds/` 在 `.git/info/exclude`（全 worktree 共享）——**线代码不入 git，以下为文件拷贝清单**（worktree → 主 checkout 同路径覆盖）：

| # | 路径（相对仓根） | 说明 |
|---|---|---|
| 1 | `apps/agent-worlds/agent-codex/` **整目录**（除 node_modules/dist/.gitignore 声明的产物） | 新包 `@pgmi-builds/agent-adapter-codex`（src/test/types/scripts/cordis.patch.yml/package.json/tsconfig） |
| 2 | `apps/agent-worlds/agent-hub/test/zero-port.audit.test.mjs` | 小修：spawnWorld 补 `bareModuleBaseUrl: process.env.AW_BARE_BASE`（主 checkout hub 测试同款环境韧性） |
| 3 | `apps/agent-worlds/test/smoke-codex.mjs` + `test/start-4985.sh`（原 start-4987.sh 改名） | 线集成 bootstrap + 验收实例脚本（AW_PORT/lan 可调） |
| 4 | `docs/superpowers/plans/2026-09-15-agent-worlds-agent-codex-adapter-plan.md` + 本报告 | 分支 `aw-codex-adapter` 上已有 commit（088557d/99ec747/48147d2 等一串）——docs 侧可整分支 merge 或 cherry-pick |
| 5 | 主 checkout 拷回后动作 | `apps/agent-worlds` 目录内对应文件以 worktree 版本覆盖；`apps/agent-worlds/agent-codex/node_modules` 主侧重新 `npm install --cache .npm-cache`；单实例检查；主 checkout 的 `.superd-test/aw/profiles/node_modules/@pgmi-builds/` 增补 `agent-adapter-codex` symlink；`aw-codex-world` fixture 如需在主线亦可拷入 `agent-hub/test/fixtures/` |

**不拷回**：worktree 根 `node_modules/`（farm + @pgmi-builds 链，主 checkout 自有）；`.superd-test/`；`.scratch/aw-codex-4985.log`。

**收尾后主 checkout 验证**：`apps/agent-worlds/agent-codex && npm run build && (env 同款) node --test test/*.test.mjs`（除 spike/live）→ 62/62；hub 15/15；`find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` → 仅 `dsh-client-ui-slots`。
