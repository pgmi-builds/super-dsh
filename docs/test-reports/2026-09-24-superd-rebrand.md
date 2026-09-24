# super-dsh 品牌轮：剥除 `agent-worlds` / `aw` 临时名（0.1.3-q）

日期：2026-09-24 · 版本：`super-dsh@0.1.3-q`（未发布，tarball 通道）· 依据：user 当日两条指令

---

## §一 指令原文（user）

1. WebUI `Plugin` 区显示 `super-dsh` 有组件 `@deepseek-ai/dsh-host-directory-picker-browse`、`@deepseek-ai/dsh-client-ui-directory-picker-browse`、`super-dsh/join`——问「为什么这里有 2 个 native dsh」「为什么 `join` 是独立组件而不是各 agent 组件的一部分」（答案见 §五，非缺陷）。
2. 品牌清理：`agent-worlds` / `aw` 是临时名，剥除；**`super-dsh` = npm pack 名 = dsh plugin market 名**，代码内用短名 `superd`（`superd-hub`、`superd-*`）；WebUI 组件显示从 `super-dsh/world/omp` + `aw-agent-adapter-omp` 改为 `super-dsh/agents/omp` + `agent-omp`；「clean up the codebase」。

---

## §二 命名映射（执行结果）

| 面 | 旧 | 新 |
|---|---|---|
| npm pack（不变） | `super-dsh` | `super-dsh`（dsh plugin market 名） |
| hub 包 / 目录 | `@pgmi-builds/agent-hub` / `agent-hub/` | `@pgmi-builds/superd-hub` / `superd-hub/` |
| per-runtime 包 | `@pgmi-builds/agent-adapter-<rt>` | `@pgmi-builds/agent-<rt>`（目录 `agent-<rt>/` 不变） |
| 主 pack exports | `./world/<rt>` | `./agents/<rt>`（`./hub` / `./join` / `./web-trust` / `./client` 不变） |
| composite row 名 | `super-dsh/world/<rt>` | `super-dsh/agents/<rt>` |
| cordis 插件名 | `agent-hub` | `superd-hub` |
| | `aw-web-trust` | `superd-web-trust` |
| | `aw.world.join` | `superd-join` |
| | `aw.world.mount` | `superd-world-mount` |
| | `aw.agent-adapter-<rt>` / `aw.agent-adapter-claude-world` | `agent-<rt>` / `agent-claude-world` |
| row id | `aw-web-trust` / `aw-agent-hub` / `aw-world-mount` / `aw-agent-adapter-<rt>` / `aw-world-join-claude` | `superd-web-trust` / `superd-hub` / `superd-world-mount` / `agent-<rt>` / `superd-join-claude` |
| 服务键 | `aw.world.<rt>` / `aw.world.join.error` | `superd.world.<rt>` / `superd.world.join.error` |
| env 家族 | `AW_TRUSTED_HOSTS` / `AW_BARE_BASE` / `AW_TEST_HOME` / `AW_APP_PORT` / `AW_APP_HOME` / `AW_JAR` / `AW_BASE` / `AW_PORT` / `AW_CWD` / `AW_CODEX_LIVE` / `AW_HERMES_{PYTHON,ROOT,TRACE}` | 同名前缀 `SUPERD_*` |
| 测试 home | `.tests/aw`（4999 线）、`.tests/aw-worlds` | `.tests/superd`、`.tests/superd-worlds` |
| profile / unit / 日志 | `aw-pub` / `aw-4999-test` / `.scratch/aw-4999.log` / `.scratch/aw-pack/` | `superd-pub` / `superd-4999-test` / `.scratch/superd-4999.log` / `.scratch/superd-pack/` |
| world profile 名 / world appName | `aw-<rt>-world-profile` / `aw-<rt>` | `superd-<rt>-world-profile` / `superd-<rt>` |
| 测试 fixture / bootstrap 名 | `aw-omp-world`、`aw-codex-world`、`aw-ctx0`、`aw-probe.mjs` | `superd-omp-world`、`superd-codex-world`、`superd-ctx0`、`superd-probe.mjs` |
| OMP 血统名（同轮并入 `agent-omp`） | `@pgmi-builds/omp-web` loader id、`data-plugin='omp-web'`、`window.__OMP_WEB_MOBILE__`、`omp-web-<pid>` sidecar 前缀、`@module omp-web/*`、preset 描述 | `@pgmi-builds/agent-omp`、`data-plugin='agent-omp'`、`__AGENT_OMP_MOBILE__`、`agent-omp-<pid>`、`@module agent-omp/*`、`… via the agent-omp bridge` |
| 仓库 URL（omp 子包） | `github.com/pgmi-builds/omp-web.git` | `github.com/pgmi-builds/superd.git` |
| 版本 | 0.1.3-p | **0.1.3-q**（字母迭代，未发布） |

