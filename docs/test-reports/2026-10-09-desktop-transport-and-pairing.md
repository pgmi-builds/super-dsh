# Desktop transport 与 UID mutual pairing 验收记录

2026-10-09。实现已落地，候选双包为 **0.3.0-k**。PC4999 和 dev3 的真实交付线已验证配对与会话行为；**实际 Electron GUI 尚待验收**，不能据本报告宣称 Desktop 全链路验收完成。

## 实现结果

Desktop 的 unary 请求走自定义 scheme，经 Electron 转成宿主 HTTP；WebSocket 则直接走宿主声明的 HTTP stream 地址。原来的 frontend patch 只识别页面地址，漏掉了这条独立 stream 通道；自定义 scheme 的 WHATWG `origin === 'null'` 也需要正确处理相对地址和重写结果。现在动态读取官方 `__DSH_TRANSPORT__.streamBaseUrl`，同时识别页面和实际 carrier。保留 scheme、上游认证与生命周期；foreign 请求进入现有 `/hub`，原生请求保持原路径。没有把所有 localhost 当作拦截对象，也没有修改上游源码。

2026-10-07 研究报告中的「裸 localStorage key 必然绕过命名空间」判断未在当前实现成立：现有 patch 拦截 `Storage.prototype`，裸 key 调用也会经过命名空间。本轮没有按该推断改写 selection 或加入掩盖错误的 workspace fallback。实际 Mac 的原始 toast 因验收机不可达尚未重现；当前代码证明的 carrier 缺口与修复不等于已在原报错现场完成因果复验。

Mutual pairing 按用户裁决实现：主动方原样提供 host URL、token 和 Hub UID；接收方先查 UID，自身跳过，已认证的同 UID 保留既有端点和设置并重新探测。新的反向连接失败仍保留 incoming 记录，显示灰色；不影响主动方已建立的连接。定期/手动探测可恢复记录。收到新的可达地址也可恢复同一 UID，不生成重复机器。

UID 用于身份去重，不能代替认证：只有 native cookie 认证成功、roster 的 UID 与 offer 一致，才开放远端 agent。未验证的 incoming 记录不参与 federation。删除记录、并发探测和重复 offer 均有回归覆盖，过期探测不能恢复被删除记录或覆盖更新后的连接。

真实配对还发现 Better 的根密码页挡住了 native token exchange。新增精确的 `/superd/pair-auth`，委托官方 `connection.authorizeIndex`，由上游验证 token、签发 cookie；没有复制认证实现。普通 Web 根页面仍保持密码登录。Electron 启动本身需要根 token exchange，因此 Better 在官方 `profileContext.name === 'desktop'` 时保留这条原生入口。可选 profile fact 经 Cordis 官方 `ctx.get` 读取，Web-only composition 无此服务也正常运行。

UI 只调整连接反馈、host URL 的 null-origin 表达及不可达颜色，没有增加地址可达性判断、地址格式警告或新布局。

## 基线与交付

- 上游物理 checkout：DSH `0.2.1-alpha.1`，HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。
- 本轮未编辑上游；上游已有 `pnpm-workspace.yaml` 修改为任务开始前的构建基线补丁。
- 两包由本仓正式 pack 入口构建；Super exact dependency 为 `better-dsh@0.3.0-k`，没有携带 Better 的物理副本。
- PC 使用官方 launcher、`.tests/superd`、4999；另一隔离消费者使用4997。dev3 使用其现有隔离 home、已安装 DSH `0.2.1-alpha.1` 和4998。
- dev3 接收未修改的同一对 tarball，并验证安装版本与 exact dependency。当轮清单保留在 `.scratch/desktop-pairing/accepted-k-pair.json`。

| 产物 | SHA256 |
| --- | --- |
| `better-dsh-0.3.0-k.tgz` | `ec250759d63d08f915c90c1f19d22b23c2130dbce50f26781b099747116e6665` |
| `super-dsh-0.3.0-k.tgz` | `a1e2bbc2a3c4cc8df8d8f3ecedc6f5cd814c0c90664c898d1d5b3157059b041a` |

## 工具、回归与审查

确实运行了 TypeScript language server，查询定义、引用与调用关系；使用真实 TypeScript AST 核查结构与调用范围，不将 `rg` 搜索冒充 LSP/AST。证据位于 `.scratch/desktop-pairing/` 的 `lsp.jsonl`、`auth-lsp.jsonl`、`final-auth-lsp.jsonl`、`ast.json`、`ast-final.json`。对 vendor profileContext 的一次额外 LSP 查询超时，该项以官方源码和真实 Context 测试核实，不计为成功的 LSP 查询。

- Hub 全量 **593/593 通过**：`hub-final.log`。
- Better 全量首次结果 **706通过、6失败、4跳过**；6项失败集中于 browser-device fixture 未找到 Chrome。提供官方 `DASHR_BROWSER_BIN` 后该文件 **10/10通过**：`better-browser-final.log`。两轮合计覆盖全部712个非跳过用例；不将首次失败隐去或写成单次全绿。
- 后续 desktop/password/Connection 修改另跑受影响测试，**24/24通过**；真实 Cordis Context 验证 **6/6通过**。最后可选 `ctx.get` 修正经独立 reviewer 复核及相关 **21项测试通过**。
- Host TypeScript、客户端类型检查及正式双构建通过。红/绿回归日志保存在同一证据目录。
- 独立 reviewer 的 cookie 残留、探测竞态、匿名 roster、误判 mutual 成功、删除期间重建等发现已修复；最后复核无剩余实质问题。

