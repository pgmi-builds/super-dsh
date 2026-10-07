# 2026-10-03 docs-packaging-trim 实测报告

- **Change**: `docs-packaging-trim`（spec: `docs/specs/docs-packaging-trim/spec.md`，档位 F）
- **执行**: 2026-10-04（batch 执行 Task 1 + Task 2）
- **范围**: 仅发布打包面。repo 的 `docs/` 树一字未动（git status 复核，仅既有 ast-work 脏文件，与本 change 无关）。

## 一、改动面（Task 1，commit `411ef47`）

- `better-dsh/scripts/copy-docs.mjs` 重构为可导入模块：
  - `export const EXCLUDE`（既有 4 条 + 新增 3 条：`hermes-dev-skill`、`dsh-dev-skill/pi-and-omp`、`dsh-dev-skill/src-scripts`）；
  - `export function excluded(srcPath)`；
  - `cpSync` filter 改为 `src => !excluded(relativeSrc(src))`（`relativeSrc` 剥前导 `../`；cpSync 传入的是绝对源路径，`(^|\/)` 锚使绝对/相对两形态等价匹配，目录遍历方式未动，既有行为字节等价）；
  - 原直跑主体（rmSync + cpSync + boot-token 脱敏 walk）包进 `import.meta.url === pathToFileURL(process.argv[1]).href` CLI 守卫。
- 新增 `better-dsh/scripts/copy-docs.d.mts`（brief 外必要补充）：brief 给定的测试文件原样 import `.mjs`，`tsc --noEmit`（NodeNext）报 TS7016；按仓内既有惯例（`src/devices/ast/engine/grammar-manifest.d.mts`）补兄弟声明文件后 tsc 归零。
- 新增 `better-dsh/test/packaging/copy-docs-exclude.spec.ts`（brief 原文，5 用例）。
- 验证：`npx vitest run test/packaging/copy-docs-exclude.spec.ts` **5/5 PASS**（TDD 先红后绿：改写前 5/5 FAIL，`EXCLUDE` 无导出）；`npx tsc --noEmit` **0 错**。CLI 守卫双向实测：`import()` 不触发拷贝；`node scripts/copy-docs.mjs` 正常产出（2 文件 token 脱敏）。
- 全量 vitest 套件本批未重跑（纯构建脚本改动，无运行时面；仓内基线 600/601 先于本 change）。

## 二、量化（Task 2）

| 指标 | 前 | 后 | 备注 |
|---|---|---|---|
| `better-dsh/docs` 磁盘 | **89 MB** | **6.6 MB** | 前 = 用 `411ef47~1` 旧脚本现场重建后 `du` 实测 |
| `80_upstream-docs-and-skills/` 内 | hermes-dev-skill 77M + dsh-dev-skill 11M | 仅 dsh-dev-skill **4.3M**（skill 304K + src 4.0M + src-README） | repo 侧 pi-and-omp 2.8M、src-scripts 3.4M 实测 |
| npm tarball（0.2.5-c 同工作树） | **21.22 MB** | **4.84 MB**（**−77%**） | 前值 = 旧 docs 拷贝下 `npm pack` 现场实测；设计轮估值 20.3→3.7 MB 基于旧包构成（现包含 ast WASM assets 等），以本表为准 |
| tarball 内 `hermes-dev-skill` 条目 | 794 | **0** | |

与 brief 预期的偏差均为**基线漂移**（设计轮数字按当时包构成估算），非实现缺口。

## 三、验收清单（spec §4）

1. ✅ 发布副本不再出现 `hermes-dev-skill/`、`dsh-dev-skill/pi-and-omp/`、`dsh-dev-skill/src-scripts/`：`tar -tzf | grep -c` = **0**。
2. ✅ repo `docs/` 一字不动：`git status -- docs/` 仅既有脏文件（ast-work 的 plan 文件，先于本 change）。
3. ✅ 承重面完好：tarball 内 `dsh-dev-skill/skill/SKILL.md` = **1**、`dsh-dev-skill/src/site-pages-map.txt` = **1**；skill/chapters ch01–ch04 在。**SKILL.md sha256 三方一致**（repo = tarball = rig 安装位 `552cbc9c5efc…`）。
4. ⚠️→✅ 零新增悬空引用：见下节。
5. ✅ 发布副本 = repo docs 严格子集减 7 类排除（`comm` 交叉核验：shipped-not-in-repo = **0**；repo-minus-shipped 全部落在排除类内）。

