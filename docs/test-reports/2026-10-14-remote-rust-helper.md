# Remote Rust Helper（superd-run）实施与验收报告

- 日期：2026-10-14（Asia/Hong_Kong）
- 规格：[docs/specs/remote-rescope/spec.md](../specs/remote-rescope/spec.md)（§5 helper、§5.2 安全契约、§5.6 生命周期、§5.7 步数账本）
- 执行计划：[2026-10-13-remote-rust-helper](../superpowers/plans/2026-10-13-remote-rust-helper.md)（Task 1–6 全部完成）
- 版本：同步字母轮 **0.3.1-d**（tarball 通道；registry 未发、未 commit/tag/push——待 user 放行）
- 事故档案：2026-10-13 killgroup `kill(-1)` 事故见 `better-dsh/src/remote/helper/NOTE-2026-10-13-killgroup-incident.md`（含回执）与 `~/workspaces/base/70_Incidents/superd-run-killgroup-uid-sweep.md`。本轮全部后续修复已并入。

## 交付物

| 件 | 位置 | 说明 |
| --- | --- | --- |
| Rust crate（零 crate，平台分裂） | `better-dsh/src/remote/helper/{Cargo.toml, build.rs, src/main.rs, src/unix.rs, src/windows.rs}` | 动词集冻结：`banner`/`run`/`killgroup`；per-invocation、无 daemon、无监听端点 |
| 四平台静态产物 + MANIFEST | `better-dsh/src/remote/helper/bin/`（MANIFEST.json 随版本 0.3.1-d 锁步） | x86_64-musl 447KB / aarch64-musl 397KB / win-gnu 337KB / apple-darwin 337KB |
| 构建入口 | `helper/build.sh`（darwin 经 `mac` 主机远程构建） | ver 自动锁 better-dsh 包版本 |
| TS 接线 | `src/remote/helper.ts` + `transports.ts` 四 argv 构造 + `driver.ts`（fast path/sticky 回退/回执）+ `tool.ts`（schema/render/description） | probe→upload（cat-over-exec 原始 stdin）→verify；任何失败 sticky 回退 POSIX shim |
| 打包 | `better-dsh/scripts/copy-helper-bins.mjs`（→`lib/remote/helper-bin/`）；`build-remote.mjs`（→闭包 `remote/helper-bin/` + provenance）；`verify-package-pair.mjs`（允许清单扩展 + **逐叶子哈希核验**） | 无 postinstall；`AGENTS.md`（根 + better-dash）修正案落定 |

## 安全契约（2026-10-13 事故后，全部实现并实测）

1. `killgroup` pgid ≤ 1 一律 exit 64，拒绝发生在任何 kill 之前（实测 1/0/-5）。
2. Linux starttime 边车（`<pidfile>.st`）防 stale pidfile PID 复用误杀：篡改→拒绝且目标不动；shim 旧格式无边车→跳过（兼容）。
3. 信号/组语义测试只在容器/VM 内执行（lane-matrix 纪律）。
4. 修 kills 之外的发现：僵尸组成员使 `kill(-pgid,0)` 排空判定恒假 → Linux 按 `/proc` 非 Z/X 成员判定（alpine 实测修复前后对比）。

## 验证矩阵

**Binary 行为（tests/lane-matrix.sh，Phase 0 方法学：真实 ssh / docker exec，不用 docker-run-as-pid1）**

| 环境 | 结果 | 备注 |
| --- | --- | --- |
| docker exec alpine:latest | 12/12 | 无 bash/无 util-linux setsid/无 procps——现行 wrapper 无法启动的环境 |
| docker exec alpine+bash | 定点验证 | wrapper `setsid --wait` 拒绝（实测）；helper 正常——headline 场景 |
| docker exec busybox:latest | 12/12 | 无包管理器环境 |
| docker exec debian:stable-slim | 12/12 | Phase 0 曾实测 pidfile 0 字节（killer 静默断裂）——helper 修复面 |
| ssh dev2 / dev3 | 13/13 | 含 **PDEATHSIG 断连清零跳**（杀本地 ssh → 远端自动清场） |
| ssh dev4（真 arm64 硬件） | 13/13 | aarch64-musl 静态产物 |
| mac（Darwin 27/ARM64，ssh mac） | 子集 + killgroup 实战 | 无 PDEATHSIG：断连泄漏如实确认（killer 会话为主路径，spec §5.6 裁定）；killgroup 成功清理泄漏树 |
| wine 10.0（win-gnu exe） | 冒烟 | banner/退出码逐字/Job Object 链路；深度验证待真实 Windows 端点（D5 未决） |

