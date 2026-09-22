# dashr bun port — 设计规格（M1）

状态：待 user 审阅 ｜ 路径：`dashr/docs/specs/dashr-bun-port/spec.md` ｜ 日期：2026-09-22
决策记录：本 spec 的四个支柱决策由 user 于 2026-09-22 逐项拍板（见 §2）。

---

## 0. 背景与定性

dashr 对 dsh 做 **bun port**：编译方法（tsc/tsdown + node 运行时 → bun `--compile` 单文件）与产物形态（node_modules 树 → 单二进制）都变了。这是移植，不是打包参数。

- **port ≠ shim 堆**。前期 PoC 阶段的产物是贴在 pristine upstream 上的补丁集（桥/守卫/替身），部署时仍依赖磁盘树（anchor/tree/③ 层/client halves 走磁盘），在 dev2 实测中暴露为"伪单文件"。本设计推倒该形态。
- **distro 定位推翻"不改上游源码"纪律**。该纪律属于 better-dsh（插件：用户不会为装插件改宿主源码）；dashr 是发行版，拥有发行版自己的代码，可整模块重写。规则随定位可证伪（user 裁决 2026-09-22）。

## 1. 产物硬契约（M1）

**Stock 产品 = 一个可执行文件。**

凡"开机 + 伺服自带 web UI"所需，全部在产物内。磁盘上只允许两类：
1. 用户数据（`DSH_HOME`：sessions、settings、workspaces 注册表、storages、.env/credentials、logs）
2. （M2 起）用户事后安装的插件

推论：anchor/、tree/、③ 层链接、随行 dist 目录——全部消灭。部署单元 = 二进制 + 空 `DSH_HOME`（+`.env`）。

## 2. 四个支柱决策（user 已拍板）

| # | 决策 | 选择 | 落点 |
|---|---|---|---|
| D1 | port 代码住哪 | **port 仓库**：`dashr/port/` 独立 git 仓库，fork 自 `dsh-v0.1.6-alpha.2`，port commit 为一等公民（可整文件重写），upstream 为 remote，升级 = merge `dsh-v*` tag | §6 |
| D2 | 产物单-file 程度 | **全内嵌**：前端 dist（~18MB）也进二进制；client halves 按"cordis 插件模块"对待（§4 R3） | §3/§4 |
| D3 | 组合归属 | **dashr 自有组合** `dashr.cordis.yml`：行级增删、逐行注理由；内嵌；anchor 机制整体消灭 | §4 R4 |
| D4 | 里程碑 | **M1 = 纯单文件 stock**（无事后插件）；loader 桥只做 registry 层，接口预留 M2 | §5/§8 |

## 3. 资产三分法（判定规则，成文）

| 通道 | 内容 | 机制 | 运行时寻址 |
|---|---|---|---|
| **bundled** | 宿主面全部 JS：冻结宇宙（§4 组合行集）+ zod 等纯 JS 第三方依赖 | 编译器随 import 图打进（registry 内嵌） | loader 桥 registry 命中 |
| **asset** | client halves（每包 `lib/client.js`+web 资产，按包相对路径）、前端 dist、`dashr.cordis.yml`、presets、badge 资产 | `--asset`（保持相对路径） | `/$bunfs/root/<相对路径>`，资产根 seam 统一寻址 |
| **disk** | 用户数据（DSH_HOME 全部） | 运行时 fs | 无产物耦合 |

判定规则一句话：**boot 与 stock UI 自足性 → 产物内；用户产生/用户安装 → 磁盘。**

## 4. 模块清单：新建 / 重写 / 保留 / 删行

### N. port 新建模块（dashr/port 内，自有代码）

- **N1 registry 生成器**（进化自现 `gen-bun-registry.ts`）：输入 `dashr.cordis.yml`，产出（a）冻结宇宙 registry（行集 ∪ 传递闭包 + `./typert` 等子路径行）；（b）资产清单（client halves/dist/yml/presets 的 `--asset` 集结脚本）。
- **N2 loader 桥 M1 版**（重写现 bridge，非搬运）：`ctx.loader.internal` 的 registry 层实现；M1 无磁盘 walk 层；接口显式预留 M2 插件装载层。
- **N3 client 资产伺服 seam**：client-modules 的包定位与静态伺服改读 `/$bunfs` 资产根（client halves 是 cordis 模块：受 port 纪律管辖、按模块内嵌、按 module-table URL 形状伺服）。

### R. 上游模块重写（port commit，消灭磁盘耦合；前期已验证语义）

