# Remote Phase 1 回执统一 + mkdir/verify 默认层（0.3.1-c）

日期：2026-10-17（Asia/Hong_Kong）。基线：commit `39bac19`（0.3.1-b 发布轮）之上的工作树迭代，字母 `0.3.1-c`（registry 不动，tarball 通道）。规格 `docs/specs/remote-rescope/spec.md` §3/§4（新增 §3.0.2 实施记录）；计划 `docs/superpowers/plans/2026-10-17-remote-phase1-receipts.md`。user 2026-10-17「去吧」放行。

## 交付内容

| 项 | 实现 |
|---|---|
| **S3/S4 回执统一** | 透传族固定 `{route(稳定短 id), argv(清洗后), exits, ok, reason?, note?, verification, created?, cleanup}`；`verified` 布尔废除，档位串 `native-exit-only`（native 默认，D1=A）/ `sha256`（hub lane 实做）/ `not-applicable`（显式跳过）。hub lane 加 `route:'hub-staged'` + `ok/reason`；rsync 加 `ok/reason/verification`。失败类：`non-zero-exit` / `digest-mismatch` / `staging-error` / `aborted` |
| **S6/S7 内部路径** | scp -3 的 `-F` 临时配置 → `<temp-ssh-config>`；两段式 staging 路径 → `<staging>`（token 形状不变）；hub 失败回执 `scratch` **保留**（既有失败 payload 诊断留样，套件有断言——清洗只针对回执时点已释放的临时物） |
| **S8 copy 命名** | route 稳定短 id：`scp / scp-3 / docker-cp / incus-file-push / incus-file-pull / staged-pull-push / hub-staged`（散文迁 `note`，如 `push not started: pull failed`）；copy/rsync `text` 从 JSON 直出改格式化单行（完整 JSON 留 `receipt` 字段） |
| **D3 mkdir 默认 true** | native 路线传输前一跳 best-effort 预检（`[ -d dir ] && echo existed || mkdir -p dir && echo created`，经 exec lane；local dst 走 node）。回执 `created: true/false/"n-a"`；预检失败不拦截传输（保住「docker cp 对停止容器可用而 exec 不可用」）。**parent-only**：只保父目录、永不预建操作数本身（见下方裁决） |
| **D1=A verify 档位** | native 路线默认 `native-exit-only`，`verify:true` 维持拒绝并给档位语言（tier C 不在本轮实现；模型自经 oneshot 发 digest）。hub lane 默认 sha256、`verify:false` → `not-applicable` |
| **F1 fixture** | `resolveThroughOriginConfig`/`tempSshConfig` 导出 + fixture config（非默认 IdentityFile）经真 `ssh -G -F` 断言内联、默认五把过滤 |
| **F4 fixture** | `waitForDaemonReady` 导出（结构化参数）+ 三态：marker 命中 / 秒退 / 超时 |

## 实施期裁决（两 条）

1. **mkdir 预检 parent-only**：初版按 spec 字面「尾斜杠 = 目录目标，预检整条」实现，套件立即抓到语义翻转——预建 `hop-final/` 后 scp -3 把源目录复制**进里面**（`hop-final:["hop-src"]`，文件落在 `hop-final/hop-src/hop-file`）。预建目录改变了 CLI 自己的布局决策。修正 = 预检只保 dirname，CLI 原生语义逐字节不变。
2. **dts 构建非确定性（工具链债，本轮发现）**：连续 pack 发现 better-dsh tarball 每次不同。根因两层：① lib/ 无 clean + chunk 名带哈希 → 陈旧块累积、文件名漂（已修：`clean: true` + `chunkFileNames: '[name].js'`，JS 侧现已逐字节稳定）；② **rolldown-plugin-dts 0.17.8 的 d.ts 模块 id 分配本身随机**（6 次 clean 构建 → 5 个不同 d.ts 哈希；host-peer 类型的 externals-vs-inline 形态随机翻转；`isolated`+`parallel:false` 收窄但不消除）。每次 pack 是一个**有效且自洽**的样本，轮内身份由记录 SHA-256 钉死；彻底确定性需上游修复/升级（挂 backlog）。super-dsh 的 remote 闭包单入口，不受影响（`ffe5c60a` 全程逐字节稳定）。

## 验证

- 单测：remote 全套 **197 过 / 0 败**；整包（除 browser-device，本机无 Chrome——环境项，非本轮改动面）**863 过 / 9 skip / 0 败**；新增 `test/remote/phase1-receipts.spec.ts` 4 例（F1/F4/D3 披露/S3·S6·S8）。
- typecheck（host + client）0 错。
- 交付对子：better-dsh `18d8e14e…2750226` / super-dsh `ffe5c60a…a0e85607`（记录于 `.scratch/release-031c-FINAL.sha256`），pair 校验绿；helper binary 4 target 重戳 `0.3.1-c`（mac 在线，darwin 在列）。
- 线：PC 4999 与 dev3 4998 均以**显式 SUPERD_TEST_PACK_DIR** 安装记录对子并运行中（http 200，super-dsh 0.3.1-c；companion better-dsh 仍 0.3.1-a——既定保留策略，新面由 super 的独立 remote 闭包承载）。

## 复验建议（user GUI）

1. 任一 copy（如 `copy /local/f ssh:dev3:/tmp/newdir/f`）→ 回执单行含 `created yes`（父目录本次新建）与 `verification native-exit-only`；再跑同目录 → `created pre-existing`。
2. scp -3（dev3→dev4）→ `route scp-3`，argv 中临时配置显示 `<temp-ssh-config>` 占位符。
3. 会失败的 copy（目标父不可写/不存在且 mkdir:false）→ 直接抛错，Error JSON 含 `ok:false` + `reason`。
4. hub lane copy → `verification sha256` + `route hub-staged`。
5. rsync 任一 → 单行回执 `verification native-exit-only`。

### 照抄版验收脚本（新开 agent 会话，逐条贴入；预期行原样给出）

```
1) copy  src=/tmp/p1-check.txt（先随便写个本地文件） dst=ssh:dev3:/tmp/phase1-new-dir/p1-check.txt
   预期单行含: route scp · verification native-exit-only · created yes
   （重跑同一条 → created pre-existing）

2) copy  src=ssh:dev3:/tmp/phase1-a/ dst=ssh:dev4:/tmp/phase1-b/ argv=["-r"]（两端目录先放个文件）
   预期: route scp-3 · argv 内出现 <temp-ssh-config> · cleanup released

3) copy  src=<本地文件> dst=ssh:dev3:/tmp/phase1-x/f mkdir=false，且 /tmp/phase1-x 不存在
   预期: 直接抛错（非正常返回），Error JSON 含 "ok":false 与 "reason":"non-zero-exit"

4) copy  src=<本地文件> dst=hub:<m4>:<远端绝对路径>（任一 hub 机器）
   预期: route hub-staged · verification sha256 · bytes/entries 计数

5) rsync src=/tmp/p1-dir/ dst=ssh:dev3:/tmp/phase1-rsync/ argv=["-a"]
   预期: 单行 route local-ssh · verification native-exit-only
```

注：1–3、5 走 native 车道，4 需对端 hub 机器在线；若会话拿到的是旧 companion 面（回执无 verification 字段），新开一个 agent 会话再试（两行 remote 竞争注册，super 闭包承载新面）。
## 红线

本轮无 npm publish、无 git commit/tag/push（0.3.1-b 的 push+tag 是上一指令完成的独立动作）、未触生产。工作树按测试轮惯例保持未提交，验收后随下一轮 commit 收口。
