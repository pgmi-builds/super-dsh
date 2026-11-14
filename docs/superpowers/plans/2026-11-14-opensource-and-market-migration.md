# super-dsh 开源与 BetterDash 旧仓迁移 Implementation Plan

> **For agentic workers:** 执行时使用 `superpowers:executing-plans` 逐任务推进；未经用户或适用规则明确要求，不派遣子 Agent。每一步用复选框追踪。**本计划含多次 user 放行点（标 ⛔）：未放行不得执行对应 GitHub / 归档操作。**

**Goal:** 将 `pgmi-builds/super-dsh`（一仓两包：`better-dsh` + `super-dsh`）**保留完整 Git 历史**转为 public，插件市场登记为**两条独立 entry**，旧仓 `pgmi-builds/better-dsh` 归档为搬迁路标，全程无装机断档、无泄露，且公开后本地开发测试流程不变。

**Architecture:** 四段串行：①树内脱敏 + AGENTS.md 原则/事实分离（本地）→ ②树验收 → ③**私有态** filter-repo 全史重写 + 全史验证 → 切公开 → ④市场双 entry 迁移 + 旧仓归档。顺序刚性依赖：历史重写与验证必须在私有状态下完成，验证通过才切 public（消除「一次机会」风险）；市场探针要读公开 repo，故 public 先于市场 PR；旧仓 entry 在市场 PR 合并前仍是装机源头，故归档最后。

**Tech Stack:** git filter-repo（全史路径移除 + replace-text）、gitleaks（或 trufflehog）、pre-commit hook / CI grep（持续防泄露门）、awesome-dsh-plugin registry（entry yml + CI 探针）、npm registry 元数据（只读）。

**Spec:** 无独立 spec；本计划即正本。背景核查事实（2026-11-14，第二轮更新）：
- 本仓 637 commits、64 tags（v0.2.x 至 v0.3.5）；npm `better-dsh` 45 版：0.2.2-a→0.2.5-e 共 19 版 + 已弃用 scoped 包的 repository 不可变指向旧仓；0.3.x 起全部指向 super-dsh（因私有现对公众 404，public 后自愈）；foreign agent runtime = **6**（agy/claude/codex/hermes/omp/pi；`agent-*-sdk` 为其中三家 SDK 线不计）——市场描述数字以此为准。
- 市场现状：仅一条 `pgmi-builds__better-dsh--better-dsh.yml`（`name: pgmi-builds/better-dsh#better-dsh`，装机停在 0.2.5-e）；super-dsh 无条目。`npm-map.json` 由 CI 探针生成（nightly 02:23 UTC PROBE_ALL 或手动 dispatch），**不手改**。
- 市场规则（contributing.md 实查）：**monorepo 子包官方支持**——「point url at the subdirectory and use `owner/repo#subname` as the name」；`category` 为**单值标量**；类目枚举 `agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`——**closed enum**（「set is not fixed」指维护者侧 taxonomy 拆分演化：security/browser/remote/voice 均由 tools/ui/dev 长大后拆出；对提交者的指引是「挑最接近的即可」）；描述中的数字/API 名会被逐项核对；PR 需 green CI；repo 需加 `dsh-plugin` topic。
- **类目实查（2026-11-14 第三轮）**：multi-agent/orchestration 生态已全部聚在 `agi`（AGI Architecture Exploration）——dsh-team-conductor、dsh-moa-native、portable-dsh-multi-agent-plugin、dsh-ladder-superagents、dsh-plugin-antigravity-agents、dsh-codex-peer、dsh-outsourcing-expert 等；foreign-runtime 桥接类（codex2dsh、dsh-claude-compat、dsh-cc-ecosystem）在 `dev`。
- 旧仓：public、6★、0 fork、0 open issue、MIT、`main` 分支；新仓默认分支 `master`。
- **历史泄露面（已查明，有限）**：`.scratch/`、`.test/home/`、`.agents/`、`docs/legacy/better-dash-local/` **从未入库**；历史中仅 `.superpowers/`（17 commits）与 `docs/60_exploration-and-research/`（2 commits）两条本地目录路径需整体移除；字符串泛化面 = 当前树 305 个 tracked 文件（docs/ 240、super-dsh/ 50、better-dsh/ 10、.test/ 4、archive/ 1、根 AGENTS.md / CONTEXT.md / Cordis 指南、根 .superpowers/ 1）的历史全集。无 CI workflows；root LICENSE 与 better-dsh/LICENSE 存在，super-dsh/ 缺 LICENSE。

