# `dvc://ast_grep` / `dvc://ast_edit` 契约与边界实测报告（2026-10-04，4998 rig）

- **被测面**: `dvc://ast_grep`、`dvc://ast_edit`（better-dsh ast 设备）
- **环境**: trimmed 安装位 rig，端口 **4998**，`DSH_HOME=.test/home/compat`，安装位 `better-dsh@0.2.5-c`（docs 已瘦身）；文件策略 `danger-full-access`、approval `never`（无审批/沙箱旁路干扰，探针所见即设备行为）
- **方法**: 在一次性夹具上跑 **20 项探针**，每项都做**盘面复核**（`cat` / `md5sum`）而非只看返回值
- **与前序报告的关系**: `2026-10-03-better-dsh-tool-surface-repl-dvc-browser-ast-lsp-4999实测报告.md` 的 §4/§5 是**面**的覆盖（设备能不能用）；本篇是**契约与边界**面（参数语义、错误路径、跨语言、越界、分页），并关闭其 §9 遗留项 `dvc://ast_edit 相对路径未复测`
- **判定**: 两设备功能面 **全绿**（19/20 行为符合预期）；新增 1 条**错误静默**行为面（A1），非功能缺陷但属可用性/可诊断性缺口

---

## 0. 一句话

`ast_grep` / `ast_edit` 在 trimmed 安装位上功能完整（AST 级匹配、元变量、分页、多语言、目录递归、dryRun 默认安全、真写盘字节级正确）；主要风险不在功能而在**失败模式的静默**——0 命中、坏 pattern、路径不存在三者返回值不可区分。

## 1. 被测面口径

两个设备都用「对设备 URI 执行 `write`」的方式驱动，args 为 JSON 对象：

- `ast_grep`: `{patterns: string[], path?, offset?, limit?, includeMeta?}`
- `ast_edit`: `{ops: [{pat, out}], paths: string[], dryRun?}`

## 2. 夹具与不变量

夹具 `.scratch/ast-tool-test/`：`sample.ts`（TS，含 interface/function/箭头函数/legacy function）、`sample.py`（def/class/print）、`notes.md`、`data.json`。

| 文件 | 初始 md5 | 终态 md5 |
|---|---|---|
| `sample.ts` | `adfa9abc6ac2e1340cb8812a6b07e6ff` | `0af459a01c4eae5619950ca88ae3160f` |
| `sample.py` | `e75c4312a714c0e9dd4f05da0146fa05`（首改后） | `e75c4312a714c0e9dd4f05da0146fa05` |
| `notes.md` / `data.json` | — | 全程未变 |

**不变量结论**：dryRun 期盘面零改动；真写盘期仅目标文件变化；**零命中真写盘后 md5 与写前逐字节相同**（无空改/重排版）。

## 3. `ast_grep` 探针矩阵

| # | 探针 | 结果 |
|---|---|---|
| 1 | 5 pattern 同发（其一带故意不匹配项），`includeMeta:true` | ✅ 4 命中，`totalMatches:4`；`metaVariables` 正确（`NAME`/`MEMBERS`/`A`/`ARGS`/`BODY`） |
| 2 | 省略 `path` | ✅ 基准 = **进程 cwd**，扫 **313** 文件；`node_modules` / `.git` 被静默跳过 |
| 3 | 目录 + 正命中 pattern | ✅ 196 文件扫出 15 命中；`limit:3` 时 `limitReached:true` |
| 4 | `offset:3, limit:3` | ✅ 返回**第 4–6 条**，与第 1 页不相交（分页真实生效） |
| 5 | Python 语法 pattern（`def`/`print`） | ✅ 命中；**语言由扩展名推断** |
| 6 | `includeMeta` false / true | ✅ 两形态均正确 |
| 7 | 不存在的文件 | ⚠️ **不报错**，`filesSearched:0`、零命中 |
| 8 | 畸形 pattern | ⚠️ **不报错**，零命中，`filesSearched:1` |
| 9 | 缺 `patterns` | ✅ 硬报错：`` `patterns` must be a non-empty array of strings `` |

**目录扫描语义**（由 #2 #3 与 §5 交叉验证）：

