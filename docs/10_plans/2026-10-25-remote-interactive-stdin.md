# Remote execution：PTY 交互输入与 one-shot 等待窗口优化计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 不自行启动并行 Agent；验收、报告和本次 user 放行之前不 commit / tag / push，不发布 npm。

**Goal:** 让模型能向正在运行的 PTY 命令继续提供 stdin，同时保留 `cmd` 的新命令语义；评估 one-shot 等待超时后携带当前输出转后台的可行性。

**Architecture:** 复用现有 PTY 会话、输出环、命令账本和官方 jobs 通道，新增独立的输入动作；输入直接写入已有会话，不重新包装成 shell 命令。新命令仍由现行 `cmd` 路径执行，忙碌时立即拒绝。one-shot 的等待窗口与进程取消期限分离属于独立第二阶段，不阻塞 PTY 主线。

**Tech Stack:** TypeScript、Node.js child_process / streams、Cordis、DSH tools / jobs、SSH / Docker / Incus PTY、现有整包 tarball 与 launcher。

**Spec:** 本文件 §1–§4 记录 2026-10-25 user 本轮需求及接口裁决；既有边界参见 [remote tools](../remote-tools.md)、[remote surface 动作计划](../superpowers/plans/2026-10-25-remote-surface-actions.md)、[通用开发测试指南](../07-cordis-dsh-dev-test-guides.md)。本文件为待实施计划，不代表功能已经交付。

## Global constraints

- 用户指定本计划位于 `docs/10_plans/`；这覆盖默认计划目录。
- `better-dsh/src/remote/` 是唯一可编辑源码；Super 的 `remote/` 为生成闭包，不手改。独立双包、无 Better 依赖边及 provenance 逐叶哈希契约保持。
- 不改上游源码；复用官方 jobs 注册、owner fencing、输出消费和清理机制，不另造任务注册表。
- 不触碰 `~/.dsh`、`~/.superd`、生产 3080 / 3081 或 live Caddyfile。
- 使用实际 LSP 定义 / 引用与 AST 结构核验；源码测试不能代替本地 4999 整包 tarball 线和 dev3 测试实装。
- 每轮测试使用同步的新字母版本，经根 `npm run version:release -- <本轮版本>` 更新；实施时核实当前版本和下一个后缀，不在本计划预占版本。
- 行为与模型可见 Surface 一起验收；保留 Web 测试线和访问 URL，报告落 `docs/test-reports/`。
- 本次仅编写计划。实施、发布及 Git 定版遵守根 AGENTS 的各自授权边界；本计划不构成 npm 发布许可。

## 1. 需求、范围与职责

### 1.1 本轮必须交付：PTY 可交互

1. 模型可以先启动程序，观察输出，再向同一个运行中命令追加 stdin，包括密码、OTP、token、选项、REPL 输入和控制字符。
2. `cmd` 始终表示新的一条 shell 命令。上一条命令正在运行、阻塞或等输入时，新的 `cmd` 立即报 busy；不得悄悄作为上一程序的输入，也不得排队到未知时间执行。
3. stdin 与 cmd 保持独立字段、独立分派语义。工具不判断某段文字是密码、代码还是选项，不自动补换行，不自动猜 EOF，不把 stdin 拼入 cmd / argv / heredoc。
4. 输入后沿用当前命令与 job 的身份及输出通道，不新增一条命令、一个 job 或一套输出游标。
5. 所有需要“观察提示后继续输入”的工作流都选择具有追加输入能力的 PTY。one-shot 仍可携带启动时已知的一份 stdin，但不承担交互式补输。

### 1.2 独立评估：one-shot 等待超时转后台

期望行为是：等待窗口到期，命令不被杀，回执包含截止此刻已捕获的 stdout / stderr、运行中状态、jobId 和下一步操作；模型可以判断继续等待还是取消。one-shot 本轮不新增运行后的 stdin 写入。

源码已存在 one-shot **启动时**的 stdin：`process.ts` 的 `child.stdin.end(options.stdin)`。本轮说“不增加 one-shot stdin”特指不增加**后续追加输入**，不得误删既有能力，也不得把未来转后台描述成自动获得交互能力。