## Global Constraints

- **红线 3**：全程无 `npm publish`；本计划不涉及发版。
- **红线 4**：GitHub 定版操作（force push / topic / market PR / archive）逐次经 user 放行。
- **红线 6**：生产隔离——市场实装验证走测试 home / 4999 线，不碰 `~/.dsh`、生产 3080/3081。
- **红线 0a**：公开前验收走交付形态——干净 clone 构建 + 4999 tarball 线冒烟。
- 顺序不可调换：脱敏 → 树验收 → **私有态历史重写 + 全史验证** → public → 市场 PR → 旧仓归档。
- 两包关系维持 ADR 0016：互不依赖、互不安装；市场两条独立 entry（官方明文的 monorepo 子包模式）。
- **历史保留裁决（D1=A，user 2026-11-14）**：全历史公开；filter-repo 重写在私有状态下完成并验证后才切 public。

---

## 本地资料安置法（三分类 + 判据，贯穿执行）

| 类 | 判据 | 去处 |
| --- | --- | --- |
| **硬私有** | 绝不能出现在公开树与公开历史：凭据、事故档案、涉密研究 | 物理出仓，`~/workspaces/base/…`（token 在 `base/secrets/`、事故在 `base/70_Incidents/`，维持现状） |
| **软本地（全本地目录）** | 整目录都是机器局部内容：`.tests/`、`.test/home/`、`.scratch/`、`.agents/`、`/upstream`、`node_modules`、`*.tgz`、`graphify-out/`、`.venv/`、`docs/60_exploration-and-research/`、`docs/legacy/better-dash-local/`、`.superpowers/` | 树内 + `.gitignore`（现状已如此）；历史残留由 filter-repo 整体移除 |
| **公开但脱敏** | 对其他开发者有用：`docs/`（含 test-reports 实测报告与计划）、`archive/`、`.test/` seed 文档与 example 脚本、`AGENTS.template.md` 原则层 | 保持 tracked，内容脱敏（主机名/域名/IP 泛化） |

判据口诀（AGENTS.md 分层同款）：**原则 = 任何克隆者都该遵守的 → 入库；事实 = 只关于这台机器的 → 本地 overlay。**

持续防泄露（公开后长期机制）：pre-commit hook + CI grep 守门；**公开侧脚本不含敏感字符串**，本机模式放 `scripts/leak-patterns.local.txt`（untracked），模板 `scripts/leak-patterns.example`（tracked）；CI 只查通用形态（token 形状、IP 形状）+ 从 example 派生的中性模式。

---

## Task 0 — 决策点（2026-11-14 user 裁决后余一项）

- ~~D1 历史形态~~ → **已裁决：A，保留全历史**（体现持续更新与成熟度）。
- ~~D2 脱敏口径~~ → **已裁决 + 2026-11-14 执行轮复审**：只泛化 actionable 标识——真实域名→`*.internal.test`、真实主机 IP（尾 .3）→RFC 5737 `192.0.2.x`；**dev1–dev5 主机名本身保留**（非 actionable：公开侧无地址语义；发货源码 `ssh:dev4` 等示例名被 byte-pin 测试锁定不动；docs 保留 devN 免除本地阅读翻译成本）；`10.0.0.5`/`10.0.0.8` 属发货示例串豁免；docker 标准网段豁免；端口保留；AGENTS.md 机器事实（npm 凭据路径、测试线真实域名、事故档案路径）下沉 `AGENTS.local.md`。
- ~~D3 archive/tests 去留~~ → **已裁决：按用户规则**——(a) 全本地目录不入库；(b) 有公开价值的脱敏后保留（docs/test-reports、archive/、.test/ seed 均保留）。
- ~~D4 super-dsh 市场类目~~ → **已裁决（2026-11-14 第三轮）：`agi`**——与既有 multi-agent 生态同类并列（informative 目的）；orchestration 定位由 description 首词组 + repo topics 承载（branding/marketing 目的）；PR 文案顺带向维护者提议未来拆 `orchestration` 类目（顺着其 taxonomy 演化机制，单插件不足以现在触发）。不自造枚举外的 category 值（CI 形状校验风险 + 大概率被维护者改回）。better-dsh 维持 `dev`。
- **D5 AGENTS/脚本反转（2026-11-14 第四轮 user 裁决）**：runtime 按文件名 auto-load `AGENTS.md`，故 **`AGENTS.md` 归本地**（gitignored，由 `scripts/sync-agents.sh` 生成 = `AGENTS.template.md` + `AGENTS.local.md`，自动加载即得全文、不依赖模型跟随引用）；**Git 上放 `AGENTS.template.md`**（公开原则模板）+ `AGENTS.local.example.md`（事实片段模板）。seed 测试脚本同法：真实 `start.sh`（含本机地址/端口）本地化 ignore，Git 只入 `start.example.sh`（占位域）。devN 示例名保留终裁确认（无所谓即保留）。子包 `super-dsh/AGENTS.md`、`better-dsh/AGENTS.md` 为纯原则（脱敏后零本机事实），维持 tracked 不反转。

