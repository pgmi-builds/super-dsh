# Remote Tool Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付可独立随 Better/Super 使用、按 Agent 实例注册的 remote；增加 script/stdin、BYO-SSH、原生 jobs、binary copy 和 SSH-only rsync 中继。

**Architecture:** `better-dsh/src/remote` 是唯一源码，Super 构建生成独立闭包。host 行监听官方 Agent 创建边界并在 agent scope 注册；Hub 是 optional structural provider，目录变化与 transport 可用性分开。共享执行进程面适配 DSH jobs；copy 和 SSH rsync 分别拥有自己的可取消、可清理资源域。

**Tech Stack:** TypeScript、Cordis scoped tools/agent lifecycle、DSH jobs、Node streams/child_process、OpenSSH、rsync、WS binary、Vitest、node:test、tsdown、双 npm tarball launcher。

**Spec:** `docs/specs/remote-tool-enhancement/spec.md`（2026-10-10 user 已审阅并授权执行）。

## Global Constraints

- 唯一 remote 源码为 `better-dsh/src/remote/`；Super 只包含生成 remote 闭包，不依赖/捆绑 Better 整包。
- `dashr-remote` / `superd-remote` 两个独立 row id 默认开启；模型工具同名 `remote`，不保证 Super 抢先。
- 每个新 Agent 实例只尝试一次；只消化同 scope remote 重名，不能吞其他错误；new/cold resume 与 hot continuation 严格区分。
- 直接使用官方 `agent/created` 边界，不自建 new/resume 判断、待命标记、启动类型表或重试状态机。
- 注册和执行资源同时归 Agent 和来源插件所有；不轮询、不热补位、不修改原生 preset 或上游源码。
- `script` 只 oneshot，与 cmd/stdin 互斥；Hub inline cmd 维持 4096 字符。
- 4M 内部上限不配置化、不加 3.5M 提醒；单位按当前真实实现报告，不虚构统一 MB。
- rsync 仅 local/SSH/byossh；remote↔remote 身份留发起机、SSH tunnel relay、不 agent-forward。
- 本轮不做 PTY backlog/probe、ephemeral ssh、fan-out、push stdout、非 SSH rsync、额外文件管理 action。
- 安装无钩子；宿主 optional peer 与模块单实例、同步双版本沿现有契约。
- 验收只沿完整 tarball + dev3 实装路径；Web 测试保留 URL；无 user 本次发布放行不得 publish/commit/tag/push。下列任务只形成工作区改动，不执行技能模板中的自动 commit。

## Source map and interfaces

现有落点：remote `plugin.ts`/`tool.ts`/`driver.ts`/`transports.ts`/`oneshot.ts`/`pty-session.ts`；Hub `exec.ts`/`exec-pty-channel.ts`/`exec-pty-session.ts`/`exec-pty-rpc.ts`/`hub-tool.ts`/`a2a-row.ts`/`gateway.ts`；打包 `build-better.mjs`/`pack.mjs`/`verify-package-pair.mjs`。

新增小模块：

| 模块 | 单一职责 |
|---|---|
| `remote/agent-registration.ts` | Agent 创建边界和双 owner 清理 |
| `remote/input.ts` | script 读取及调用模式验证 |
| `remote/ssh-targets.ts` | per-Agent BYO-SSH 注册和规范化 connection spec |
| `remote/process.ts`、`remote/output-ring.ts` | 可取消进程、真实流式输出、总量与截断 |
| `remote/jobs.ts` | 官方 JobSpec producer 适配 |
| `remote/hub-contract.ts` | owned optional provider 类型，无 Super import |
| `remote/endpoints.ts`、`remote/copy.ts`、`remote/archive.ts` | 文件寻址、中转清理、binary carrier 与验证 |
| `remote/rsync.ts`、`remote/ssh-relay.ts` | 原生 rsync 选项与 tunnel/daemon 资源域 |
| Hub `remote-provider.ts`、`remote-row.ts` | provider 装配；独立于模型工具行 |
| Hub `remote-file-rpc.ts`、`remote-job-rpc.ts` | binary file lane 与跨端 start/read/cancel |
| `scripts/build-remote.mjs` | 以唯一源码生成 Super remote 闭包、provenance |

交界类型（同名只在 owned contract 中定义一次；类型字段见对应任务）：