## 四、悬空引用核查（对 brief Step 3 预期的修正）

解包 grep `hermes-dev-skill|pi-and-omp|src-scripts` 命中 **3 个文件**，非 brief 预期的"仅 src-README 一处"：

| 文件 | 性质 |
|---|---|
| `80_.../dsh-dev-skill/src-README.md:22` | spec §3 **已知例外**（对 src-scripts 的结构自述，明示接受） |
| `docs/specs/docs-packaging-trim/spec.md` | **本 change 自己的 spec**（描述"摘了什么"，自指引用） |
| `docs/superpowers/plans/2026-10-03-docs-packaging-trim.md` | **本 change 自己的 plan**（brief/测试片段文本） |

定性：后两处是 change 自带文档对被摘目录的**提名**，非指向已摘内容的活引用；spec §1.4 的实质契约（无悬空活引用）成立。字面 grep 预期在设计轮无法预见 spec/plan 自身随 docs 发布。**接受，不改写正文**（改写即分叉 repo 副本，违背 §1.2）。

## 五、rig 冒烟（4998，rig 在场 → 执行）

1. `dsh plugin remove better-dsh` → `plugin add /tmp/trimpkg/better-dsh-0.2.5-c.tgz`（compat home，remove→add 完整来回）。
2. 安装位物理核验：`profiles/web/node_modules/better-dsh/docs/80_upstream-docs-and-skills/` 仅 `dsh-dev-skill`；SKILL.md、site-pages-map.txt 在位；`find` 无 hermes/pi-and-omp/src-scripts；docs 6.4M；`dsh-docs/` 48 项在位。
3. `PORT=4998 bash .test/seed/test123/start.sh` 重启：监听正常。
4. HTTP 实测（密码闸，seeded 口令登录）：shell 200（39,772 B）；boot graph 含 `"id":"better-dsh"`；`/plugins/??better-dsh/client.js&rev=98a2110f16da` 200（29,700 B ≈ 本地 lib/client 29,632 B + sourceMappingURL 行）。
5. **技能面等价证据**：`skill-filesystem` 扫描根（project/user/agent-preset/custom）静态配置均不指向插件 docs；本会话（prod，仍在 pre-trim 安装位）技能目录实时列出 `dsh-dev-skill`，其描述与该 SKILL.md frontmatter 逐字一致 → 技能目录确从该文件取得；trim 保持该文件与章节、`src/docs/`、`site-pages-map.txt` 字节不变（sha256 同上），只移除正文零引用的兄弟目录。
6. ~~**未执行项（记录在案）**：rig 上的活会话技能目录读取（`skill://dsh-dev-skill` 现场解析）未驱动——需要经密码闸 GUI 发起真实 LLM 会话，超出本批范围；按编排方预授权口径记录跳过理由。~~ → **已于 2026-10-04 由本 batch 之外的终审轮现场闭环，见 §七**。原文保留：rig 自身干净 boot（boot graph + client.js 200）已实证插件装载无损。

### `dsh://docs` 拓扑澄清（brief Step 4 子项修正）

`dsh://docs` 的解析（`src/url-schemes/docs-dir.ts` 最近优先 walk-up，`dsh-docs` 先于 `docs`）在**安装态**命中包根 `dsh-docs/`（DSH 官方文档，本 change 未触碰）。故"`read dsh://docs/50_test-reports/` 一份可读"在安装态拓扑下**不适用**——`docs/` 树仅在 `dsh-docs/` 缺席时才充当 `dsh://docs` 兜底。本会话实测 `dsh://docs` 列表正常（官方文档 200+ 项，无 `50_test-reports/`），与上述一致；trimmed `docs/` 树的消费者是技能面（第五节证据链）。

## 六、结论与红线

