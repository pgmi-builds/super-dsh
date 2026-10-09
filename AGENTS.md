# Super D (superd) — Agent 开发总纲

本文件保留项目定位、开发原则与操作红线；机制细节按需披露，不继续把命令、版本流水账和排障记录堆入根总纲。词汇表见 `CONTEXT.md`，设计正本见 `docs/`。

---

## 〇、Development Operation Contract — 红线

0. **生态即产品**：依赖、解析与交付通道也是产品的一部分。
   - a. 验收必须走交付形态、上目标环境：本地 4999 整包 tarball 线 + dev3 目标机实装；源码树跑通不能代替消费者验收。
   - b. 开发脚手架不得以交付物没有的机制掩盖缺陷；类型与运行时来源一致，禁止假类型存根遮丑。
   - c. 业务代码不迁就测试流程；环境隔离由 launcher / 夹具执行，不以业务守卫限制正常消费者。
1. **npm 发布顺序不可省略**：
   - a. 真实运行时第一人称验收通过；构建、单测和进程存活不能替代行为验收。
   - b. 报告落 `docs/test-reports/`。
   - c. user 对本次发布明确放行，授权不沿用到下次。
   - d. 迭代经 tarball 通道，每轮换字母后缀；补丁号与新 minor 留给真实 feature 发布。npm 不是 git，registry `latest` 保持最近一次获准发布。**2026-10-06 user 澄清**：本条讲的是 registry **不可删除、不可回滚**（npm 发了即定版，与 GitHub tag 可删可逆相对）；registry 版本号形态（含字母后缀）由 user 发布指令逐次指定，不得由本条推断出「字母版本不进 registry」之类的限制。
2. 验收覆盖实际改动行为；Web 测试线保持运行、提供访问 URL，供 user 亲手验收后收尾。
3. 未经 user 单次明确同意不得 `npm publish`。
4. GitHub commit / tag / push 不抢在验收、报告和放行之前定版。
5. **上游源码零修改**：除已有明确授权的三个本地构建补丁外，改动走声明式 patch / 自有插件；依赖按现有 exact-pin 契约管理，宿主 optional peer 兼容范围沿用专门裁决。vendor 保护机制落地后强制启用。
6. **生产隔离**：不触碰 `~/.dsh`、`~/.superd` 或生产 3080 / 3081；生产重启、关停及 live Caddyfile 修改必须有 user 明确授权，不能用延时等手段绕过。

---

## 一、这是什么（定位速查）

- **superd = 独立 App（最小 cordis 宿主）**，不是 dsh 的插件/profile/fork。桥接层：把本机与远端已有 Agent 运行时映射到 DSH Web UI 可消费的数据面；**自己不跑 agent、不存原始会话**（唯一持久状态 = pairing 表）。
- 交付结构：**单一 pack `super-dsh`**（unscoped npm 包 = dsh plugin market 名；内含 `superd-hub` + 各 `agent-<runtime>` 兄弟目录；composite patch 自指 subpath `super-dsh/hub` / `super-dsh/agents/<label>` / `super-dsh/join`，另加一条裸名行 `super-dsh` 承载 client half）。per-runtime 对偶包命名：`@pgmi-builds/agent-*`（数据面）+ `@pgmi-builds/agent-ui-*`（呈现面）。根 `package.json` 是 private 编排入口，统一版本、构建与测试；两个发布包是 `better-dsh` 与 `super-dsh`，版本同步，后者运行时经原生 Plugin Manager 安装前者（自身版本精确请求优先，依次回退 latest、裸包名），无 npm 依赖边。
- 命名纪律：App 名 Super Dash / 品牌 Super D / 代码与 CLI `superd`（无空格连字符）；上游 UI 内 DSH 字样原样保留（品牌原则：仅自研代码用 Super D 品牌）。
- 设计正本：`docs/00-blueprint.md`（v0.4a）+ `docs/01-component-boundaries.md`（v0.3）+ `docs/adr/0001–0007` + `CONTEXT.md` 词汇表。研究镜像 `docs/01–05` 簇保留历史只读；合仓资料导航见 `docs/README.md`，原 Better 根文件保留来源。

---

## 二、上游基线与对齐

- 开发参考来自 `upstream/deepseek-harness` 源码，基线以物理 checkout 与本轮报告确认；版本快照和已授权的三个构建补丁按需见 [开发环境记录](docs/dev-test-environment-notes.md)。
- 对齐必须同时覆盖 dev3 目标机实装与本仓同版本源码；检查相关官方接口及破坏面，清理旧产物后重建，记录结论。
- 依赖与运行时保持同源、宿主模块保持单实例；不能靠假类型、重复模块或开发专用链接掩盖交付缺陷。
- 每个受影响 runtime 验证 create、prompt、resume，不能用 boot / mount 探针替代会话行为验收。详细流程见 [通用指南](docs/07-cordis-dsh-dev-test-guides.md)。

---

## 三、开发与测试原则

