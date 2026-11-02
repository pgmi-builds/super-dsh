# 双上游漂移与长期对齐机制

> adapter = 垫片（gasket），两侧独立漂移，谁都不等你：
> - **DSH 侧**（peer `>=0.2.0-0 <1.0.0-0`）：组合语义、settings 投影机制、session log vN 格式、原生 UI 面。
> - **foreign 侧**：协议、daemon / 进程所有权模型、auth、CLI 面。闭源（codex / claude）随时破坏性变更；开源（omp / hermes / pi / agy）也会大改（hermes 2026-11-02 例：常驻 gateway 独占 home，独立 stdio spawn 全灭）。
>
> 「两边改一改就又对不上」是常态，不是异常。本文件是把对齐变成例行公事的机制。

## 沉淀纪律（强制）

每次事故 / 弯路 → 在对应 `3x-<agent>.md` 落一条，模板：

```
### YYYY-MM-DD <一句话>
- 触发：<什么改动 / 什么操作暴露的>
- 签名：<用户在 DSH UI 里看到什么>
- 根因：<机制层一句话>
- 检查点：违反 G#（10-dsh-checkpoints.md）
- 修复：<代码 / 修复工具 / 配置，commit 或报告引用>
- 回归探针：<以后怎么快速重测这一条>
```

没沉淀 = 白疼。共性结论（跨 agent 都会踩的）升进 `10`，注明出处事故。

## 重对齐流程（任一侧升级时执行）

1. 读对应 `3x-<agent>.md` 的**已知脆弱缝**清单——已知缝优先重测，最快命中。
2. 4999 pack 线跑检查点全表 G1–G6（`10`）。
3. dev3 目标机实装（tarball → restart → 同组探针）。
4. 真实 UI create / prompt / resume（browser-bridge 族）。
5. 更新 `3x-<agent>.md` 的版本基线表。

## 版本基线登记

每个 `3x-*.md` 头部维护一张表：DSH 版本 / runtime 版本与部署形态 / adapter 传输形态 / 上次全绿日期。升级后不更新基线 = 下次对齐没有起点。

## Backlog（登记未建）

- **统一 conformance 探针**：把 per-adapter 的 stdio 探针（hermes 的 `probe.mjs` 模式：像真实 adapter 一样驱动 bridge / 子进程，验证请求转译与事件形状）泛化成 per-agent 标准剧本，自动化 G1/G2。G3–G6 仍走真实 UI（user 裁决不可替代）。
- 新 agent 接入 checklist：建 `3x-<label>.md`（版本基线 + 机制事实骨架）→ 按 `10` 逐门接线 → G6 收尾。
