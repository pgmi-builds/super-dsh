# DSH 0.2.1-rc.1 对齐 — 0.3.1-i / 0.3.1-j / 发布 0.3.1-e

2026-10-17（Asia/Hong_Kong）上游对齐轮。user 指令：upstream DSH 更新到 0.2.1-rc.1，启动本轮对齐；授权放下 4999 测试线供本轮使用。同日晚 user 手工验收发现 A2A 会话面回归（单一根因，见文末 0.3.1-j 增补），当轮修复并在两条测试线复验；随后 user 明确放行 push + publish，取 registry 最小未用字母发布 **0.3.1-e**（j 内容原样、仅版本号改动；发布记录见文末）。生产 3080 全程未触碰。

## 基线与上游源码轨

npm `next` = `@deepseek-ai/dsh@0.2.1-rc.1`（2026-10-17，GitHub tag `dsh-v0.2.1-rc.1` = `1600d8a1e140dcde43a1a0941940a0480712c011`，merge PR #6387）；`latest` 仍 0.2.0-rc.2。物理 checkout 从 `dsh-v0.2.1-alpha.1` 前进到 rc.1：alpha.2–alpha.5 随 fetch 一并到达；相对 alpha.1 为 13,744 个非 merge 提交、5,588 文件（+252k/−40k，除 lockfile）——本 rc 吸收了完整 merge window（桌面、subagent 重构、gateway 授权、plugin-market 重做、HMR 依赖同步等）。

构建：清产物 → `git checkout -f` → 唯一 sanctioned 补丁（`pnpm-workspace.yaml` 追加 `storeDir` + `verifyDepsBeforeRun: false`；rc.1 该文件新增 `@fortune-sheet/react`、`app-builder-lib` patchedDependencies，原 diff 上下文失配，按既有精确步骤追加两键）→ `npx pnpm@11.7.0 install --frozen-lockfile && run build`：9/9 gates PASS，`apps/cli/lib/bin.js --version` = 0.2.1-rc.1。0.2.1-alpha.1 起官方 native config loader 已使 unrun / repository-root 两补丁退役，本轮延续单补丁状态。farm 同步：kept=317 relinked=32 removed=11 total=349。

## 接口破坏面与迁移（全部经 LSP/源码核实，非猜测）

1. **Subagent 托管激活重构**（`dsh-tool-subagent` 移除 `backgroundMode`/`run_in_background`；`ctx.subagents` 移除 `start`/`startContinuable`，新增 `startActivation({provider,label,request,signal,delivery:'parent'|'caller'}) → {childId,result,dispose}`；`sendMessage`/`interrupt` 不变）。better-dsh `agent()` 桥接迁移到 startActivation（parent 交付=continuable、caller 交付=one-shot），并保留 legacy 双轨特性检测——声明的 peer 范围（<0.2.1 宿主，含生产 rc.2）行为不变；工具返回 `{kind:'foreground', runId}` 改 `{kind:'foreground', subagentId}`（schema 同步）。新增 pre-0.2.1 legacy 回退测试。
2. **连接信任核心迁移**：HTTP 桥直调 `connection.admit()`，`requestRejection()` 变为其薄包装。better-dsh 的 authentication-only 准入腿从覆盖 `requestRejection` 改为覆盖 `admit`（403 栅栏拒绝→`authorizeIndex` cookie 复核→`browserPeer` 准入；其余裁决原样透传）——一个接缝同时 steer 两条路径。
3. **`webRuntime` 服务消亡**（`web-listener-trust-config` 指南）：better-dsh `cordis.patch.yml` connection 行 `inject:[webRuntime]` 在 rc.1 上使 required 插件永不激活（首启失败实证）。核实 0.1.7-rc.1 / 0.2.0-rc.2 / rc.1 三代 `webStartup` 均存在且携带 `trustedHosts`（`--trusted-host` 值）后，行改 `inject:[webStartup]` 读 `ctx.webStartup.trustedHosts`——对 <0.2.1 宿主仅丢弃 wildcard bind 派生的 LAN 字面量（三代皆拒绝 wildcard bind，本仓线路均显式声明 authority）。
4. **Gateway 调用方身份**（rc.1 每次 invocation 读 `peer.signal/principal`）：hub `/hub` 族转发对 in-process world gateway 传 `peer=undefined` → 所有 world `session/create` 崩（`gateway/internal: reading 'signal'`）。修复：world 注册时捕获 `connection.browserPeer`（targets `ForeignTarget.peer`），carrier `dispatchRpc`/`openWireStream` 与 `worldMuxOf` 全链路透传；mesh 联邦 wire adapter 不受影响（远端自理 peer）。
5. **Profile resolution 语义**：同目录版本变更（realDir 不变）现被 in-place 采纳（HMR era），目录 retarget 仍 `ResolutionRestartRequired`。hub 子类无需改动；world-resolution-refresh 测试按新契约重写（in-place 采纳 + symlink retarget 拒绝双断言）。
6. **元数据/兼容门（无破坏，核实记录）**：`engines.dsh` 优先、未声明沿用 dsh-* peerDeps 规则——两包 `>=0.1.5-0 <0.3.0-0` 覆盖 rc.1，且有新 `plugin allow-version` 豁免通道；subpath 插件不再读 `<subpath>/package.json`——super-dsh 子路径行从未导出该路径，显示回退前后一致（bare `super-dsh` 行为 package-root 不变）；composer `stats` 拆分/`toolPresentation both` 移除/`agent-instructions` dshHome 移除——本仓零使用；`installBundle` 对已装包 under-HMR 拒绝 `already-installed`——hub 仅在未安装时调用，无 over-install 路径；`BundleInfo.installed` 语义不变（hub 只读 name/installed）；`--public-url/--trusted-host/--port/--host/--no-open` 全部健在（新增 `--tls-cert/--tls-key`）；SDK `session/wait` 仅约束 dsh-SDK 协议 runtime，本仓 agent-*-sdk 为外部 SDK fetcher 不适用；headless 凭据优先级变更（env 优先、saved key 默认不读）仅影响 headless 任务——本仓线路均 web 登录，报告知悉。

