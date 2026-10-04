# Claude Adapter：SDK runtime 出包 + Multi-Provider 验收报告（0.1.10-a → 0.1.10-e）

- 日期：2026-10-04
- 范围：`super-dsh/agent-claude/`（sdk-runtime 自取 + provider 五模块 + 路由架构）、`super-dsh/package.json`、`super-dsh/superd-hub/`（面板映射）、`super-dsh/test/`（种子）
- Spec：`docs/specs/claude-sdk-runtime-and-multi-provider/spec.md`；Plan：`docs/superpowers/plans/2026-10-04-claude-sdk-runtime-and-multi-provider-plan.md`
- 执行：subagent-driven（13 任务 TDD + 每任务评审 + 终审全分支评审 + 3 轮 scoped re-review）
- 结论：**4996 真 turn 验收通过（user 2026-10-04）**；dev3 实装 0.1.10-e 落位、boot 零错

## 1. 交付面（相对 0.1.10 基线）

| 面 | 内容 |
|---|---|
| SDK 依赖出包 | `@anthropic-ai/claude-agent-sdk` 从 agent-claude 与主 pack dependencies 双摘（源面/产物面契约测试钉死）；首次真 prompt 自取进 `<worldHome>/sdk-runtime/`（marker/lock/error-log）；双模式：**host-binary**（默认，`--omit=optional`，~5MB JS + 宿主 CLI）/ **bundled-payload**（无本地 binary 时含平台载荷） |
| Multi-Provider | codex 五模块同构（`claude-providers/native-config/route/launch/provider-gateway`）：`<worldHome>/claude-providers.json` 0600 正本、原生 settings.json env 段只读 fold-in（URL 去重 + 墓碑）、route 优先级 pending→logged→preferred→fallback、env+`--settings` 注入、RPC `claudeProviders/get|save|remove`（key 只写不读） |
| 选择器分组 | codex route 架构：固定 `claude` route 载 observed/native 模型，**每 provider 一条 route** 载 curated 模型；面板增删实时 `routes.replace` |
| 切换语义 | provider = 轮间换子进程 + `resume` 同 session；model = `setModel` live |
| hub 面板 | `claude` 行展开 providers 面板（容错 claude 视图形状；顺手修了三个面板前缺陷：protocols 必填 / 4-path 必填 / 编辑丢 Bearer key） |
| 测试种子 | `test/seed-claude-providers.mjs` + start 脚本 hook：DeepSeek（api.deepseek.com/anthropic）+ GLM（api.z.ai/api/anthropic，ZAI_PLAN key） |

## 2. 关键裁决（控制器在案，全量见 SDD ledger）

1. **SDK 线维持主线**（user 2026-10-04，推翻同日早前"CLI 直连重写"方向）：实测 SDK JS 4.9MB 零 deps、206MB 载荷纯 optional 且 R5 后从不使用——"重依赖"前提不成立；CLI 直连降级为 fallback 知识（spec §7）。
2. **binary 优先 + 无 binary 才自取装包**（user）；`resolveClaudeBinary` 全落空返回 undefined（不回落裸名）。
3. **命名全线不动**（user：Claude 非 cloud，STT 纠正）：`agent-claude` / key `claude` / home `agents/claude` 零迁移。
4. F1（Critical，验收发现）：npm 无 package.json 锚时上溯祖先项目根 → "up to date" 假成功；修复 = 私有 package.json 锚 + 装后 entry 验证才写 marker（曾污染仓库根 package.json/lock/node_modules，已还原）。
5. F-A/F-B（真 turn 发现）：native settings env 按变量覆盖注入 → provider env 改走 `--settings`（命令行层级）；选择器分组 → codex 每-provider-route 架构镜像。
6. C2 教训入案：摘依赖前"零活体 import"预检必须覆盖 `require.resolve`/动态形态，且必须查 base 线报告既有结论（`@openai/codex` 是 codex 主路线要的，已恢复）。

## 3. 实测证据

### 本机（4996 pack 线，交付形态）

- 套件 **249/249**（含离线 `SUPERD_SDK_NPM=/nonexistent` 双跑）
- tarball 契约：`@anthropic` 条目 **0**；安装 manifest `@openai/codex: 0.154.0` 在位
- world home：providers store 0600 两条种子；sdk-runtime marker **host-binary**、树落地（无载荷目录）、`loadClaudeQuery` 可加载
- **user 真 turn（2026-10-04）**：DeepSeek 会话 prompt ✓ → GLM 会话（401 缺陷发现→修复→复测）✓ → 选择器按 provider 分组 ✓ → **测试通过**
- 重启续会话：roster/列表/replay 常态（多轮重启均绿）

### dev3（目标机实装，srv1637772）

- 通道：tarball scp → `~/.dsh/profiles/web` `corepack pnpm@10.33.2 add file:` → `systemctl --user restart dsh.service`（user 授权轮，a/b/c/d/e 五轮）
- 每轮 boot **0 world failed / ERR**；`agents/claude/` 全套自动落地；sdk-runtime **host-binary**（dev3 claude 2.1.202 命中）+ 树落地
- 安装 manifest 复核：零 `@anthropic`；`@openai/codex` pin 回归
- dev3 UI 真 turn 待 user 浏览器抽查（curl 侧 cookie-mint 未通，非产品问题）

## 4. 缺陷台账（发现→修复 commit）

| # | 级别 | 缺陷 | 修复 |
|---|---|---|---|
| F1 | Critical | npm 祖先根锚定假成功（marker 在树不在） | `8164c1b` 锚 + entry 验证 |
| C1 | Critical | curated models 无路径进选择器 | `e3bb8e3` adapter worldHome + 并目录 |
| C2 | Critical | 误摘 `@openai/codex`（codex 主路线） | `e3bb8e3` 恢复 pin |
| C3 | Critical | gateway 构造行被注释重写吞掉（行数平衡不可见） | `1cee0a5` 恢复 + mutation 验证接线 pin |
| F-B | 用户发现 | native settings env 按变量覆盖注入 → GLM 401 | `e950fee` provider env 走 `--settings` |
| F-A | 用户发现 | 选择器不按 provider 分组 | `e950fee` 每-provider route 架构 |
| L1 | Important | 旧形状会话 resume 静默回落 native | `92ede51` routeOf 内 legacy 拆分 |

## 5. 遗留（deferred，ledger 全量）

- `--settings` 携带 key 经子进程 **argv 对 ps 可见**（世界进程同信任域；environ 更优但需 CLI 支持）——登记
- `syncNow` 注释残留旧措辞；`uniqueProviderId` 未保留固定 route id `claude`（hostname 恰为 claude 才触发）；`emitRequestContext` ctx-window 元数据边角；契约测试正则的规避形态；`.sdk-runtime-preview` 未 gitignore；agent-claude 根 package-lock 的 npm bookkeeping——均登记不改
- dev3 UI 真 turn 抽查（user 浏览器）；`mintCatalogEntries` 等 3 个死导出（终审确认无害）

## 6. 版本

`0.1.10-a/b/c/d/e`（字母迭代，dev3/tarball 通道；registry `latest` 冻结未动，publish 待 user 单独下令）