```ts
interface RemoteInput {
  target: string; cmd?: string; script?: string; stdin?: string;
  mode?: 'oneshot' | 'pty'; timeout?: number;
}
interface PreparedRemoteInput {
  target: string; cmd: string; stdin?: string; mode?: 'oneshot' | 'pty'; timeout?: number;
}
interface SshConnection {
  host: string; user?: string; port?: number; key?: string; proxyJump?: string;
}
interface RemoteProcess {
  cancel(reason?: string): void;
  done: Promise<{exit: number | null; timedOut: boolean; durationMs: number}>;
  read(channel: 'stdout' | 'stderr', fromByte: number): {
    text: string; nextOffset: number; lossy: boolean;
  };
}
interface HubTarget { id: string; label: string; execEnabled: boolean }
interface HubRemoteTransport {
  protocol: 1;
  listTargets(): readonly HubTarget[];
  start(machine: string, input: PreparedRemoteInput, owner: string): Promise<RemoteProcess>;
  pty(machine: string, cmd: string, owner: string, options: {stdin?: string; timeout?: number}): Promise<RemoteCallResult>;
  fileEndpoint(machine: string): BinaryFileEndpoint;
  releaseOwner(owner: string): Promise<void>;
}
```

`RemoteCallResult` 沿 driver 现有公开结果类型；`BinaryFileEndpoint` 在 Task 6 定义。provider 可以委托现有 exec/PTY 模块，不复制另一套状态机。

## Task 0: Baseline、LSP/AST 和执行隔离

**Files:** Read root/Better/Super AGENTS、spec、docs/07；记录到本计划对应的 git-ignored ledger。

**Interfaces:** 消费物理上游 checkout 和本仓 exact build 输入；输出实际 baseline、影响图和隔离工作目录。

- [x] 先核对 spec 书面确认、`git status --short`、当前版本与是否已在 worktree，保留所有无关未跟踪文件。实现不能在 master 上直接进行；按 using-git-worktrees 选择隔离工作区，保留原测试 home 和安装锚，不执行 blind npm install。
- [x] 用 typescript-language-server 实际查 `RemoteDriver`、`tools.register`、`agent/created`、`jobs.start`、`registerPtyExecutor` 的定义/引用；用 `@ast-grep/wasm` + 现有 TS grammar 核实注册点、spawn 点、end/stdin 和 RPC 装配范围。工具缺口写入 ledger，不以 rg 冒充 LSP。
- [x] 跑定向 baseline：

```bash
(cd better-dsh && ./node_modules/.bin/vitest run test/remote)
node --test super-dsh/test/better-dash-composition.test.mjs super-dsh/test/pack-package.test.mjs
```

- [x] 记录现有 failure，不把它算成本轮回归；复核 Git 不定版、上游零改、生产隔离。

## Task 1: scoped Agent registration + 独立双包交付

**Files:** Modify `better-dsh/src/remote/plugin.ts`、`super-dsh/package.json`、`super-dsh/cordis.patch.yml`、`super-dsh/scripts/pack.mjs`、`super-dsh/scripts/verify-package-pair.mjs`；Create `better-dsh/src/remote/agent-registration.ts`、`super-dsh/scripts/build-remote.mjs`；Test `better-dsh/test/remote/agent-registration.spec.ts`、`super-dsh/test/remote-delivery.test.mjs`。更新根/Better AGENTS 的 remote 窄范围复制例外，不改其他包边界。

**Interfaces:** 消费 `RemoteDriver`/`createRemoteTool`；输出 `installAgentRemote(ctx, config, getHub): disposer`，在 Agent scoped Context 注册工具并有双 owner 清理。生成目录为 `super-dsh/remote/`，导出入口 `./remote/plugin.js`，provenance 不包含绝对开发路径。

- [x] RED：用真实 Cordis、真实 tools/Agent fixture 挂两份独立 plugin module，创建两个 Agent；分别调用 scoped remote，断言创建成功、每 Agent 仅一份执行；卸载赢家后当前 Agent 无自动补位，新建和 cold resume 有 remote。

```ts
it('does not veto creation when another remote owns this Agent scope', async () => {
  const h = await createRealRemoteHarness({ copies: 2 });
  try {
    const agent = await h.createAgent('collision');
    expect(await h.invoke(agent, {target:'byop:t', spawn:'bash', cmd:'printf ready'})).toMatchObject({text:'ready'});
    expect(h.visibleTools(agent).filter(t => t.name === 'remote')).toHaveLength(1);
  } finally { await h.dispose(); }
});
```

fixture 只能在 test helpers 里实现，并通过真实 AgentRegistry announce/scoped tools 调用；不在业务类加 test-only 计数。

