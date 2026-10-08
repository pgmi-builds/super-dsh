# DSH 0.2.1-alpha.1 alignment

本轮目标：将本仓唯一现役 upstream checkout 从 `dsh-v0.2.0-rc.2` 对齐到 registry 最新上传 `0.2.1-alpha.1`（alpha tag；latest 仍为 rc.2），覆盖合仓后的 Better Dash 与 Super Dash。

- 源码基线：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`；仅在仍需要时重放既有授权构建补丁，清理旧产物后完整构建。
- 调查破坏面：子路径 metadata、invariant 移除、composer activity/usage、HMR 与 runtime dependency mapping、Web public URL、Automation 组合、会话与工具 API。
- 只实施必要兼容适配，不顺带引入 feature。宿主 optional peer 范围沿用既定裁决，类型与运行时保持同源。
- 双包同步字母版本，先构建本仓 Better tarball，再内嵌 Super；测试小包消费者与整包消费者。
- 先完成本机 4999 整包行为验收，再验 4997 小包及 dev3；dev3 安装 registry 精确上游版本至独立测试安装树，沿现行 launcher、保留测试 home 验证同一 tarball。
- 验收覆盖原生实际工具 Surface、create/prompt/resume、受影响 foreign runtime 会话、平行插件开关与 client metadata。
- 不触碰生产 home/3080/3081，不升级共享生产安装树；不 publish、commit、tag 或 push。报告落 docs/test-reports，Web 测试线保持运行供 user review。
