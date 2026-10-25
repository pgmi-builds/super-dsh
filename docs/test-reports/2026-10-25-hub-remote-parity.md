# 2026-10-25 Hub Remote Parity（0.3.2-c）验收报告

> 计划：`docs/10_plans/2026-10-25-hub-remote-parity.md`（user 2026-10-25 三点裁决：① one-shot 对端 handling = 对端 Hub Server；② hub PTY = PTY over WebSocket 交给 BYO spawn；③ Q2 hub-tool 迁移必须）。
> 版本：`0.3.2-c`（better-dsh + super-dsh 同步）。npm **未发布**。

## 0. 一句话结论

**Hub 双线并入同一形状完成**：`hub:<m4>:pty[:label]` 现在是 canonical PtySession（身份/label 池/input/busy/handoff/close/card/账本/TTL/配额与其他 transport 逐动作同形），载体 = 本地 `script` PTY 托管的 WS 字节泵子进程（BYO spawn 通道，正本 `pty-session.ts` 零改动）；one-shot 回执如实披露 `hub-lease` 监督（对端 Hub Server 原生 Node 监督 = runner 角色的化身，superd-run helper 是 dumb-pipe 专用物、经 hub 不上传 = 文档化 non-goal）。对端 `/api/superd/exec/pty` 与任务租约协议**零改动**（protocol 1 不动）。

## 1. 交付内容

### 1.1 canonical（better-dsh/src/remote/）
- **`hub-pty-pump.mjs`（新，原样资产）**：哑 WS 泵——`stdin→WS`、`WS→stdout`、`{"op":…}` 控制帧不进字节流；连接事实走环境变量（`SUPERD_HUB_PTY_URL/COKIE/WS`，cookie 不落 argv/ps）；ws 模块按**调用方解析好的绝对路径** require（泵内零按名解析）；crash-proof（error 监听先挂）。helper-bin 同款纪律：`copy-hub-pty-pump.mjs` 复制进 `lib/remote/`，`build-remote.mjs` 带进闭包并计入 provenance（sources+outputs），`verify-package-pair.mjs` 叶子哈希核验。
- **`transports.ts:buildHubPtyArgv`**（单一事实源，driver 与 superd-hub face 共用）：`['script','-qfec','stty -echo 2>/dev/null ; export SUPERD_HUB_PTY_URL=… COOKIE=… WS=… ; exec <node> <pump>','/dev/null']` —— 与 docker exec 的嵌套 PTY 同形（0.3.2-b 已验收 input/^C/EOF 的机器）。
- **`hub-contract.ts`**：`HubRemoteTransport.pty()` 删除，新增 `ptyEndpoint(machine): {url, cookie, wsPath}`——wsPath 由 transport 侧（superd-hub 上下文，分叉的 proven 解析链）解析；闭包/泵子树解析不到 ws，按名解析不在闭包里做（实测：worktree 中 `ws` 在 `superd-hub/node_modules`，闭包子树 miss → 定稿为 transport 下传）。`protocol` 不动。
- **`driver.ts`**：`hub-pty` 表单 = 创建形（`createPtyLane` 新分支）→ canonical 会话（connection `hub:<m4>`、label 进统一池、10/Agent 配额同池）；**P10**：创建与每次 dispatch 都重验 pairing（复用不豁免）；`input` 对 `hub:<m4>:pty` 的拒绝改为「creation form」教学（与 ssh/docker 同词）；hub oneshot 回执补 `runner: "hub-lease (peer bash -lc, peer Node supervision)"`；`hubPtyAssets()` 导出（pump 旁挂定位，npm 包与闭包同构）。
- **`jobs.ts`**：hub-pty background 拒绝删除（会话化后 handoff/后台自动成立）。
- **`plugin.ts`**：闭包导出面 + `PtySession` / `PtyDispatchResult` / `buildHubPtyArgv` / `HubPtyEndpoint` / `hubPtyAssets` / `tailWindow`（Q2 单一会话实现的消费入口）。
- **`tool.ts` surface**：input 教学句改为「any transport (ssh / docker / incus / hub / BYO)」；run_in_background 删「Hub-machine PTY has no background lane」；runner schema 加 `hub-lease`；hub 附录重写（同形状会话 + WS 字节泵 + 对端 Hub Server 即监督者 + helper 不经 hub 上传）。base description 保持 hub 中立（hub.spec 守卫维持）。