- [x] 运行 `(cd better-dsh && ./node_modules/.bin/vitest run test/remote)/agent-registration.spec.ts`，确认失败是缺少实例级注册；保留非重名注册异常导致创建失败的测试。
- [x] GREEN：host 行监听官方 `agent/created`；在 `agent.ctx` 注册，不直接移动到共享 preset。注册同步尝试，只对当前 native duplicate diagnostic+确实占名做局部跳过；不吞无关异常。每个成功注册的 driver 在双 owner scope 内清理。
- [x] 打包以单独 tsdown remote entry 构建 self-contained ESM/dts 闭包到 Super；schema 私有 alias 真正 bundle，不将 Better lib 的其他 shared chunks 整目录拷过去。记录源码 SHA-256 manifest；消费者闭包无 `better-dsh` 裸 import。
- [x] 两条独立 id 默认开；不落 Better disable override。更新 pack 契约，使 tarball 允许只读 remote 生成目录，但仍拒绝 Better 整包 payload/dependency/client。
- [x] GREEN 检查：真实双包消费者关/卸载 Better 后从 Super subpath 注册并执行；相反安装顺序；两 Agent cwd 不互串；owner 退出无 PTY 遗留。单测与 `node --test super-dsh/test/remote-delivery.test.mjs` 通过后登记任务，不 commit。

## Task 2: 可选 Hub provider 和模型 local 门

**Files:** Create `better-dsh/src/remote/hub-contract.ts`、`super-dsh/superd-hub/src/remote-provider.ts`、`remote-row.ts`；Modify `driver.ts`、`tool.ts`、`roster.ts`、Hub `a2a-row.ts`、`gateway.ts`、`hub-tool.ts`、pack YAML/exports。Tests `better-dsh/test/remote/hub.spec.ts`、`super-dsh/superd-hub/test/remote-provider.test.mjs`、既有 `hub-tool`/exec tests。

**Interfaces:** provider 使用 Source map 中的 `HubRemoteTransport`；Task 4 完成前 `start` 可委托同步 process adapter，但不能提前宣称 streaming jobs；fileEndpoint 在 Task 6 交付前返回明确 unsupported。

- [x] RED：真实 provider 被装入而 targets=[]，roster 仍有 Hub 空目录；无 provider 则拒绝 hub target 且 SSH/BYO 正常；self m4 被拒，执行器 RPC 仍能处理对端调用。

```ts
it('keeps an empty hub directory without exposing self execution', async () => {
  const h = await createRealHubRemoteHarness({ remoteMachines: [] });
  try {
    expect(await h.roster()).toContain('hub machines: none');
    await expect(h.call({target:`hub:${h.self}`,cmd:'printf forbidden'})).rejects.toThrow(/remote machine|local execution/);
  } finally { await h.dispose(); }
});
```

- [x] 运行定向测试确认缺少 hub 路由。GREEN：owned structural type、optional `ctx.get('superdRemoteTransport')`、官方 service 通知更新 Surface，不轮询 peer。request 时读取当前 pairing/execEnabled，既有 WS PTY nonce/TTL/cwd 行为复用。
- [x] provider 随 Hub 本体装配；把模型工具开关与接收服务端拆开，不能因为 remote/a2a tool row off 而拆别人使用的 exec/file endpoint。检查 world subtree，不在 foreign world 错挂 native 服务。
- [x] legacy `superd-hub` exec 新增 localExec false：缺 machine/self 返回明确提示；收到远端 RPC 的本地 executor不受此调用侧门影响。模型说明同步更新，不改原生 bash。
- [x] 测 tools 行 off + provider still on，unknown/disabled machine，无 SSH 的 Hub PTY cwd/env 两轮复用；provider off 不退回 SSH。

## Task 3: script、stdin parity 与真实输出截断

**Files:** Create `better-dsh/src/remote/input.ts`、`output-ring.ts`；Modify native driver/tool/oneshot/PTY/framing，Hub `exec.ts`、`hub-tool.ts` 和 RPC sender；Test `input.spec.ts`、oneshot/tool/PTY tests、Hub exec tests。

**Interfaces:** `prepareRemoteInput(input: RemoteInput): Promise<PreparedRemoteInput>`。非 script 调用保留可选 mode，由 driver 沿既有 target/PTY 状态推断；script 显式 oneshot。script 路径读取后返回 `cmd:'bash -s'`、`stdin:源码`，不把源码拼成 argv。ring 按 native char 与 job UTF-8 byte cursor 分别记真实数，不能混用 offset。