### 1.3 不做的产品扩张

不构建提示词 / 密码提示识别器、万能 EOF wrapper、自动重放输入、自动生成 heredoc、全屏 TUI 画面重建、二进制输入协议或新的进程管理服务。模型决定使用方式；工具负责字节传递、输出可见性、身份和生命周期。

## 2. 现状与证据

| 事实 | 当前落点 | 对本轮的影响 |
| --- | --- | --- |
| `action` 必填，动作决定字段白名单 | `better-dsh/src/remote/tool.ts`，`ACTION_PARAMS` / `remoteExecute` | 追加输入用独立动作，不回退到按字段在场猜路由 |
| stdin 被要求与 cmd 同时提供 | 同文件，`E_STDIN_WITHOUT_CMD` | 新动作必须允许只有 stdin；既有 exec 组合保持兼容 |
| PTY 先写包装后的 cmd，再紧跟写 stdin | `pty-session.ts`，`dispatch` | 字段能携带控制字符，但没有“看到提示后再输入”的调用入口 |
| PTY 超时已有 running job handoff | `pty-session.ts`、`tool.ts`、`jobs.ts` | 复用 commandId / jobId、输出环与收养逻辑 |
| detached job 忙碌时报错；部分同步并发仍排 FIFO | `pty-session.ts`，`queue` / `inFlight` / `detachedJob` | busy 规则必须覆盖全部运行中命令，不能只检查 detached job |
| one-shot 流和后台任务已经存在 | `RemoteProcess.read/done/cancel`、`driver.start`、`startRemoteJob` | 转后台可复用进程和输出，无须重跑命令 |
| one-shot 超时目前直接触发 cancel | `process.ts`，`startBinaryProcess` 的 timer | 不能只改 Promise.race 或回执；必须避免执行层先杀进程 |
| Hub 接收端也获得 `timeoutSec` | `super-dsh/superd-hub/src/remote-job-client.ts` / `remote-job-rpc.ts` | 全通道超时改义牵涉远端监督和租约，不是单一工具层改动 |
| 既有 `hub:<machine>:pty` 没有可复用 session / 追加输入协议 | `hub-contract.ts` / `driver.ts` / Hub provider | 不得把这一旧通道宣传成已经可交互 |

本会话的隔离实验：Codex 本地 PTY 与已安装 Codex Remote 插件 BYO PTY，在命令与控制字符连发时都复现过 `cat` 未结束；本地待 `cat` 运行后再发送 Ctrl+D 能正常结束，外层 shell 继续可用。该证据说明发送时机是实际验收点，不证明仓库当前 tarball 已完成验收。已安装插件的调用 schema 与本仓 2026-10-25 新 action schema 不同，实施时以本仓源码和新 tarball 为准。

准备计划时已用 TypeScript AST 核实 `dispatch → write(wrapPtyCommand) → write(stdin)`、`registry.start → driver.start` 与 one-shot `stdin.end` 结构；此前 LSP 定义 / 引用查询只返回部分链接，不能据此宣称全链路符号分析完成。实施预检需在实际 tsconfig 下补齐引用追踪。

## 3. PTY 接口与行为裁决

### 3.1 新增 `action: "input"`

保留 `exec | add | status | close`，新增第五个动作 `input`。这样继续遵守“action 是唯一派发维度”，不用在 `exec` 内依据 cmd / stdin 是否出现再猜动作。

```json
{"action":"exec","target":"ssh:dev3:pty:login","cmd":"some-interactive-program","timeout":2}
```

模型从回执取得 session / commandId / jobId，使用 `job_output` 观察提示，再调用：

```json
{"action":"input","target":"pty:login","stdin":"example-response\n"}
```

示例中的程序名和响应是说明用途的假数据，不是应执行的登录命令。实际验收使用自有夹具生成的提示和非真实凭据。

