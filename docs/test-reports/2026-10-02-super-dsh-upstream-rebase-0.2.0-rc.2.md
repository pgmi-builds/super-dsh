# 2026-10-02 — 上游基线 rebase：`dsh-v0.1.7-rc.1` → `dsh-v0.2.0-rc.2`（super-dsh 0.1.9，不发版）

对齐对象：本仓 `upstream/deepseek-harness` dev base **`dsh-v0.1.7-rc.1` → `dsh-v0.2.0-rc.2`**（`639ed015`）。
被测件：**super-dsh 0.1.9，版本与产物均不变**——本轮只换源码基准，不 publish、不改 `package.json` 版本。

## 0. 为什么两条轨都要（2026-10-02 user 裁决）

0.1.9 的兼容验证走的是**实机轨**：在 dev3 上把 DSH 升到 registry 的 `@deepseek-ai/dsh@0.2.0-rc.2`，直接把 SuperD 装上去跑（结论见 `2026-10-02-superd-dsh-0.2.0-rc.2-alignment.md`，12/12 绿）。这条路成本低、等于真实消费者现场，之后可以继续用——上游是 core 系统，不匹配基本自愈。

但 **registry 装到的是预编译 JS**。coding agent 的参考基准只能是源码，所以**源码轨**必须同步跟上：本仓 `upstream/` checkout 必须 checkout 到同一个最新 tag。本报告就是源码轨的执行与验收记录。

## 1. 换 tag（含三个 sanctioned 补丁重放）

```bash
cd upstream/deepseek-harness
git fetch --depth 1 origin tag dsh-v0.2.0-rc.2      # origin = /home/u1/workspaces/dashr/upstream/deepseek-harness
git checkout -f dsh-v0.2.0-rc.2                      # 639ed015 "Merge pull request #5479 … release-dsh-0.2.0-rc.2"
git clean -xdf                                       # 清旧 lib/ dist/ node_modules（201M ← 2.3G）
git apply .scratch/upstream-0.1.7-sanctioned-patches.diff
```

- **三个 sanctioned 补丁全 hunk 命中、零冲突**（`package.json` +4 offset、`pnpm-workspace.yaml` +3 offset、`tsdown.client.ts` 干净）：① `pnpm-workspace.yaml` += `storeDir` + `verifyDepsBeforeRun: false`；② 根 `package.json` devDeps += `unrun@^0.3.1`（0.2.0 上游仍未声明）；③ `packages/client/tsdown.client.ts` 的 `REPOSITORY_ROOT` → `resolveRepositoryRoot()`（0.2.0 该行仍是 `fileURLToPath(new URL('../..', import.meta.url))`）。
- 补丁集在该 tag 上**仍然必要**，一条都不能省。

## 2. 构建证据

| 步骤 | 结果 |
|---|---|
| `pnpm install`（pnpm 11.7.0 / node v22.23.2） | `Done in 18.8s`（store 复用 `.npm-cache/pnpm-store`），0 error |
| `pnpm run build`（`tsx scripts/build.ts` = native + lib host/client + web） | 全绿；`apps/web/dist/index.html` 产出；日志零 `error`/`ELIFECYCLE` |
| `node apps/cli/lib/bin.js --version` | **`0.2.0-rc.2`** |
| `super-dsh/scripts/sync-dsh-farm.mjs`（主 worktree） | `kept=316 relinked=9 removed=0 total=325` |
| 同上（`.worktrees/mesh-p1`） | `kept=0 relinked=325 removed=325 total=325` |

## 3. super-dsh 在 0.2.0-rc.2 源码基准上的编译与测试

- `node super-dsh/scripts/pack.mjs`（tsc hub + client halves + 6 agents + `npm pack`）：**零 error**（仅有既有的 client bundle `react/jsx-runtime` UNRESOLVED_IMPORT 警告，属 externals 预期）。
- 全测（7 包，`node --test --test-reporter=spec --test-concurrency=8 --test-force-exit test/*.test.mjs`）：

| 包 | tests | pass | fail |
|---|---|---|---|
| superd-hub | 486 | 486 | 0 |
| agent-agy | 32 | 32 | 0 |
| agent-claude | 125 | 124 | 0 |
| agent-codex | 70 | 70 | 0 |
| agent-hermes | 133 | 133 | 0 |
| agent-omp | 47 | 47 | 0 |
| agent-pi | 56 | 56 | 0 |
| **合计** | | **948** | **0** |

