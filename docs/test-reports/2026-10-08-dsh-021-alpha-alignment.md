# DSH 0.2.1-alpha.1 alignment — 0.3.0-c

2026-10-08 调查与验收；2026-10-09（Asia/Hong_Kong）user 明确授权 push/publish `0.3.0-c`，随后重装两台机器的 registry DSH。此前 4999 先行，dev3 后验；中途按 user 要求暂停等待 4999 手工测试。

## 基线与实现

npm 最新上传版本为 `@deepseek-ai/dsh@0.2.1-alpha.1`，alpha tag；latest/next 仍是 `0.2.0-rc.2`。官方发布：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1>。本仓物理 checkout 为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。

备份旧构建补丁，清除生成物，用官方 pnpm 11.7.0 frozen install 后完整重建，均 exit 0。新版官方 native config loader 已不需要旧 unrun 依赖补丁和 repository-root 补丁；仅保留已有授权的 workspace storeDir/verifyDepsBeforeRun 配置。没有其他上游源码改动。

- Hub 发布 world 映射时保留官方 `ProfileRuntimeResolution` 子类和可重算能力；修复 world 挂载后原生 Plugin Manager refresh 失败。重算只补回 world 映射，原生映射优先，仍遵守官方 loaded-package restart 边界。
- 通过 namespace 特性检测兼容真实旧 rc.2 宿主，避免静态导入新版类使旧宿主无法启动。实际旧安装的 regression 已通过，无假类型或第二份宿主模块。
- Better 首次由内嵌包晋升为 profile 直接依赖时，新版宿主必须冷重启，coordinator 正确报告 restartRequired；精确 no-op 不要求重启，旧宿主保留旧行为。
- 摘除已退役且未使用的 invariants optional peer，并标注旧开发文档快照。两包及 exact 内嵌依赖同步为 `0.3.0-c`。

实际使用 TypeScript LSP 查官方定义、引用、调用层级，并用 TypeScript AST 检查全部九个 adapter 的 168 个 TS/TSX 文件及变更结构。metadata 子路径、composer、preset registry、调度、Web public URL、会话接口均检查；没有发现需要额外 adapter 重写的接口破坏。最终独立代码复审无阻断项。

## 同一组交付产物

| 包 | SHA256 |
| --- | --- |
| better-dsh@0.3.0-c | `a9287af10438fc48ca32a048392cf5192f5cef864fe152eb2b50c99e58061563` |
| super-dsh@0.3.0-c | `d9a2402dde554204d703e7cc342762d66ffeec54e1c2faec9a36608b90e2a37a` |

Better 先构建，Super 物理内嵌 Better 的 749 个文件，与独立 tarball 内容逐文件一致。dev3 收到同一对 tarball，哈希一致；没有 registry/兄弟仓构建回退。

## 行为验收

| 检查 | PC4999 | PC4997 小包 | dev3 独立4998 |
| --- | --- | --- | --- |
| 实际宿主 | 源码完整构建 alpha.1 | 同左 | registry alpha.1 独立安装锚 |
| 密码登录/实际模型 Surface | 通过 | 通过 | 通过 |
| 客户端模块唯一 | 68 | 67，无 Hub | 68 |
| 原生 eval 输出 `ALIGNMENT-EVAL-42: 42` | 通过 | 通过 | 通过 |
| 同一会话冷恢复回忆实际输出及口令 | 第3轮通过 | 第2轮通过 | 第2轮通过 |
| 两包九组独立启停组合 | 全通过 | 独立启用 | 全通过 |
| 七 world ready / enabled plugin 无失败 | 通过 | 不适用 | 通过 |
| Pi、Codex、Claude、OMP、Hermes create/prompt/冷resume | 全通过 | 不适用 | 全通过 |
| Antigravity create | 通过 | 不适用 | 通过 |
| Antigravity prompt/resume | 外部 billing QUOTA 阻断 | 不适用 | 同样阻断，未自动重试 |

会话判断读取真实 V4 zstd 日志中的 tool/call、tool/result、assistant/message 和 turn/end，不以 boot/mount 冒烟代替。PC 同一会话还跨 b→c 更新恢复。默认关闭的三个可选 SDK 路线仅跑各自 suite，未声称做模型行为验收。

PC Chrome 真浏览器密码登录、原生 composer、Hub/Automation 入口页面加载正常，pageerror 为空。dev3 HTTP/client graph 和模型行为检查通过；浏览器经 SSH review tunnel 的页面加载等待超时，未声称浏览器验收通过。

dev3 沿同一 launcher，独立 `.tests/dsh-0.2.1-alpha.1-install` 宿主锚，复用已有 socat 测试二进制；测试 WebMCP 两个预构建文件与本机最新编译的 SHA256 一致，真实宿主 peer 重新绑定。第一次启动需等待 companion 登记后冷重启。生产安装和服务在这轮对齐验收期间未改动；后续重装属于 2026-10-09 的新显式授权。

## 自动验证及边界

对齐实现验证：root 27 passed；Better 709 passed / 4 skipped；Hub 与九个 adapter 合计 1753 passed / 1 skipped，0 failed；host/client typecheck 和 pack 构建通过。2026-10-09 发布前再次执行同一套最终源码验证，结果另见发布报告。

Antigravity QUOTA 是未关闭的外部行为验收缺口，不计为通过；foreign 验收汇总故意返回失败。发布授权来自 user 本轮明确指令，不隐去这一缺口。没有增加新 feature 或改变既定 optional peer 范围。

私有证据在 `.scratch/alignment-0.2.1-alpha.1/`：registry metadata、build/install exit、pair、LSP/AST、review、pc/dev3 delivery/matrix、native/foreign proof、真实会话事件和测试日志。含认证的文件不进 Git。独立小包与整包测试 home/用户会话均保留。