| 动作 | 字段契约 | 语义 |
| --- | --- | --- |
| `exec` | 维持 cmd / scriptPath 与既有 exec 参数 | 启动新命令；cmd+初始 stdin 继续支持，但不保证控制字符的提前发送时机 |
| `input` | 必填 `target`、`stdin`；可选 `commandId` | 只写已有、正在运行的 PTY 命令 |
| `input` 禁用字段 | cmd、scriptPath、ssh、spawn、force、timeout、run_in_background | 不创建会话，不启动命令，不隐式转后台，不改变原任务期限 |

`target` 接受 `pty:<id|label>`，也接受经同一 Agent 池确认为 PTY 的裸 label；不接受 machine target 或带 `:pty` 的创建形。可选 `commandId` 是匹配当前运行命令的保护条件：不匹配就拒绝，避免把针对旧提示的输入写给下一条命令。

### 3.2 会话状态、并发与失败规则

| 当前状态 | 新 cmd | input |
| --- | --- | --- |
| ready / idle | 按既有路径执行新命令 | `E_SESSION_NOT_RUNNING`；不把它变成隐式 shell 命令 |
| 正在运行 / 等输入 / detached job | 立即 `E_SESSION_BUSY` | 向当前命令写入，复用身份 |
| 正在建连 / 预热 | 保留明确的创建占位规则，不能重复派发 | 明确 not-ready 错误，不提前缓冲凭据 |
| dead / disposed / 不存在 | cmd 保留原有重连 / 不存在行为 | 明确拒绝，不自动重连、不重放输入 |
| 不属于当前 Agent | 按既有 owner 隔离拒绝 | 同样拒绝，不能按全局 label 越权写入 |

- `input` 不加入“等整条命令结束才放行”的 `dispatch.queue`，否则等待输入的命令会与补输入动作死锁。
- 命令占位在异步启动前建立；第二条 cmd 不能利用首条尚未 timeout / detach 的窗口排入 FIFO。
- 多次 input 按收到的调用顺序写入，整段 stdin 不交错；完成、关闭、取消与 write 之间检查活动状态及可写性。写失败必须返回错误，不能沿用私有 `write()` 的静默忽略作为成功回执。
- 可选 commandId 在实际写入前再核对；它不能消除远端程序在任意瞬间退出的终端固有竞争，回执只承诺写入通道，不承诺程序已经读取或接受内容。
- `stdin: ""` 是明确的零字节写入，不代表 EOF，也不作为新增输出轮询入口。状态仍须符合运行中约束。

### 3.3 输入回执与输出归属

拟定内部接口（名称在任务间保持一致）：

```ts
interface PtyInputOptions { stdin: string; commandId?: string }
interface PtyInputReceipt {
  session: string
  commandId: string
  jobId?: string
  writtenBytes: number
}
// PtySession.input(options: PtyInputOptions): Promise<PtyInputReceipt>
// RemoteDriver.input(target, options, { sessionKey }): Promise<PtyInputReceipt>
```

Tool value 增加 `kind: "input"`，保留上述身份与写入 UTF-8 字节数；render 明示“已写入，使用原 jobId 的 job_output 查看响应”。不回显 stdin，不把输入内容加入账本摘要、job label 或额外日志。程序本身是否回显由终端 / 程序决定，工具不承诺自动识别和遮蔽所有秘密。

输入动作不新建命令账本条目，不重新 adopt 同一个 job，不分配第二个输出消费游标。原任务的输出继续由同一个 parser / ring / jobs producer 收集；`job_output` 读取响应。首次 exec 超时回执继续携带已捕获的输出，不能退化为只有 jobId。

### 3.4 EOF、控制字符与教学边界