- **R1** `profile.ts` `resolveBundleDir`/`loadProfileDirectory` → 读内嵌组合表（N1 产物），删除 node_modules walk 与 anchor 依赖。
- **R2** `profile-resolution/resolver.ts` → 删除 Node-internals addon 路径；generation 表替换为 registry 成员判定。
- **R3** `typert-loader` 子路径加载 → registry 覆盖 `./typert` 行（zod 随编译器自然打入，磁盘 zod 消失）。
- **R4** `lease.ts` flock → 单进程租约（上游 webworker 单进程替身先例升格为 port 实现）。
- **R5** `dsh-scope` kScope → 进程单例 Symbol（`globalThis` 铸造；字符串键不可用——cordis 将字符串属性路由进 inject 注册表，已实证）。
- **R6** `agent-presets`/`skill-badge` 资产锚 → 资产根（`/$bunfs`），env 兜底删除或仅诊断用。
- **R7** 前端 dist 解析 → 编译态默认 `/$bunfs`，`DSH_WEB_FRONTEND_DIR` 降级为诊断覆盖。

### K. 原样保留

agent-loop、tools 家族、LLM 适配、session-persistence（flock 修复后）、webserver 核心、client 包本体（只动组合与伺服，不动实现）。

### D. 组合行账本（`dashr.cordis.yml` 首版删行，逐行注理由；merge tag 时冲突即复审）

初版删除（理由）：
- Windows-only 行：`dsh-pwsh-sandbox`、`dsh-tool-pwsh`（M1 目标 linux-x64；win 行待跨平台期复审）
- `dsh-host-directory-picker-browse`（实测不在冻结宇宙，装载即报错且不用）
- 终端线（`dsh-api-terminal-controller`、`@xterm/headless` 消费者）：M1 不含终端特性（user 前期裁定的 lean 集）；复审窗口在 M2

行账本格式：每行 `# dashr: keep|drop <理由>`，merge 冲突逐行裁决，禁止静默继承上游新行。

### S. 随行转正

本机 standing build patches（tsdown `resolveRepositoryRoot`、pnpm storeDir/verifyDeps/zeromq、apps/web preact 五件套）转为 port commit，注明来源与理由。

## 5. 构建与发布

- 构建入口在 port 仓库：clean checkout → N1 codegen → `pnpm run build` → `bun build --compile`（entry = `apps/cli/lib/bin.js`，asset 集结按 N1 清单）→ 产物 `dashr-<ver>-<os>-<arch>` → 填充 npm 骨架（umbrella `dashr` + `@dashr/dashr-<os>-<arch>` 平台包，esbuild/turbo 同款 os/cpu 门）。
- 发布通道：npm（`npm i -g dashr` / `bun i -g dashr`，同读 npm registry）；GitHub Releases 为并行渠道。
- **发布三闸**（第一人称实测 → 报告 → user 放行）不豁免（根 AGENTS.md §〇）。

## 6. 上游同步

- port 仓库 remote `upstream` → 本地 checkout `upstream/deepseek-harness`（保持 pristine tag 检出，仅作 remote 源）。
- 升级 = `git merge dsh-v<新tag>`；预期冲突面 = 组合行账本（§4 D）+ 重写文件（§4 R）；冲突解决即审阅记录。
- port 仓库继承上游测试纪律：port commit 同步更新受影响测试；M1 验收脚本（§7）进 port 仓库 CI 面。

## 7. M1 验收（自动化，干净环境）

在无 node 的干净 VM/容器（如 dev2 或 incus）：

1. 产物目录**只含一个可执行文件**（`find` 断言，无 tree/anchor/dist）
2. 空 `DSH_HOME` + `.env` → `./dashr web` boot，token URL 打印
3. 经域名（caddy）shell 200；完整对话（prompt → 回复渲染，无 toast）
4. `session.v3.jsonl.zstd` 落盘且重启服务后会在话列表存活
5. 产物体积预算 ~110–130MB（含 dist + client halves），超限需说明

## 8. M2 展望（本 spec 不展开，仅约束接口）

事后插件（用户 `npm i` 进 DSH_HOME）经 N2 预留的插件装载层（运行时打包 + 身份纪律）；better-dsh 组件以插件形态回归。M2 单独 spec。

## 9. fresh-start 账本（对现有资产的处置）

**取**：三个根因修复的语义（R4/R5/R6）；registry 生成器逻辑（N1 底稿）；桥 v1 作 N2 重写参照；dev2 的 DNS/caddy/systemd 部署配方；瞬态 toast 捕获法（诊断方法论）。
**弃**：patch 系列作为主机制（`dashr/src/seams/`）；anchor/tree/③ 部署形态；现有二进制与 `.scratch` 试验场产物。
**过渡**：dev2 继续跑旧产物当试验台；port M1 出厂后整目录替换（DNS/caddy 复用）。

## 10. 明确推迟项（非占位，有归属）

- 跨平台产物（darwin/arm64/win）：M1 后，跨平台期复审 Windows-only 删行。
- 诊断日志体系：port 内以 `DASHR_DEBUG` 门控的正式日志位替代前期 console.error 埋点（M1 实现期内做，不单独立项）。
- pnpm workspace 在 port 仓库内的去留（能否直用 bun install 构建）：实施期试，失败不阻塞（回退 pnpm）。
