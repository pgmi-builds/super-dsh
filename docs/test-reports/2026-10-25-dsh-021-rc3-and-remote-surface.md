# DSH v0.2.1-rc.3 对齐 + `remote` surface 重构（2026-10-25）

## 范围与结论

user 三条指令：① 上游对齐 dsh v0.2.1-rc.3；② 拆分 `remote`——文件传输独立为 `remote_transfer`，`remote` 改为必填 `action` 显式派发；③ 重写工具简介，把 PTY 定位成「stateful oneshot」并引导模型优先使用。

**结论：三条全部落地**。上游 checkout 已对齐 rc.3（9/9 gates PASS）；`remote` / `remote_transfer` 双工具在源码、Better 包、Super 独立闭包三处一致；简介重写完成。typecheck 通过，remote 测试 **216 pass / 8 skipped / 0 fail**（宿主上复跑；见 §6 的沙箱假象说明）；双包 tarball 已本地重打（**0.3.3-a**）并逐字节验证；tarball 内的插件在真实 registry 中注册出的是新 surface（§5.3）。**4999 线已重启到 0.3.3-a**，并用真实模型会话验证它调用 `remote{action:"status"}`、完整列出 `remote` / `remote_transfer` 的参数表（§7）。npm registry 未发布、git 未提交。

## 1. 上游对齐 rc.3

| 步骤 | 结果 |
| --- | --- |
| fetch | GitHub 直取 `dsh-v0.2.1-rc.3` = `1f81c047fc48fa190a683e469daa699857e9afe8`（origin 镜像止于 rc.2） |
| 硬切 | `git checkout -f` + `git clean -xdf`，工作树干净 |
| sanctioned 补丁 | 仍为单补丁：`pnpm-workspace.yaml` 尾部 `storeDir` / `verifyDepsBeforeRun`（rc.2→rc.3 该文件无变化，原样重放） |
| install+build | `npx --cache <仓>/.npm-cache/npx pnpm@11.7.0 install && run build` → pnpm 自切 11.28.5；**9/9 gates PASS（137.05s）**；`node apps/cli/lib/bin.js --version` = `0.2.1-rc.3` |
| farm | `sync-dsh-farm.mjs`：kept=351 relinked=1 removed=0 total=352 |

**rc.2→rc.3 delta = 640 文件 +5682/−1021**。实质变更：client UI（sidebar view pin、entry customization、tooltip/primitives、conversation composer/analytics、slot catalog）与 LLM listing/catalog（`llm-deepseek*`），另有 tsconfig/vitest 配置与快照。super-dsh 的契约包 `core/{tools,agent,scope,session}`、`boot/*`、`client/connection` **只有 package.json 版本 bump，src 零改动**；`web/webserver`、`gateway/stream`、`core/jobs`、`core/plugin-manager` 零改动 → **零契约漂移**，双包不因对齐而需改代码。与 user 预判（rc.3 已在 PC/DEV3 production 使用且兼容）一致。

## 2. `remote` surface 重构

### 2.1 判别字段：唯一派发维度

| 工具 | 判别字段 | 腿 → 字段集 |
| --- | --- | --- |
| `remote` | `action: exec\|add\|close\|status`（**必填**，无默认） | exec → target, cmd, stdin, scriptPath, timeout, run_in_background；add → ssh\|spawn（+ 可选 target 作 label）；close → target, force；status → target? |
| `remote_transfer` | `mode: copy\|rsync`（**必填**） | src, dst, argv \| pullArgv+pushArgv, verify, mkdir |

