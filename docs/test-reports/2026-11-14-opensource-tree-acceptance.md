# 开源树验收报告（Task 2：历史重写与转公开前总检）

- 日期：2026-11-14（Asia/Hong_Kong）
- 范围：`pgmi-builds/super-dsh` 全仓（637+ commits、64 tags），为 filter-repo 历史重写与转 public 前的树级总检。
- 依据计划：`docs/superpowers/plans/2026-11-14-opensource-and-market-migration.md` Task 2（⛔ 放行点 1 前置）。
- 本轮 commits：`23dce9e`（Task 1 主体）、`0c783a7`（AGENTS/脚本反转）、`261e526`（token/LAN 脱敏 + credits）。

## 1. 扫描工具与口径（Step 2.1）

| 工具 | 口径 | 结果 |
| --- | --- | --- |
| gitleaks 8.30.1（临时下载单二进制） | **干净 clone tracked 面**（2060 文件 / 27.09MB） | 30 命中，全部 `generic-api-key` 规则 |
| gitleaks 8.30.1 | 工作树全量 `--no-git` | 1777 命中 / 3.26GB —— **不可用口径**：混入 node_modules、`.tests` 运行 home、upstream 等本机未跟踪内容；本报告一律以干净 clone 口径为准 |
| `scripts/check-leaks.sh --all`（仓内守门） | tracked 面（symlink-aware） | 仅剩 1 已知良性豁免：`better-dsh/test/remote/ssh-targets.spec.ts:81` 合成私钥头 fixture（`PRIVATE KEY` 文件头 + 字面量 'secret' 内容，第 81 行） |

**30 命中分诊**：

| 类别 | 数量 | 判定 | 处置 |
| --- | --- | --- | --- |
| 测试报告内 `?token=` 令牌值 | 23 处 / 16 文件 | **真问题**：至少一枚注明 seed 持久、旧 cookie 对在役 4999 线仍有效；公开 = 送出 WAN 可达测试线访问令牌 | 全量 `token=<redacted>`（`261e526`） |
| LAN 网段 `192.168[.]31.x`（.130×139、.7×3、.90、.0/24） | 144 处 | **真问题**：本机真实 LAN 拓扑 | → `192.0.2.x`（RFC 5737）（`261e526`） |
| `deployment-proof.json` SHA-256 完整性哈希 | 5 | 良性（熵形态误报） | 保留 |
| 带端口测试 URL（`api.z.ai:80` 等） | 5 | 良性（fixture 字面量） | 保留 |

上述两类真问题的模式已入 `scripts/leak-patterns.local.txt`（守门实测拦截生效）并列入 filter-repo `--replace-text`（计划 Step 3.2）。

## 2. 附加手扫（Step 2.2）

- **作者身份**：`superd <superd@local>`（381 commits，机器生成身份）与 `mark1kwok <mark1kwok@users.noreply.github.com>`（258，GitHub noreply 隐私形态）。**无需脱敏**；可选：filter-repo mailmap 将 `superd@local` 统一为 mark1kwok noreply（美观项，非安全项）。
- **`/home/u1/` 路径**：tracked 文本 1144 处 + Rust helper 二进制 3 枚内嵌构建路径。用户名 `u1` 形态已近匿名；建议**接受现状**（filter-repo 全史替换 1144 处收益低）；二进制如需彻底清理可选 `--remap-path-prefix` 重建（非阻断）。
- **`ssh://` / `~/.ssh` / `/home/` 其他形态**：命中均在发货文档示例与 `src/remote/` 功能代码（读取本机 ssh config 属产品功能），正常。
- **凭据类**：npm token 仓外受控（`AGENTS.local.md` §1），tracked 面零命中。

## 3. Licenses / Credits（user 2026-11-14 裁决）

- 根 `LICENSE`、`super-dsh/LICENSE` → `Copyright (c) 2026 pgmi-builds and contributors`。
- `better-dsh/LICENSE` **保留血统署名**（RimuruW and Yugimob, original pi-hashline-edit / pi-hashline-edit-pro）——DASHR 工具血统（LSP/AST 工具链）归属 better-dash。
- 新增根 `THIRD_PARTY_NOTICES.md`：上游 DeepSeek Harness（MIT，宿主/参考）、better-dsh vendored MIT 包（schemastery/cosmokit/ast-grep wasm/tree-sitter/lumis 语法）、嵌入的 `@earendil-works/pi-coding-agent`（MIT，lockfile 固定 bundled delivery）、运行时自取的 foreign agent（codex/omp/claude/hermes/agy，不随包分发）。

## 4. 干净 clone 构建与 4999 冒烟（Step 2.3）

### 4.1 干净 clone 构建（clone @ `14f4ec6`，与公开面同构）

