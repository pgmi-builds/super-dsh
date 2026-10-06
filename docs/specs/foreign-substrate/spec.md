# Foreign agent 接入 Substrate Hub（第一波）

状态：2026-10-06 user 已认可方向并授权继续实施。

## 目标与范围

Super D 启动的 PI、OMP、Codex 会话均可使用现有 `superd-hub` facility：roster、messaging、status、oneshot / PTY exec。PI / OMP 共用扩展主体；Codex 采用官方 app-server 动态工具接口。后排 runtime 与可选 SDK adapter 不在本轮范围。

## 交付与边界

- 按次增量加载优先，既有插件发现与原生工具保留；不向原生 home 安装。仅若机制无法实现才按 user 本轮授权考虑原生 home 安装，记录具体理由。
- 扩展代码内嵌单一 `super-dsh` tarball；会话 wrapper 在 world data home 首次 prompt 时创建，权限 0600，不含 provider key。
- Codex 开新 thread 使用 `dynamicTools`，回调经 `item/tool/call`；恢复本轮 thread 复用 runtime 保存的定义。旧 thread 未有定义时明确能力边界，不伪造历史或另建 thread。
- 新建 native Codex 会话不注入 Hub；原生客户端恢复带动态工具的 thread 时，以实测记录其回调不可用行为。
- 不使用 MCP，不修改上游源码，不添加安装期 hooks 或二进制依赖。

## 接线

Hub 保持唯一语义执行实现；绑定 runtime + DSH session 后构建工具上下文，其 initiator 使用真实 runtime a6。PI / OMP 扩展通过 Hub 自有、仅 loopback 的内部 HTTP 通道调用绑定后的工具；每个会话独立 bearer capability，不接受模型指定 caller 身份。该内部 listener 由 hub 拥有，world 无 listener，不改变公开 UI 认证域。Codex callback 通过同一绑定调用执行实现。

回信经已有 delivery face 寻址该绑定的 live Agent handle，idle / running 均 followup；已关闭会话入现有 unread buffer，read 清扫。create / passive read 不启动 runtime、不写 wrapper、不启动内部 listener。

## 模型 Surface

工具名、描述、JSON schema、结果与错误恢复指引复用 DSH Hub 工具。未知字段和错误类型沿用真实 schema 校验；无绑定 / Hub 不可用明确返回错误，不冒充成功。插件 tool call / result 投影到既有 WebUI 事件路径。

## 验收

单元覆盖 caller 身份、防串会话、schema 错误、capability 生命周期、lazy wrapper、PI / OMP registerTool 兼容边界、Codex callback 与审批共存。行为验收走整包 tarball 4999 和 dev3：三个 runtime 的 create / prompt / resume；真实模型调用 agents / exec / send；异步回信；既有工具共存。测试线保持并提供 user URL。报告落 docs/test-reports。未经本次发布明确放行不 commit / tag / push / publish。
