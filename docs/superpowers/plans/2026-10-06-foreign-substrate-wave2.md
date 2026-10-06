# Foreign Hub 第二批实施计划

当前隔离工作区 foreign-substrate-wave2；设计见 docs/specs/foreign-substrate-wave2/spec.md。无新增发布、commit 或 push 授权。

## 1. 共享 transport 与原生未绑定错误
- [x] Hub failing unit：transport 延迟启动、不写 native home、调用成功、缺 capability 返回 E_HUB_ADDRESS_REQUIRED 且不执行工具、dispose 撤销。
- [x] 提取现有 extension 的 loopback 配置为 binding.transport()，保持第一批兼容。

## 2. Hermes 原生插件与 lazy wiring
- [x] Python plugin 测试：真正 register_tool，schema 与 Hub 同源；测试调用 HTTP、native 未绑定错误、没有 hook/prefetch 注册。
- [x] installer 测试：owned path、保留其他插件、不覆盖无标记用户目录、公共配置无 capability、仅增量启用自己的 key。
- [x] Hermes gateway client 测试：首次 ensureStarted 前异步准备插件，close 时取消后续 spawn，准备失败显式报错，dispose binding。
- [x] create/resume 为 handle 注册 binding，独立于工具调用；执行回归。

## 3. Claude / AGY
- [ ] Claude 查清 Corti 实际工具层与 user 已有裁决，按其确认范围实现插件；不走 skill 替代，不让 MCP 承担收信。
- [ ] AGY 核实原生插件工具登记入口与正式部署路径；复用公共 Hub 业务与 lifecycle。

## 4. 交付验收
- [x] Hermes 本轮 tarball 0.1.11-j，4999 与 dev3 同包安装。
- [ ] 真模型 create/prompt/resume、exec/send/reply、从未调用过工具的接收会话、native 无门牌报错。
- [ ] Surface 核验与报告，Web 保持供 user 验收，明确自动验收与 user 验收区别。

Hermes 自动行为验收已完成，详见 2026-10-06-hermes-native-hub.md；第 4 节剩余项仍包含未实现的 Claude / AGY 和尚未进行的 user 人工验收，不能整批勾选完成。