- [x] RED：脚本大于 4096，包含 `$()`、反引号、heredoc、Unicode，在目标只执行一次且输出正确；script+cmd/script+stdin/script+pty/相对路径在 spawn 前拒绝。

```ts
it('executes a large script over stdin without argv expansion', async () => {
  const path = await writeTempScript('#'.repeat(5000)+"\nprintf '%s' 'literal $HOME'\n");
  const h = await createRealRemoteHarness({ copies: 1 });
  try { expect(await h.invokeScript(path)).toMatchObject({text:'literal $HOME'}); }
  finally { await h.dispose(); await removeTempScript(path); }
});
```

期望为 literal `$HOME`，不能由被测 quoting helper 生成期望值。

- [x] 运行 tests 观察 RED。GREEN：tool 在路由前准备 input；Hub body parser known fields 加 stdin/string 校验、执行端写 stdin/end 并处理 EPIPE；legacy tool schema/description 一并补齐。
- [x] 输出超过保留上限后仍有最后 sentinel；回执有真实 total/retained/dropped；同 PTY 下一 dispatch 不重复前输出。native oneshot改为收尾 ring，保持 stdout/stderr分离和总量统计。
- [x] 定向回归：4096+1 inline 仍被 Hub 拒；script不受该限制；source read失败不拨号；3.5M 阈值没有新通知；杀组与超时原行为未退化。

## Task 4: 可取消 oneshot process 和官方 jobs

**Files:** Create native `process.ts`、`jobs.ts`；Modify oneshot/driver/tool；Create Hub `remote-job-rpc.ts`，Modify provider 和 auth route装配；Test `process.spec.ts`、`jobs.spec.ts`、Hub remote-job tests。

**Interfaces:** `RemoteProcess` 如 Source map；`startRemoteJob(registry, input, exec): JobId` 仅在 `registry.start({kind:'remote', owner:exec.agent.id, run})` admission后启动。类型扩展 JobKindMap 使用官方类型，新增 dsh-jobs optional peer沿现有范围，锁元数据同源。

- [x] RED：运行 `printf first; sleep ...; printf second`，completion之前读取 job_output得到first，后续读取不重复；job_kill停止真实进程/远端任务；拒绝admission后没有spawn；PTY+background拒绝。

```ts
it('exposes running output and cancellation through native jobs', async () => {
  const h = await createRealJobsHarness();
  try {
    const job = await h.remote({target:h.target,cmd:'printf first; sleep 30',run_in_background:true});
    expect((await h.readUntil(job.jobId, 'first')).text).toContain('first');
    await h.kill(job.jobId);
    expect((await h.waitJob(job.jobId)).status).toBe('killed');
    expect(await h.targetProcessAlive(job.jobId)).toBe(false);
  } finally { await h.dispose(); }
});
```

- [x] 跑RED。GREEN：process factory提供 incremental output rings/cancel/done；JobHooks映射完成/失败/kill，不另写完成消息；没有jobs仅background失败，foreground仍工作。
- [x] Hub start/read/cancel由native remote provider能力建立，owner和配对cookie关联，不能靠客户端abort fetch取消远端。端点调用幂等cancel，断连/插件dispose有明确清理，done在cleanup后才settle。
- [x] 回归owner dispose、spawn error、非零exit、取消启动中、不同Agent无法读/杀对方job；nativejob完成通知由真实模型收到。

## Task 5: BYO-SSH registration

**Files:** Create `ssh-targets.ts`；Modify target/transports/driver/roster/tool；Test `ssh-targets.spec.ts` 与 transport/tool tests。

**Interfaces:** `SshTargets.register(label, connection): SshConnection`、`get(label)`、`entries()`，每Agent独立；`sshArgv(connection, options): string[]` 统一给exec、copy、rsync/relay。既有 string spawn只给byop；新增ssh object不破坏旧schema。

- [x] RED：首次byossh命令成功、第二次无ssh参数复用；同label换参数拒绝；不同Agent同label不同目标互不影响；ssh option注入不能另起本地shell。

```ts
it('does not replace an existing SSH identity under the same label', () => {
  const targets = new SshTargets();
  targets.register('build', {host:'dev3',port:2222});
  expect(() => targets.register('build',{host:'dev4',port:2222})).toThrow(/conflict/);
  expect(targets.get('build')).toEqual({host:'dev3',port:2222});
});
```