- [x] **Step 0.1:** user 确认 D4 → `agi`（四个决策点全部关闭）

## Task 1 — 树内脱敏、AGENTS.md 分层与 LICENSE / 门面补全（本地，不出仓）

**Files:** 约 305 个 tracked 文件内容替换；`AGENTS.template.md`（tracked 原则模板）、`AGENTS.local.md`（untracked 事实片段）、`AGENTS.local.example.md`（tracked）、`scripts/sync-agents.sh`（tracked 拼装）；`super-dsh/AGENTS.md`（原则层改写）；`.test/seed/*/start.sh`（untracked 真身）+ `start.example.sh`（tracked 占位）；根 `.gitignore`（`/AGENTS.md`、seed 真身、`AGENTS.local.md`、`scripts/leak-patterns.local.txt`、`docs/80_upstream-docs-and-skills/`、根 `.superpowers/`、`.claude/`）；`scripts/check-leaks.sh`（tracked）+ `leak-patterns.local.txt`（untracked）+ `leak-patterns.example`（tracked）；`super-dsh/LICENSE`（新）；根 `README.md`（公开门面）。

**Interfaces (Produces):**
- 泄露终检 = `scripts/check-leaks.sh --all`：仅允许已知豁免（`ssh-targets.spec.ts` 合成 PRIVATE KEY fixture）；`git ls-files` 无根 `.superpowers/`、`.claude/`、seed 真身、80_upstream 残留。
- AGENTS 反转协议（D5）：`AGENTS.template.md`（tracked，公开原则）+ `AGENTS.local.md`（untracked，本机事实）--`scripts/sync-agents.sh`--> 本地 `AGENTS.md`（untracked，auto-load 自足全文）。实证：git mv 移走 AGENTS.md 后 runtime 即报 instructions removed，重新生成后全文（含事实段）恢复加载。
- 守门脚本契约：`check-leaks.sh` 读 `leak-patterns.local.txt`（存在则附加）+ 内置通用形态（`npm_[A-Za-z0-9]{20,}`、`ghp_…`、`AKIA…`、IP 字面量），对 staged 内容非零退出；公开脚本本体零敏感串。

