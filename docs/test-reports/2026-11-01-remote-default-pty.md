# remote default-PTY 重构（0.3.3-b）交付形态验收与第一人称行为验收

日期：2026-11-01（Asia/Hong_Kong）。被测版本：`0.3.3-b`（root / better-dsh / super-dsh 同步，`npm run version:release -- 0.3.3-b`）。计划：[2026-11-01-remote-default-pty-plan](../10_plans/2026-11-01-remote-default-pty-plan/plan.md)；正本 spec：[docs/specs/remote-default-pty/spec.md](../specs/remote-default-pty/spec.md)（含四轮 user 裁决）。

本轮**未 commit / tag / push，未 npm publish**（publish 待 user 单轮放行；工作树保留全部 Task B–F 变更未提交）。

---

## 0. 结论

1. **实现面**（Task B–E，本轮完成）：默认 PTY 槽 + 三路 handoff、`run_in_background` 同操作 handoff、配额 30、`input` action 与 `:pty` 创建语法退役（exec stdin-only / add spawn 承接）、ledger 退役、SSH oneshot MUX（`ssh-mux.ts`，含取消即发远端清理的 `onCancel` 修复）。全量回归 **better-dsh remote 33 文件 / 270 pass / 8 skip / 0 fail**（较 Task D 净增 9 个 MUX 用例），tsc 零错。
2. **交付形态**：双 tarball（better `cb1935b0…`、super `ca358b80…`）经 `pack-pair.mjs` 独立包校验；PC 4999 与 dev3 4998 双 rig 安装态叶哈希逐字节一致（better `lib/remote/plugin.js` = `323e74f1…`、super 闭包 `remote/plugin.js` = `cd209e74…`），双 rig companion 均 0.3.3-b，boot 零 `failed to import`。
3. **模型第一人称**：PC 4999 真实模型会话 3 轮（A）+ 独立第二 Agent（B），dev3 4998 真实模型会话 2 轮；spec §8 列出的全部场景（默认 PTY/三路 handoff/went-async 双层表述/从 0 首读/busy stdin-only/oneshot/script+stdin/BYO `~/` 展开/status·close.force/配额触顶与恢复/两 Agent 隔离/roster 即时呈现）**全部以模型实际回执闭环**，MUX 复用以宿主侧 socket/master 证据闭环。
4. **模型如实上报 4 处与验收清单预期的分歧**——经对照 spec 全部为本清单预设错位或设计内行为，无一为回归（§4 逐条定性）。

---

## 1. 现场与证据链

| 项 | 实测值 |
| --- | --- |
| 版本 | `0.3.3-b` 同步（root/better/super + lockfile 元数据） |
| better-dsh tarball | `.scratch/superd-pack/better-dsh-0.3.3-b.tgz` sha256 `cb1935b0bbf93175…` |
| super-dsh tarball | `.scratch/superd-pack/super-dsh-0.3.3-b.tgz` sha256 `ca358b80cbb2d09d…` |
| pack 校验 | `pack-pair.mjs` 独立双包校验（independent-bundle/provenance）；dev3 侧经 `SUPERD_TEST_PACK_DIR` + `read-pack-pair.mjs` 重定位核验后安装（目标端不重建，docs/07 §8.1 流程） |
| PC 4999 | `superd-4999-test` / lan-relay / pair-registry 三 unit active；`/` 200、匿名 `/api` 401；安装态 better+super 均 0.3.3-b |
| 哈希链（PC） | 安装态 `better-dsh/lib/remote/plugin.js` = tarball 叶 = `323e74f1f7acc7d3…`；`super-dsh/remote/plugin.js` = `cd209e749bed807d…`；当前 boot 零 import 失败（日志含历史 boot 旧条目，已甄别） |
| 哈希链（dev3 4998） | 同两叶哈希与 PC 逐字节一致；`superd-4998-test` / relay / pair-registry(14998→pack-0.3.3-b) active；`/` 200、匿名 401；boot 零 import 失败 |
| dev3 安装锚 | `.tests/dsh-0.2.2-alpha.2-install`（独立测试锚，npm 安装 `@deepseek-ai/dsh@0.2.2-alpha.2`，与生产 `~/.local` 树无关；测试 home `.tests/superd`，测试 env 经 `SUPERD_TEST_ENV_FILE` 独立播种） |
| Web URL | PC：`https://test.pc.internal.test/`（4999 保持运行供 user 验收）；dev3：本机 4998，另有浏览器 review 转发 `http://127.0.0.1:4996/`（unit `superd-4996-dev3-review`，docs/07 §8.2 形状；收线 `systemctl --user stop superd-4996-dev3-review`） |
| 生产红线 | `~/.dsh`、`~/.superd`、生产 3080/3081、live Caddyfile 未触碰；dev3 生产安装未动 |

## 2. 回归与定向复测