## 真实交付行为

| 场景 | 结果与证据 |
| --- | --- |
| 两个 loopback 实例互连 | 4999/4997、不同 UID，双方 reachable，mutual 成功。`loopback-mutual.json` |
| 原样 offer `dsh-app://app` | 主动连接成功；反向实际 dial 失败，接收方保留 unreachable 行，mutual 明确失败。`custom-gray.json` |
| 灰色记录跨重启 | 4999 冷重启后仍存在。`custom-gray-retained.json` |
| 同 UID 恢复与去重 | 可达 offer 恢复原记录，只有一行；已认证 UID 保留有效端点；自身 UID 跳过。`recover-pair.json` |
| PC/dev3 跨主机 reciprocal | dev3 成功反连 PC 的公开测试域名；双方 reachable。`pc-dev3-mutual.json` |
| 远端真实 gateway | PC 通过已认证 dev3 Pi 读取真实会话列表，HTTP200；灰色 peer 暴露0个 agent。`federated-rpc.json` |
| 灰色 UI | 浏览器实际读取 unreachable 图标，主题色 `--dsw-alias-label-caption`，computed `rgb(173,178,184)`。`gray-ui.json`、`pc-hub.png` |
| PC UI 切换后新建 | Pi、Codex、Claude、Hermes、OMP 均进入 `/hub/api/session/create?agent=…`；DSH 进入原生 `/api/session/create`，无 pageerror。`pc-switch.json`、`pc-switch.png` |
| dev3 UI 切换后新建 | 同组六个目标均创建成功，包含通过官方目录选择器建立/选择 workspace；无 pageerror。`dev3-switch.json`、`dev3-switch.png` |

跨主机测试中 PC 访问 dev3 使用4996→dev3:4998 的隔离 SSH 测试载体；dev3 反连的是 PC 公开域名。这只是测试网络安排，产品没有新增 tunneling 服务。该测试隧道和配对行暂留，便于复查。

PC 和 dev3 各在实际整包消费者上完成 Pi、Codex、Claude、OMP、Hermes 的 create、真实 prompt、宿主冷重启后同 SID resume；原生 DSH 在两端完成真实 Python eval 与冷重启后的再次 eval。没有用进程存活或 mount 探针替代这些行为。

证据：`pc-foreign-k-turn1-evidence.json`、`pc-foreign-k-turn3-evidence.json`、`dev3-foreign-k-turn1-evidence.json`、`dev3-foreign-k-turn2-evidence.json`、`dev3-claude-turn3-evidence.json`、`pc-native-k-final-turn1.log`、`pc-native-k-final-turn2.log`、`dev3-native-k-create.log`、`dev3-native-k-cold-resume.log`。

dev3 Claude 第二轮把 ASCII 口令翻译为中文，严格 literal checker 因此未通过；第三轮在同 SID 询问历史原文、未提供预期答案，正确恢复原始口令。原始失败和补验均保留。

Antigravity 两端均创建会话并实际调用 prompt，但返回外部 `QUOTA`；其成功 prompt/resume 验收未完成，不能声称七个 runtime 全绿。

PC 原生 eval 初次失败，定位为测试安装目录既有 `.venv-kernel` 缺少 Python interpreter。停止隔离测试 unit 后将残缺缓存移到 `.scratch/desktop-pairing/partial-kernel-1791534594` 保留，再由交付物自带 provisioner 重新创建。最终 eval 与冷重启续聊通过。详见 `kernel-fixture-repair.json`；没有改业务守卫、删除用户会话或操作生产 home。

## Desktop 验收边界与保留环境

`carrier-live.json` 使用交付 HTML 中的注入脚本、自定义 scheme 页面环境、上游真实 `forwardWebRequest` 和实际宿主 HTTP/WS，验证原生及五个 foreign runtime 的 session create、WS ready、路径/agent 参数与401认证拒绝。它是**传输载体验证，不是实际 Electron GUI**。其 profile 是 `superd-pub`；没有把 Web profile 的 dedicated token exchange 冒充 desktop profile 的启动结果。

已尝试连接可用的 Mac 桌面验收机，但当前无法连通；官方 CLI 也明确拒绝自行启动 desktop 专属 profile。本轮未绕过这个边界，也未操作 Mac 的在役 profile。实际 Electron 安装、启动、切换、工作区选择和连接远端仍须在可用的桌面隔离环境补验。

保留 Web 验收入口：[PC 测试线](https://test.pc.internal.test/)。PC4999、隔离 peer4997、dev3:4998 与测试隧道仍运行，用户可以继续验收。

本轮没有 npm publish、Git commit/tag/push、生产重启、生产3080/3081操作或 live Caddy 修改。实现与候选包可审阅；发布与 Desktop 完整验收尚未定版。

后续用户明确指示 push/publish，并采用 registry `0.3.0-d` 之后的最小字母 `0.3.0-e`。发布过程与归档等价性另见 [0.3.0-e 发布记录](2026-10-09-030-e-release.md)；本报告保留发布授权前的验收事实和 Desktop/QUOTA 边界。