- 目录遍历时 `.md` / `.json` **不进搜索集**（`better-dsh/src` 196 文件 vs 显式传单文件时把非代码文件也算 1）
- 显式传单个非代码文件时会计入 `filesSearched`（**计数语义在两种调用形态下不可比**，见 A4）
- `totalMatches` = 全量命中数；`limitReached:true` 只表示**返回页被截断**

## 4. `ast_edit` 探针矩阵

| # | 探针 | 结果 |
|---|---|---|
| 10 | **省略 `dryRun`** | ✅ 默认 `true`：`applied:false`，md5 未变（fail-safe 默认） |
| 11 | `dryRun:false`，2 条 op | ✅ 两条均落盘；md5 `adfa…`→`0af4…`，`cat` 复核 `console.log(msg)`→`logger.info(msg)`、`function legacyThing` → 箭头函数 |
| 12 | Python 文件 | ✅ `print(...)` → `sys.stderr.write(...)` |
| 13 | `paths` 传**目录** | ✅ 递归生效，`filesSearched:2` |
| 14 | `paths` 传**绝对路径（workspace 之外 `/tmp`）** | ✅ 直接写入成功；返回 `path` 为未规范化的 `../../../../tmp/…` |
| 15 | **重叠** op（两 pattern 命中同一节点） | ✅ 先入列者胜；**遮蔽的 op 静默消失**（源码有重叠守卫，见 A6） |
| 16 | 不存在的路径 | ⚠️ `applied:true`、零改动、**不报错** |
| 17 | 畸形 pattern | ⚠️ `applied:true`、零改动、**不报错** |
| 18 | 缺 `paths` | ✅ 硬报错：`` `paths` must be a non-empty array of strings `` |
| 19 | 真写盘但零命中 | ✅ 文件**逐字节未变**（无重排版/空改） |

## 5. 交叉验证（防假阴性）

对 #3 的**零命中**结果做了独立 ground truth 核对，防止把「工具坏了」误判成「确实没有」：

```bash
grep -rn 'console\.log' better-dsh/src | wc -l     # → 0（与 ast_grep 结论一致，非假阴性）
grep -rn 'export function' better-dsh/src/devices/ast | wc -l  # → 10
```

经验法则：**`totalMatches:0` 但 `filesSearched>0` 时，先 grep 证明目标是否存在，再检查 pattern 是否完整节点。**

## 6. 发现清单

| ID | 严重度 | 面 | 现象 | 建议 |
|---|---|---|---|---|
| **A1** | 中（可诊断性） | 两者 | **不完整 AST 节点 pattern 静默零命中**。见 §7 根因分析 | 把 `Multiple AST nodes are detected` 透出为 `unavailable`/`patternError` 字段，而非回落空结果 |
| **A2** | 低（语义） | `ast_edit` | `applied` = 「本次不是 dryRun」，**不等于「有文件被改」**：#16/#17 零改动仍回 `applied:true` | 改名或补 `changed:boolean`；判定用 `filesTouched`/`totalReplacements` |
| **A3** | 中（可诊断性） | 两者 | **三类失败不可区分**：真实零命中 / 坏 pattern / 路径不存在，返回值形状一致 | 至少区分「路径不存在」（#7 #16 已有 `filesSearched:0` 可作信号，但未标错） |
| **A4** | 低（语义） | `ast_grep` | `filesSearched` 两形态不可比：目录遍历跳过非代码文件，显式传单文件却计入 | help 里明确计数口径 |
| **A5** | 中（安全面） | `ast_edit` | **无 workspace 边界**：绝对路径可写 workspace 之外（#14 `/tmp` 实测成功），且返回路径未规范化 | 明确「设备无沙箱，边界由 approval/policy 层负责」；或规范化显示路径 |
| **A6** | 观察（正面） | `ast_edit` | 重叠编辑有**显式守卫**（`src/devices/ast/engine/edit.ts` 内按 start 升序线性扫描 + `overlapping` 计数），先入列 pattern 胜——**非未定义行为**；但该计数**未出现在设备返回体中**，故从 API 看仍表现为静默 | 把 `overlapping` 透出到返回值 |