- [x] GREEN：官方ssh options的argv构造、label验证、register-only形态、roster无秘密；ProxyJump/identity path复用，不写原生config。
- [x] 本机受控sshd fixture执行自定义port/key/跳板，并验证一条native SSH config target仍兼容。目标机验收再测真实byossh，不以argv snapshot替代行为。

## Task 6: Binary copy 和 verified cleanup

**Files:** Create `endpoints.ts`、`archive.ts`、`copy.ts`；Create Hub `remote-file-rpc.ts`；Modify provider/driver/tool，auth upgrade装配。Tests native endpoints/archive/copy tests，Hub binary lane tests。

**Interfaces:**

```ts
interface BinaryFileEndpoint {
  exportTree(path: string, signal: AbortSignal): Promise<NodeJS.ReadableStream>;
  importTree(path: string, source: NodeJS.ReadableStream, options: {mkdir: boolean; signal: AbortSignal}): Promise<void>;
  digest(path: string, signal: AbortSignal, selection?: readonly string[]): Promise<{sha256: string; bytes: number; entries: number}>;
}
interface TransferReceipt {
  action: 'copy'; src: string; dst: string;
  verified: boolean; sourceDigest?: string; destinationDigest?: string;
  bytes: number; entries: number; scratch?: string;
}
```

local/CLI/Hub端点各实现同接口；tar filesystem carrier归archive模块验证，不把remote shell输出文本当bytes。cancel是所有leg共有的AbortSignal，任务owned资源在finally清理。

- [x] RED：随机bytes含NUL/非法UTF-8、嵌套目录/空文件/Unicode和换行文件名，经两腿copy精确相等；篡改destination检测mismatch、failed receipt给scratch；success scratch消失。

```ts
it('copies binary bytes and removes only its own successful staging', async () => {
  const h = await createBinaryCopyHarness();
  try {
    const bytes = Buffer.from([0,255,128,10,13,0,42]);
    await h.seedSource('binary',bytes);
    const receipt = await h.copy({src:h.src('binary'),dst:h.dst('binary'),verify:true,mkdir:true});
    expect(await h.readDestination('binary')).toEqual(bytes);
    expect(receipt.verified).toBe(true);
    expect(await h.ownedScratchExists()).toBe(false);
  } finally { await h.dispose(); }
});
```

- [x] GREEN：task级scratch中转、SHA-256/目录manifest、精确端点解析；BYO-PTY拒绝不假冒支持。WSbinarybuffer有backpressure，控制frame和数据frame分离；auth/trust沿既有PTYupgrade。
- [x] 测unsafearchive member、symlink出界、断连/取消、unsupported旧peer、verify:false诚实回执、目录合并无delete。
- [x] 同一tarball消费者真实Hub paired-only copy，证明无需ssh alias；测试文件大于单frame大小，不能只用几字节通过即宣称大文件可用。

## Task 7: SSH↔SSH 原生 rsync tunnel relay

**Files:** Create `rsync.ts`、`ssh-relay.ts`；Modify endpoints/tool，Reuse Task5 sshArgv；Tests `rsync.spec.ts`、`ssh-relay.spec.ts`、本机受控双sshd集成fixture。

**Interfaces:** `runRsync(request: {src,dst,dryRun?,delete?,excludes?,preserve?}, signal): Promise<RsyncReceipt>`；`withSshRelay(source:SshConnection,destination:SshConnection,targetPath:string,signal,run)`创建owneddaemon/forward，run结束后无论结果清理。

- [x] RED：发起机可登录两个sshd，但源机无目标登录凭据；remote→remote成功；第二轮只修改一个大文件少量内容，接收bytes显著小于完整文件；dryRun默认不写，delete默认不删除。

```ts
it('relays delta without giving either remote the other SSH identity', async () => {
  const h = await createTwoSshRelayHarness();
  try {
    await h.seedLargeSource();
    await h.rsync({dryRun:false});
    await h.patchSmallSourceRange();
    const receipt = await h.rsync({dryRun:false});
    expect(await h.destinationMatchesSource()).toBe(true);
    expect(receipt.transferredBytes).toBeLessThan(h.fullSize / 4);
    expect(await h.remoteForeignIdentityFiles()).toEqual([]);
    expect(await h.ownedRelayResources()).toEqual([]);
  } finally { await h.dispose(); }
});
```

delta fixture关闭压缩/使用不可压缩内容，解析原生rsyncstats而不是比较模型回执长度。