- better-dsh remote 全量（含 `source`/`better`/`super` 三交付变体）：**33 文件 / 270 pass / 8 skip / 0 fail**（container-process 8 skip 为既有无夹具跳过；MUX 新增 `ssh-mux.spec.ts` 9 用例：argv 形状/七维身份键/0700 目录/dispose `-O exit`/路径超限退化/builders 注入面/首连-复用/并发/超时取消 master 存活/status 同链/双身份不串/PTY 零注入/残 socket 自愈/`-F` config alias 与 MUX 并存）。
- tsc（src+测试）零错；产物重建后跑（`better:`/`super:` 变体消费构建产物）。
- Task E 探针基线（发起端 OpenSSH 10.2p1）：首连 ~80ms、复用 ~6ms（≈13×）、master fork 后 PPID=init 自成会话组、SIGKILL 残 socket 自愈、`-O exit`/persist 到期自删——已记入 spec §7.3。

## 3. 模型第一人称证据（PC：session-83fa3a6c（A，3 轮，167 条 assistant 消息）、session-d253ab81（B，28 条）；dev3：session-3b24a670（2 轮，73 条）；三会话全程 **deepseek-flash**（transcript `model` 字段核实），仅 remote/官方 job 工具）

| 场景 | 模型实际回执（摘） |
| --- | --- |
| 默认 PTY 建槽 | `[pty:pty-hngk · conn ssh:dev3 · cmd remote-5184af71… · cwd /tmp · env +MARK,+OLDPWD ~PWD · idle-left ~15m · exit 0 · 0.9s]`；同机二次调用同 id、`v1/tmp`（cwd/env 保留） |
| card（status） | `pty:pty-hngk — ssh:dev3 · idle 4s (connected) · cwd /tmp` / `no command running` |
| fresh handoff | `handed off pty:pty-hngk — ssh:dev3` / `detached` / `this machine's next exec opens a fresh default PTY`；随后 machine exec 开新会话 pty-gpto、MARK 为空（fresh shell） |
| busy handoff（超时置忙后） | `handed off pty:pty-e6a5 — ssh:dev3 … still running: command remote-74427460… — follow with job_output …, cancel with job_kill`（running + commandId） |
| 机器默认 `run_in_background` | `Started remote-b435b91… on pty:pty-gpto (ssh:dev3). …completion is reported by the host.` → 下一次 machine exec 即新会话 pty-e6a5（**同操作 handoff**）；完成后**完成通知实际送达**模型（BG4/BG5 + completed） |
| went-async 双层表述 | 模型逐字引述 schema：`the command went async (not bash &) — a running job returns immediately and a completion notification will follow, so no polling is required…job_output reads the command's full stream from byte 0 (overlap with a pre-handoff receipt is expected)` |
| job_output 从 0 首读 | 提交后首次读 = `BG1⏎BG2⏎BG3 [running]`（从字节 0 起，无缺头）；`LATE` 场景同 |
| busy stdin-only | `wrote 2 bytes into pty:pty-4nwl for command remote-9714672e… — this confirms the write…` ×2 → `P1:P2:GOT:x/y [exit 0]` |
| oneshot 隔离 | `OS` + `[runner superd-run 0.3.1-d.b596 … · exit 0 · 0.1s]`，无 session 字段、无状态 |
| MUX 复用（宿主侧） | 3 个 `superd-mux-<owner8>` 目录（每 Agent driver 一个）；两 Agent 对**同一对身份哈希**各自持 master（目录隔离、socket 哈希相同）——4 master `-O check` 全 `Master running`；socket `srw-------` 于 0700 目录内。回执粒度（0.1s/0.1s）不可见速度差，属预期（MUX 对模型不可见） |
| script+stdin | oneshot `scriptPath:/tmp/acc-rdp/echo.sh` + `stdin:"hello\n"` → `SC:GOT:hello` |
| BYO + `~/` 展开 | `add {ssh:{host:dev3.internal.test,user:u1,key:~/.ssh/id_key2}}` → registered（no dialing）→ `ssh:acc` oneshot `BYO`；Agent B 同名 label 注册成功（label 按 Agent 分区） |
| status 机器卡 | `probe: reachable in 106ms (just now, on demand)` + `default PTY: pty-gpto ssh:dev3 idle 75s` + 本连接全部会话；dev3 侧出现 `default PTY: none — this machine's first exec opens one` |
| roster 即时/外部变更 | 无 target roster 即时返回（本地 config/docker/incus/hub 读取，无拨号）；外部新建容器 `acc-pty-f` 在下一轮 roster 出现 `docker containers: acc-pty-f (running), corti…` |
| 配额 30 | 第 31 个 spawn 拒绝：`[E_SESSION_LIMIT] … this Agent already holds 30 live PTY sessions — the per-Agent session global limit (30) is reached…`（q28 起如实计数 30，含教学）；全关后 `pty:rec` spawn 成功（恢复） |
| close 语义 | busy：`[E_SESSION_BUSY] … job_kill … first (or wait…), then close again; force:true closes the tab and kills the group in one step`；job_kill 后 close 成功；对已腾空 machine slot：`not closed (not-found) — no default PTY on ssh:dev3 — a machine's first exec opens one`；模型原话确认 **close 只收 target/force，无 job 字段** |
| TTL | 回执 `idle-left ~15m`（结构化 `ttlSec` 渲染形）；配额恢复即额度释放的证据 |
| 两 Agent 隔离 | B 的 roster 仅 `pty sessions: pty:pty-364a ssh:dev3 [idle 1s; default on ssh:dev3]`——无 A 的 busy1/io1/q1..q30/rec，ssh hosts 无 A 的 `acc`；B 自注 `add ssh:acc` 成功且为自身注册；清理后 `pty sessions: none` |
| dev3 实装行为 | ssh:pc 默认 PTY 状态保留、handoff、oneshot×2、status、stdin-only 交互、close/清理、resume（同会话第 2 轮）全过；`incus containers: unavailable — exec: spawn failed — spawn incus ENOENT`（宿主无 incus 的诚实降级） |
| create/prompt/resume | PC（A 三轮 = create+prompt×3、B create+prompt）与 dev3（create+prompt×2）均真实模型会话 |