| 步骤 | 结果 |
| --- | --- |
| `npm --prefix better-dsh ci` | ✓（install-scripts 仅警告） |
| `npm --prefix super-dsh ci` | ✓（213 packages / 2s，lockfile 皆可从 registry 解析） |
| `node super-dsh/scripts/pack.mjs` — better-dsh | ✓ **构建成功**：`better-dsh-0.3.5.tgz`（6.19MB），含 docs payload（恢复 tracked 的 dsh-dev-skill 镜像） |
| `node super-dsh/scripts/pack.mjs` — super-dsh hub | ✗ tsc 失败：`Cannot find module '@deepseek-ai/cordis' / 'dsh-agent' / 'dsh-home-paths' / 'dsh-app-boot'`（类型依赖未声明，见下） |

**过程修复（`14f4ec6`）**：首轮 clone 构建即失败于 `docs/80_upstream…/dsh-dev-skill/skill/SKILL.md` ENOENT——Task 1 将 80_upstream 整体出库，误伤了 better-dsh 发包 docs payload 的 load-bearing 镜像子集（docs-packaging-trim 裁决集）。修正为**只出库 hermes-dev-skill（77MB 镜像 + ClawHub 抓取 + crawl 工具）**，dsh-dev-skill（11MB，上游 MIT 文档，随包发布）恢复 tracked；次轮构建 better-dsh 即通过。

**super-dsh hub 构建缺口的根因与补救（转 public 前待办）**：hub 的类型依赖在 dev 机经 farm symlink（`super-dsh/node_modules/@deepseek-ai` → `upstream/` checkout）解析，`super-dsh/package.json` 未声明任何依赖 → 公开 clone 无法解析。Registry 实查四个依赖均已发布：`@deepseek-ai/cordis@4.1.0`、`dsh-agent@0.1.0-rc.6`、`dsh-home-paths@0.0.1-rc.3`、`dsh-app-boot@0.1.0-rc.6` → **补救可行**：声明 build-only devDependencies（npm pack 不携带 devDeps，发布面零影响；dev 机 farm 由 `sync-dsh-farm.mjs` 安装后重指，语义不变）。备选：README 记 farm 前置。按与当前上游基线（0.2.2-rc.1 工作区）的 API 兼容性核对后落版本。

### 4.2 4999 整包线冒烟（dev 树 pack）

| 项 | 结果 |
| --- | --- |
| dev 树 `npm run pack` | ✓ fresh pair：`better-dsh@0.3.5`（sha256 `85ea5ac2…`）、`super-dsh@0.3.5`（sha256 `6b2465d2…`），pair 独立性核验过（Super 无 Better 依赖/payload） |
| `start-4999.sh` 整包重启 | ✓ file: tarball 装机（pnpm 4s）、provider seeds 写入、`superd-4999-test` + LAN relay unit 全 active、共用 auth seed 持久（cookie 不失效） |
| 门检 | ✓ 根路径 200；匿名 API 401；unit active |

**过程中发现并当场修复的功能性回归**：Task 1 的域名批量替换把 launcher（`super-dsh/test/start-4999.sh`）的 `--trusted-host` 默认值也换成了占位域——WAN 腿（真实 Caddy 域入口）会过不了 trust fence。修复 = launcher 参数化（`SUPERD_TEST_WAN_HOST` env，默认占位域）+ 仓根 untracked `.superd-test-local.sh`（真实值注入，gitignore）+ 回显跟随 `PUBLIC_URL`；重跑后 journal 证实真实域进入 trusted-host、门检全绿、launcher 回显真实 WAN URL。与 AGENTS.md/sync-agents 同一款「tracked 骨架 + untracked 本机值」模式。

### 4.3 小结

| 验收面 | 状态 |
| --- | --- |
| 公开面泄露（gitleaks + 守门 + 手扫） | ✓ 剩余命中均良性（哈希/端口 URL/合成 fixture），守门 --all 仅 1 已知豁免 |
| 公开面可构建 — better-dsh | ✓ clone 构建成功（含 docs payload） |
| 公开面可构建 — super-dsh hub | ✗ farm 类型依赖未声明（补救可行，见 4.1；**转 public 前待办**） |
| 4999 交付形态行为 | ✓ fresh pair 装机 + 门检全绿 + WAN trust 修复实证 |

## 5. 结论与放行请求

**Task 2 完成**：公开面泄露清零（两类真泄露已修复并入守门与 filter-repo 词表）、better-dsh clone 可构建、4999 交付形态行为全绿。**请求 user 放行 Task 3（⛔ 放行点 1）：filter-repo 历史重写（私有态）→ 全史验证 → 转 public（放行点 2/3）。**

转 public 前待办（放行 Task 3 前或并行）：
1. **super-dsh 构建依赖声明**（必做）：四个 `@deepseek-ai/*` 类型依赖加为 devDependencies（registry 版本已核实存在；npm pack 不携带 devDeps，发布面零影响；dev 机 farm 照旧覆盖）；完成后 README 补 build 章节。
2. 可选：filter-repo mailmap 统一作者身份（`superd@local` → mark1kwok noreply）；helper 二进制 `--remap-path-prefix` 重建（去 `/home/u1` 构建路径）。
3. 接受现状：`/home/u1` 文本路径（1144 处，形态近匿名）、devN 主机名。