- [x] GREEN：预检rsync；目标端loopback-only短命daemon/module限定destination，daemon以当前登录user无chroot权限要求；发起机-L接目标daemon；源端task-owned Python loopback proxy经独立SSH二进制stdio连发起机bridge，源端rsync访问该本地module。真实全路由greeting先于业务准入，proxy/listener/helper/group服从既有receiving lease/cleanup barrier，不再依赖源端-R/sshd FD/pidfd。通过官方-p/ProxyJump既有连接spec管理，不下发key、不-A。
- [x] 数据路径不改远端SSH配置，无public监听，不持久安装daemon。临时config严格文件权限、受控参数转义，paths有空格/单引号也不注入；port冲突失败清理。
- [x] 标准rsync选项按argv：dry-run、delete、exclude项、preserve和约定slash；不支持非SSH target，缺rsync不fallbackcopy；退出码/changes真实。
- [x] 测dryRun/delete/excludes/trailing slash、禁止forwarding、sourceexit失败、取消传输、targetdaemon中途退出。每场景都断言ownedtunnel/daemon消失，不关闭fixture之外的用户SSH连接。

## Task 8: Surface、双包 pack、4999 和 dev3 验收

**Files:** Modify docs/07 remote章节、包文档清单及模型tooldescription；Create `docs/test-reports/2026-10-10-remote-tool-enhancement.md`（实际轮次日期变化时据实命名）；更新本计划checkbox和spec状态。更新两包AGENTS以准确表述sole-sourcecopy，不篡改旧报告证据。

**Interfaces:** 消费完整artifact与真实模型；输出可复现报告、两包/上游版本与hash、现行WebURL、user验收未完成项。

- [ ] 所有task定向测试通过后按根脚本统一同步下一可用字母版本；不单改package.json、不publish。
- [ ] 运行完整必要checks（远端Hub测试先npm build，以当前manifest命令为准）：

```bash
npm --prefix better-dsh run typecheck
(cd better-dsh && ./node_modules/.bin/vitest run test/remote)
npm --prefix super-dsh/superd-hub run build
node --test super-dsh/superd-hub/test/exec*.test.mjs super-dsh/superd-hub/test/hub-tool*.test.mjs super-dsh/superd-hub/test/remote*.test.mjs
npm run pack
npm test
```

- [ ] 检查pack内Super remote closure/provenance、各声明export存在、无Better dependency/whole payload、宿主模块未inlined；脱离源码树仅tarballimport并行为验收。
- [ ] 用现行 `bash super-dsh/test/start-4999.sh` 联合消费者启动；Better standalone消费者按 `SUPERD_TEST_CONSUMER=better-dsh` 独立测试home运行，不手搓另一launcher、不清掉既有用户测试数据。Web线保持运行，记录launcher实际URL而非猜测端口。
- [ ] 真实模型经native工具和REPL各验证roster、byossh、script、stdin、PTYpersist、jobsrunningdelta/completion/kill、binarycopy、rsyncdryrun/actual/delta；测试catalog中的调用说明及恢复提示。
- [ ] 真正双包管理矩阵：Better-only、Super+Better、Better disabled/uninstalled、两种启用顺序、全部remote行off、获胜插件中途卸载、new/coldresume恢复、hotcontinuation无自动重抢。不能只测rowmount。
- [ ] 经dev3现行非生产测试launcher/installAnchor实装同一双tarball和pair.json，核对SHA-256。paired-only无SSHHubPTY/copy；经发起机dev3↔另一SSHtarget中继；二次delta及取消cleanup。
- [ ] 报告记录第一人称行为与模型Surface，必要改动回到相应任务RED/GREEN及覆盖测试。review所有scope/API/cleanup/packdiff，仍不commit/tag/push。
- [ ] 最终呈报“实现/自动验收/用户亲验/发布”四个分离状态；user尚未亲验不能写成全部完成。请求发布时只请求本轮明确放行，不沿用设计授权。

## Preflight self-review

| 共享文件/接口 | 顺序与一致性 |
|---|---|
| Task1→Task2 `plugin.ts`/getHub | Task1建Agent边界，Task2 optionalprovider；不允许Task2重新全局register |
| Task2→Task3 Hub exec input | Task2路由与local门；Task3仅加stdin，不绕过machine检查 |
| Task3→Task4 `output-ring`/`process` | native char cap与UTF-8 job byteoffset区分；delta来源必须已运行，而非done全量 |
| Task4→Task6 provider | job/file独立lane且共享owner/auth；copy不可复用textPTY |
| Task5→Task6/7 SSH connection | 只有ssh-targets规范化；copy/rsync/relay不得自己解alias忽略BYO |
| Task6↔Task7 暂存策略 | copy收完整中转；rsync走tunneldelta，不引入copy临时全量cache |
| Task1/2/8 pack YAML | row独立id，默认均开；不遗留旧Better-disable patch |
| Task0–8 Git/验收 | 每task可验证，但本仓红线优先于技能自动commit；最终消费者验收不能被unitgreen代替 |