## 4. 模型上报分歧的定性（全部非回归）

1. **`exec` 无 payload → `[E_PARAMS] must execute something`**：card 语义归 `status {target}`（spec §5：exec = 命令/stdin-only；错误文案恰好教三正途）。driver 内 `cardReceipt` 机器分支经工具层不可达，属内部 API 保留（测试在用），记录为观察项，不改。
2. **`spawn` 不属 `exec`（属 `add`）**：Task D surface 定稿（add 承接 ssh 与 spawn 两 BYO 入口）；模型被错误教学文案一次纠正。
3. **`handoff` 拒绝 `pty:` 目标**：设计（handoff = 机器默认槽专属；可寻址会话天然已分离）；busy handoff 经「同步超时置忙 → handoff 机器」路径第一人称补齐（A3-22）。
4. **MUX 速度差在回执粒度不可见**：MUX 为内部传输层，模型面零披露（设计）；宿主侧 socket/master 证据补齐（§3）。

## 5. 已知形状披露

- dev3 上 `runner: superd-run 0.3.1-d.b596`：helper 二进制有独立版本节奏（`~/.cache/superd/run` 既有缓存），`runner` 字段如实披露实际缓存版本——既有形状（v032e 同）。
- MUX：调用期间本机 SSH config 固定是前提（spec §6）；本轮双 rig 均未中途改 config。master 残留于 Agent 崩溃时由 `ControlPersist=600` 到期自清；正常退出走 dispose `-O exit`。
- 首拨即 master 的客户端被取消时，远端清理 killer 经 `onCancel` 取消即发（否则 mux fd-passing 持管道到远端会话结束）；该路径已被 `ssh-process.spec` 既有 6 用例 + `ssh-mux.spec` 覆盖。
- 配额错误仅在触达时披露（spec §4 二/三轮裁决：任何模型可见 surface 不预先公布上限）；roster/status 全量可见 active 会话。
- 测试会话（A/B/dev3 各一）保留于 `.tests/superd` 与 dev3 `.tests/superd`（session-format 验证资产）；外部容器 `acc-pty-f` 已清理；探针临时文件已清。

## 6. 遗留与下一步

- **publish / git 定版**：待 user 单轮放行（0.3.3-b 为测试字母版本；正式发布版本号由 user 指令定）。工作树含 Task B–F 全部变更 + 本报告，未提交。
- 4999（`https://test.pc.internal.test/`）与 dev3 4998 保持运行供 user 复验；收线：`systemctl --user stop superd-4999-test superd-lan-4999-relay`（PC）/ `superd-4998-test superd-lan-4998-relay superd-4998-pair-registry`（dev3）。
- 观察项（不阻塞）：driver 机器 target 无 cmd 的 `cardReceipt` 分支为内部保留路径，未来若工具层永不放行可裁剪。
- **后续独立第一人称复测**（同一 `0.3.3-b` 交付，2026-11-01 晚）：[2026-11-01-remote-default-pty-first-person-independent.md](2026-11-01-remote-default-pty-first-person-independent.md)——主干判定复核通过；另报告 4 个 `scriptPath`/后台组合缺陷（PTY 脚本永不结算并接管会话、脚本载体与业务 stdin 未分离、bg+script 丢载体、raw Ctrl-C 后 job 滞留），本文未覆盖这些组合。
- **修复轮（同日 21:00–22:30，0.3.3-c → 0.3.3-d）**：独立复测四缺陷已修（F1/F2 载体、F3 lane、F4 surface），另发现并披露 rig-only「bg + startup stdin」概率性丢失（未根治，surface 已标注 + 防御性合并写入）。详见 [2026-11-01-remote-default-pty-c-d-fix-round.md](2026-11-01-remote-default-pty-c-d-fix-round.md)；本报告的 script+stdin 覆盖结论以修复轮报告为准。