## 4. 关键结论：base 切换对 super-dsh 产物零影响

在新 base（0.2.0-rc.2）上重编 0.1.9，与 registry 上那份 0.1.9 对比：

- 文件清单 **227 = 227**，完全一致；
- 解包后 `diff -r` **逐字节相同**（`package/**` 全等）；
- 两个 worktree（主 / mesh-p1）各编一次，**两份都等于 registry 那份**；
- 只有 **gzip 容器**不同（sha256 不同、`npm pack` 的容器 framing/时间戳导致），内容无差。

即：super-dsh 0.1.9 的编译产物对上游 base 不敏感（TS 类型变化不进 JS emit），0.1.9 在 0.2.0-rc.2 上既是运行兼容、也是编译兼容。

## 5. 实机验收（4996 线，新 base）

`SUPERD_PORT=4996 bash super-dsh/test/start-4999.sh`（pack 重编 → profile 重装 → repo build 0.2.0-rc.2 启动）：

- 装到的版本：profile 依赖 `super-dsh 0.1.9`，`node_modules/super-dsh/package.json` = `0.1.9`；
- 认证 fence：无 cookie `GET /` → **401**；token URL 铸 cookie → **200**（seed 持久，`?token=` 仅首铸）；
- `/api/superd/machines` → `self 79he` + **dev3 `bfwu` `status: "reachable"`**（O1 探针行为不变）；
- `/api/agent-runtime?mesh=1` → `hub: {machineId: "79he", version: "0.1.9"}`，7 个本地 agent 全部 `ready: true, failed: false`（native/claude/omp/codex/pi/hermes/agy）；
- `/hub` 家族语义与设计一致：`/hub`（无 `agent`）→ 404 `foreign-only`；`/hub/…?agent=nope` → 404 `unknown-agent`；`/hub/api/…?agent=<label>` 对已注册 label 正常应答。
  - 记录一处**语义澄清**（不是缺陷）：对 world 没有精确 Fetch route 的路径（如 `/api/agent-runtime`），请求走 world 的 `createSharedFetchHandler('/api')` 兜底通道回到宿主，因此 `/hub/api/agent-runtime?agent=claude` 的响应与宿主 `/api/agent-runtime` 相同（含 `hub.machineId: 79he`）。`/hub` 家族设计上服务的是 world 自己的注册路由（session-log export 一类），其余按共享通道回落——与 `carrier.ts` 注释一致。

### 5.1 零新增警告（旧 base 逐行对比）

同一 log 内 boot3（0.1.7-rc.1，18:0x）与 boot4（0.2.0-rc.2，18:31）的输出去掉时间戳/token 后**逐行相同**：

```
[omp-provider] omp models --json unavailable; falling back to the on-disk model cache
(node:N) ExperimentalWarning: SQLite is an experimental feature and might change at any time
superd-hermes: warning: 1 entry did not activate
session-controller (@deepseek-ai/dsh-api-session-controller): pending (waiting for service: fileUploads)
```

→ 换 base **没有引入任何新的 warning / 降级**。

## 6. 发现与残留