## 同一组交付产物（0.3.1-i）

| 包 | SHA256 |
| --- | --- |
| better-dsh@0.3.1-i | `77682a7cc48bb9e4bd576689139cb0363007d64c195f40b745acab2255f08591` |
| super-dsh@0.3.1-i | `abc32b1895273f3f6f8dec23698b732f404e450aee8ac670944eba428e0b216a` |

版本号取 `i`：字母序在 0.3.1-d 发布与 0.3.1-g/h 本地轮之后，e/f 未用但 g/h 已被 scratch 轮占用，取 `i` 消歧。独立双包边界经 pack 验证（无 Better 依赖/payload）。dev3 收到同一对 tarball + pair.json，`read-pack-pair` SHA256/manifest/独立包核验通过。

## 行为验收

| 检查 | PC 4999（repo 源码轨 rc.1 构建） | dev3 4998（registry rc.1 独立安装锚） |
| --- | --- | --- |
| 宿主 | upstream checkout 0.2.1-rc.1（`node bin.js --version` 核验） | `npm i @deepseek-ai/dsh@0.2.1-rc.1`（611 包，版本核验） |
| 密码门 / 匿名 API 401 | 通过 | 通过 |
| client 模块唯一 | 70 entries 唯一 | 70 entries 唯一 |
| 七 world ready 无失败 | 通过 | 通过（roster 另含 pairing 表历史 hub agent，ready） |
| 原生 eval `ALIGNMENT-EVAL-42: 42` | 通过 | 通过 |
| 冷重启后同会话回忆口令（turn≥2） | 通过 | 通过 |
| Pi/Codex/Claude/OMP/Hermes create/prompt/冷resume | 全通过 | pi/codex/omp/hermes 通过；claude 外部 429（BigModel glm 余额不足，PC 同路径通过） |
| Antigravity | create 通过；prompt/resume 外部 billing QUOTA（与 alpha 轮相同缺口） | 同样 QUOTA |
| agent 桥接（startActivation 双路径）live smoke | 通过（eval 一次调用内 one-shot `foreground+subagentId` 与 continuable `continuable+subagentId` 双返回，turn completed） | 未单测（同一二进制） |
| 真 Chrome 登录/页面/pageerror | 通过（0 errors，rc.1 版本串可见） | 未做浏览器轮（沿 alpha 轮口径） |

会话判断读取真实 V4 zstd 日志的 tool/call、tool/result、assistant/message、turn/end。native 会话跨两次冷重启恢复。

## 自动验证

root 42 passed / 0 failed；better-dsh 871 passed / 6 failed / 9 skipped —— 6 个失败全部为 `browser-device.spec` 的 `/usr/bin/google-chrome-stable` 缺失（本轮发现该机器路径已不存在；`DASHR_BROWSER_BIN` 指向 chrome-for-testing 后同套件 10/10 通过，环境缺口非代码缺陷）；Hub 638 passed / 1 skipped / 0 failed（含按新 face 更新的 /hub 族与联邦测试）；九个 adapter suite 通过（0 failed）。hub/adapters tsc 0 错；pack 构建（tsc/tsdown/verify-package-pair）通过。

## 本轮发现的 0.3.1 遗留缺陷（与 rc.1 无关，一并修复）