任务内一致性：Task1 double-owner测试覆盖卸载；Task2空Hub不等于缺provider；Task3脚本原文与stdin互斥；Task4输出真增量且kill远端；Task5不改config；Task6校验失败保留数据而不留服务；Task7复用原生delta且凭据留origin；Task8验证交付形态而非源码链接。spec各节均映射Task1–8，P2/P3明确留后续。

## Execution status

- 已完成：会话设计、上游机制源码核实、规格/计划书面化与自审。
- 已获 user：书面规格审阅与执行授权（2026-10-10 "ok go ahead"）。
- 进行中：Task0–7 已独立审阅通过；Task8 在隔离 worktree 内进行双包/模型/目标机验收。M 已实装，worker/SSH cleanup 已有实际消费者GREEN；后续 container/source-proxy 修复当前源码验收中，待新同步N整包实装，用户亲验仍待进行。
- 不在本次授权：npm发布、Git定版、生产操作。
- 2026-10-10 第一人称实测（安装态 O 整包、真实 DSH 模型会话）：roster / byossh / script / stdin / PTY / jobs / copy（SSH、Docker、Incus、paired-only Hub）/ rsync（默认 dry-run、实际、真 delta）全部亲手 GREEN，结束资源清理经独立（非被测工具）核对为零残留；报告 `docs/test-reports/2026-10-10-remote-tool-first-person.md`，并在 companion report 顶部交叉引用。用户亲验与发布仍未进行。

### 2026-10-10 consumer worker delivery correction

The generated Super `remote/` contains exactly `plugin.js`, `plugin.d.ts`, private `file-worker.js`, and `provenance.json`. The worker leaf is built solely from canonical `better-dsh/src/remote/file-worker.ts`, has Node-builtins-only imports, and is hashed/checked with the closure. It has no public package export, host peer imports, duplicated host modules, source loader or Better dependency. The public plugin contract remains unchanged. The existing owned child-process/group cleanup remains the receiver boundary; no worker-thread lifecycle replacement. This narrow extra generated leaf fixes actual installed receiver resolution, not a general guarantee that host plugins import outside their host resolver.

### Task8 authorized consumer correction — Ruling22

Use canonical portable sideband ownership for SSH oneshot foreground/background/script/stdin after actual installed native job kill left remote processes alive. Three SSH startups and explicit remote Bash4.1+/Python3.7+ (macOS3.10+)/fcntl/shared monotonic/core utilities; no rsync prerequisite for ordinary commands, no origin Python or Linux/pidfd. Preserve literal work stdio, exact native SSH identity, Agent/plugin ownership and official job lifecycle. Actual receiving helper/group release before settlement; separate final stream drain bounded2500ms with honest incomplete-output diagnostics when transport is unavailable. Existing lease/recovery gate bound unchanged. Fresh synchronized artifact letter and installed job/PID GREEN required.


### Task8 container oneshot ownership correction (Rulings23–24)

Actual installed Docker/Incus native job cancellation reported killed while receiving children remained live. Canonical oneshot foreground/background/script/stdin therefore share the SSH portable receiving gate/control/work barrier through native container exec argv, not local CLI termination. Each command requires three native exec startups (clock, owner, literal-stdio work), remote Bash4.1+, Python3.7+, Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep. Linux containers additionally require stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER before business admission; the work helper reaps only its own/adopted children and stays alive until its work group is absent. This supports ordinary non-reaping PID1 containers without forcing --init, privilege/capability, image/config mutation, rsync, pidfd or origin Python. PTY/BYOPTY stay unchanged; SSH portable prerequisites are not broadened. The same eight-second counted lease, gate recovery, actual cleanup barrier and 2500ms honest final-output drain apply, with no enlarged grace, second job registry or availability polling. Consumer iteration N must prove real native killed status together with owned process/group/helper/state absence; M failures remain historical evidence.

