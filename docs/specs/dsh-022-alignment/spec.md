# DSH 0.2.2-alpha.2 alignment

本轮目标：将本仓唯一现役 upstream checkout 从 `dsh-v0.2.1-rc.3` 对齐到 `dsh-v0.2.2-alpha.2`（GitHub 直取 tag），覆盖合仓后的 Better Dash 与 Super Dash，修复 0.2.2 破坏面。

- 源码基线：`f3803c96974ad4a94195fb97e5c637e9c2a3afe3`；仅在仍需要时重放既有授权构建补丁（单补丁：pnpm-workspace.yaml 两键），清理旧产物后完整构建。
- 调查破坏面：dsh-tools 拆分（TOOL_RUNTIME_SCHEDULER 移除 → ToolExecutionPipeline）、PTC 事件包迁移、renderIndex Peer 化、tools.execute batch+executor 架构、Agent.model 必选面、installModelSelection 签名、approval/policy augmentation 断链。
- 只实施必要兼容适配，不顺带引入 feature。宿主 optional peer 范围沿用既定裁决（新增 dsh-tool-executor-ptc / dsh-tool-testkit / dsh-session-projection / dsh-tool-executor-native 均 optional、仅测试/类型面），类型与运行时保持同源。
- 双包同步字母版本（0.3.2-f），先构建本仓 Better tarball，再内嵌 Super；测试小包消费者与整包消费者。
- 先完成本机 4999 整包行为验收（含移动端 patch 全链验证），dev3 生产安装/重启需 user 单次明确授权，不 publish、不 commit/tag/push。报告落 docs/test-reports。