**刻意保留**（非临时品牌，属语义/身份）：`@pgmi-builds` scope（org 名）；internal 概念「world」（`world-mount` / `world-mux` / `world-provision` / `world-plugin.ts` = 每运行时挂载实例）；`apps/omp-web/src/rpc.ts`、`~/workspaces/dsh-omp/apps/omp-web/AGENTS.md` 等**血统出处引用**（verbatim 移植来源，删掉反而失真）；`agent-worlds` 作为**历史事实**出现在 `apps/agent-worlds`（旧路径）与 `.superpowers/sdd/*`（历史工作日志，未入库、未触碰）。

---

## §三 执行面

- **目录/文件**：`git mv` 保留历史——`super-dsh/agent-hub/` → `super-dsh/superd-hub/`；`agent-{omp,codex}-test fixtures` 与 `test/aw-probe.mjs` 同理。
- **代码字符串**：有序 sed 规则集（最长匹配优先：`@pgmi-builds/agent-adapter-*` → `@pgmi-builds/agent-*` → … → 兜底 `\baw-` → `superd-`），覆盖 113 个 tracked 文件；随后核对零残留（`\baw[-.]` / `AW_` / `agent-worlds` 在 living 文件中为 0）。
- **dev 链接**：`agent-*/node_modules/@pgmi-builds/agent-hub` → `superd-hub`；测试 home farm（`.tests/superd/profiles/node_modules/@pgmi-builds`、`…/superd-omp-world-mounted/…`）重建为 `agent-omp` + `superd-hub`，清除旧名与 dangling 链接。
- **测试 home 迁移**：`mv .tests/aw .tests/superd`（保留 credentials / sessions / world homes）；旧 `aw-pub`、`aw-omp-world-mounted` profile 目录清除；world homes 的 profile 由 `provisionWorldProfile` 在下次 spawn 时**无条件重写**（包名、bundles、`@pgmi-builds` links 全部换新）。
- **文档**：根 `AGENTS.md`（§一 交付结构、§二 台账 += 品牌轮条目、§五 布局/scope）、`super-dsh/AGENTS.md`、`agent-adapter-dev-rules.md`、`README.md`（主包标题）、各 `package.json` description（去掉 `Agent Worlds` / `AW-E` / `AW-F` / `AW-H` 代号）。
- **判断性动作（user 可否决）**：
  - 删除 `agent-omp/test/start-4999.sh` 与 `start-5199.sh`——两者引用已不存在的 `~/workspaces/dsh-omp` 仓库路径、全局 dsh 0.1.5-rc.2 二进制与 `DSH_HOME=~/.omp/omp-web`；`super-dsh/AGENTS.md` 本就声明 `start-*-app.sh` 族为「standalone legacy 线，仅存档参考」，omp 这两个更早已失效。git 可恢复。
  - 页面 global `__OMP_WEB_MOBILE__` → `__AGENT_OMP_MOBILE__`（host 注入脚本与 client half 的包内契约，全部引用同包内，已 build 验证）。

---

## §四 验证

### 4.1 构建与单测（全绿）

- `node super-dsh/scripts/pack.mjs`：0 error；tarball `super-dsh-0.1.3-q.tgz`（183 files / 337.8 kB 打包后 / 1.3 MB 解包）→ `.scratch/superd-pack/`。
- 单测（`node --test`，改名后全量重跑）：hub **106/106**；pi 56；codex 70 pass + 3 skip；claude 140；hermes 126 pass + 2 skip；agy 32；omp **49 pass + 1 skip**。
  - 过程中两处**测试预期**残留旧名（`OMP agent via the omp-web bridge`、`omp-web/zoom-font-floor`）→ 已随源码改名更新；omp 首轮 2 fail 为「改源未 rebuild，测试读 `dist/`」所致，rebuild 后归零。

### 4.2 4999 交付形态（pack 线）

- 起线：`bash super-dsh/test/start-4999.sh` → pack → `corepack pnpm@10.33.2 add file:` 装 `super-dsh 0.1.3-q` 进全新 profile `superd-pub`（home `.tests/superd`）→ unit `superd-4999-test` active。
- 日志健康：`world failed|incompatible|skipping profile` 计数 **0**。
- 挂载探针：`/omp/ /codex/ /claude/ /pi/ /hermes/ /agy/` 无凭据 **6×401**（mounted + fenced）；带认证 cookie 请求 `/<rt>/api` 到达世界网关（返回 `gateway/bad-request`，非 401）。
- **组合 dump（= Plugins 页所列行的权威来源）**：`dsh --profile superd-pub --dump-config` 的 `# == super-dsh` 段为

  ```
  - id: superd-hub               name: super-dsh
  - id: superd-web-trust         name: super-dsh/web-trust
  - id: agent-omp                name: super-dsh/agents/omp
  - id: agent-codex              name: super-dsh/agents/codex
  - id: agent-pi                 name: super-dsh/agents/pi
  - id: agent-hermes             name: super-dsh/agents/hermes
  - id: agent-agy                name: super-dsh/agents/agy
  - id: superd-join-claude       name: super-dsh/join   config: {key: claude, label: Claude}
  - id: directory-picker-browse  name: '@deepseek-ai/dsh-host-directory-picker-browse'
  - id: directory-picker-browse-surface  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
  ```
  且 `@deepseek-ai/dsh-web-app` 段内 `- id: directory-picker`（`dsh-host-directory-picker-auto`）被 super-dsh patch `disabled: true`。
