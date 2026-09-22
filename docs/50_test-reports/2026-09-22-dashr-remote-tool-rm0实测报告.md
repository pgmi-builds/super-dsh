# dashr remote tool RM0（ssh 工具面）4988 第一人称实测报告

- **日期**: 2026-09-22
- **分支**: `remote-tool-rm0`（隔离 worktree `.worktrees/remote-tool-rm0`；一仓两工作流 git 分离后的 pure 链）
- **代码范围**: `better-dsh/src/remote/*`（ssh-config / registry / framing / hostkeys / session / backend / preparation / engine / tool / plugin）+ 三处接线（package.json exports `./remote`、tsdown entry、cordis.patch.yml `dashr-remote` 行）
- **对照设计**: `docs/10_plans/dashr-remote-tool-design.md` §9 RM0 验收行（六条）
- **执行计划**: `docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md`

## 一、环境与部署

- Dev/Test 1：monorepo `upstream/deepseek-harness`（tag dsh-v0.1.6-alpha.2 基线 + 仓内 patch），canonical src 自 worktree rsync（本次起 rsync 源从共享 checkout 切到 `.worktrees/remote-tool-rm0/better-dsh`——git 分离后正本随分支走），devDeps 手术（14× workspace:*）照旧。
- 新依赖：`ssh2@^1.17.0`（+ devDep `@types/ssh2`）；monorepo `pnpm-workspace.yaml` allowBuilds 增 `ssh2: true`（其 optional crypto binding 构建成功）与 `cpu-features: false`（可选加速器，拒装保最小 native 面）。注意：pnpm 11 首次 install 失败时会在 yaml 尾部自动追加 `set this to true or false` 占位行，手写条目后会与之 duplicated mapping key 冲突——需删除占位行再装（本次坑，已记）。
- 构建：`pnpm --filter better-dsh exec tsdown` + `tsx scripts/build-client.ts`（lib/client 清洗陷阱照旧成立），`lib/remote/plugin.js` 产出。
- 实例：`PORT=4988 bash .tests/dsh-test1/start-4999.sh`（4999 被外部进程占用且沙箱内无法核验归属，选 4988；unit `dsh-4988-test`，boot 产物 `apps/cli/lib/bin.js` + 裸 node——双平面红线遵守）。boot graph client entries 含 `"id":"better-dsh"`；服务端行装载由下述 session 证据反证。
- 第一人称载体：`dsh headless`（真实运行时 session、真实 LLM、真实工具派发）。test home 的 headless profile 原不含 better-dsh——已在其 package.json bundles 增补 + node_modules symlink 指向 monorepo 副本（**仅测试 home 变更**，tracked 种子未动；web profile 未改）。`--dump-config` 确认 `dashr-remote` 行入组合。

## 二、RM0 六条验收（逐条证据）

验收脚本一（6 调用：status+bind → cd → pwd → pnpm → sleep 超时 → echo），脚本二（4 调用：status+bind → hostname&&pwd → echo ×2，并配 ss 采样器 0.5s×80）。输出摘自 headless session log（`.dsh-test/sessions/--…harness--/session-*.v3.jsonl.zstd`）与终端回显。

1. **`cd` 一次后连续调用粘住（shell 常驻）** ✅ — `ssh({cmd:"cd /tmp && pwd"})` → `/tmp`；随后 `ssh({cmd:"pwd"})` → `/tmp`（同一 PTY 会话，cwd 未归零）。
2. **`pnpm` 首调用即可用（login bootstrap）** ✅ — `ssh({cmd:"pnpm --version"})` → `10.33.2`（exit 0 · 0.4s），无任何安装/PATH 手工。
3. **`ssh({target:"dev3"})` 一调用拿到 user/key/工具链/sudo/RTT/cwd 全块** ✅（fix round 2 后）— verbatim：
   ```
   target : dev3 → u1@dev3.internal.test:22  (key /home/u1/.ssh/id_key2, via ~/.ssh/config)
   conn   : alive 1s   rtt 941ms
   cwd    : (unset)
   env    : login-shell (bash -lc)
   tools  : node v24.15.0 (/usr/bin/node) · python3 3.14.4 (/usr/bin/python3) · pip 25.1.1 (/usr/bin/pip) · git 2.53.0 (/usr/bin/git)
   sudo   : NOPASSWD ✓
   ```