- **代码逻辑与语义工程并重**：DSH 插件与 Agent Harness 的交付物包含 Code Logic（硬编码逻辑）和 Semantic Engineering（语义工程），必须一起设计、实现与验收；不能仅凭传统编程经验把语义当作附属文案。
- **Surface 就是产品**：明确哪些内容、在什么时机进入消费工具的模型上下文；tool catalog、工具描述、教学指引、错误信息和结果中的恢复提示都是交付范围。Inline comment 面向人类或开发 Agent，不能代替运行时 Surface；模型可见内容要通过实际运行时核验。
- **Agent 对代码库承担 ownership**：负责实现选择、依赖链与副作用；把 user 当 supervisor / reviewer，以目标、结论、用户可见影响和必要决策汇报，不默认其熟悉内部字段、Schema 或调用链。内部细节由 Agent 查清并消化，需要解释时先说明与目标的关系。
- **LSP 与 AST 工具必须实际使用**：开发前用 LSP 查定义、引用和调用关系，用 AST（如 ast-grep）核实结构与匹配范围，追踪上游已有 CLI、配置和扩展入口，再决定实现。优先官方机制；环境变量绕行或 monkey patch 须有官方入口不足的证据；工具不可用时明确缺口，不能声称已核实。
- **验证按真实交付路径进行**：遵守生产隔离与发布红线，通过整包 tarball 线和 dev3 实装验证代码行为及模型看到的 Surface；复用测试 home、保留用户数据，测试口接管、认证和启动交给现行 launcher，不手搓临时替代流程。
- **Better Dash 合仓开发与交付（2026-10-09 user 再修订）**：本仓 `better-dsh/` 与 `super-dsh/` 是唯一现役源码；两个同步版本 npm 包、独立原生 DSH bundle。Super 不声明 Better 的 dependency/optional/peer，不携带其文件；运行时调用宿主 `pluginManager.installBundle`，先请求自身已安装版本对应的 exact Better，失败依次请求 latest、裸包名。首次自动安装与 Hub Settings 显式重装复用同一操作；既有安装、关闭和卸载选择保留，不在 Super 升级时强行重装。profile companion 状态位于 `$DSH_HOME/superd/companions/`，迁移旧 receipt 后清理自身旧文件。Super 不实现第二套 npm/pnpm/store。Better 欢迎策略使用官方 `settings.onboarding`，不替换 WebServer/HMR；测试监听由 launcher 的 loopback 与 LAN relay 管。机制见 docs/07 §8。
- **版本与资料**：`npm run version:release -- <version>` 同步根、两包版本及锁文件元数据；测试轮使用同步字母版本。共享资料归根 `docs/`，`docs/package-catalog.json` 明确 Better Dash 发包副本，不能无差别扫入 Hub 文档。历史根文件冲突存 `docs/legacy/better-dash/`。
- **细节按需披露**：通用开发与测试机制见 [docs/07](docs/07-cordis-dsh-dev-test-guides.md)，整包与 adapter 规则见 [super-dsh/AGENTS.md](super-dsh/AGENTS.md)，启动入口为 `super-dsh/test/start-4999.sh`，历史记录见 [开发环境记录](docs/dev-test-environment-notes.md)；局部守则放对应子目录，根总纲不收纳操作流水账。

---

## 四、规划与执行工作流（Superpowers）

- 任务开始先读 `.agents/skills/superpowers/using-superpowers/SKILL.md`，按任务加载适用技能；优先级为 user 指令 > 本仓 AGENTS.md > 技能 > 默认行为。
- 规格写入 `docs/specs/<topic>/spec.md`；计划写入 `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`。设计裁决进入蓝图 / ADR，计划内接口决策记入对应任务。

---

## 五、仓库导航

- `super-dsh/` 是整包主线，含 hub、runtime adapter、可选 SDK 及测试入口；局部规则见 `super-dsh/AGENTS.md`。
- `better-dsh/` 是独立原生 DSH 工具包，局部规则见其 `AGENTS.md`；`dev-webmcp/` 是仅测试使用的配套。联合测试入口仍为 `super-dsh/test/start-4999.sh`。
- `archive/` 是冻结存档，`.tests/` 是运行 home，`upstream/` 是源码参考基座，`docs/` 是设计、计划与报告正本；动态状态以当前文件和运行现场核实，不维护根文档快照。

---

## 六、嵌套 AGENTS.md 约定（Nested AGENTS.md Convention）

子目录可放置自己的 `AGENTS.md` 承载局部规则；本节约定其组织、作用范围与优先级。

- **嵌套（Nesting）**：支持层层嵌套，但**每一层并非都必须有**——只在有实质内容的子目录放置（源码子项目，如 `super-dsh/`、`archive/multi-agent/dsh-multi-agent-registry/`）。根目录本文件是总纲（base），子目录只补充/覆盖本目录相关规则；中间层级无 `AGENTS.md` 则跳过，沿用最近上层。
- **作用范围（Scope）**：每个 `AGENTS.md` 只管辖其所在目录及所有子目录（subtree），不约束兄弟目录、不反向影响上层。
- **优先级（Precedence）**：对某文件，生效规则 = 从根到该文件路径上所有 `AGENTS.md` 的叠加；冲突时离文件最近的胜出（nearest wins）；用户在会话中显式给出的指令优先级高于任何 `AGENTS.md`。
- **定位写法（不写层级号）**：子目录 `AGENTS.md` 声明自身路径并指向上一层（无中间层则直指根目录），不写绝对层级号；后续更深的子模块若有本地需要，由其自行创建。

---

## 七、插件开发机制速查

完整机制见 [通用开发测试指南](docs/07-cordis-dsh-dev-test-guides.md)，这里只保留原则：

- patch 按 id **整行重述**，不是深合并；插件顺序由 `inject` 决定。
- 共享能力放 host composition，单 session 贡献放 agent preset；preset 自有服务的提供者与消费者置于同一 `isolate` realm。
- 被组合替换的服务用 `inject`；宿主 API 用 `import` + optional peer；自带真依赖用 `import` + `dependencies`。
- 浏览器 module table 同 id、Cordis 同 scope 同名 service 都是硬冲突；官方 UI 遮蔽遵守 slot priority 规则。
- UI 只寻址官方服务、语义属性和控件，第三方 DOM 不作状态输入；客户端类型检查、外部化与模块单实例均属交付契约。
- 热插拔遵循 Comply or Explain：先核实官方热更新能力与实际生效窗口；确需重启时解释原因并复验。