- `458e488`（0.3.1 里程碑）的 re-arm 启发式会把**迁移后的 legacy 移除回执**误判为“中断的首用”而在 Super 升级后复活已卸载的 Better——`Intent` 增加 `removed` 标记豁免 re-arm（`bundle-delivery` 测试恢复 14/14）。
- 同提交的“observed installed 确认 done”语义使 `bundle-delivery` 旧断言过时——测试按已发布行为更新（错误在 observed installed 后清除）。

## 已知缺口与环境备注

- Antigravity QUOTA（PC+dev3）与 dev3 claude BigModel 429 为外部计费/凭据缺口，不计为通过；foreign 验收汇总对它们诚实失败。
- 本机 `/usr/bin/google-chrome-stable` 已不存在；测试用 `DASHR_BROWSER_BIN=/home/u1/.omp/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome`（或 browser.mjs 内置 monorepo-migration chrome）。
- upstream 新增独立 SSH helper 运行时（远端文件/进程/终端/沙箱/Node PTC）——与 superd remote 线（superd-run）生态重叠，remote 线后续方向需 user 裁决，本轮不动。
- 4999 与 dev3 4998 线保持运行供 user 亲手验收：https://test.pc.internal.test/（密码门 admin）；dev3 `http://187.127.111.29:4998/`。

## 0.3.1-j 增补 — A2A 会话面 peer 修复（同日晚，user 验收驱动）

user 手工验收发现：`agent_status` 本地收集与 `send` 到本地 agent 全灭（`gateway/internal: reading 'signal'`）——根因与本轮 /hub 修复同源但漏了一处：进程内 A2A 桥 `bridgeTypertGateway` 仍以 3 参形态调 RAW typertGateway（a2a-host.ts），rc.1 每次 invocation 读 `peer.signal` 即崩。修复：

- `bridgeTypertGateway(real, peer)` 双调用透传 peer；resolver 本地 world 行取 `ForeignTarget.peer`（world 注册时捕获的 `connection.browserPeer`），native 缝取 ctx0 `connection.browserPeer`。
- **native peer 必须懒取**：typertGateway 在自身构造器即注册（gateway/src/index.ts:237），早于 connection 挂载——布线期取值会永远捕获 undefined（0.3.1-j 第一版实证仍崩）；改为 `() => ctx.get('connection')?.browserPeer` 逐次解析。
- 测试：raw gateway fake 的 `dispatchRpc` 改为**元数严格**（<4 参即抛，防再犯）；bridge 断言 peer 逐位透传（stream 第 4 位、dispatch 第 4 位）。

验收：hub 638/0/1；root 42/0。**双线 live 复验**——PC 4999（egv8）：in-line 会话 send `egv8-ifgo5p` → `delivered` + 对端回 `OK` 中继回传；`agent_status` fresh 采集（conversation 0ldh8y，lastOutput "OK"）。dev3 4998（9nzd，全新未配对 home）：send `9nzd-zl4qk6` → `delivered` + `OK`。诊断期对 rig 安装 dist 的临时插桩已还原为 tarball 原像（复验 `delivered`）。

**生产发现（未触碰，留待 user 裁决）**：本 agent 会话的 hub 工具绑定的是 PC 生产 hub（self `skc8`，`~/.dsh`）——实测其运行 **dsh 0.2.1-alpha.4 + superd 0.3.1-a**，同一 A2A 缺陷在场（本次两笔 `send` 失败均发于此，非 4999）；dev3 生产（bfwu，dsh.dev3.internal.test）按 user 报告为 rc.1 + 0.3.1-i，其本地 A2A 同样带 i 系缺陷。两条生产线的修复（升级到 rc.1/0.3.1-j）属生产操作，需 user 单独授权。另：dev3 4998 测试 home 为全新身份 9nzd（remotes 空），与 egv8 的测试线配对未建立——跨机 A2A 的测试线验收走 dev3 生产 bfwu（user 已验 exec）或另行配对。

| 包（0.3.1-j） | SHA256 |
| --- | --- |
| better-dsh@0.3.1-j | `3efde640f0a1913ccb79953d83cb78ba67753e5fec32b65c773dd149d31fe429` |
| super-dsh@0.3.1-j | `8020ed404ce00dca1543df618ac105fbddf1285e97e1675d28e8c0b14e2d6d87` |

（better-dsh@0.3.1-j 内容与 i 相同字节，仅版本号同步；super-dsh 携带 A2A 修复。）

## 发布 0.3.1-e（2026-10-17 晚，user 放行：push + publish，最小字母版本）

registry 已发布字母 a/b/d → 最小未用字母 **e**。j 内容原样重版本（仅版本号差异），root 42/0，4999 整线装 e 双包重启后 A2A send smoke `delivered`（conversation 0ldh8y）——发布字节与验收字节一致。

| 包 | SHA256 |
| --- | --- |
| better-dsh@0.3.1-e | `38eb5478b2e2a771746338906600734ca58b87527fed775519ef8901d225ad93` |
| super-dsh@0.3.1-e | `803c1417bf221fe5061a0b3f6390c372df145e70a4e966c9423cb8d1aac841ca` |