## 7. A1 根因分析（不完整节点 pattern）

**触发**：`{"patterns":["export function $NAME($$$ARGS)"],"path":"better-dsh/src/devices/ast"}` → `totalMatches:0`、`filesSearched:11`。

**根因（代码路径排除法）**：`src/devices/ast/engine/match.ts` 中 `findInSource` 的 `root.findAll(pattern)` 外包了一层 catch：

```ts
} catch (error) {
  if (error instanceof Error && error.message.includes(MULTI_NODE)) return { matches: [], unavailable: false }
  throw error
}
```

`MULTI_NODE = 'Multiple AST nodes are detected'`（同文件 :13）。该 catch 是**唯一**回落为空的分支，其余错误一律 rethrow（设备层会显式报错，如 #9/#18 所见）。既然 #A1 与 #17 都没有报错、只回空结果，**只能**是命中该分支：pattern 只写了签名（缺函数体），不是完整 AST 节点，ast-grep 抛 `MULTI_NODE` 后被吞掉并伪装成「无命中」。同族处理见 `engine/edit.ts:55`（`continue` 跳过）。

**对照实验（同目录，同一设备）**：

| pattern | 结果 |
|---|---|
| `export function $NAME($$$ARGS)`（用户处方，不完整节点） | `totalMatches: 0`（静默） |
| `export function $NAME($$$ARGS) { $$$BODY }` 等三条完整节点 | **`totalMatches: 13` / `filesWithMatches: 8`** |

**规避**：pattern 必须写成**完整 AST 节点**；0 命中时先按 §5 交叉验证。

## 8. 相对路径基准（前序 F1 复验）

前序报告 F1 记录：相对 `path` 基准 = harness 进程 cwd，`"better-dsh/src"` 直接 `Path not found`。该问题已在 `2026-10-03-physical-import与llm-completion-ast相对路径修复实测报告.md` §三 修复（基准改为会话 workspace）。

**本轮复验（trimmed 安装位 0.2.5-c）**：`path:"better-dsh/src"`、`path:".scratch/ast-tool-test/..."` 等**相对路径全部直接可用**，扫 196 / 1 文件均符合 workspace 基准预期；`paths` 侧同样通过。**F1 判定：已修复，本轮无回归。** 前序 §9 遗留项「`dvc://ast_edit` 相对路径未复测」**关闭**。

## 9. 未覆盖 / 遗留

- 未测 `.tsx/.jsx/.go/.rs` 等其余 grammar（仅验 TS + Python 两语言）
- 未测 `include`/`glob` 过滤与 `maxFiles`(默认 1000) 上限边界
- 未测 `parseErrors[]` 路径（未构造语法错误文件）
- 未测超大文件/超多文件下的性能与截断行为
- **未改任何源码**：本篇只记录行为面；A1/A2/A3/A5/A6 若要收，属 `better-dsh/` 源码变更，须走 build → rig 实测 → 报告 → 发布的老闸门

## 10. 复现

```bash
# 夹具
mkdir -p .scratch/ast-tool-test && cat > .scratch/ast-tool-test/sample.ts <<'EOF'
export function describeProbe(cfg: { name: string }): string {
  console.log(cfg.name)
  return cfg.name
}
function legacyThing(a, b) { return a + b }
EOF

# A1 对照：不完整节点 vs 完整节点（在任意 4998/4999 会话内对 dvc:// 设备 write）
# ① {"patterns":["export function $NAME($$$ARGS)"],"path":"better-dsh/src/devices/ast"}          → totalMatches:0（静默）
# ② {"patterns":["export function $NAME($$$ARGS) { $$$BODY }"],"path":"better-dsh/src/devices/ast"} → totalMatches:13

# dryRun 默认安全复验：省略 dryRun → applied:false，随后 md5sum 应不变
# {"ops":[{"pat":"console.log($A)","out":"logger.info($A)"}],"paths":[".scratch/ast-tool-test/sample.ts"]}
```

---

**发布闸状态**：本篇为**观察性实测**，不含 `better-dsh` 版本变更；`npm publish` 不在范围内（按根 AGENTS.md 〇节，仍需 user 单次明确放行）。