- Task 1 + Task 2 全部落地：发布副本 89 MB→6.6 MB 磁盘、21.22→4.84 MB tarball（−77%），外来材料（77 MB Hermes 镜像 + 59 MB api-skills.json 所在树）、未引用第三方资料、抓取工具全部离场；承重技能面字节不变；rig 在 trimmed 安装上干净 boot。
- **`npm publish` 不在本 change 内**——按根 AGENTS.md 〇节，发包需第一人称实测通过 + user 单次明确放行，两道闸缺一不可。

## 七、终审人为条件闭环：`skill://dsh-dev-skill` 活会话实测（2026-10-04）

§五.6 记录的唯一未执行项（trimmed rig 上的活会话技能目录读取）已于本批之外驱动并通过。**执行方式**：在 trimmed 安装位（本 rig，端口 4998，密码闸 GUI 之后的真实 LLM 会话）现场执行 `read skill://dsh-dev-skill`，且由**两个互相独立的主体**各跑一次——(a) 编排会话本体；(b) **冷上下文子 agent**（不带任何预热/继承的技能目录状态，独立 session）。

| 检查 | 结果 |
|---|---|
| `read skill://dsh-dev-skill` 返回 SKILL.md 正文 | ✅ 完整正文：H1 + `**Source**` 行 + How to Use This Skill + 8 条 Core Mental Models + 章索引 ch01–ch22 + ~55 条 Topic Index + Supporting Files + Scope & Limits 收尾。无错误信封、无 `[truncated]`、无缺路径标记；结尾句完整，非截断 |
| 冷上下文子 agent 独立复现 | ✅ 与 (a) 逐字一致（含前 20 行原文引用）；两通道均 PASS、均零错误文本 |
| 技能目录**树**承重面（不只在 router 层） | ✅ `read skill://dsh-dev-skill/chapters/ch15-subsystems-tool-execution.md:1-15` 返回真实章正文（Core Idea / Frameworks Introduced），非空、非错误 —— 证明解析穿透到章文件，router 之外的目录亦在位 |
| 解析源确为 **trimmed 安装位**（非 repo 旁路） | ✅ 安装位 `…/profiles/web/node_modules/better-dsh/docs/80_upstream-docs-and-skills/` 顶层**仅 `dsh-dev-skill`**（无 `hermes-dev-skill`/`pi-and-omp`/`src-scripts`）；`skill/chapters` = **22** 项；`skill/SKILL.md` sha256 = `552cbc9c5efcc418e8e10eb85e8628a61174a283bf2b8df9b5180d184ea3d375`，与 repo 副本**逐字节一致**，亦即 §三.3 记录的那一枚 |
| 与 §五.5 静态等价证据的关系 | 本轮为**活会话动态解析证据**，补上 §五.5 静态等价链缺的那一环；两者路径独立、结论一致 |

**结论：技能面在 trimmed 安装位上现场可用，`docs/` 瘦身未打断技能目录解析。§五.6 未执行项关闭。** 证据边界（诚实记录）：`read` 面返回的是 SKILL.md 正文，**未显示 YAML frontmatter**（`---` 包裹的 `name`/`description`）——与该 face 的既有呈现方式一致，不影响正文完整性判定；§五.5 已用 frontmatter 描述逐字比对另行取证。

**附（同批顺带执行，非本 change 验收项）**：`write dvc://ast_grep {"patterns":["export function $NAME($$$ARGS)"],"path":"better-dsh/src/devices/ast"}` 实测 `totalMatches: 0`、`filesSearched: 11`。根因非工具故障：该 pattern 非完整 AST 节点（缺函数体），ast-grep 抛 `Multiple AST nodes are detected`，而 `src/devices/ast/engine/match.ts:68` 对该错误**静默回落为空结果**（`return { matches: [], unavailable: false }`）。交叉验证：同目录 grep 实测 10 处 `export function`；改用完整节点 pattern（`export function $NAME($$$ARGS) { $$$BODY }` 等三条）当场得 `totalMatches: 13 / filesWithMatches: 8`。记录为**已知行为面（错误静默）**，不影响本 change 结论，另见 ast 设备契约条目。