npm publish（pgmi-builds，token 经 secrets store 显式注入）两包 latest → 0.3.1-e；git tag `v0.3.1-e` 与 master 一并推送。授权来自 user 本轮明确指令，不沿用到下次。

私有证据在 `.scratch/alignment-0.2.1-rc.1/`（PC）与 dev3 `~/workspaces/superd/.scratch/alignment-021rc1/`（构建/安装/对账/会话/浏览器/双机 matrix）。含认证的文件不进 Git。

## dev3 生产部署 — rc.1 + 0.3.1-e（2026-10-17 21:29–21:34，user 明确授权）

user 指令：从 registry 安装 dsh 0.2.1-rc.1 + super-dsh 0.3.1-e 到 dev3 生产，并确认重启。变更前现场实测：bfwu `dsh.service`（3080，dsh.dev3.internal.test）运行 **dsh 0.2.1-alpha.1 + super-dsh/better-dsh 0.3.1-a**（进程 2026-10-12 23:35 起）——与上节“rc.1 + 0.3.1-i”的转述不符，以现场为准。

- 全局安装：`npm install -g @deepseek-ai/dsh@0.2.1-rc.1`（added 75 / removed 22 / changed 536，1m）；`dsh --version` = 0.2.1-rc.1。
- Profile：`dsh plugin --profile web add super-dsh@0.3.1-e better-dsh@0.3.1-e`（pnpm 12.10.1，4.8s，lockfile supply-chain policy 通过）；node_modules 两包 = 0.3.1-e。备份 `package.json.pre-031e.bak`、`pnpm-lock.yaml.pre-031e.bak`。
- 重启：stop → 安装 → start（user 本轮授权）；dsh.service active，127.0.0.1:3080 监听，进程 21:31:32 起（rc.1 bin）。
- 验收：`https://dsh.dev3.internal.test/` = 200；匿名 `/api/*` = 401；`--dump-config` exit 0（1426 行，superd 行齐）；boot 日志无 error（仅各 world 的 harness-dev-context pending webApp 既有 warning）；PC 4999 hub roster 中 bfwu 七 world 全 ready=true；重启后首轮常规 sweep（21:36:46）本地采集 ok（7 agents，无 note）；hub exec 通道恢复（回读 rc.1 / 0.3.1-e）。
- 过程注记：首次经 hub exec 通道执行 stop 时，该通道随 prod 进程一起断开（502），后续安装/启动改用 SSH `remote` 通道完成；无残留 pnpm 进程，备份保留。
- 未触碰（本步）：PC 生产 hub（skc8）——同一轮 user 指令随后扩展到 PC 生产，见下节。

## PC 生产部署 — rc.1 + 0.3.1-e（2026-10-17 21:34–21:41，同轮 user 指令 “Do the same to pc prod”）

变更前现场：homepc `dsh.service`（3080，dsh.pc.internal.test，`DSH_HOME=~/.dsh`）运行 **dsh 0.2.1-alpha.4 + super-dsh/better-dsh 0.3.1-a**，同一 A2A 缺陷在场。

- 全局安装：`npm install -g @deepseek-ai/dsh@0.2.1-rc.1`（added 75 / removed 22 / changed 536，1m；npm 12 默认跳过 install-scripts——node-pty/koffi 经 require 验证可加载，linux-x64 无 spawn-helper 需求）；`dsh --version` = 0.2.1-rc.1。
- Profile：`dsh plugin --profile web add super-dsh@0.3.1-e better-dsh@0.3.1-e`（pnpm 12.10.1，2s）；node_modules 两包 = 0.3.1-e；备份 `package.json.pre-031e.bak`、`pnpm-lock.yaml.pre-031e.bak`。
- 重启：stop 21:34:37 → 安装 → start 21:35:25（user 本轮明确指令）；active，127.0.0.1:3080 监听，停机 48s。
- 验收：`https://dsh.pc.internal.test/` = 200；匿名 `/api/`、`/api/superd/machines` = 401；boot 日志无 error（仅六个 world 的 harness-dev-context pending webApp 既有 warning + token 行）；重启后首轮常规 sweep 21:40:36：本地 skc8 采集 ok（7 agents / 74 rows，无 note），remote bfwu ok——与 dev3 21:36:46 的本地采集共同证实 0.3.1-e 本地腿在 rc.1 上工作。
- 注意：boot tick 按设计跳过 local 腿（`localCollect=false`），本地 agent_status 缓存要到启动后首个 5 分钟常规 tick 才刷新；此前的“失败”条目是上一进程的遗留，不是新 build 的失败。
- 未触碰：dev3 4998 测试线与 PC 4999 测试线（本次只动两处 prod）。
