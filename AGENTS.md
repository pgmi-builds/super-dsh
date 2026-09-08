# Super D (superd) — 拓扑与 Dev/Test 约定

本文件是 agent 指引的一站式契约：操作红线、定位速查、上游基线与对齐纪律、dev/test 路径、规划工作流、当前仓状态。词汇表见 `CONTEXT.md`；设计正本见 `docs/`。

---

## 〇、Development Operation Contract — 红线

1. **npm publish 前置条件，缺一不可，顺序不可换**（superD 尚未发布，提前立规；先例：npm 发了就发了，撤不回）：
   - a. **第一人称实测通过**：真实运行时里走通改动路径（起 4999 实例 + 浏览器/curl 实测）。进程没崩、单测绿、tsc 0——这些是构建卫生，**不是验收**。
   - b. 实测结果落报告（`docs/` 下 test-reports 惯例，建立后生效）。
   - c. **user 明确确认放行**（实测通过 ≠ 放行，两道独立闸门）。
2. **验收标准与改动点同类**：改「运行时行为」就用「运行时行为」验收，不得降级为进程活性或静态证据。
3. **未经 user 单次明确同意，不得 `npm publish`**；授权粒度单次有效。
4. GitHub 侧（commit/tag/push）可逆，跟随上述节奏，不抢跑。
5. **上游源码零修改**：依赖全部 exact-pin，改动一律走 patch 层（`cordis.patch.yml`）/自有插件；vendor 保护机制（`superd vendor verify/restore`，蓝图 §5）落地后强制启用。

---

## 一、这是什么（定位速查）

- **superd = 独立 App（最小 cordis 宿主）**，不是 dsh 的插件/profile/fork。桥接层：把本机与远端已有 Agent 运行时映射到 DSH Web UI 可消费的数据面；**自己不跑 agent、不存原始会话**（唯一持久状态 = pairing 表）。
- 双包结构：根 `superD`（CLI `superd`）+ `packages/superd-web-bundle`（web 面 bundle：载体 + 中性底座 roster patch + 胶水插件）。后续 per-runtime 对偶包：`@pgmi-builds/agent-adapter-*`（数据面）+ `@pgmi-builds/agent-ui-*`（呈现面）。
- 命名纪律：App 名 Super Dash / 品牌 Super D / 代码与 CLI `superd`（无空格连字符）；上游 UI 内 DSH 字样原样保留（品牌原则：仅自研代码用 Super D 品牌）。
- 设计正本：`docs/00-blueprint.md`（v0.4a）+ `docs/01-component-boundaries.md`（v0.3）+ `docs/adr/0001–0007` + `CONTEXT.md` 词汇表。研究镜像 `docs/01–05` 簇**只读**（正本在 dashr 仓）。

---

## 二、上游基线与对齐（Upstream Baseline & Alignment）

- **exact-pin 基线（2026-09-08 user 裁决）**：dsh 系列 `0.1.3-alpha.2`（npm `alpha` tag）——0.1.2→0.1.3 的主要变更已落在 alpha.2，后续 alpha.3+ 破坏性预期递减，superd 贴近 upstream 跟跑。框架伴生：`@deepseek-ai/cordis@4.0.2`、`cordis-plugin-loader@1.0.3`、`cordis-plugin-include@1.0.7`、`schemastery@3.18.2`、`commander@15.0.0`。
- **本地参照 checkout**：`upstream/deepseek-harness`（浅克隆，HEAD = `dsh-v0.1.3-alpha.2`，与 pin 同版；`dsh-v0.1.2-alpha.5`（研究语料基线）/ `dsh-v0.1.2-rc.1` 两 tag 已 fetch 可 diff；gitignored，**勿改**）。
- **版本事实（2026-09-08 核 registry）**：dist-tags — `latest`/`next` = 0.1.2-rc.1、`alpha` = 0.1.3-alpha.2；alpha.5→rc.1 为纯版本号 bump（252 行 package.json）；rc.1→0.1.3-alpha.2 为大周期（4866 文件，+103k/-39k）。
- **对齐轮程序（上游每发一版必跑）**：
  1. `git fetch --depth 1 origin tag <new-tag>` → checkout；
  2. diff 关键文件清单：`packages/boot/app-boot/src/{index,profile}.ts`、`packages/bundle/web-app/{cordis.patch.yml,src/*}`、`packages/boot/cmdline/src/index.ts`、`packages/client/connection/src/{browser-auth,rpc-host}.ts`、`packages/host/{frontend-static,webserver}/src/index.ts`、`packages/util/home-paths/src/index.ts`、`apps/cli/src/profile-boot.ts`、`vendor/*/package.json`；
  3. 无破坏 → 全仓 sed 换 pin（每包一行）→ `npm install --cache .npm-cache` → `npm test`；有破坏 → 更新受影响代码块与计划文档后再换 pin；
  4. 记录对齐结论（commit message 或 docs）。