- schema 层 `required` 已生效（实测 `missing required property "action"` / `"mode"`），execute 内再留同义守卫；每个 action 声明自己的字段集，**跨腿字段一律 `E_PARAMS` 报错**（`"cmd" does not belong to action "add"`），不再做在场推断、不留别名。
- `status` 保留唯一一处浅在场语义：无 target = roster，有 target = probe / session card（REST `GET /list` vs `GET /:id`），按 user 裁决不再拆成两个动词。
- `add` 只进池、不跑命令：`ssh` 注册身份（不拨号），`spawn` 建 BYO PTY（warm）；`cmd` 恒为空串。**warm creation 从 surface 去掉**——`exec` 必须执行东西，想预热就 `cmd:"true"`。
- `exec` 必填 `target`；`:pty[:label]` 后缀仍即建即跑（tab 语义不变），`pty:<id|label>` / 裸 label 复用会话。
- 传输语义原样迁移：native scp/docker cp/incus/rsync、Hub binary lane、argv/pullArgv/pushArgv、verify/mkdir、fail-loud 全部不变；只是换了工具名与判别字段。`remote_transfer` 用 `mode` 而非 `action`（copy/rsync 是搬运方式，与「对目标做什么动作」不同层级）。
- 注册：`agent-registration.ts` 一次注册 `remote` + `remote_transfer`，两者 all-or-nothing——同名冲突时整对让给赢家行，其他异常照旧抛出并回滚已注册项、dispose driver。

### 2.2 代码

- 新文件 `better-dsh/src/remote/transfer-tool.ts`（`createRemoteTransferTool`，含自己的描述/参数/output schema/格式化回执）。
- `better-dsh/src/remote/tool.ts` 重写 surface 层：description、`RemoteArgs`、`ACTION_PARAMS` 校验、`add/status/close` 腿、输出 schema（kind 去掉 copy/rsync）。
- driver / pty-session / copy / rsync / jobs **零改动**——重构只发生在上层 surface，避免行为回归。
- Super 的 `super-dsh/remote` 仍由 `build-remote.mjs` 从 canonical 源码生成；新源文件自动进闭包与 provenance（已核验 transfer-tool.ts 在 `sources`，plugin.js/d.ts 在 `outputs`）。

## 3. 简介重写：PTY = stateful oneshot

user 诊断：预训练里 one-shot 的印记太深（返回形状原生、状态传递可审计），模型天然少用 PTY。本轮把「PTY 是另一种东西」改成「PTY 是同一种回执 + 状态」：

- 标题句 **"PTY IS A STATEFUL ONESHOT — default to it."**，明确：回执同样是 text/exit/duration，**只增** session/cwd/envDelta/commandId/idle-left；读取阶段什么都不少、上下文什么都不缺。
- 卖点写成 shell 的持续性：cwd、导出环境、shell 变量、venv、alias、开着的 REPL 跨调用存活；多步任务从「N 次无状态登录」变成「N 次廉价调用」；超时不再杀命令，而是交接成可 poll 的 job。
- 保留诚实边界：终端把 stderr 并入输出流（**与 oneshot 唯一的回执差异**），并保留 oneshot 的适用场景（单次探针、pipeline 阶段、需要 runner 监督保证的构建）——不靠贬低 oneshot 来抬高 PTY。
- 行动指引落在「创建会话只是 target 后缀，不是另一个工具」，并给出默认选择的判据（探索、迭代编辑、dev server、同一目录多步）。

`remote_transfer` 的简介独立重写：mode 两腿、endpoint 语法、argv 透传/两段式 pull/push、verify/mkdir 的真实语义、失败 fail-loud。`docs/remote-tools.md` 与 `docs/remote-copy.md` 同步更新（含新的 call 表与「PTY is a stateful oneshot」小节）。

## 4. 兼容性判断

- 旧调用形（无 action 的 `{target,cmd}`、`{action:"copy"|"rsync"}`、`{spawn,cmd}` 一次注册+执行）**全部硬失败**并带 action 提示，不会静默走错腿——这是 user 要的「不保留两套派发机制」。
- 旧 `KNOWN_PARAMS` 只校验 copy/rsync 分支；现在每个 action 都校验，历史上被 dsh-tools 透传的多余字段（例如遗留 `mode:"pty"`）会显式报错。
- BYO 从「一次注册+执行」变成 `add` 然后 `exec` 两步；`E_LABEL_IN_USE` 语义不变（同 label 再次 add 仍拒绝）。

## 5. 验证

### 5.1 类型与单测