- `input.stdin` 原样传递文本及可表示的控制字符；不做 shell quote / 语法解析，不把字面 `\\x03` 自动再解码。
- JSON 用 `"\u0003"` 表示 Ctrl+C 对应字符，用 `"\u0004"` 表示 Ctrl+D；它们不是换行，Enter 通常用 `"\n"`。
- 终端模式开启相应规则时 Ctrl+C 可触发中断、Ctrl+D 可让读取者观察到 EOF；关闭这些规则的 REPL / TUI 可以自行处理。工具不保证某个字节对所有程序都生效。
- Ctrl+D 不等于永久关闭 PTY 写通道；在未换行的非空行中可能只交付已有文字。不得自动追加 Ctrl+D，也不新增一个声称无条件永久 EOF 的 `then:"eof"`。
- `job_kill` 仍是需要明确取消任务时的官方入口，保持已有中断及清理语义；直接输入控制字符不自动变成一次管理层取消请求。
- heredoc / `< file` 继续作为模型可选的批量输入办法；不制定“永远不用 stdin”的全局禁令。

### 3.5 可交互通道的诚实覆盖

第一阶段覆盖 SSH、Docker、Incus 创建的 live PTY 与 BYO PTY，均经同一 PtySession 输入入口。Super 生成闭包消费同一实现。

旧的 `hub:<machine>:pty` 不具备 session 身份和写入协议，本轮不将其冒充交互 PTY。input 必须 fail-loud，错误提示使用可寻址的 SSH / Docker / Incus / BYO PTY；surface 明示这一例外。后续若统一 Hub PTY 为可寻址会话，应另列 Hub 协议任务，不能静默重启对端命令假装补输成功。

## 4. One-shot 评估结论：可行，独立第二阶段递延

### 4.1 复杂度依据

| 层 | 可复用部分 | 必须改变的部分 |
| --- | --- | --- |
| 进程与输出 | `RemoteProcess.read/done/cancel`、双流输出环 | 把同步等待窗口与取消计时器分离；共享文件搬运 / helper probe 的硬期限不能一起改义 |
| 官方 jobs | 已有 one-shot background producer、owner / controller admission | 同一个进程只启动一次；foreground 变 handoff 后仍由同一个 owner 管理 |
| Tool 回执 | 现有 stdout / stderr 渲染、outputStats / running / jobId | 窗口到期立即返回已捕获的两路输出，正确处理恰好完成、截断与最终 drain |
| Hub | 已有任务流、取消、租约清理 | 调用端窗口与接收端 timeoutSec 的语义一起核实，否则“转后台”的进程仍会被对端杀死 |

结论：不是重写执行框架，但属于**中等规模的跨层生命周期修改**，明显大于增加一个 stdin 写入口。不能通过删除公共进程计时器一刀切完成。本轮优先完成阶段 A；阶段 B 递延，不作为 A 的完成条件，不预先改变文档里的 one-shot timeout 承诺。

### 4.2 第二阶段推荐实现方向与准入条件

1. 在允许 handoff 的执行开始前走官方 job admission，再建立唯一的 process / output producer。避免命令已经开始后，因缺 controller 或 Agent scope 已销毁而出现无人接管的进程。
2. 工具层 timeout 表示同步等待窗口；窗口到期不取消 process。helper 探测、文件通道、显式清理请求仍保留硬期限。不要修改 `startBinaryProcess` 全部调用者的默认语义。
3. 复用同一个 job 的输出源：快速完成返回终态输出；仍运行返回 `running:true`、`exit:null`、jobId、截至窗口的 stdout / stderr 与统计。不能重跑 cmd 或通过第二个 SSH 连接重新执行。
4. 输出游标明确：初次快照标注其含义；后续 `job_output` 依官方 registry 消费规则工作，不通过清空进程环来消重，也不丢弃交接窗口中新到达的字节。若重放已返回片段，必须在回执明确披露，不能静默重复。
5. 无官方 jobs/controller 时维持有说明的旧行为：按原 timeout 取消并返回已有输出及“不支持继续接管”的提示，不留下无主进程，不声称已转后台。
6. 对 Hub 同时核验调用端、接收端与租约持有者；不能做到全程 owner 持续存在及远端不误杀，就保持旧语义并在阶段 B 报告列明，不能推广成全通道已支持。
7. 等待密码之类的输出应如实返回，但不得据此宣传 one-shot 可补输；提示模型可取消并改用 PTY。one-shot 的初始 stdin 已关闭时，程序也可能直接得到 EOF，而非一直等待。