1. **`pack.mjs` 不清理 `dist/` → stale 产物会被打进 tarball（本轮已修）**：主 worktree 的 `agent-*/dist`、`superd-hub/dist` 里残留 16 个早已删除源码的旧文件（`agent-preset-projection.*`、`app-home.js`、`spike.js`、`client-shim.*`、`index-pass.*`、`labels.*`，mtime 09-16~09-26），`files` 字段列的是 `agent-*/dist` **目录**，所以它们被主 worktree 的一次 pack 收进了 tarball（243 files / 603,105 B）。处置分两步：① 按「无同名 src + 旧 mtime」逐个核实后删掉这 16 个文件；② **`pack.mjs` 已加前置清理**——构建前 `rmSync` 掉 8 个生成目录（`superd-hub/{dist,lib}` + 6× `agent-*/dist`；`super-dsh/client/index.js` 是刻意入库的产物，由 `build-superd-client.mjs` 重写，不在清理之列）。修复后实测：`[pack] cleaned 8 generated dir(s)` → 227 files，内容与 registry 0.1.9 逐字节相同。**registry 上的 0.1.9 本来就是干净的**（那次 pack 在 dist 干净的 worktree 跑的），本轮没有重新发布。
2. **tarball 不是逐字节可复现**：内容是逐字节相同，容器（gzip framing）不同 → 校验 artifact 身份要用「解包 diff」或 registry 的 `dist.integrity`，不要用本地 tarball 的 sha256 去比 registry。
3. **`0.1.9` 在 registry 上的状态未变**：`latest=0.1.9`（`next=0.1.5-a`），`dist.integrity sha512-LHVp1g…MNjQ==`、`shasum ded9f2a9…`，回下载 sha256 `46a0c562…e0ca`（本轮再次复验通过）。归档：`.scratch/superd-pack/registry-super-dsh-0.1.9.tgz`。
4. **残留分支/目录（历史，非本轮遗留）**：`.scratch/{echo-agent-loop,p1}`、`.worktrees/p0-api-wrap`（分支 `p0-api-wrap-probe` 09-26，1 unique commit）挂着的实验分支（`echo-agent-loop` 09-09、`p1-minimal-cordis-host` 09-08，ahead 34/22、behind 213），本地 `legacy/pre-github`、`m0-multi-agent-registry`，以及 `.scratch/aw-codex` 的**陈旧 worktree 注册**（目录已不存在，本轮 `git worktree prune` 清掉了注册元数据）。**另注**：`.worktrees/dsh-browser-engine-fix`（2.3G）是**上游 checkout 的另一个 worktree**（gitdir 在 `upstream/deepseek-harness/.git` 下），不属于本阶段、未动。`mesh-p1` 与 master 同点、零 unique commit，worktree 已移除（见 §8）。
5. **dev3 上 better-dsh 0.2.5 的两行 import 失败**、dev3 Codex world 无 session plane —— 均为既有问题（见 0.1.9 发版报告残留节），与本次 rebase 无关。

## 7. 结论
- 本仓 dev base 已是 **`dsh-v0.2.0-rc.2`**（源码轨）；实机轨结论（dev3，0.2.0-rc.2 实装 12/12 绿）继续有效。
- super-dsh **0.1.9 = 本阶段版本号**：源码在 0.2.0-rc.2 上编译零错、全测 948/0、产物与 registry 逐字节相同、新 base 上实机 boot 零新增警告。
- 本轮**未发版、未改 super-dsh 版本**；仓内改动 = `AGENTS.md`（台账/对齐程序）、`super-dsh/scripts/pack.mjs`（前置 dist 清理）、`super-dsh/scripts/sync-dsh-farm.mjs`（link 写物理路径）与本报告。**三者都不进交付物**（`files` = 27 项，registry tarball 里 `scripts/` 条目数 = 0）→ 不产生 artifact diff，除 push 外无需任何发版动作。`start-4999.sh` 的 registry 旋钮与 `super-dsh/AGENTS.md` 的对应说明**已撤回**。

## 8. 收尾（2026-10-02 同日追加）

### 8.1 0.1.9 相对 0.1.8-e：功能零差异

`git diff 916cd71(0.1.8-e) 449a72e(0.1.9 release)` = **`super-dsh/package.json` 一行版本号（0.1.8-e → 0.1.9）+ 3 份 docs/报告**。源码零改动 → dev3 换到 0.1.9 后**行为与 0.1.8-e 完全相同**，唯一的“新东西”是 housekeeping/版本号本身。

### 8.2 dev3（`~/.dsh/profiles/web`）

已是 registry 精确版：manifest `"super-dsh": "0.1.9"`，lockfile `specifier: 0.1.9 / version: 0.1.9`，`node_modules/super-dsh` 逐文件 sha256 清单与 registry tarball **完全一致**（`bf9f1e5e…`）；`dsh.service` 17:19:41 启动，`world failed` = 0。→ 这一步**无需再动**。

### 8.3 4996 线（本机）

