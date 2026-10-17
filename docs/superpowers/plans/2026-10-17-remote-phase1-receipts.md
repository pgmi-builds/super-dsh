# Remote re-scope Phase 1：回执统一 + mkdir/verify 默认层（0.3.1-c）

依据 spec `docs/specs/remote-rescope/spec.md` §3/§4/§6 + user 2026-10-17「去吧」放行。
范围 = S3/S4/S6/S7/S8 + D3（mkdir 默认）+ D1=A（verify 档位）+ F1/F4 回归 fixture。
不改引擎、不动透传契约、不动 helper（动词集仍冻结 banner/run/killgroup）。

## 裁决输入（既有）

- **D1 = A**：默认仅原生退出码（user 倾向，§4）。`verify:true` 的档位 C 在 native 路线
  **本期不实现**（拒绝并如实说明；模型可自经 oneshot 发 digest 命令，helper 加 digest
  动词属另案裁决）。Hub lane 维持默认真校验（sha256）。
- **D3 = 接受**（§3.0 实测背书）：mkdir 默认 true，native 路线传输前经 exec lane 一跳预检。
- S8 无文字定义，按摘要「copy 命名」落：**route 稳定短 id + copy/rsync 渲染格式化行**
  （原 route 是散文串、text 直出 JSON）。验收时 user 可纠。

## 回执统一格式（S3/S4，spec §3.3）

固定字段 `{action, src, dst, route, argv, exits, ok, reason?, note?, verification, created?, cleanup}`，
原则：**没做过的保证不出现**。

| 字段 | 语义 |
| --- | --- |
| `route` | 稳定短 id：`scp` / `scp-3` / `docker-cp` / `incus-file-push` / `incus-file-pull` / `staged-pull-push` / `hub-staged`；rsync 维持既有 `local-ssh` / `ssh-ssh-forward` / `ssh-ssh-stdio` |
| `ok` | 全部 exit 为 0（hub lane = 无 error 且 digest 一致）|
| `reason?` | 失败类短 id：`non-zero-exit` / `digest-mismatch` / `staging-error` / `aborted` |
| `note?` | 人类语境补充（如 `push not started: pull failed`，原 route 括号散文迁此）|
| `verification` | 档位串（S4）：`sha256`（hub lane 实做且一致）/ `native-exit-only`（native 默认，D1=A）/ `not-applicable`（显式跳过或未到达）——`verified` 布尔废除 |
| `created?` | D3 预检披露（仅 copy）：`true`（本次创建）/ `false`（已存在）/ `"n-a"`（opt-out 或预检失败降级，失败细节进 note）|
| `cleanup` | 既有三值不变 |

## 内部路径清洗（S6/S7）

回执 argv 里工具自产的临时物替换为占位符（真实路径转瞬即逝，对模型只有噪声）：

- scp -3 临时配置路径 → `<temp-ssh-config>`
- 两段式 staging 路径 → `<staging>`（staged 文件名保留）
- relay 本地隧道端口 → `<tunnel-port>`
- hub 错误回执的 `scratch` 字段 → 删除（细节在 error 文本里）

## mkdir 预检（D3，driver 层）

- 位置：`driver.copy` native 分支，调 `nativeCopy` 之前；`request.mkdir === false` 跳过。
- dst 为 local：node 侧 exists + mkdir（created true/false）。
- dst 为 ssh/docker/incus：**best-effort 一跳** `[ -d dir ] && echo existed || mkdir -p dir && echo created`
  (**parent-only**：实施期套件抓到——预建尾斜杠目录会翻转 scp 布局语义，目录已存在 →
  源目录被复制到「里面」（scp -3 用例实证 `hop-final:["hop-src"]`）；故预检只保
  **dirname**，永不碰操作数本身，CLI 原生语义逐字节不变)。
- 预检失败**不拦截传输**（例：docker cp 对停止容器本可用而 exec 不可用）——`created:"n-a"` + note，CLI 按原行为报错。
- **S6 范围裁决**：hub 失败回执的 `scratch` 字段**保留**——它是既有诊断保留特性（失败 payload 留样，套件有断言）；S6/S7 清洗只针对**回执时点已释放的临时物**（-F 临时配置、staging 路径）。
- rsync 不适用（既有拒绝不变，argv 逃生舱 `--mkpath` 自己带）。

## Surface（tool.ts）

- `mkdir`：copy 全路线可用（默认 true，预检结果入回执 created）。
- `verify`：仍 Hub lane 专属；native 路线传 verify 维持拒绝，文案升级为档位语言。
- Files 段补 verification 档位与 created 一句；description 的 `-r`/`-R` 既有指引不动。
- 渲染（S8）：copy/rsync `text` 从 JSON 直出改格式化行
  （`copy A → B · route scp-3 · exits [0] · verification native-exit-only · created false · 0.8s`，
  失败行加 `✗ reason …` + stderr 尾）；完整 JSON 仍在 `receipt` 字段。

## F1/F4 回归 fixture

- **F1**：`ssh -G` identityfile 内联——临时 fixture config（Host 别名 + 非默认 IdentityFile）
  走 `resolveThroughOriginConfig`，断言输出含该路径、不含编译期默认五把。
- **F4**：`waitForDaemonReady`——伪 daemon（延迟打 `SUPERD-RSYNC-TMP` marker / 永不打 / 秒退）
  三态：超时内命中、超时拒、早退即败。

## 验收

typecheck + 单测绿 → `version:release 0.3.1-c` → pack（pair 校验）→ PC 4999 + dev3 4998 实装 →
报告落 `docs/test-reports/2026-10-17-remote-phase1-receipts.md` → user GUI 第一人称收口。
不 publish、不 push/tag（0.3.1-b 已发，本轮 tarball 迭代）。
