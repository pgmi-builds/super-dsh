# Machine Mesh P1 — pack 线自环 + 双实例配对实测报告

> 日期：2026-09-27 · 分支 `mesh-p1`（worktree `.worktrees/mesh-p1`，commits `1776cee..640c117` + 本报告）
> 形态：交付形态 pack 线（`test/start-4999.sh`：pack → tarball → 全新 profile → repo build dsh 启动）
> 实例：A = 4999（home `.tests/superd`，长寿命）；B = 4996（home `.tests/mesh-remote`，本报告临时起停）
> Spec：`docs/specs/machine-mesh-a2a/spec.md` §3/§4/§6.2；计划 `docs/superpowers/plans/2026-09-27-machine-mesh-p1.md` Task 6

## 探针矩阵（全部第一人称 curl 实测）

| # | 探针 | 结果 | 证据 |
|---|---|---|---|
| 1 | roster 加性块 | ✅ | `GET /api/agent-runtime` → `hub: {machineId:'79he', label:'local', version:'0.1.0'}`；每 agent 带 6 位 id（native=8ah589…）；`available` 7 键原样 |
| 2 | 自环配对拒绝（spec §3.1 撞库守卫） | ✅ | POST self token URL → `duplicate-machine-id 79he — collides with self…`（mint+probe 已走通，采纳被正确拒绝；**计划原步骤假设自环 201 属计划缺陷，行为以 spec 为准**） |
| 3 | 错误脱敏 | ✅ | 坏端口 + 携 token 的 URL → `token mint to http://127.0.0.1:1 failed — fetch failed`（只报 origin，token 不回显） |
| 4 | 双实例全链配对 | ✅ | POST B 的 token URL → 201，行 `{id:'qf4e'（B 的自铸 id，采纳）, status:'reachable'}`；响应无 token/cookie 字段 |
| 5 | reprobe op | ✅ | `POST {op:'reprobe', id:'qf4e'}` → B 全 roster（8 agent 各带 id，native=mj14g1 等） |
| 6 | **cookie 跨本机重启**（spec §4 核心） | ✅ | 停 A → 重跑 rig（A 新 launch token）→ 新 cookie reprobe B → reachable；`machines.json` remotes[0] keys 含 `cookie`（0600 单测已证） |
| 7 | **cookie 跨对端重启** | ✅ | 停/重启 B（新 launch token）→ A 用旧 cookie reprobe → reachable（持久签名密钥，ADR 0007 机制在本栈兑现） |
| 8 | DELETE | ✅ | `DELETE ?id=qf4e` → `{removed:true}`；GET 复核空 |
| 9 | 浏览器面 HubPage | ⏳ 交 user | 4999 保持运行（token URL 见下），machines 区应显示 self 行 + add 表单（Name + Token URL） |

## 单元测试台账

全 suite 235/234 绿 + 1 已知预存失败（`spawn-world`：worktree 缺 `.tests/profiles/ctx1-min` fixture，主线同样缺失，与本线无关——T1 实现者 stash A/B 验证 + T3/T4/T5 评审复核）。

## Ruling（计划内冲突裁决）

- **Task 6 自环步骤**：计划写"自环 add → 201"，实测被 §3.1 撞库守卫正确拒绝——配对自己即退化碰撞，fail-loud 是 spec 行为；全链采纳改由双实例（4996）完成，证据等效更真。
- **hub.version 显示 `0.1.0`**：Task 4 按 spec §6.2"superd-hub 自身 package.json"实现；pack 版本（0.1.6）与子包版本（0.1.0）不同源。**记 minor follow-up**：mesh 兼容窗判断应用 pack 版本（P2 wire 握手时改为读 `super-dsh` 版本）。

## 遗留与移交

- user 浏览器亲测：`https://test.pc.internal.test/?token=<redacted>`（或 local `http://127.0.0.1:4999/?token=…`）——Hub 面板 machines 区。测完 `systemctl --user stop superd-4999-test superd-lan-4999-relay`。
- dev3 真跨机实装属 release 闸门（根 AGENTS §〇.1），随 P1 收尾轮执行，不在本报告范围。
- 4996 临时实例已停；其 home `.tests/mesh-remote` 保留（复配对可重跑）。
