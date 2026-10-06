# Antigravity native Hub plugin — 2026-10-07

状态：代码、整包构建及自动回归完成，真实模型行为验收尚未通过。user 最新指令已放行并发布 B（见文末裁决与发布报告）；不把六个 runtime 全部标为通过。

## 合并与现场保留

已验证的 PI / OMP / Codex / Hermes / Claude 进入主线：wave2 实现 `a3cabaf`，合并 `5bb69f1`，已 push `origin/master`。主线合并重建后的 1,322 项检查通过、1 项既有 skip。`foreign-substrate-wave2` worktree、分支及 Git registration 已删除；独有 scratch 证据保留在主目录 `.scratch/foreign-wave2-archive/worktree-scratch/`，夹具保留在 `.tests/foreign-wave2-fixtures/`，未清理用户原生会话。

4999 的真实长期 home 原本就是主目录 `.tests/superd`；启动 WorkingDirectory、CLI anchor、安装 profile 和日志路径已切回主目录。共用凭据 seed 保留。Web 继续提供 [本机](https://test.pc.internal.test/) / [dev3](http://dev3.internal.test:4998/)，未触碰生产 3080 / 3081、生产 home 或 Caddy。

`h` 到 `t` 是本轮 tarball 迭代，不是 Git tag。核对时仅有 `v0.1.11` 和 `v0.1.11-a`；它们对应已有发布，不删除。发布前 registry latest 为 `0.1.11-a`；B 发布结果见[发布报告](2026-10-07-super-dsh-0.1.11-b-publish.md)。

## 接入形态

官方 CLI plugin 使用 root `plugin.json` + `mcp_config.json`，原生 `agy plugin install / enable` 增量登记自有 `superd-hub`；自有 marker 拒绝覆盖同名非自有目录。stdio helper 仅实现 catalog / tool call，通过同机 loopback HTTP 访问现有 Hub。没有 skill、rules、prompt injection 或 SSE 主动通知。

MCP 不承载收信。create / resume 已独立登记 live handle；Hub 来信通过现有 actor 队列与原生 CLI stream-json user 输入启动轮次，不要求先调用工具。native 未绑定 helper 不携带 capability，实际邮局拒绝为 `E_HUB_ADDRESS_REQUIRED`；capability 只进入 Super D child env，关闭即撤销。owned native plugin 在 Hub 重启时刷新公共 endpoint。

依据：[官方 Plugins](https://www.antigravity.google/docs/plugins?tab=cli)、[官方 MCP](https://antigravity.google/docs/mcp?tab=cli)。本机 / dev3 CLI 均为 `1.2.16`；help 未见 per-spawn 增量 plugin path，采用 user 已授权的 native-home fallback。官方 plugin validator 处理了 1 个 MCP server；格式验证不等于模型工具 Surface 通过。

开发前实际使用 TypeScript LSP definition / references 定位 createLiveClient 的 create / resume 调用，并以 TypeScript AST 遍历 spawn / turn / send 结构。初次 LSP 缺 TypeScript 安装定位，指定真实 tsserver 后取得有效定义与引用；证据 `.scratch/agy-hub/lsp.jsonl`、`ast.jsonl`。

## 验收中修复的既有缺口

- OAuth 凭据已被 auth ladder 识别，但 onboarding gate 未识别，导致原生已登录用户仍被要求 API key；现在一致识别原生登录证据。
- 冷恢复未传 mapped conversation ID；现在使用已有官方 `--conversation`，不从原生历史猜配对。
- CLI tool 帧在 consume 和 turn 两处发往 actor，导致重复记录；改为唯一 sink。分时 ACTIVE / DONE 帧回归通过真实 `assertReleasedV4Relationships`，没有缩窄校验类型集合。
- 旧轮次失败后未继续投递已接收的 Hub 信；现在失败收尾也 drain。deadline 停止 CLI 时保留旧轮次所有权，成功与失败路径均等待停止完成，再开放下一轮；覆盖停止期间收到缓冲 SUCCESS 的竞态。自然 child exit 重置 ready，重新 spawn 等待真实 init。

## 自动检查与真实验收缺口

整包 `0.1.11-u` 构建通过，最终完整回归再次通过。Hub + 六个 runtime + pack contract：1,407 项，1,406 pass、1 个既有 skip、0 fail。stdio 真实 HTTP fixture 覆盖工具 catalog、带 capability 调用、无门牌号拒绝及 capability 不进入 native 文件；lazy / dispose、恢复路由、失败队列、deadline 竞态和真实 V4 日志关系均有回归。独立最终针对性复核 19/19 通过，未发现剩余代码阻塞问题；真实模型验收是单独的剩余门槛。

本机缺少原生 OAuth credential 文件、ADC 文件或 Gemini API key；真实消费者 prompt 因无认证停在 onboarding，未被算作模型回复。dev3 已有原生 OAuth / ADC 证据，但真实 CLI session `71000e0a-0014-47d7-b24f-fb900dfb45cd` 返回 Google 项目 `crafty-run-501613-m0` 未启用 billing 的 403。没有修改项目计费、购买额度或更换身份。重复安装验证发现本轮 marker 多写一个换行，导致误判非自有目录并跳过 endpoint 刷新；已修正 canonical 写入，识别确切旧测试 marker，并补重复安装 / 刷新回归。没有强行接管非自有目录。

待现场认证和计费恢复后：两端 create / prompt / resume，真实 Hub exec / send / 自动回信，Pi 向零工具调用的新 Antigravity 投信，并核验原生模型 Surface。完成这些后才能称六个 foreign runtime 全部通过；B 已按 user 最新指令放行，此剩余验收缺口随版本明确记录。

本机用真实交付包及官方 CLI 独立完成 native 插件安装和格式验证（不依赖模型认证）。t 轮本机已安装 helper 直接调用真实 loopback 邮局，实际返回 E_HUB_ADDRESS_REQUIRED；这是 helper / 邮局验证，不冒称原生模型调用。dev3 同形复验曾因上述 marker 刷新缺陷返回 E_HUB_UNAVAILABLE；u 轮两端均已实际返回 E_HUB_ADDRESS_REQUIRED，证明重启 endpoint 刷新恢复。原生模型调用仍未验证。

最终 u tarball SHA-256：`3235862e46509558aaef00dc87c695eba64b35fda9ed00e11071d9faa961d0b4`。两端安装同一 tarball，本机 4999 / dev3 4998 继续运行。

## 本次发布裁决

2026-10-07 user 在上述认证 / 计费与模型验收缺口已明确报告后，再次明确下令 `push and publish 0.1.11b`。按该最新指令发布 canonical npm 版本 `0.1.11-b`；此指令替代先前等 Antigravity 实测通过再发布的条件。保留实际验收缺口，不把发布放行写成六个模型行为均已通过。