### 1.2 super-dsh（superd-hub）
- **分叉三文件删除**：`exec-pty-session.ts`（老 FIFO/自动^C/无身份）、`exec-pty-channel.ts`、`exec-pty-framing.ts`（tailWindow 改从闭包导入，唯一正本 nonce-framing）。
- **`remote-provider.ts`**：`face.pty(owner, machine, cmd, opts)` 迁 canonical PtySession——per-owner 每机器一个持久 shell（A2A 语义保持：cwd/env 跨调用存活、dead→dispatch 内部重连=旧 markDead/重启、disposed→重建）；P4 handoff 对 A2A 面保持旧语义（显式两段 ^C 后等帧结算=分叉自动中断的等价物）；idle TTL 900 对齐 canonical；`ptyEndpoint()` 实现（URL+cookie+wsPath，校验 registry 行）。
- **`hub-tool.ts`**：face 类型改引闭包 `PtyDispatchResult`（调用点零改动）——Q2 完成，单会话实现。
- `exec-pty-rpc.ts`（对端 dumb executor）与 `remote-job-rpc.ts`（租约）**零改动**。

## 2. 测试证据

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| better-dsh `test/remote`（vitest） | **241 pass / 8 skip / 0 fail** | 0.3.2-b 基线 236 + 新 5（hub 会话创建/label/复用、P10 重验、配额同池、runner 披露、scriptPath-over-hub） |
| superd-hub `node --test` | **643 pass / 0 fail**（644 tests） | exec-pty.test.mjs 重写为实线 4 条（canonical 会话 over 泵+WS：cwd 持久、两道提示 input ACCEPTED、gate 401 诚实死）；remote-provider.test 6 条（face 语义：复用/配重验/owner 隔离 + 新 two-clock 钉） |
| 双 tsc --noEmit | 全绿 | better-dsh + superd-hub（对重建后的闭包） |

- **two-clock 钉**：`sleep 8 / timeout 1` 经真实租约线 1008ms 结算、`timedOut:true`——对端时钟拥有超时，客户端租约独立续。
- **scriptPath 钉**：hub oneshot 收到 `bash -s` + 字面 stdin（脚本体不进 argv）。
- **已知形状披露**：嵌套 PTY 下 `script` 把泵子进程 0/1/2 全挂 pty slave——泵 stderr 进字节流而非会话 diag 管道，初始化失败以诚实 `E_SESSION_DIED/E_SESSION_START` 面世（不带 cause 细节）。gate 测试如实断言此行为。

## 3. 真实模型验收（0.3.2-c 整包，PC 4999 rig）

Session `session-78323c91-5ffc-47e5-8b2e-2cbea7e56b92`（deepseek-flash，真实 RPC enqueue→完成 455s）。对端 = **DEV3 生产 hub**（既有 mesh pairing `hub:bfwu`；对端为旧版 super——**混版兼容实证**，protocol 1 对端零改动的直接证明）：

| 步骤 | 模型实测 |
| --- | --- |
| 1 创建+两道提示 | `hub:bfwu:pty:hubacc` → `pty:pty-5b2r (hubacc) · conn hub:bfwu`；`Password:` 可见；**120.3s 超时自发 handoff** 成 running job（`job_output remote-2583e8b67f0e4c7a`，会话存活）|
| 2 busy 拒绝 | `[E_SESSION_BUSY] remote: pty session 'pty-5b2r' still runs a command (remote-83ee2484f3c64335)…`（四出路全列） |
| 3-4 input | `demo\n` → **writtenBytes 5**；`123456\n` → **writtenBytes 7**；`Password: OTP: ACCEPTED [status: completed, exit code: 0]` |
| 5 状态持久 | `cd /tmp && pwd` → `cwd /tmp`、`STATE-OK`、env delta `+OLDPWD ~PWD` |
| 6 runner 披露 | hub oneshot 回执：`HUB-ONESHOT-OK [runner hub-lease (peer bash -lc, peer Node supervision) · exit 0 · 0.1s]` |
| 7 roster | `pty sessions: pty:pty-5b2r (label hubacc) hub:bfwu [idle 3s]` + `hub machines: hub:bfwu (DEV3)` |
| 8 close | `closed pty:pty-5b2r (hub:bfwu)` |