- **world 树自愈**：`.tests/superd/agents/omp/profiles/web/package.json` 已被重写为 `name: superd-omp-world-profile`、bundles `[…, "@pgmi-builds/agent-omp"]`；profile-local links = `agent-omp` + `superd-hub`；该 world 的 `--dump-config` 显示 `patched by @pgmi-builds/agent-omp`（新包名生效）。

### 4.3 dev3 目标机实装

- tarball `scp` → `~/.dsh/profiles/web`；`corepack pnpm@10.33.2 add file:/tmp/super-dsh-0.1.3-q.tgz`；profile 备份 `package.json.pre-0.1.3-q.bak`；`~/.dsh/agents/**/@pgmi-builds/{agent-hub,agent-adapter-*}` 旧链清理后 `systemctl --user restart dsh.service`。
- 结果（实测）：profile dep = `file:/tmp/super-dsh-0.1.3-q.tgz`，`dsh.profile.bundles` 含 `super-dsh`；`dsh.service` **active**；重启后 journal `world failed|incompatible|skipping profile` **0**；认证 `GET /?token=` **200**；6 个世界挂载无凭据 **6×401**（mounted + fenced），带 cookie 请求 `/<rt>/api` 到达世界网关（400 bad-request，非 401）。
- **world 自愈同样成立**：`~/.dsh/agents/omp/profiles/web/package.json` = `superd-omp-world-profile` + bundles `[…, "@pgmi-builds/agent-omp"]`；profile-local `@pgmi-builds` links = `agent-omp` + `superd-hub`（旧名链在重启前清除，由 provision 以新名重建）。
- 待 user 第一人称验收的 token（本 boot，dev3 走 `http://127.0.0.1:3080/`）：`Qe5dXM3kQwMvxluBTBrQjzBh5FcT2XstZhs3u2oquhc`；本机 4999 线 token：`qG5bJnVIS9KKARnuyvPJDMx0jRAUcMRIRxLfewHnt2c`（WAN `https://test.pc.internal.test/?token=…`）。

---

## §五 回答指令 1：那两个 native 组件与 `join` 为何在 super-dsh 名下

**「2 个 native dsh」= 一个功能的两半，被 super-dsh 的 composite patch 主动插入。** dsh 的目录选择是 host/client 对偶：`@deepseek-ai/dsh-host-directory-picker-browse` 是宿主侧后端（注册浏览能力），`@deepseek-ai/dsh-client-ui-directory-picker-browse` 是客户端 UI 面（占用 workspace picker 的目录流槽位）。上游 stock 行 `directory-picker-auto` 不是简单别名——它在 boot 时解析 interaction 并挂载 `dsh-client-ui-directory-picker-<kind>`；若仅把它 `disabled: true`，client 端 `WorkspacePicker` 的 `flowAvailable` 为假 → 「add workspace」入口整个消失。super-dsh 于是**自己钉 browse 形态**：插入两半 + 禁用 auto 行（`super-dsh/cordis.patch.yml`；各 adapter 的 standalone patch 同款）。Plugins 页的「Components」= bundle 的 `insert` 行，所以这两条 native 行显示在 super-dsh 名下——**这是刻意设计，不是误挂**。

**`join` 独立**（裁决 R2，2026-09-16）：把某个 adapter「接入 hub」是**hub 侧的职责**，不是 adapter 的。`agent-claude` 刻意只发 standalone 形态（其 `./world` 入口 inert），因此由 hub 侧一条通用 joiner 行 `super-dsh/join` + `config {key: claude}` 完成 roster 注册、world provision/spawn、`/claude` 挂载。它是**一个共享组件**：任何 standalone-only adapter 都复用同一条（避免在每个 adapter 里复制 spawn/roster/mount 接线），且 cordis 以模块标识插件 → 每棵树一条 joiner 行（第二个被 join 的 world 要么走 adapter 自带 world 插件（omp/codex 形态），要么把该插件提升为逐行实例）。

---

## §六 待办 / 不由本报告放行

- **user 第一人称验收**（根 AGENTS §〇.1.a）：4999 与 dev3 均已就位待测。
- **`npm publish` 只在 user 明确下令时执行**（§〇.1.c/d）；registry `latest` 仍冻结。
- dev3 page-trust 仍惰性（未声明 trusted hostname），启用需 `AW_TRUSTED_HOSTS→SUPERD_TRUSTED_HOSTS` 一行 env 或 plugin config。
- 已知非阻塞：world 页 `open-in-app` 401（world-tree cookie secret 与 ctx0 不同源，0.1.6 起既有）。
