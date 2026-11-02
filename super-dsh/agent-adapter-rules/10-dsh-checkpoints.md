# DSH 侧强制检查点（所有 foreign agent adapter 必过）

> DSH 是终点：adapter 把异构上游接到统一的 DSH UI / 后台 / session log 规格上。
> 本表语言全部是 **DSH 侧行为**，与上游形态无关；codex / claude / omp / hermes / pi / agy / … 一视同仁。
> 每条含「要求 / 未达标签名 / 验法」。签名引真实事故（出处见 `30-*.md` 各文件）。

## G1 会话生命周期门

- **要求**：create → prompt → 助手回复 → turn 闭合；steer / interrupt 中途插话生效；restart 后 resume 既有会话。验收 = **真实模型轮**，boot / mount 探针不算。
- **resume 语义**：外来记录但从未到达模型的会话 → 诚实报错并指引重建，不得给误导性错误（hermes 2026-11-02 E2：fresh record 报 "predates durable-id capture" 教训）。
- **未达标签名**：一切回合 GATEWAY_CRASH = 传输 / spawn 层断（hermes：gateway 拒 stdio spawn）。
- **验法**：真实 UI 交互工具（browser-bridge 族）逐字回复验证；纪律见 `docs/07` §4.2（2026-11-02 user 裁决：绝不由 API/curl 代验）。

## G2 会话日志门（v4 写纪律 = 回放闸）

- **要求**：DSH session log 是 WebUI 的读取面，writer 纪律：header 行在前；事件 `seq` = 行号 − 1；`tool/call` 必须落在已广告的 step 里；`turn/end` 必须闭合当前 turn；**错误路径（崩溃 / 被拒 / 中断的 turn）也要补 closer**，不得留裸事件。
- **未达标签名**：回放炸（Session unavailable）+ 污染新建会话流程 + 每个 failed turn 再产一条新坏档（恶性循环）——hermes 2026-11-02 在 PC 与 dev3 双机实测（共 12 档，全为被 gateway 拒绝后中断的 turn）。
- **验法**：adapter 任何改动后跑 log sweep（**real-reader 驱动**，不是语法猜测）；restart → 会话列表 → 回放 → resume 实测。
- **修复工具**：real-reader 驱动的 clone+remap 修复已在案（`fixes` 计数可能读 0，以复扫全绿为准）。

## G3 组合 / 设置门（原生 UI 挂载闸）

- **要求**：原生 UI 的 onboarding 面（welcome / preview notice、settings 行）读的是 **composition 投影的 settings 值**，不是可变存储。world 组合必须携带 CTX0 的 `ui-settings-general` ack 行（0.3.4-b 起 `world-provision.ts` 自动镜像——**改动 provision 模板时必须保住这一行**）。占位模型 id 不得写 settings、不得传 runtime。
- **未达标签名**：弹窗 + "The acknowledgement could not be saved. Please try again."——写永远无法在回读中反映，**结构性**失败（换浏览器 / 重试无用）。
- **通则**：**任何原生 UI 面都必须在 world 上下文里重验**；CTX0 通过 ≠ world 通过（世界组合是另一个投影）。PC 曾因 Better skip 策略遮蔽而「看起来没问题」，非结构保证。
- **验法**：world 页新建会话，观察无 notice / welcome 残留；点过之后回读持久。

## G4 工作区与降级门

- **要求**：session cwd = 用户工作区，**绝不指任何 home**（dev-rules §5 红线）。工作区路径消失 / 改名、last-used model id 失效 → DSH 可见**诚实降级**（明确提示 + 显式 skip），不得 crash loop、不得外流占位值。
- **未达标签名**：UI 报找不到旧 workspace path 反复重试；模型列表出现 `*-default` 占位。
- **验法**：改路径 / 删目录后打开既有会话，观察降级面。

## G5 上游进程所有权门（2026-11-02 立例）

- **要求**：接入任何上游前先问：**它是否假设常驻 daemon 独占其 home？**（hermes：resident gateway 持有 `~/.hermes`；codex：app-server daemon 存在但 adapter 自管 spawn。）若存在，adapter 必须**自动探测**所有权拒绝（"owned by a running gateway" 族错误）并**自动切换** attach / 连接既有 daemon——**不得要求用户手动 patch 环境变量或配置**。边界红线：装 DSH + 装插件 → 同机同 OS 开箱可用。
- **未达标签名**：新会话首回复即被拒（hermes E1）；或「装完还要手动拨 lever 才能用」。
- **验法**：常驻 daemon 在跑的机器上开箱新会话；关掉 daemon 再开箱新会话（两态都要通）。

## G6 验收门

- **要求**：真实 UI 交互验收（browser-bridge 族工具，页面密码解锁，不注 cookie）；通道 = 4999 pack 线 + dev3 目标机实装；per-runtime **create / prompt / resume** 全过。
- **未达标签名**：以 HTTP wire / boot 存活代替行为验收（2026-11-02 user 裁决：API 级测试对 adapter 验收无意义，最后一公里就是 UI）。

## 检查点一览（速查）

| # | 门 | 一句话 | 本次事故对应 |
|---|---|---|---|
| G1 | 生命周期 | 真实模型轮 create/prompt/steer/resume + 诚实 resume 报错 | E1 回合全灭、E2 误导报错 |
| G2 | 会话日志 | v4 不变量 + 错误路径 closer，sweep 复扫 | 12 档坏 log 卡新会话 |
| G3 | 组合/设置 | world 组合镜像 CTX0 ack 行；原生 UI 面在 world 重验 | notice 存不上 |
| G4 | 工作区 | cwd=工作区；缺失 → 诚实降级 | （既有规则重申） |
| G5 | 进程所有权 | 常驻 daemon 探测 + 自动 attach，零手动 lever | stdio 被 gateway 拒 |
| G6 | 验收 | 真实 UI + tarball 线 + dev3 | 2026-11-02 裁决 |