Ruling25 supersedes the original two-remote source -R/private-master/sshd-FD/pidfd design after actual default dev3 source failed its permission requirement. A task-owned portable Python loopback proxy, inside the existing receiving helper/group/lease, carries bounded binary frames over authenticated SSH work stdio to an origin TCP bridge into the destination -L tunnel. A real full-route @RSYNCD greeting precedes business admission. No source Linux /proc, pidfd, privileged sshd access or source forwarding permission is required; native find, native rsync and the existing portable Bash/Python/fcntl/shared-monotonic prerequisites remain. No origin Python, credentials on peers, copy fallback, lease increase or second registry. Five-byte type/length frames cap data at64KiB and Python queues at256KiB; one active connection, real backpressure and half-close, prior reader/socket close before next OPEN. Ordinary two-remote transfer measures12 SSH startups: source preflight+inspection clock/work3, relay source/destination preflight2, destination clock/daemon+tunnel2, source proxy clock/owner/work3, native source rsync clock/work2. Fault recovery adds only task-owned authenticated cleanup reconnects, never transfer retries. Same real helper/listener/group/metadata/tunnel/socket cleanup barrier; receiving progress remains an explicit assumption. Historical M permission failure remains in the acceptance report; current default-dev3-source source test passes, installed next-artifact proof is separate.


### CLI binary receiving ownership (consumer correction, Ruling26)

Actual N native SSH copy cancellation settled while the remote import process and its unnamed staging file remained live under a finite work-channel EOF hold. CLI export/import/digest now reuse the canonical portable receiving owner, with raw binary work streams and the same counted lease, admission gate and authenticated recovery. Cancellation/failure waits for receiving helper/group/temp cleanup before local transport teardown/settlement. Normal success must completely drain the binary stream; the oneshot text lane's 2500ms incomplete-output rule does not apply. Archive validation, selected manifest digests, merge/no-delete behavior and canonical SSH identity/ProxyJump are unchanged. Local and Hub file lanes are unchanged.

This intentionally replaces the former Python-only minimum for CLI peers: Bash4.1+, Python3.7+ (macOS3.10+), Unix fcntl.flock/shared non-adjustable cross-process monotonic clock, mktemp/mv/rm/sleep; Linux containers also need stdlib ctypes and permitted unprivileged PR_SET_CHILD_SUBREAPER. No rsync or origin Python requirement, auto-install, second registry, fallback, peer polling or increased lease. Minimal Python-only peers no longer support this CLI lane; use a supported peer or authenticated Hub.

Each remote export/import/digest costs three native transport starts: clock, independent owner/control, literal binary work. Thus verified local→CLI or CLI→local costs six; CLI→CLI twelve. verify:false skips digest operations, reducing counts to three/three/six. Local/Hub operations do not contribute CLI starts. Fault recovery may add same-identity authenticated cleanup starts and may remain pending until genuine cleanup observation is possible. Artifact O must re-prove installed cancellation and complete binary integrity; N failures remain historical evidence.

### 2026-10-10 Ruling26 completion status (DSH continuation)

- 已完成：Ruling26 源码实现与覆盖测试（codex 阶段）；三处覆盖失败根因修复（stale prerequisite surface、dev3 fixture 动态摘要、TERM trap 重入）；incus 负载失败 Mode B 根因（recovery-run 入口闸 tick+8s 预算被负载吃掉、原先静默）与全部静默 admission/entry 路径的 stderr 化；全部现行必要检查绿（typecheck、vitest test/remote 30 文件/228 测试、hub build+83/83、npm test 42/42）。
- 已完成：0.3.0-o 同步双包构建与验证（better 4bf132ac…、super f07a3649…）；PC 4999/4997 与 dev3 4998 三线实装 O（dev3 pair SHA 复核、prebuilt WebMCP 修正沿用）；installed same-case 全绿：ssh-hold/docker/incus copy cancel（receiver gone before turn end；ssh-hold 附带 channel-close-withheld 终端后快照）、Better 移除后私有 worker 摘要+清理、owned cancel、Better 恢复复核。
- 待办/保留：Mode A（owner-active 150ms 窗口消失）已布防诊断未再复现，监控项；dev3 完整模型矩阵未在 O 重跑（O 对 N 的产品差异仅为失败路径 stderr 诊断），沿用 M/N 证据并在报告中如实区分；user 亲验未开始。
- 红线状态：无 commit/tag/push/publish；Web 测试线保持运行（PC 4999 local/https://test.pc.internal.test//LAN、Better 4997、dev3 4998 经 4996 转发）。