阶段 B 只有在 admission、远端期限、交接输出和 owner teardown 都有确定方案且测试通过后才能启用；否则继续递延，保留本节作为后续工作的明确起点。

## 5. 实施任务

### Task 1：先锁定会话写入与 busy 行为

**Files:** Modify `better-dsh/src/remote/pty-session.ts`；Test `better-dsh/test/remote/pty-session.spec.ts`；Create `better-dsh/test/remote/pty-input.spec.ts`。

**Interfaces:** 产生 §3.3 的 `PtyInputOptions`、`PtyInputReceipt` 与 `PtySession.input`；复用原 dispatch 的活动命令身份与输出环。

- [ ] 用 LSP 查 `PtySession.dispatch`、`PtyRunningJob` 和 driver 引用；用 AST 确认所有直接 write / queue / detachedJob 的匹配范围，并记录原有同步并发 FIFO 将被本需求替换。
- [ ] 先增加真实 PTY 回归夹具，使用 `script -qfec bash /dev/null`，不能拿普通 `bash` 管道模拟终端。夹具输出 `Password:` 后禁回显读取一行，输出 `OTP:` 再读一行，仅输出 `ACCEPTED`，不输出测试凭据。
- [ ] 测试先断言当前入口不存在 / 行为失败，再实现 input：等待第一提示后发送第一行；等待第二提示后发送第二行；原命令结束且 exit=0；同一 shell 后续 `pwd` 正常。
- [ ] 增加同一会话第一条 cmd 尚未 detach 时第二条 cmd 立即 busy 的测试；input 不等命令结束。再覆盖 detached job 和多次输入的整段顺序。
- [ ] 覆盖 idle / dead / disposed / stdin 空串 / 错误 commandId / 写入失败；输入不得自动重连或新建账本。
- [ ] 真实终端用例覆盖：等 `cat` 就绪后 Ctrl+D、无末尾换行时需要的两步操作、原样字面 `\\x04`、关闭特殊字符处理后读到实际 `0x03/0x04`。取消和信号行为测试使用容器 / VM，沿用现有安全夹具，不做主机进程组信号扫射。
- [ ] 运行 `cd better-dsh && ./node_modules/.bin/vitest run test/remote/pty-session.spec.ts test/remote/pty-input.spec.ts`，确认不把“写入成功”误测成“应用已经读取”。

下面是 `pty-input.spec.ts` 的首个行为测试，依据 §3 接口实施后运行；它不是已通过的现状测试：

```ts
import { expect, it, vi } from 'vitest'
import { PtySession } from '../../src/remote/pty-session.ts'

it('answers two prompts inside one command and retains the shell', async () => {
  const session = new PtySession({
    key: 'input-owner|p:input-test', id: 'input-test', connection: 'fixture',
    argv: ['script', '-qfec', 'bash --noprofile --norc -i', '/dev/null'],
    idleTtlSec: 600,
  })
  try {
    const commandId = 'input-command'
    const started = await session.dispatch(
      `printf 'Password:'; IFS= read -r pw; printf '\\nOTP:'; IFS= read -r otp; [ "$pw" = demo ] && [ "$otp" = 123456 ] && printf '\\nACCEPTED\\n'`,
      { commandId, background: true },
    )
    expect(started.running).toBe(true)
    const job = started.job!
    await vi.waitFor(() => expect(job.read(0).text).toContain('Password:'))
    await expect(session.dispatch('echo must-not-run', { commandId: 'other' }))
      .rejects.toThrow('E_SESSION_BUSY')
    await session.input({ commandId, stdin: 'demo\n' })
    await vi.waitFor(() => expect(job.read(0).text).toContain('OTP:'))
    await session.input({ commandId, stdin: '123456\n' })
    const result = await job.done
    expect(result.exit).toBe(0)
    expect(result.output).toContain('ACCEPTED')
    expect(session.ledgerSnapshot()).toHaveLength(1)
    const next = await session.dispatch('pwd', { commandId: 'next' })
    expect(next.exit).toBe(0)
    expect(next.reconnected).toBe(false)
  } finally {
    await session.dispose()
  }
}, 10_000)
```