步骤 1 的超时 handoff 与 input 在**同一 job**上衔接（handoff 后 input → job_output 读到 ACCEPTED）——P4/P5 与 interactive-stdin 的组合场景在 hub lane 上首次联合实证。

## 4. 双现场

- **PC 4999**（`superd-4999-test`）：0.3.2-c 对（super + companion better 显式同步；companion 落后陷阱再次出现并按既有流程修复：`plugin --profile superd-pub add better-dsh@0.3.2-c`）+ root 200 + 无 world failed。
- **dev3 4998**（`superd-4998-test`）：pack 双 tarball（SHA-256 与 pair.json 一致）经 `read-pack-pair` 校验（verify-package-pair 同步了泵叶子清单）；0.3.2-c 对 + root 200 ×3。
- 交付物 SHA-256：`better-dsh-0.3.2-c.tgz` `f38db7c3e2cfb66eda4ede1343229cbfc9afaccfd8172df8d7258ab1fefe375d`；`super-dsh-0.3.2-c.tgz` `61ed2a90dd247c44b5d4590e51a52f6978273c06600aca994d985b097d1a8bc4`。

## 5. 验收标准对照（计划 §6）

✅ 逐动作同形（身份/提示可见后 input/busy 四出路/超时 handoff/close 幂等/roster/card 可见）；✅ one-shot 回执如实披露 hub-lease；✅ 旧「no session id / no parallel / no background」例外句从 surface 消失（tool.spec 断言更新为反例）；✅ 对端 `/api/superd/exec/pty` 与租约协议零改动（混版对端实测通过）。

## 6. 遗留与披露

1. **泵 stderr 诊断不可达**（§2 已述）：仅影响初始化失败的 cause 细节；恢复路径不受影响（ptyEndpoint 预检 + 诚实错误码）。后续若需要，可用带内约定前缀把泵诊断透传为可读行——非本轮。
2. **O8 二阶差异**（计划 §3）：对端 hub 进程崩溃时运行中组可能孤儿化（hub 存活时租约兜底）；Node 路径无 starttime 防 PID 复用。写进 surface/文档，不改造。
3. **阶段 B**（one-shot 等待窗口转后台）：维持递延（Q5）。
4. dev3 rig 的 RPC 面（0.2.1-rc.1 锚）无新版 `session/prompt` 网关形状——真实模型验收在 PC 4999 完成；dev3 侧以 pack 校验 + 双绿套件覆盖。

## 7. 红线核对

- 未 `npm publish`；未 GitHub push/tag；生产 home/端口/Caddyfile 零触碰（4999/4998 测试线 launcher 常规重启）。
- `better-dsh/src/remote/` 唯一可编辑源；`super-dsh/remote` 闭包纯生成（重建 + provenance + pair 校验通过）。
- 泵子进程环境可见性：cookie/URL 走 env（同 uid 可读，与会话进程自身同信任域），不进 argv。

## 8. 独立复测（2026-10-26，0.3.2-c）

独立第一人称复测报告：[2026-10-26-remote-pty-c-retest.md](2026-10-26-remote-pty-c-retest.md)。要点：

- remote PTY（ssh/docker）无回归；hub PTY 的身份/label/提示→input→完成/状态持久/busy/handoff/runner/close/card 均在 `hub:bfwu` 上实测通过。
- **F4（本轮新发现，与本文件 §5 的「逐动作同形」冲突）**：hub lane 的本地 `script` 包装只有 `stty -echo`、没有 raw，`^C`/`^D` 先被本地终端行规程消费（SIGINT 打死 pump / EOF 结束 pump stdin），因此 hub 上的 `input ^C`、`input ^D`、`job_kill` 都会把整条会话打死（`session died`，下一次 dispatch reconnect），而不是「中断命令、会话存活」。根因与实验室对照见复测报告 §4；修复方向 = wrapper 改 `stty raw -echo`，建议 `0.3.2-d` 并重测。
- b 轮 F1/F2 在 c 仍复现（`pty-session.ts` 零改动）；F3 未复现但理论风险仍在。
- 复测期间重跑双套件：better-dsh `241 pass / 8 skip`、superd-hub `643 pass / 1 skip / 0 fail`；dev3 4998 的安装/健康/哈希核验通过。
