# Remote 透传再定位：默认值层、诚实回执与对端 Helper

- 日期：2026-10-13（Asia/Hong_Kong）
- 状态：**讨论草案**。未定版、未实现、未验收；不改变现行代码与已发布产物的任何承诺。Phase 0 审计已于 2026-10-13 执行完毕，结果并入 §2；生命周期澄清见 §5.6。
- 来源：2026-10-12/13 两轮对话（user 与 agent），含 user 对 binary 动机的重排论证。
- 关系：
  - 前置裁决 [remote-native-shortcut](../remote-native-shortcut/spec.md)（2026-10-11，已实施）：确立原生 CLI 透传路线，把 `verify`/`mkdir` 限定在 Hub/本地托管 lane，并**否决过一次**"Rust 自带 worker 用于文件传输"，同时留有活口："若以后重新要求强远端生命周期保证，再单独评估"。本草案重开的正是该活口，且动机不同（见 §5.1）。
  - 更早历史：本仓曾有一次"每次 copy 默认独立哈希验证"方向，已被 native-shortcut 取代。§4 的档位讨论是该立场的第三次校准。

---

## 1. 定性：透传框架（user 定位，正式化）

**我们现在的 SCP / SSH copy / Docker cp / Incus file，就叫透传（passthrough）。** 工具在传输环节自己不实现任何东西：能交给原生 CLI 的传输、选项、退出码、报错，都交给它们。工具的真实价值在透传两侧：

**入口（仍然超出语法糖的部分）：**
1. 路由解析——裸名 `target` 背后是 ssh config → docker → incus → live pty 匹配链；
2. 身份管理——`byossh` 注册后密钥永不内联、不落盘、可跨调用复用，`scp -3` 时身份留本机不扩散；
3. Hub 常驻通道与 pty 会话语义（cwd/env 存活、Ctrl-C 不杀会话、空闲回收）；
4. 执行纪律——oneshot 的进程组隔离、收割、超时杀组（现状经 POSIX wrapper 实现，见 §2）。

**出口（回执）：** 透明汇报实际 argv、各段 exit、做了什么没做什么。

术语约定（本草案及后续讨论使用）：

| 术语 | 含义 | 现状 |
| --- | --- | --- |
| **透传 lane** | native CLI verbatim：`scp`、`rsync`、`docker cp`、`incus file` | 任何 CLI peer 端点 |
| **托管 lane** | 工具自实现：archive manifest + digest + 原子 import（Node worker） | 仅 Hub↔local↔local（[copy.ts](../../../better-dsh/src/remote/copy.ts)、[file-worker.ts](../../../better-dsh/src/remote/file-worker.ts)） |

**Re-scope 原则（user 表述，本草案恪守）：** 不把透传改成托管；同样的 functionality 只改一点点——**默认值多一些，返回值保持诚实透明**。入口薄到 `{src, dst}` 可调用，出口厚到每个默认决策都有证据。省心的是参数，诚实的是回执。

---

## 2. 现状核实（代码事实，2026-10-13 主 checkout）