**TS 接线**

- 单测 `test/remote/helper.spec.ts` 7/7（argv 形状、arch 映射、registry 状态机：miss→upload→verify、sticky ready/absent、版本偏差拒绝、垃圾输出即退）。
- better-dash 全量套件绿（27 个 remote 测试文件全过；typecheck 双通道 0 error）。
- 真实 driver e2e（dev2）：首呼 1502ms = probe+upload+verify+run，回执 `runner:"superd-run 0.3.1-a (x86_64-unknown-linux-musl)"`（按当时版本）；次呼 806ms（0 额外跳）；强制 shim（`helperAssetsFor:null`）→ `runner:"posix-shim"`。升级 0.3.1-d 后缓存目录按版本隔离，自动重上传。

**交付形态**

- PC 4999 线（`.tests/superd`，superd-pub）：0.3.1-d 安装成功、服务监听（`https://test.pc.internal.test/`）。安装态 super 闭包 surface 字节核验：helper 句 ×1、`posix-shim` ×2、schema `runner` 字段、实现字节（`SUPERD-PROBE`/`.cache/superd/run`/killgroup 接线）齐备；closure MANIFEST ver=0.3.1-d。
- 双包 bundle 字节核验：better lib 与 super 闭包一致（实现全部在包内）。
- dev3 目标机（4998 线，`.tests/foreign-substrate`）：pair 传输 + `read-pack-pair` 重定位核验（含新 verifier 的 helper-bin 叶子哈希）→ launcher 安装 → 服务 active/HTTP 200；安装态 super 0.3.1-d、closure MANIFEST 0.3.1-d；**目标机直跑安装产物**：banner 正确、`run` 退出码逐字（exit 6）。
- pack 契约测试 6/6；`npm run build` 全链绿（better-dsh@0.3.1-d 615b9c39…、super-dsh@0.3.1-d 3919663d…）。

## 已知边界（如实）

1. **better-dsh 0.3.1-a 保留**：两条联合线（4999/4998）按 companion 保留策略未随 super 升级 better——这是设计行为（升级场景测试）。better 0.3.1-d 的新 surface 已由独立 tarball 安装核验（throwaway 消费者）与 bundle 字节核验覆盖；GUI 会话里 remote 行按 Agent 创建竞争注册。
2. **GUI 第一人称终验留给 user**：测试线密码为 user 持有（scrypt），模型侧无法代铸 cookie。建议 user 在 `https://test.pc.internal.test/` 开会话执行 `{target:"dev2", cmd:"echo HI"}` 观察回执 `· runner superd-run 0.3.1-d (…)` 行；dev3 review 走既有 `superd-4996-dev3-review` 转发。
3. macOS 无 PDEATHSIG（泄漏实测确认，killer 主路径）；Windows 仅构建+wine 级（D5 待裁）；裸 alpine（无 bash）仍诚实 exit 127（与 wrapper 同契约）。
4. 首呼成本：每目标首呼 +2 跳（probe miss + upload）+1 verify，实测 ~1.5s 总耗时；之后 1 跳 probe 命中缓存。

## 放行请求

按红线：本轮未 npm publish、未 commit/tag/push。请 user 裁定：
1. 是否放行 0.3.1-d（或指定版本号）进 registry 测试轮；
2. GUI 亲手验收（上面第 2 条）结果；
3. D5（Windows 深度）/ D6（darwin 产物常态化）是否开启后续轮。