| 项 | 结果 |
| --- | --- |
| `better-dsh npm run typecheck:host` | 0 error（host + test 全部） |
| `better-dsh npx vitest --run test/remote` | **216 pass / 8 skipped / 0 fail**（224 条；宿主复跑） |
| 根 `npm test`（node --test） | **42 pass / 0 fail**（宿主机复跑，0.3.3-a 版本同步后；早前 `pi-bundle` 的失败同为沙箱内 pnpm store 只读） |
| `remote-delivery` 交付测试 | 通过（闭包 provenance、Better 无共享 chunk、无 host peer import、provenance 哈希逐叶子核验） |

测试同步改写的点：8 个 remote spec 的调用形改为 `action` / `mode`；`real-harness.invoke` 增加工具名参数；BYO 用例改为 `add`→`exec` 两步（`runPty` helper 只对 `E_LABEL_IN_USE` 兜底）；`add` 相关断言改为检查 `.parameters.required`（数组）与 `properties`。**没有为迁就测试而在业务代码里留兼容层**；唯一为可测性调整的是 `add` 的注册回执措辞（含 `registered — address it as …`）。

### 5.2 双包 tarball（本地重打，registry 冻结不动）

- `better-dsh@0.3.3-a` sha256 `e8ef6deb78a5f68df099585146760c8750e460cfc11a27655598d16d2f321151`
- `super-dsh@0.3.3-a` sha256 `184febc3fe88a4cd927fdf05f10ee937d24513604ae7d462cbf61bc282755e21`
- `[pack] verified independent synchronized packages; no Better dependency or payload in Super`。
- 解包核对：Super 闭包 `remote/plugin.js` 含 `remote_transfer` / `PTY IS A STATEFUL ONESHOT` / `action is required` / `mode is required`，`provenance.sources` 含 `transfer-tool.ts`，`outputs` 仍只有 `plugin.js` / `plugin.d.ts` / `file-worker.js` / `helper-bin/*`；Better `lib/remote/plugin.js` 同样两个工具与教学句。

### 5.3 交付形态下的真实注册面

把**两个 tarball 解包后的插件**放进真实 cordis registry（SystemPrompt + ToolRuntime + AgentRegistry + scoped agent），`agent/created` 后 dump 模型可见 schema：

```
super-dsh-0.3.3-a tarball
{"name":"remote","required":["action"],"fields":["action","target","cmd","stdin","scriptPath","timeout","run_in_background","ssh","spawn","force"],"actionEnum":["exec","add","status","close"],"ptyStateful":true,"descriptionChars":4615}
{"name":"remote_transfer","required":["mode"],"fields":["mode","src","dst","argv","pullArgv","pushArgv","verify","mkdir"],"modeEnum":["copy","rsync"],"ptyStateful":false,"descriptionChars":2252}
better-dsh-0.3.3-a tarball
（同上，逐字段一致）
```

即：**交付物里注册出来的就是目标 surface**，不是源码树里的一个理想形态；两条 remote 行（Better / Super）产出的 schema 完全相同，重名仍按 all-or-nothing 让给赢家。

## 6. 误判修正：沙箱 uid 映射假象（不是系统缺陷）

本轮第一版报告曾把 5 条 ssh fixture 失败判成「本机 ssh 系统配置被改属」。**该判断错误，已撤销**：那是在 DSH bwrap 沙箱内看到的 `nobody:nogroup`（user-namespace uid 映射假象）。宿主上实际为 `root root 755/644`，`-F` 与 `-o` 两种 ssh 调用都正常。

- 沙箱内症状：`Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` → `scp: Connection closed`，5 条用 `-o` 隔离的用例（copy 3 / container-copy 1 / ssh-targets 1）exit 255。
- 宿主复跑同一套件：**216 passed / 8 skipped / 0 failed（224 条，29 个文件全过）**。
- 教训：在沙箱里看到「文件属主 nobody / 权限异常」先怀疑身份映射，用宿主真实 `stat` 复核；**ssh 系统配置无需也不得改动**（本轮未改）。

