# 2026-09-29 · P4 one-shot remote exec（0.1.7-d）——端点 + 工具腿 + 跨机 wire 活体验收

**版本**：0.1.7-d（`cd6a92a`）
**形态**：hub 套件 453/453；裸 pack 线 931/931；双机 0.1.7-d 实装（dev3 world failed = 0）

---

## 一、落地范围（spec §8.1 全量；§8.2 PTY 留下轮）

| 件 | 内容 |
|---|---|
| `src/exec.ts` | `runOneShotExec`：`bash -lc`，detached 进程组，per-stream **30k 尾窗** over **4M 环形保留**，超时 **SIGTERM→2s→SIGKILL 组杀**；`parseOneShotExecBody`（端点与工具共享的 exact-shape 校验：cmd 非空 ≤4096、cwd 绝对、timeoutSec ∈[1,600] 整数、未知字段拒收）；`postOneShotExec`（wire 腿，cookie 随行，预算 = timeout+15s） |
| `mesh-rpc.ts` | `handleExecPost`（共享 /api fence 后，POST-only 方法门 405、类型化 400）+ `registerExecRpc`（与 a2a 端点同 inject scope） |
| `hub-tool.ts` | exec 占位退役：`{action:'exec', cmd, machine?, cwd?, timeoutSec?, mode?}`；默认目标 = 本机；远端经 a2a-row exec face；`mode:'pty'` 诚实 not-yet（§8.2 下轮） |
| `machines.ts` | `MachineRow += execEnabled?: boolean`（加性；行守卫更新；**发起侧**旋钮——发信前拦截，spec §5） |
| journal | `a2a.exec.run`（执行侧：cmd/exit/durationMs/timedOut/truncated）+ `a2a.exec.remote`（发起侧转发） |

## 二、活体验收

1. **PC rig 端点（本地执行）**：`{"cmd":"echo exec-alive on $(hostname); uname -s","cwd":"/tmp"}` →
   `{"exit":0,"stdout":"exec-alive on homepc\nLinux\n","stderr":"","durationMs":90,"truncated":false,"timedOut":false}`
   journal：`superd-hub: a2a.exec.run cmd="echo exec-alive on $(hostname); uname -s" exit=0 durationMs=90`（含空格 cmd 正确引号包裹）。
2. **跨机 dev3 → PC**（pairing cookie over `https://test.pc.internal.test`）：`echo cross-machine from $(hostname); date +%s` → 在 **homepc** 执行，exit 0，92ms——hub-to-hub exec 车道开通。
3. **工具腿（模型面）**：headless 驱动 rig agent 的 turn 停在 `approval/policy:"ask"`（无人在场审批）——环境特性非缺陷；工具腿 dispatch/校验/face 路由已单测覆盖（30+ 断言：本地 run、pty 诚实注、unknown machine 类型化、E_BAD_EXEC 空 cmd、render 过 output schema）。**留给用户浏览器亲测一条。**

## 三、测试
- 新 `test/exec.test.mjs` 8 测：解析器全规则、exit/stdout/stderr 分离、`bash -lc` 环境加载、cwd、**尾窗语义**（60k→30k 且保尾不保头）、**4M 环**（4.6MB 流尾窗不变）、**组杀**（`sleep 30 & wait` timeoutSec 1 → timedOut + <10s 返回）、journal 行、端点门（405/400/真实 run）、wire 腿（cookie 随行、4xx 错误体透传、unreachable 类型化）。
- hub-tool 三处旧占位断言改写为真实腿断言；render/schema 测试的 exec 腿补 `cmd`。
- 套件：**453/453**；裸线 **931/931**。

## 四、边界与裁决记录
- `execEnabled` 落在**发起侧** registry 行（工具发信前拦截）；执行侧信任边界 = 共享 /api fence（与 machines/a2a 同门）——spec §5 的 per-machine 语义按此实现，如需执行侧独立开关另行裁决。
- `exit` 可为 null（超时/信号）——output schema 该字段用 json 类型承载。
- PTY（§8.2）：nonce-framing/PtySession 照抄 better-dash `src/remote/` + 远端哑执行器（`script -qfec`），下一轮。

## 五、实测通过 ≠ 放行
双机 0.1.7-d 在役；4999 rig URL：`https://test.pc.internal.test/?token=<redacted>`（seed 持久，旧 cookie 仍有效）。待用户：浏览器亲测工具腿 exec + 放行裁决。