### Task 2：接入 driver、schema 与现有 jobs

**Files:** Modify `better-dsh/src/remote/driver.ts`、`tool.ts`；仅在关联元数据确需共享时修改 `jobs.ts`；Test `better-dsh/test/remote/tool.spec.ts`、`jobs.spec.ts`、`driver.spec.ts`、`agent-registration.spec.ts`。

**Interfaces:** 消费 Task 1 的 input；产生 `RemoteDriver.input`、新 action 白名单与 `kind:"input"` 回执。`exec` 的 cmd 语义不变。

- [ ] 先加 schema 与 execute 双层测试：action 必填；input 无 cmd 合法；input 携带 cmd / scriptPath / timeout 等字段报错；exec 仅有 stdin 仍报错；cmd+初始 stdin 保持兼容。
- [ ] driver 经现有 caller-scoped label 池解析 live PTY；input 不触发发现、拨号、创建或 auto-reconnect。machine、创建形和旧 Hub PTY 给出可恢复的明确错误。
- [ ] 通过真实 scoped tools + 官方 jobs 运行 `exec → 初始输出/提示 → input → job_output → input → 原 job 完成`。同时检查 commandId 不变、账本长度不因补输增长、没有重复 job registration。
- [ ] 校验不同 Agent、不同 PTY、旧 commandId、取消 / close / 任务完成竞争；busy 错误必须同时给出 input、job_output、job_kill 和另开会话的正确用途。
- [ ] input 回执不包含输入正文；不额外复制到账本、错误或任务名称；程序自身 echo 的输出按真实终端行为返回，不写虚假的全面保密承诺。
- [ ] 运行 `cd better-dsh && ./node_modules/.bin/vitest run test/remote/tool.spec.ts test/remote/jobs.spec.ts test/remote/driver.spec.ts test/remote/agent-registration.spec.ts test/remote/input.spec.ts`。

### Task 3：同时交付模型看到的教学 Surface

**Files:** Modify `better-dsh/src/remote/tool.ts`、`docs/remote-tools.md`；Test `better-dsh/test/remote/tool.spec.ts`、`agent-registration.spec.ts`；按 `docs/package-catalog.json` 的既有副本流程生成消费文档，不手改包内副本。

**Interfaces:** action / 字段 schema、description、错误恢复提示和输出 renderer 必须表达同一契约。

- [ ] 将“PTY is a stateful oneshot”作为唯一定位的表述改为“persistent and interactive terminal session”；保留状态持久能力，但突出分步观察和输入。
- [ ] 教学必须包含下面的实用流程，且模型真实 catalog 能看到，不得只写 inline comment：

```text
需要密码 / OTP / token / 选项 / REPL 后续输入 → 创建或复用可交互 PTY。
exec + cmd 启动新命令；running 回执包含当前输出和身份。
观察提示（必要时 job_output）→ input + stdin 发送原样内容。
要提交一行，明确包含换行；控制字符依终端 / 程序规则处理。
补输后沿用原 jobId 读取响应；新 cmd 在 busy 时失败。
一次性已知数据仍可给 one-shot 的初始 stdin；它不支持后续互动。
```

- [ ] 明示 `input` 的回执确认写入，不代表密码正确 / 登录成功；完成结论依后续程序输出和原任务状态判断。
- [ ] 明示旧 Hub PTY 的能力例外、one-shot timeout 本阶段仍取消、heredoc 不是强制方案，不保证 Ctrl+D 对所有程序通用。
- [ ] 验收真实 runtime 的工具描述、参数说明、错误信息和输出中的恢复提示，不能只对说明字符串做包含断言。

### Task 4：整包、目标机与真实模型验收

**Files:** 按需补充 `super-dsh/test/remote-delivery.test.mjs`；生成 `docs/test-reports/YYYY-MM-DD-remote-interactive-stdin.md`（日期取实际实施日）；如有真实机制变更更新 `docs/07-cordis-dsh-dev-test-guides.md`。