## 7. 4999 浏览器线：已重启并完成第一人称模型验证

沙箱解除后（宿主 PID 1 = systemd、systemctl --user 可用、4999 由测试 unit 持有），用 `bash super-dsh/test/start-4999.sh` 重启。**过程中发现并处理了一个真实消费面的坑**：

- 测试 home 里 Better 仍是 0.3.2（同一版本号 → companion 按「既有安装保留」策略不重装，`lib/remote/plugin.js` 里没有新 surface），而 Super 已换新。两条 remote 行谁先注册谁定义模型可见面，**旧 Better 行赢 = 模型拿到旧 surface**。
- 处理：把本轮升到同步字母版本 **0.3.3-a**（`npm run version:release -- 0.3.3-a`，registry 不动），Super 走 launcher 安装；Better 用官方原生入口 `dsh plugin --profile superd-pub add better-dsh@0.3.3-a`（等价 Settings → Install）。再重启后两个包都是 0.3.3-a 且都含新 surface。

最终状态：

| 项 | 结果 |
| --- | --- |
| units | `superd-4999-test` / `superd-lan-4999-relay` / `superd-4999-pair-registry` 全 active |
| 入口 | `http://127.0.0.1:4999/`、`https://test.pc.internal.test/`、LAN relay；根 200（Better 密码页），匿名 API 401 |
| boot | 本次启动窗口 0 个 `world failed`；六个 world 仅既有 `harness-dev-context pending` 警告 |
| 安装产物 | profile 内 `super-dsh@0.3.3-a` 与 `better-dsh@0.3.3-a`，`remote/plugin.js`、`lib/remote/plugin.js` 均含 `remote_transfer` 与 `PTY IS A STATEFUL ONESHOT` |

**第一人称模型验证（真实 4999 实例 + deepseek-official / deepseek-flash）**：用 operator cookie 经 RPC 建会话 `session-6df72906…` 并发提示词要求它「用 `remote` 的 `action:"status"`（无 target）跑一次，然后列出本会话可见的 remote 相关工具及其参数名」。会话日志证据：

```
tool/call  {"name":"remote","arguments":"{\"action\": \"status\"}"}
assistant  "1. remote — params: action, target, cmd, stdin, scriptPath, timeout, run_in_background, ssh, spawn, force
            2. remote_transfer — params: mode, src, dst, argv, pullArgv, pushArgv, verify, mkdir"
           + roster 实际返回 hub machines / ssh hosts / docker / incus 列表
```

即：模型在真实运行时里看到并正确使用了新 surface，`remote_transfer` 作为独立工具出现，`remote` 的参数表与实现完全一致。浏览器侧的用户亲手验收仍按惯例交给你（`https://test.pc.internal.test/`，cookie 直入）。

## 8. 未做与注意

- **未发布 npm、未提交 git**：本轮没有 user 放行；registry `latest` 仍为 0.3.2 原发布。
- **版本已升到同步字母版本 0.3.3-a**（仅用于本轮 tarball 通道与 4999 实测，registry 冻结）。要正式交付给消费者，按红线等 user 放行后发布；届时 Better 与 Super 必须**一起**升到同一新版本，否则 companion 的「既有安装保留」会让旧 Better 继续提供旧 surface（见 §7）。
- **dev3/PC production 未动**：user 已明确 rc.3 在两地 production 现场运行且与本工具兼容，本轮对齐只覆盖仓内 checkout 与构建面。
- BYO 两步化（`add` → `exec`）是本次唯一的行为收紧，旧「一次注册+执行」调用会失败并提示 action 用法；若 user 希望保留一步式，需要把 `ssh`/`spawn` 重新并入 `exec` 字段集——那会部分回退「action 是唯一派发维度」。
- `docs/remote-tools.md` / `docs/remote-copy.md` 已同步；`docs/specs/remote-tool-enhancement/spec.md` 顶部加了本轮 surface 修订条目；`docs/dev-test-environment-notes.md` 记录 rc.3 基线与 ssh 缺陷。