- [x] **Step 1.1:** `AGENTS.local.md` 先建（npm 凭据、域名映射、目标机拓扑、本机参数、敏感词表五节）
- [x] **Step 1.2:** 根 AGENTS.md（前言 + §〇.1.e + §七事故档案路径）与 super-dsh/AGENTS.md（端口条）原则层改写，机器事实改引 local overlay
- [x] **Step 1.3:** `AGENTS.local.example.md` 模板；`.gitignore` 增补（`AGENTS.local.md`、`scripts/leak-patterns.local.txt`、`docs/80_upstream-docs-and-skills/`、根 `.superpowers/`）；`git rm -r --cached` 80_upstream（87MB vendor 研究库，含 ClawHub 抓取目录——packaging 测试仅用路径字面量不受影响）与根 `.superpowers/` 残留
- [x] **Step 1.4:** 域名→`*.internal.test`（115 tracked 文件，排除 seed 运行时默认与本计划文件）；真实 IP（尾 .3）→192.0.2.3（machine-mesh 计划 + hub 两测试）；devN 保留（D2 复审）；受影响测试全绿（web-trust 15/15、hub 67/67）
- [x] **Step 1.4b（D5 改道）:** seed 真实脚本本地化——`.test/seed/*/start.sh` `git rm --cached` + gitignore（磁盘原样，4999 线零影响），Git 入 `start.example.sh`（占位域 + 说明头）；两 seed README 补「脚本形态」段。原「env 参数化」方案作废（example 法更稳：真身字节不动，无需重启验证）
- [x] **Step 1.5:** 守门三件套落地（`scripts/check-leaks.sh` + `leak-patterns.local.txt` + `leak-patterns.example`），接入 pre-commit，双向自测通过（干净过 / 泄露拦）
- [x] **Step 1.6:** `super-dsh/LICENSE`（MIT © 2026 super-dsh contributors）；root LICENSE 版权行「DASHR contributors」（旧名）是否更新待 user 拍板；root THIRD_PARTY_NOTICES 暂缓（80_upstream 已出库，Task 2 复核是否仍需）
- [ ] **Step 1.7:** 根 README 公开门面：目录结构、两包关系与安装命令、ADR 0016 边界一句话、market 入口占位
- [x] **Step 1.8:** 硬私有终检完成——`--all` 扫描仅剩 1 个良性合成 fixture；出库路径（80_upstream/.superpowers/.claude/seed 真身/AGENTS.md）`git ls-files` 零残留
- [x] **Step 1.9:** 两轮 commit（`23dce9e` Task 1 主体；本轮 D5 反转收尾）

## Task 2 — 树验收（⛔ 放行点 1：历史重写与转公开前总检）

**Files:** 产出验收记录进 `docs/test-reports/`。

- [ ] **Step 2.1:** gitleaks 扫当前全树（含待 push 文件清单核对）
- [ ] **Step 2.2:** 附加手扫：`ssh://`、`~/.ssh`、作者邮箱/姓名（是否泛化按 user 意见——npm 侧 email 本已公开）、内网主机名变体
- [ ] **Step 2.3:** 干净 clone → 构建 → 4999 tarball 线冒烟（红线 0a；两包 install/add 各一次）
- [ ] **Step 2.4:** 报告落 `docs/test-reports/`，user 放行历史重写

## Task 3 — 私有态全史重写、验证与切公开（⛔ 放行点 2：force push；⛔ 放行点 3：转 public）

**Files:** 无新文件；历史重写与 GitHub 侧操作。

**Interfaces (Produces):** 公开仓 = 全历史（637 commits 风格、64 tags 重写后全量保留）且逐 commit 验证零泄露。

- [ ] **Step 3.1:** 重写前备份：`git clone --mirror` 至仓外安全位置（+ `super-dsh-private-YYYYMMDD.bundle`）
- [ ] **Step 3.2:** filter-repo 执行：`--path .superpowers/ --path docs/60_exploration-and-research/ --path docs/80_upstream-docs-and-skills/ --invert-paths`（全本地目录整体出史；末者为 87MB vendor 研究库）+ `--replace-text`（真实域名→internal.test、真实 IP（尾 .3）→192.0.2.3；devN 不替换）
- [ ] **Step 3.3:** 全史逐 commit 验证：`git rev-list --all` 循环内 `git grep -lE <词表> <commit>` 零命中 + gitleaks 全史扫描 + tag 逐个抽查（重写后 tag 重打正确、0.3.5 树与重写前树语义等价——diff 仅限词表替换与移除路径）
- [ ] **Step 3.4:** 本地环境跟进：origin force push（⛔ 放行点 2）；`.worktrees/` 各检出重建；本地分支/tags 重置到重写后哈希
- [ ] **Step 3.5:** GitHub 门面：repo 转 public（⛔ 放行点 3）；加 topic `dsh-plugin`（市场 CI 前置要求）、`orchestration`、`multi-agent`（branding 落点）；description、social preview、About 链 npm 两包页
- [ ] **Step 3.6:** 验证自愈：npmjs.com 两包各 0.3.x 版本页 repository/homepage/bugs 逐一 200
- [ ] **Step 3.7:** 观察窗口 24h：GitHub 侧树 gitleaks 复扫、traffic/watchers 无异常

## Task 4 — 插件市场两条 entry（⛔ 放行点 4：market PR）