**本机线一律本地 build + tarball（2026-10-02 user 裁决）**：上游用仓库本地 checkout，被测 target = 本地 `pack.mjs` 出的 tarball——本地开发/测试与 registry 无关，不能靠 publish→fetch 来做本机测试（registry 只属于 dev3 那种“消费者实装”场景）。因此 4996 线维持默认路径：`pack.mjs` 本地构建 → `pnpm add file:<tarball>` → repo build 启动；曾经短暂加过的 `SUPERD_PACK_FROM=registry` 旋钮**已撤回**（连同 `super-dsh/AGENTS.md` 里那行说明）。当前 profile 依赖 = `{"super-dsh": "file:…/.scratch/superd-pack/super-dsh-0.1.9.tgz"}`；探针 = mint 200 / 无 cookie 401 / `hub.version 0.1.9` / 7/7 agent ready / dev3 `reachable`。

### 8.4 worktree

`.worktrees/mesh-p1` **已移除**（`git worktree remove --force`，移除前先手工 unlink 了它指向共享树的 `.tests`/`upstream` 两个 symlink，共享 home 与 upstream checkout 均未受影响；`.scratch` 日志与本地 tarball 归档到 `.scratch/mesh-p1-archive/`）。分支 `mesh-p1` 保留并与 master 同点 —— P1 的成果全在 master 上，worktree 本身零 unique commit，所以移除不丢信息；P2 从当时 master 新开 worktree 即可。

### 8.5 事故与修复：farm link 里烘进了 worktree 前缀（dev 工具，已修）

删掉 `mesh-p1` 之后第一次跑 pack 直接 **tsc 全红**：`src/*.ts error TS2307: Cannot find module '@deepseek-ai/dsh-tools' …`（325 个 farm link 全是 dangling）。根因：`sync-dsh-farm.mjs` 用 `join(CHECKOUT, …)`（**未经 realpath**）做 link 目标，而 dev worktree 的 `upstream/` 是指回主树的 symlink —— 于是从 worktree 跑一次同步，就把该 worktree 的路径写进了共享 farm；worktree 一删，整片 farm 悬空（主树与 worktree 的 `super-dsh/node_modules` 是同一份物理目录，两边会互相覆写）。

修复：harvest 时存 **`realpathSync(pkgDir)`** → link 一律指向物理 checkout，worktree 前缀不可能再进去；比较逻辑（`realpathSync(link) === target`）随之成为物理路径比较，天然幂等。验证：造一个 `upstream` 为 symlink 的临时 worktree，旧脚本写出 `.scratch/farmtest/upstream/…`（复现），补丁后写出 `/home/u1/workspaces/superd/upstream/…`（物理路径），二次运行 `kept=325 relinked=0`；临时 worktree 已删，主 farm 完好。主树 farm 重同步后 pack 恢复正常。

> 典型「dev 脚手架遮丑」：本地能跑只因为恰好没删过那个 worktree。绝对路径烘进 link 的写法要按物理路径固化。
## 9. 已登记、留给下一轮的问题（housekeeping review）

1. **`agent-agy` 的 spawn 没有 `error` 监听 → 缺 `agy` 二进制会把整个宿主打死（dev3 实证）**：`super-dsh/agent-agy/src/agy-cli-client.ts:156` 与 `agy-client.ts:138` 直接 `spawn(...)` 且全仓 `src/` 内无 `.on('error')`。dev3 17:19:37 有一次 agy 会话启动（`agy` 不在 PATH；`which agy` 空），Node 抛 uncaught `spawn agy ENOENT` → `dsh.service` 整体退出、systemd 重启 1 次（当前实例正常）。正确形态应是「该 agent 标 failed / 报 typed 错误」，而不是进程级死亡。**未在本轮修**（属产品代码改动，要按 gate 走）。
2. dev3 上 `dashr-failover` / `dashr-compaction-tuning` 两条 import 失败**已消失**（属 better-dsh，非 super-dsh；14:23–15:16 的旧 boot 有、现役 boot 无，profile 里 better-dsh 已是 `0.2.5-a`）。现役 boot 只剩 `superd-{codex,hermes}: 1 entry did not activate`（`session-controller … pending (waiting for service: fileUploads)`，既有）。
3. dev3 Codex world 无 session plane、0.2.0 上 client/UI 半边只做过静态验证、pnpm ≥11 消费者需裸包名 `minimumReleaseAgeExclude` —— 既有残留，未动。

## 10. 现场（保持运行，等 user 亲手验收）：
`http://127.0.0.1:4996/?token=<redacted>`
`http://192.0.2.130:4996/?token=<redacted>`