---

## 三、Dev/Test 约定

- **In-place build，零全局包依赖**：repo 本地 `node_modules` 是唯一依赖来源；禁止 NODE_PATH / symlink 机器全局树。`npm install --cache .npm-cache`（仓内缓存；默认 `~/.npm` 在受限沙箱下 EROFS）。锁版本：exact-pin，无 `^`。
- **Test profile 隔离**：dev/test 一律 `--home .superd-test`（仓内，gitignored）或测试 tmpdir。**绝不触碰 `~/.dsh`（用户 dsh 数据）与 `~/.superd`（prod home）**。`DSH_HOME` 由 bin 显式覆盖为 superd home——用户的 `DSH_HOME` 环境变量**永不被 superd 继承**（见 `src/home.ts` 契约）。
- **端口**：默认 3090（prod 面）；dev/test 一律 **4999**（机器共用惯例，**用完即停**）。
- **运行（tsx 直跑，无构建步）**：
  ```bash
  npm run superd -- web --port 4999 --home .superd-test
  # token URL 从 stdout 取（superd: http://127.0.0.1:4999/?token=…）
  # curl 冒烟：curl -c jar -L '<token-url>'（303 重定向靠 cookie 保认证）
  ```
- **认证探针指纹**：GET `/` 未带 token/cookie → 401 + `dsh web authentication required`（复用 client-connection 认证面；也是 DSH runtime 存活探针，蓝图 §6）。
- **测试**：`npm test`（vitest 单测 + 4999 集成冒烟）；`npm run typecheck`。
- 调试：`superd web --dump-config` 打印组合后的插件行表。
- **dsh-plugin 线（multi-agent-registry 等）拉起与用户验收（2026-09-09 user 裁决）**：
  - 测试实例一律 `systemd-run --user` 拉起（沙箱内直起会继承嵌套沙箱、bwrap 探测失败；沙箱内连 user bus 被拒，单命令按惯例 `danger-full-access` 升级）；配方照 dsh-omp AGENTS.md §二：`WorkingDirectory`=仓根、`Environment=DSH_HOME=<仓内 .superd-test 绝对路径>`、日志 append 到 `.scratch/<unit>.log`、unit 名 `<线名>-<port>-test`，ExecStart = `/usr/bin/node /home/u1/.local/bin/dsh --profile <name> --no-open`。
  - **trusted hosts**：要让用户从内网/外网实测，bind `0.0.0.0`（web-app bundle 全接口 bind 自动派生 LAN 信任）；外网域名访问加 `--trusted-host <域名>`（omp-web 同款）。只绑 127.0.0.1 的实例用户永远看不到。
  - **验收模式**：起了 Web 服务器就停下来交给用户——把 token URL 交给用户、**保持运行**，等用户亲手测完再收尾（`systemctl --user stop`）；不得自行 kill 完才报告。

---

## 四、规划与执行工作流（Superpowers）

- 流程链：brainstorming（已完成：grilling 4 轮 → 蓝图 v0.4a + ADR 0001–0007）→ **writing-plans**（当前）→ executing-plans / subagent-driven-development。
- 计划落位：`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`；TDD bite-size 任务，每任务独立可测交付 + commit。
- M1 计划序列：**P1 骨架+宿主（计划就绪）** → P2 Machine/Pairing/Selector → P3 DSH adapter 全透传 → P4 OMP adapter → P5 DEV3 remote + 半构建验收。
- 决策落档纪律：设计裁决进蓝图 §9 决策表/ADR；开放问题关闭用蓝图 §11 划掉格式；计划内决策记录在任务 Interfaces。

---

## 五、Repo 状态（2026-09-08 快照）

- **docs-only + P1 计划**：尚无 src/node_modules（P1 执行时产生）。git：blueprint v0.1 → CONTEXT/ADR 0001–0005 → design freeze v0.4a（含 ADR 0006/0007、研究档重组）→ P1 计划。
- 上游 checkout 就位（见 §二）；参考源 dsh-omp（OMP adapter 蓝本）与 dashr 仓在同机 `~/workspaces/`。
- 待决：`.agents/`（superpowers 技能目录）入库与否——user 裁决搁置（ignore）。
