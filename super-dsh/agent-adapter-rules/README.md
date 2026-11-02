# Agent Adapter 规则库（渐进式披露）

> 2026-11-02 起，adapter 侧的**共性检查点、长期对齐机制、per-agent 事故沉淀**落本目录，按模块拆分。
> 核心开发规则仍在上级目录 [`../agent-adapter-dev-rules.md`](../agent-adapter-dev-rules.md)（§ 编号历史稳定，既有引用不破坏；该文件不再膨胀，新知识进本目录）。

## 加载契约（ progressive disclosure ）

**不要一次全读。** 先读本 README，再按任务加载：

| 文件 | 何时读 |
|---|---|
| [`10-dsh-checkpoints.md`](10-dsh-checkpoints.md) | **必读**——新接 / 改动任何 `agent-*`，交付验收前逐条过 G1–G6 |
| [`20-upstream-drift.md`](20-upstream-drift.md) | DSH 上游或 foreign runtime 任一侧升级时；发生事故 / 弯路时 |
| [`30-hermes.md`](30-hermes.md) | 触碰 agent-hermes 的任何时刻 |

## 目录定位

- **DSH 是终点规格**：所有 foreign agent（codex / claude / omp / hermes / pi / agy / …，无论开源闭源）最终都要接到统一的 DSH UI、后台与 session log 形态上。`10` 用纯 DSH 侧行为语言描述强制检查点，与上游形态无关。
- **上游异构在 `3x-*` 承接**：每个 agent 一个沉淀文件（机制事实、事故链、已知脆弱缝、版本基线）。新 agent 接入时先建自己的 `3x-<label>.md`，哪怕只有版本基线表。
- **两侧都在漂移**：对齐机制（沉淀纪律、重对齐流程、版本基线登记）见 `20`。

## 贡献纪律

每次事故 / 弯路**必须**在对应 `3x-<agent>.md` 落一条（模板见 `20` §沉淀纪律）：没沉淀 = 白疼。共性结论升进 `10`，并注明出处事故。