两条 lane 的分界与拒绝点（[driver.ts:119–167](../../../better-dsh/src/remote/driver.ts#L119-L167)）：
- 托管 lane：`copyTree`，manifest digest 校验、`mkdir ?? true`、scratch 清理；
- 透传 lane：argv 原样透传；调用方显式传 `verify`/`mkdir` 会**直接 throw**（"apply to the Hub/local staged lane only"）——这是 native-shortcut 规格的既定行为，不是缺陷；
- `rsync` 仅限 SSH/byossh 端点（[driver.ts:149–158](../../../better-dsh/src/remote/driver.ts#L149-L158)），docker/incus/hub 明确拒绝。

远端脚本清单（= 潜在 helper 替换面）：

| 远端脚本 | 位置 | 职责 |
| --- | --- | --- |
| oneshot wrapper | [transports.ts:20–33](../../../better-dsh/src/remote/transports.ts#L20-L33) | `setsid --wait bash -c`、pgid 写 pidfile、TERM/HUP/INT 自免疫 trap、EXIT trap 杀组+清 pidfile |
| killer 会话 | [driver.ts:225–232](../../../better-dsh/src/remote/driver.ts#L225-L232) | 独立 ssh 会话读 pidfile → `kill -TERM -- -pgid` → `sleep 0.3` → `kill -KILL` → rm |
| rsync relay 守护/清理脚本 | [ssh-rsync-native-relay.ts:228–262](../../../better-dsh/src/remote/ssh-rsync-native-relay.ts#L228-L262) | mktemp、rsyncd.conf 生成、stderr marker、pidfile 轮询清理 |

wrapper 的**安静依赖集**（透传"只要 bash"承诺的真实边界）：

| 依赖 | Linux (glibc) | Linux (busybox/Alpine 容器) | macOS | Windows (OpenSSH) |
| 依赖 | Ubuntu dev2/dev3（ssh 实测） | Debian slim 容器（docker exec 实测） | Alpine / busybox 容器（实测） | macOS（ssh 实测，Darwin 27 / ARM64） | Windows（文档级） |
| --- | --- | --- | --- | --- | --- |
| `bash -lc` | ✓ | ✓ | **✗ 基础镜像无 bash** | ✓（3.2） | ✗（DefaultShell 默认 cmd.exe） |
| `setsid --wait`（util-linux） | ✓ | ✓ | **✗ busybox setsid 仅支持 `-c`** | **✗ 无 setsid(1)** | ✗ |
| `ps -o pgid= -p $$`（procps） | ✓ | **✗ slim 镜像无 procps** | **✗ busybox ps 无 `-p`** | ✓（BSD ps 支持） | ✗ |
| POSIX trap / `mktemp` | ✓ | ✓ | ✓ | ✓ | ✗ |

真实 wrapper 保真测试（与 [transports.ts:20–33](../../../better-dsh/src/remote/transports.ts#L20-L33) 逐字节同构的脚本，2026-10-13）：

- **ssh lane（dev2/dev3）：rc=0 全绿**——参考基准。
- **docker exec + debian-slim：rc=0 但双静默断裂**——每次 oneshot 带 `ps: command not found` stderr 噪音；**pidfile 为 0 字节空文件**（实测确认），killer 路径哑火：取消/超时后远端进程组清理实际不发生，且无任何报错。
- **Alpine 基础镜像 / busybox 镜像：rc=1**，三重缺口叠加（无 bash、busybox setsid 无 `--wait`、busybox ps 无 `-p`）；`apk add bash util-linux procps` 三包补齐后 rc=0。busybox 独立镜像无包管理器，无法自愈。
- **macOS：真链 rc=127**（setsid 不存在）。去掉 setsid 的退化实测：输出能到达，但 EXIT trap 的 `kill -TERM 0` 把 ssh 会话进程一起杀掉（exit 255）——**setsid 不是优化项而是必需品**，没有它 wrapper 收尾即"会话自杀"。
- **Windows：无本机目标，文档级**——OpenSSH 默认 shell 为 cmd.exe（[Microsoft Learn: OpenSSH Server Configuration](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)、[Win32-OpenSSH DefaultShell](https://raw.githubusercontent.com/wiki/PowerShell/Win32-OpenSSH/DefaultShell.md)）。
- **方法学注记**：`docker run`（argv 为容器 pid1）路径会触发 util-linux setsid 的伪错误（`setsid: wait: Success` / rc=1），lane 保真必须走真实 `ssh` / `docker exec`；本轮 ssh lane 复测即修正了这一假象。

结论：**"现状已破"成立，且比预期更碎**——wrapper 不止是 glibc-centric：glibc 内部（slim 镜像）就有 killer 静默断裂；macOS / Alpine / busybox / Windows 四类端点不可用或退化。M1/M3 关闭（2026-10-13 实测），§5 主论证的事实基础坐实。

---

## 3. Re-scope 提案：默认值层 + 诚实回执（纯 TS，小改）

### 3.0 2026-10-14 user GUI 实测校准（0.3.1-d 线上第一人称）

user 对 copy/rsync 全 lane 手测（报告见 `docs/test-reports/2026-10-14-remote-copy-acceptance-fixes.md`）：10 项通过（含 hub lane verified:true+mkdir、跨端两段命令、双 SSH rsync 反向隧道+临时 rsyncd），5 项发现，其中 3 项已修（0.3.1-e）：

1. **copy 目录需显式 `-r`**（scp 路线不加）——§3.2 旧论断「copy 树/文件同构」**订正**：现状 scp 路线不自动带 `-r`，目录必须 `argv:["-r"]` 或改用 rsync。是否改为「本地 src 为目录时 scp/incus 路线自动补 `-r` 并回执披露」= **新决策点 D8**（与 native-shortcut「不替 CLI 决定选项」原则张力，需 user 裁）。
2. **mkdir/verify 仅 Hub lane**——正是本 §3.1 提案的现状证据（D3 由本轮实测背书，待裁即实施）。
3. **scp -3 别名断裂（已修）**：`-F` 临时配置看不到 `~/.ssh/config` 别名 → `HostName dev4` 不可解析。修复 = `ssh -G` 在 origin 解析别名后内联 effective 字段（显式注册字段优先；key 只认连接自带）。
4. **双 SSH rsync 目标目录缺失时误导性 code 12（已修）**：本地 `-L` 先行监听、远端 daemon 脚本秒退 → rsync 打死隧道。修复 = daemon 可达后核查持有会话存活即 fail-fast，且**任何非零 exit 都附加 relay stderr**（原来只 255 附）。
5. **docker cp 不跟随符号链接（原生行为）**：description 已补一句提示（`-L` 跟随；`/etc/os-release` 类 symlink 源不加 `-L` 会 invalid symlink）。

另：superd-run 在 ssh lane 每呼必打的 `setsid failed` 良性噪声已消音（`SUPERD_RUN_DEBUG` 才回显；dev2 实测 stderr 0 字节）。

### 3.0.1 2026-10-14 晚二轮实测定谳（F1/F2 修复轮 0.3.1-f）

user 受控实验定谳 scp -3 身份断裂根因（F1）：**三台配置与 key 全部正常**；临时配置刻意不内联 config 的 `IdentityFile` 路径是缺陷本体——dev2/dev3 靠 ssh-agent 恰持 `id_key1`（其 authorized_keys 也认）而幸免，dev4 唯一授权 key `id_key4` 既不在 agent 又被丢弃，第一个戳穿缺陷（「dev2/dev3 是运气，不是配置差异」）。**修复**：`resolveThroughOriginConfig` 把 `ssh -G` 吐出的 `identityfile` 一并内联（过滤编译期默认五把、保序去重；byossh 显式 key 排首位；内联的是**路径**非密钥材料，「身份留 origin」原则不变）。实测 dev3→dev4 scp -3 `exits:[0]`、cleanup released。

**F2（copy 失败静默）同步修复**：tool 层 copy 分支与 rsync 同契约——`exits` 含非零即 throw（回执全量入 Error，失败原因不再埋 stderr 数组）；成功路径 `durationMs` 改真实值（原恒 0，即 S5）。**S1**：目录 `-r` 指引上移 action 层并显式标注大写 `-R`（scp 远端客户端模式，被拒）与小写 `-r`（递归）的差异——user 第一轮正是被这对大小写误导得出「copy 不支持目录」。

其余 backlog 挂账待排：F3/D8（目录能力对齐）、S3/S4（回执结构统一 / `verified:false`→`verification:"not-applicable"` 类档位改名）、S6/S7（内部路径与状态暴露）、F7（roster 陈旧 hub 注册探活过滤）、F8（byossh 跨轮丢失体验）、F6（docker exec 偶发 143，观察项）。

**darwin 产物纪律（本轮新增）**：mac 主机离线时 build.sh 不再滞留旧版本戳产物（过不了自身 banner 校验 = 死重）——`BUILT-VER` 边车记录戳造版本，不匹配即剔除该 target 并如实缩编 MANIFEST（本轮实际剔除，三 target 交付）；主机回归后下轮重建。

### 3.0.2 Phase 1 实施记录（2026-10-17，0.3.1-c 轮开工）

D1=A、D3 接受落实施；S3/S4/S6/S7/S8 + F1/F4 fixture 一并收口，计划见 `docs/superpowers/plans/2026-10-17-remote-phase1-receipts.md`。两条实施期裁决：

1. **mkdir 预检 parent-only**：预建尾斜杠 dst 目录会翻转 scp 自身布局语义（目录已存在 → 源目录被复制到里面；scp -3 用例实证），故预检只保**父目录**，永不碰操作数本身，native CLI 语义逐字节不变。
2. **S6 范围**：清洗只针对回执时点**已释放**的工具临时物（scp -3 `-F` 临时配置、两段式 staging 路径 → `<temp-ssh-config>`/`<staging>` 占位符）；hub 失败回执的 `scratch` 保留（既有失败 payload 诊断留样特性，套件有断言）。

回执统一落法：透传族固定 `{route(稳定短 id), argv(清洗后), exits, ok, reason?, note?, verification('native-exit-only'|'sha256'|'not-applicable'), created?, cleanup}`；hub lane 同步改名 `verification` 并加 `ok/reason/route:'hub-staged'`；rsync 加 `ok/reason/verification`。copy/rsync 的 `text` 从 JSON 直出改格式化单行（S8），完整 JSON 留 `receipt` 字段。

### 3.1 Schema 变更（原提案，待 D1–D3/D8 裁决后实施）
不新增引擎、不动透传契约，只撤掉"必须显式"的部分并把决策写进回执。

### 3.1 Schema 变更

| 项 | 现状 | 提案 | 性质 |
| --- | --- | --- | --- |
| `action` | 必选 copy/rsync | **可选，缺省 `copy`** | 默认值，非"推断" |
| 方向 | 由 `src`/`dst` 的 `target:` 前缀决定 | 不变（已机械可判） | 无变更 |
| `mkdir` | 透传 lane 显式传即 throw | **默认 true**：传输前经 exec lane 预检 `mkdir -p`（ssh exec / docker exec / incus exec），回执记 `created: true/false/n-a` | 撤 [driver.ts:167](../../../better-dsh/src/remote/driver.ts#L167) 拒绝 |
| `verify` | 透传 lane 显式传即 throw | 按 §4 档位决策（倾向：默认不校验，opt-in） | 决策点 D1 |
| `argv` 逃生舱 | 原样透传 | 不变 | 无变更 |

### 3.2 「智能化判定」评估（user 提问，本草案结论）

另一 agent 建议"同名→copy、目录→rsync"。逐项判定：

| 判定 | 机械性 | 结论 |
| --- | --- | --- |
| **方向**（谁源谁汇） | `target:` 前缀有无，纯结构信息 | **成立**，采纳（现状已如此） |
| **动词默认 copy** | 无需任何元数据 | **成立**——但这是默认值，不是推断 |
| **文件→copy、目录→rsync** | 需要知道端点是文件还是目录 | **不成立**，理由见下 |

「文件→copy、目录→rsync」不成立的三个理由：

1. **前提信息不在手上。** 远端端点是文件还是目录，origin 不知道，除非先 stat（多一跳）或依赖尾斜杠约定。而尾斜杠恰是 rsync 最著名的 footgun——把它变成工具的隐式推断，等于把 rsync 的隐式语义重新引进来，违背"入口薄、无隐式决策"的原则。
2. **引擎可用性由 route 决定，不由形状决定。** `rsync` 在本工具中仅限 SSH 端点（既定设计）；`docker cp`/`incus file`/托管 lane 各有归属。"目录→rsync" 无法作为跨 lane 默认——同一次目录传输在 docker 端点上根本没有 rsync 可选。
3. **copy 本身树/文件同构。** 现有 nativeCopy 已按 route 选引擎（scp -r / docker cp -a / incus / 托管），copy 一个目录不需要换动词。rsync 的真实差异是**增量/字节级 delta/argv 细粒度控制**——这是调用方知道自己需要时才该说的东西，保持显式。

**替代方案（本草案建议）：** 单动词默认 + 路由选引擎（已实现），`rsync` 保持显式专家动词。未来可选增强（不在本草案范围）：`copy` 在"双端均为 SSH/本地且传了 rsync 专属 argv"时路由到 rsync 引擎——由**调用方给的信号**触发，不由工具猜。

另：最初表述"同名文件→copy"混淆了两件事——方向靠前缀，动词靠默认值，两者都不需要"同名"这个信号。

### 3.3 回执统一格式

透传 lane 回执固定字段：`{route, argv, exits, verified, created, cleanup}`；helper 存在时追加 `runner`（§5.4）。原则：**回执里没有发生的保证不出现**——`verified` 只能是实际做过的档位（见 §4 档位枚举），native CLI 成功 ≠ verified。

### 3.4 改动量与验收

估计：撤拒绝 + action 默认 + mkdir 预检 + 回执字段 ≈ 小几十行 TS + 测试；无新依赖、无新构建步骤。验收按仓库契约：tarball 线 + 4999 + dev3 实装，第一人称核验模型可见的 schema/错误/回执变化；报告落 `docs/test-reports/`。

---

## 4. verify 档位：从"默认校验"降级为"可选档位"（user 论证，本草案采纳方向）

**user 的类比与立场：** human 平时 copy 文件从不校验 hash，也不见得拷错；对大模型同样不是必须。损坏概率上，rsync（增量、非原子）高于整文件 copy；且工具已有 oneshot/PTY——**大模型关心时可以自己去校验**。

**失效类别分析（回应"那校验到底防什么"）：**

| 失效类别 | 传输中是否已覆盖 | 剩余风险 | 各档位能否捕获 |
| --- | --- | --- | --- |
| 传输比特损坏 | SSH 通道 MAC/AEAD + rsync 自身块校验 | 极低 | A/B/C 均覆盖不了也不需要 |
| 中断残留半成品（scp/SFTP 可能留下；rsync 默认删 `--partial` 除外） | 否 | 低但真实 | B（大小/存在性）即可捕获，C 才用得上 hash |
| 错投路径 / 0 字节 / 权限错 | 否 | **agent 场景中最常见的真实错误类** | B 即捕获 |
| rsync 非原子完成（对端状态部分更新） | 否 | 低 | 仅 C 可查，且属调用方 `--partial` 语义责任 |

**档位定义（决策点 D1）：**
- **A（user 倾向）：默认仅原生退出码。** 回执 `verified: "native-exit-only"`。模型需要时自己经 oneshot/PTY 发 digest 命令（helper 存在时即 `superd-run digest`，见 §5.3，正好免去跨 OS 猜命令）。
- B：默认 + 一跳目标端存在性/大小检查（经 exec lane 的 `stat`/`ls -l`），`verified: "size-exists"`。捕获 agent 最常见错误类，成本一跳。
- C：默认两端哈希（原 2026-10-12 提案）。成本 1–2 跳 + 全量读，与 human 直觉相悖，本草案不再作为默认主张。

无论 D1 取哪档，`verify: true` 作为**显式 opt-in** 保留，档位 C 在 opt-in 时可用。

---

## 5. 对端 Helper（Rust binary）：动机重排（user 论证为主）

### 5.1 主论证：对端进程监督的可靠性，不是传输能力（user）

剩下这些远端脚本在做什么？**监督与清理对端进程**。而它们现在用 POSIX shell 写成，面对 OS 异构性：即便在 Linux 内部也不是"四到十行兜住"（§2 实测：debian-slim 的 killer 路径静默断裂，Alpine/busybox 三重缺口），加上 macOS（无 setsid(1)，已实测）与 Windows（无 POSIX shell 语境）两类端点，shell 版本只能不断加探测分支，复杂且不保证成功。

既然脚本搞不定，就换一个非常薄的 binary：把「进程组隔离 + pgid 自知（不靠 `ps -o` 解析）+ 组信号 + 收割」变成同一套语义——POSIX 上 `setsid()`/`setpgid`/`waitpid`/`kill(-pgid)`；Windows 上 Job Object。这在 shell 里**表达不出来**（macOS 没有 setsid(1)，Windows 没有 POSIX trap 语境）。

**与 2026-10-11 否决的关系：** 那次否决的是"Rust 用于文件传输能力"（"没有需要 Rust 才能完成的文件传输能力"），并留了活口"若以后重新要求强远端生命周期保证，再单独评估"。本提案走的就是这个活口：**目标是 exec lane 的监督可靠性，不是给 copy/rsync 增加传输能力**。透传契约不变。

### 5.2 Helper 替换面与边界

**替换：** oneshot wrapper（transports.ts）→ `superd-run run`（pgid 精确自知，自写 pidfile）；生命周期不再靠 shell trap 的近似，而是**内核锚定**（§5.6：Linux PDEATHSIG / Windows Job Object）——断连清理由内核触发，pidfile killer 从"必须存在"降级为 backstop（helper 被 SIGKILL 的残余情形、锚定竞态、以及无 PDEATHSIG 的 macOS 上仍是主路径）。

**不替换（Phase 2 范围外）：** rsync relay 脚本（SSH-only 场景，Linux 假设强，低频）；pty lane（origin 侧纪律，R7 reversal 领地不重开）；Hub lane（已有常驻通道）。

**明确不是理由的：** 握手延迟（不解决）、新能力（没有）、daemon 化（禁止——对端不留常驻进程，per-invocation 即退）。

**killgroup 安全契约（2026-10-13 事故后确立，硬约束）：**
1. **pgid ≤ 1 一律拒绝（exit 64，任何 kill 之前）**——`kill(-1, sig)` 是 uid 全域扫描。2026-10-13 23:14 HKT，`killgroup --pgid 1` 自测哨兵值在守卫缺失下执行了 `kill(-1, SIGTERM)`，把本机 uid u1 的桌面会话整层打掉（gnome-shell、dsh、hermes 全灭，用户被闪屏登出）。事故档案：`~/workspaces/base/70_Incidents/superd-run-killgroup-uid-sweep.md`；字条：`better-dsh/src/remote/helper/NOTE-2026-10-13-killgroup-incident.md`。
2. **PID 复用防御（starttime 边车）**：`run` 在 Linux 上写 `<pidfile>.st`（组长内核 starttime）；`killgroup` 见边车即校验 `/proc/<pgid>` 现值，不符或不可查 → 拒绝（exit 64）。shim 旧格式无边车 → 跳过校验（兼容，行为同现状）。SIGKILL 残留的 pidfile+边车正是 killer 兜底的输入，属设计内。
3. **测试纪律：信号/组语义类测试只在容器或 VM 内跑**，不在活跃桌面用户的 uid 下裸跑。


### 5.3 次论证（降级保留）：证据动词，服务 opt-in 校验与模型自助

即便默认不校验（§4 档位 A），模型"自己去校验"时面对的仍是跨 OS digest 命令变体（`sha256sum`/`shasum`/`openssl dgst`）。helper 提供 `digest`（按条目流式输出，`manifestDigest` 语义留在 origin TS，binary 只做机械动词）后，**模型自助校验与 helper 互补**：一条 `superd-run digest` 处处一致。列为 Phase 3 可选，不是引入 helper 的理由。

### 5.4 反论证与永久成本（诚实清单）

1. **Bootstrap 循环：** 上传后用 binary 验自己 hash 无意义（损坏的 binary 自报 hash 不可信）。首跳信任 = ssh 通道完整性 + 包内钉死 MANIFEST；回执如实记录 bootstrap 路径，不声称独立校验。
2. **双路径永存：** 首跳（未上传前）、noexec 挂载、arch 未命中、darwin 未编译——永远回退 POSIX shim。shim 即 §2 现状 wrapper，从此永久维护两份。回执 `runner: "superd-run <ver> <sha8>" | "posix-shim"` 如实区分。
3. **Windows 的覆盖折扣：** user 估"三平台 99% 覆盖"——对 **helper 可达性**成立（Linux 需 x86_64+aarch64 两条 musl；macOS 需 SDK 交叉编译或 CI runner，决策点 D6）；但 **命令语义可用** 是另一回事：sshd DefaultShell=cmd 时 `bash -lc` 不存在，helper 监督得了它被要求跑的任何东西，却造不出 bash。Windows 深度是独立决策点 D5。
4. **治理成本：** 预编译资产进入两个 npm 包 = AGENTS.md 2026-10-10 remote 例外条款需要显式修正案（新资产类别：binary + 构建脚本 + MANIFEST，无 postinstall，运行时按 `process.platform/arch` 选择）；CI 增 Rust 工具链；双路径测试都进验收。

### 5.5 体积与分发

- 动词集冻结：`banner` / `run` / `killgroup`（+Phase 3 可选 `digest`/`stat`）。**无 plan 解释器**——编排永远在 origin TS，否则远端版本变成协议矩阵。
- std-only、零 crate、`panic=abort`、静态链接；行协议 `key=value`，banner 带 `v1` 探测版本偏差。
- 体积校准（对 user"KB 级、1MB 内"的估计）：**1MB 内/平台现实可达**；KB 级需 no_std 特技，不值得。预期 200KB–600KB/平台，×4 产物（musl x86_64、musl aarch64、darwin、win）。
- 二进制随包提交 + SHA-256 MANIFEST；不跑 postinstall。

### 5.6 生命周期：per-invocation、内核锚定、与「常驻 + 空闲自灭」的对比（2026-10-13 user 追问）

**helper 不是守护进程。** 设计是 per-invocation：`superd-run run` 随 exec 会话启动，监督子进程组，子进程组结束即退出并清 pidfile——生命周期被 children 严格界定，**不存在"空闲"状态，也就不需要空闲 TTL**。远端唯一的驻留物是磁盘上的缓存文件（按版本钉死的 binary），是惰性数据，不是进程。

**「能不能清理自己」——能，而且比 shell 强一档：内核锚定。** helper 经远端命令的 `exec` 成为 sshd 会话进程的直接子进程后：
- **Linux：`prctl(PR_SET_PDEATHSIG, SIGTERM)`**——连接断开时 sshd 会话进程退出（这正是孤儿被 reparent 的原因，实证它会退），**内核**直接给 helper 发信号，helper 杀组、收割、清 pidfile、退出。这把"sshd 对无 PTY 会话断连不发信号"从问题变成解法的触发器；**shell 做不到 prctl**——pidfile killer 在 Linux 上由"必须"降级为 backstop。
- **Windows：Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**——helper 进程死则作业内子进程全灭，同一保证的内核形态。
- **macOS：无 PDEATHSIG**，pidfile killer 会话仍是主清理路径（kqueue `EVFILT_PROC` 可作未来增强）。
- helper 自身被 SIGKILL 的残余情形（锚定来不及、竞态）：pidfile + killer backstop 兜底——这是 killer 保留的理由。

**与「常驻 + 30 分钟空闲自灭」的对比（user 设想）：** idle-TTL 自灭守护是真实存在的正当模式，30 分钟也是合理量级——但它解决的是"常驻进程的分摊成本"问题，而 per-invocation 设计里该问题不存在。若未来真要分摊每次连接的成本，正确的层次是**传输层**：ssh `ControlMaster` + `ControlPersist=30m`——恰好就是"30 分钟空闲自动拆链"的久经考验实现（OpenSSH 自己的语义），分摊的是真正贵的东西（握手），且 helper 完全无需常驻、无需监听端点。常驻 helper 需要监听 socket（攻击面 + 版本偏差 + 生命周期管理），等于用自研劣化重造 ControlPersist——不做。

**边界情形：** `run_in_background` 长任务（[jobs.ts](../../../better-dsh/src/remote/jobs.ts)）会让 helper 长时间"忙碌"——那是 busy 不是 idle，任何 TTL 都会误杀合法长任务。故 `run` 动词**无任何默认时限**，超时是 origin 的职责（现状契约），断连清理交给内核锚定 + killer backstop。

### 5.7 善后步数账本（2026-10-13 user 追问"执行完是不是本来就要多走好几步"）

| 流程 | 现状善后成本 | helper 后 |
| --- | --- | --- |
| oneshot 正常完成 | 0 步（EXIT trap 自善后；slim 镜像上 pidfile 步静默失败） | 0 步（不变；差别是可移植、精确、无 stderr 噪音） |
| oneshot 取消/超时 | +1 killer 会话 hop + `sleep 0.3` 盲等 + shell 链；slim/Alpine/busybox 上走不到 | Linux/Windows：**0 hop**（PDEATHSIG / Job Object 内核触发）；macOS：killer 1 hop（仍主路径） |
| 断联（网络中断） | killer 会话 1 hop（前提是 origin 还连得回去） | Linux/Windows：0 hop 自动清场；macOS：killer 1 hop |
| 透传 copy + mkdir 默认（Phase 1） | mkdir 预检 1 hop | 同左（这跳是语义，不是浪费，helper 不省它） |
| 透传 copy + opt-in verify | `sha256sum`/`shasum`/`openssl dgst` 变体探测链，1–2 hop 且解析脆弱 | `superd-run digest` 1 hop，输出统一（Phase 3） |
| rsync SSH↔SSH relay | daemon 脚本 + 2 条转发 + stderr marker + 清理会话 ≈ 4 步 | Phase 3 评估迁移，不在首批 |
| 托管 lane（Hub↔local） | 0 步（digest/mkdir/清理在同一条 hub 通道内自带——"托管"的含义） | 不涉及 |

结论：**执行本身从来只有 1 hop，不需要也不应该有 helper 插手；善后才是 helper 的辖区**——它把"再连一次 + shell 猜测"（取消/断联）变成内核自动，把"跨 OS 变体链"（验证动词）变成一条命令。正常路径的 hop 数一字不变。

---

## 6. 阶段建议

| 阶段 | 内容 | 前置 |
| --- | --- | --- |
| **Phase 0 审计（已执行，2026-10-13）** | M1/M3 实测关闭：dev2/dev3 基准全绿；**debian-slim killer 路径静默断裂**（pidfile 0 字节）；Alpine/busybox 三重缺口（补 `bash util-linux procps` 后恢复）；macOS 无 setsid(1)，退化即会话自杀（exit 255）；Windows 文档级确认。结果并入 §2，**"现状已破"成立，helper 主论证生效**。方法学：保真测试必须走真实 ssh / docker exec，docker-run-as-pid1 有 util-linux 伪错误 | 已关闭 |
| **Phase 1（纯 TS）** | §3 默认值层 + 回执字段化 + D1 档位实现 | D1–D3 裁决 |
| **Phase 2（Rust helper）** | `banner`/`run`/`killgroup` + 内核锚定（PDEATHSIG / Job Object），双路径 + `runner` 回执字段；AGENTS.md 修正案；4999+dev3+arm64 容器验收 | D4/D7 裁决（Phase 0 已过） |
| **Phase 3（可选）** | `digest`/`stat` 动词 → opt-in verify 统一入口；rsync relay 脚本迁移评估 | Phase 2 稳定 |

## 7. 决策点汇总（下一轮讨论待裁）

| # | 问题 | 选项与倾向 |
| --- | --- | --- |
| D1 | verify 默认档位 | A 仅退出码（user 倾向）/ B +存在性大小（agent 常见错误类，一跳）/ C 哈希（仅 opt-in） |
| D2 | 动词与推断范围 | 方向推断 ✓、`action` 缺省 copy ✓、文件/目录→rsync ✗（本草案结论，待确认） |
| D3 | `mkdir` 默认 true 的预检成本（每次传输多一跳 exec）是否接受 | 接受 / 仅 ssh lane 接受 / 保持显式 |
| D4 | helper 范围 | 仅监督动词（本草案）/ 含 digest |
| D5 | Windows 深度 | 仅 helper 可达（本草案）/ 加 shell policy（bash 存在性声明与降级语义） |
| D6 | darwin 产物 | 现在做（交叉编译/CI runner）/ 暂缓，shim 覆盖 |
| D7 | AGENTS.md 2026-10-10 例外修正案 | binary 资产类别 + 构建来源 + MANIFEST 纪律的措辞 |