**Files:** fork 内两新一删：`data/plugins/pgmi-builds__super-dsh--better-dsh.yml`（新）、`data/plugins/pgmi-builds__super-dsh--super-dsh.yml`（新）、`data/plugins/pgmi-builds__better-dsh--better-dsh.yml`（删除，同 PR）。

**Interfaces (Produces):** better-dsh 坐标 = `pgmi-builds/super-dsh#better-dsh`；super-dsh 坐标 = `pgmi-builds/super-dsh#super-dsh`；探针完成 npm 名映射。文件名遵循官方 monorepo 子包模式（`owner__repo--subname.yml`）。

- [ ] **Step 4.1:** 两条 entry 撰写——better-dsh：`category: dev`，文案沿用旧条目（描述须与代码一致，数字会被核对）；super-dsh：`category: agi`，description 首词组 = 「Multi-agent orchestration hub …」，remote/cross-machine 作为能力从句（local or cross-machine over SSH/Docker/Incus），**adapter 数量逐个数准**（夸大是打回首因）
- [ ] **Step 4.2:** PR 落盘：两新 + 删旧同 PR；PR 文案显式说明「旧 entry 由本 PR 取代（坐标搬迁 + 旧仓将归档）」——PR gate 会列出被改的既有 entry，需在文案里交代清楚；文末向维护者提议：multi-agent/orchestration 类插件渐多时可拆新类目，届时 super-dsh 可第一个迁入
- [ ] **Step 4.3:** ⛔ user 审阅后提交；CI 绿是合并前置；等 maintainer merge
- [ ] **Step 4.4:** merge 后触发/等待探针（nightly 02:23 UTC PROBE_ALL 或请 maintainer dispatch），确认 npm-map 两包映射新坐标
- [ ] **Step 4.5:** 消费端实装验证（测试 home）：Discover 两卡片可见可装、Installed 行描述正确（坐标换绑后 dshmarket notes/toggles 重置一次属预期）
- [ ] **Step 4.6:** 根 README 市场入口占位回收

## Task 5 — 旧仓归档为路标（⛔ 放行点 5：旧仓写操作）

**Files:** 旧仓 `pgmi-builds/better-dsh` 的 README.md、description、archive 设置。

- [ ] **Step 5.1:** README 顶部搬迁告示：新 repo、npm 两包页、市场新坐标；注明 0.2.5-e 后发版均出自新仓
- [ ] **Step 5.2:** description 改 `MOVED to pgmi-builds/super-dsh — better-dsh & super-dsh now maintained there`
- [ ] **Step 5.3:** Settings → Archive（此后永不再动；归档仓可 clone，旧 npm 链接不断）
- [ ] **Step 5.4:** 复核：旧仓主页、`better-dsh/` 子目录页、raw README 可达；`git clone` 冒烟一次

## Task 6 — 收尾观察与记录

- [ ] **Step 6.1:** 一周观察：npm 周下载、市场装机、旧仓 insights、搜索引擎收录
- [ ] **Step 6.2:** `docs/dev-test-environment-notes.md` 追加：filter-repo 重写记录（新哈希基线、mirror 备份位置）、AGENTS.local 分层生效、守门脚本用法、市场双坐标、旧仓归档状态
- [ ] **Step 6.3:** 全计划 checkbox 收口，遗留项单列

---

## 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| 全史重写漏清 | 逐 commit grep + gitleaks 双扫 + tag 抽查（Step 3.3）；重写全程私有态完成 | mirror 备份可完整恢复；公开后发现泄露→立即转回 private→补清→重新 public |
| 重写后哈希全变（637 commits、64 tags） | Step 3.1 mirror 备份 + Step 3.4 worktree/本地分支重建清单 | mirror 即回退 |
| 市场 PR 久拖 | 旧 entry 仍指旧仓（未删未归档），装机不断 | 等待即可 |
| 描述与代码不符被打回 | Step 4.1 数字逐个数；contributing 明言夸大是打回首因 | 修文案重推 |
| 探针映射失败 | Step 4.5 实装验证拦住；分支 master 已固化在 entry | 修 entry 重提 PR |
| 公开后持续开发再泄露 | Step 1.5 守门三件套（hook + CI + 本地模式文件） | 单 commit revert |
| 脱敏批量替换误伤 | dry-run diff 抽查 + Step 2.3 冒烟 | commit 粒度回滚 |