- [ ] 确认当前工作树已有改动的归属，不覆盖本计划前已存在的 action / transfer 及上游对齐工作。按实际版本选新字母后缀，执行根版本同步。
- [ ] 运行 `npm --prefix better-dsh run typecheck` 和 `npm --prefix better-dsh test -- test/remote`；重点失败修复后再进入打包，不用一遍遍全量测试代替交付验收。
- [ ] 运行根 `npm run pack`，核验独立 Better/Super、生成 remote 的 provenance、无新增 Better 依赖边；用现有 package-pair 校验流程验证产物。
- [ ] 经 `bash super-dsh/test/start-4999.sh` 启动本地整包线，复用测试 home / launcher 的认证与监听机制；再通过同一 tarball、pair.json 和既有 launcher 在 dev3 的测试环境实装，不重建另一套产物。
- [ ] 在两个安装现场由真实模型执行：提示可见→密码→下一道 OTP→完成；忙碌时误发 cmd→读懂错误后改用 input；EOF→shell 继续可用；取消→核对重连提示；跨会话 / 跨 Agent 拒绝。覆盖 SSH、Docker、Incus、BYO 的受影响路径，记录环境中确实具备的通道及未覆盖项，不伪造全覆盖。
- [ ] 使用有限、自有、非真实凭据的夹具；每个受影响 agent runtime 验证 create / prompt / resume，并确认恢复后旧的进程内 PTY 身份是否仍可用，失效时诚实报错而非向新 shell 重放凭据。
- [ ] 报告记录实际 artifact 版本/哈希、安装现场、模型可见 schema/description、命令与输入时序、输出和终态、清理结果及局限；保留 Web 线，给 user 访问 URL 手验。
- [ ] 阶段 A 的验收、报告及 user 放行满足后，再按根红线处理 Git 定版；npm 仍需本次单独明确发布许可。

### Task 5：阶段 B 的独立执行清单（递延）

**Files:** 预计涉及 `better-dsh/src/remote/driver.ts`、`jobs.ts`、`tool.ts`、`hub-contract.ts`；若需要独立等待适配器，新增 `better-dsh/src/remote/oneshot-wait.ts`；Hub 的 client / RPC 只在实际需要改期限传递时修改。公共 `process.ts` 的硬期限调用者逐项核验，不整体改义。

- [ ] 先为 §4 的七条准入条件逐项写出实际调用链和测试；无法在官方 admission / owner 生命周期内成立，则保持递延，不进入产品实现。
- [ ] 增加启动一次的计数夹具：例如 `printf 'Password:'; sleep 30`，设置远短于 30 秒的等待窗口；窗口到期回执必须含该提示、running、jobId；随后取消并验证自有进程/子进程已清理。这里验证提示可见及 handoff，不谎称这个 one-shot 夹具支持密码补输。
- [ ] 覆盖快速完成、窗口边界恰好完成、stdout / stderr 分别有提示、截断和 Unicode 游标、交接间隙尾输出、无 controller、owner 关闭、Hub 对端期限及最终 drain。
- [ ] 按 §4.2 推荐方向实现，确认 one-shot 仍无追加输入，不把 `input` 路由到它；已捕获提示必须在窗口回执中可见。
- [ ] 单独更新 one-shot 的 timeout Surface 和报告，重新走 Task 4 的 tarball / dev3 行为验收，不借用阶段 A 的通过记录宣称阶段 B 完成。

## 6. 完成标准与执行顺序

先完成 Tasks 1–4，形成可独立交付的阶段 A。Task 5 为已评估、有具体起点的递延阶段，不把它的未执行计作 PTY 功能失败，也不在第一阶段文案中提前承诺。

阶段 A 的完成标准不是“进程启动了”或“stdin 字段存在”，而是：真实模型在真实安装产物上看到提示，能先后提交不同输入，获得响应并完成原任务；期间新 cmd 的 busy 语义、原身份、输出可见性与 owner 清理均保持正确。