4. **全程一条 TCP（连接池化）** ✅ — 4 次 ssh 调用（status+bind + 3 exec）期间 `ss -tn state established` 采样（0.5s×~40 命中）：唯一四元组 `192.0.2.130:49478 ↔ 187.127.111.29:22`（11 个样本同本地端口，仅队列态抖动）——单 TCP 多 channel 成立。
5. **超时命令被 Ctrl-C 打断且会话存活** ✅ — `ssh({cmd:"sleep 300", timeout:5})` → `[exit 130 · 5.0s · interrupted]`（130 = 128+SIGINT，看门狗 `\x03` 路径）；随后 `ssh({cmd:"echo alive"})` → `alive`（exit 0），同一会话继续可用。
6. **审计 + TOFU 落盘** ✅ — session log 含 `dashr/remote-exec` 结构化事件（成功 `{target,cmd,cwd,exit,durationMs}`、失败含 error）；TOFU pin 首连写入 `.dsh-test/storages/better-dsh/remote-hostkeys.json`：`{"dev3":"SHA256:VMPA7FG+Ae+o/V5TJtUbzgu9UhEJO+Qkys6/X4Nzc7g"}`。

localhost 变体（本机 sshd）未跑：registry 从 `~/.ssh/config` 播种，本机无 localhost 条目；dev3 已覆盖全部判据，RM0 不追加（如需，给行配置 targets 加一条 override 即可复测）。

## 三、实测中发现并修复的缺口

- **status 冷 target 不拨号（fix round 2，commit 1167500）**：首轮验收 status 只渲 4 行（target/conn/cwd/env）——engine 把 Ruling 2 实现成"永不为冷 target 拨号"。修复：status 冷路径经 exec 同一 lazy factory 拨号 + degraded probe（10s）→ 全 facts 块（tools/sudo/bashVersion/rtt=probe 时延）；拨号/探测失败渲 error 行、status 永不 throw；仍永不建 PTY 会话。修复后复测 = 上面第 3 条的 verbatim 全块。这正是第一人称验收的价值：单测绿 + tsc 0 都抓不到"设计裁决被反向实现"这一层。

## 四、已知细节（不阻塞，记录在案）

- **probe 的 tools 行在 dev3 上无 pnpm**，而 PTY 会话里 `pnpm --version` 可用（10.33.2）：degraded probe 走 `bash -lc` 的 PATH，dev3 的 pnpm 属交互 shell shim（.bashrc 侧）——两条路径语义都"诚实"（各自所见即所报），与设计 §3.2 工具链解析的口径一致；模型实际执行时走 PTY 面不受影响。
- bashVersion 已进 facts 但不渲染（§3.3 渲染契约本无 bash 行；如需属 preparation 层增行）。
- stdin 参数为 best-effort 拼接（engine 无 stdin 通道，EOF 不可发；描述文本已如实披露）——RM0 后候选。
- 依赖级联实测报告（2026-09-22 热插拔轮）确认行级 HMR 开关可用；本行 `dashr-remote` 形态与 sibling 行一致（无 config 块），插件管理器开关面天然继承。

## 五、测试基线

- worktree `npx vitest run test/remote/`：**133/133**（10 个 spec 文件；含 fix round 2 的 14 例 engine）。
- 全量 vitest（worktree）：恰为基线 14 失败（url-schemes 2 + surface-devices/agent-family 12，皆先在、与本特性无关），635 通过 + 1 skip，无新增失败。
- `tsc --noEmit`：remote/* 相关 0 新错（仓内既有 peer-dep 噪声照旧）。

## 六、遗留（后续里程碑）

- RM1 Docker 同构面（`docker(target, cmd)`，Engine API + WorkingDir/Env 状态携带）。
- RM2 tmux 驻留增强 + Web UI 终端面板（人机同会话 attach）。
- RM3 forward（端口/Unix socket 转发）+ LXD REST backend；ProxyJump 支持随 RM3 评估。
- 方案糖（O-R12 `read ssh://…`）默认不做，等真实使用数据。

## 七、结论

RM0 入口闭环六条验收全绿；SDD 全流程（10 任务、9 轮评审、2 轮 fix loop）收口。`dashr-remote` 行以 better-dsh 内 composition row 交付（非独立 npm 包），插件管理器可开关。发布（npm publish）另按发布红线走（本报告仅为 dev 实测，不含放行）。
