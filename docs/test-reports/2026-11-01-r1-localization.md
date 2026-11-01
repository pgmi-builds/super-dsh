# R1 定位轮报告：PTY background startup stdin 丢失（2026-11-01 深夜）

- 结论先行：**R1 已在 0.3.3-d 的「合并单次 write」中修复**。修复轮报告 §3 的「合并缓解无效（rate2 6/6 仍丢）」是**构建归属错误**——rate2 实际跑在 0.3.3-c 进程上，0.3.3-d 从未执行过丢失形状直到本轮。工具 surface 上的 Known defect 披露文本描述的是 c 时代行为，**已过时**，建议在发布构建中移除（待 user 裁决）。
- 本轮方法：0.3.3-e 插桩构建（env 门控 JSONL trace，热路径零同步 IO）+ dev3 侧 tty FIONREAD 观察器 + 精确复刻原始组合 + 原始时间线取证 + 纯净 d 对照。
- 生产隔离：仅触碰 4999 测试线（profile tarball 装载 + unit 重启 + drop-in env）；`~/.dsh`、`~/.superd`、3080/3081、live Caddyfile、dev3 生产均未动。

## 1. 时间线取证（构建归属修正的依据）

unit 重启时刻（`journalctl --user -u superd-4999-test`）与丢失会话 mtime 对照：

| 时刻 | 事件 |
| --- | --- |
| 21:26–21:28 | 0.3.3-c 打包 → 装载 → rig 重启（21:28:28） |
| 21:34 | 会话 55e97765：bg-read 探测（**c**） |
| 21:48 | 会话 7fbab822：bg-read/dbl 探测（**c**） |
| 22:08 / 22:23 | rig 重启（两次，仍是 c；d 在 22:30 才打包） |
| 22:13 | 会话 94df5f4f：pty:fixio 系列探测（**c**） |
| 22:15 | 会话 29985ec4：rate2 s1–s6（**c**，非 d） |
| 22:30–22:32 | 0.3.3-d 打包 → 装载 → 重启 |
| 22:33 | d 最终重启；此后只有 §9 复核（未测 bg+stdin） |

**全部 19 例丢失（13/13 + rate2 6/6 + dbl 阻塞）都发生在 0.3.3-c 进程上。d 装载后丢失形状一次都没跑过**——「d 仍丢」的结论从未被实测支持。

## 2. 插桩设计（0.3.3-e）

- `better-dsh/src/remote/trace.ts`（新增）：`SUPERD_REMOTE_TRACE=<file>` 时输出 JSONL；未设 env 时全 no-op。事件先入内存缓冲，settle/dispose/满 200 条时异步 flush——写路径零同步 IO，尽力不扰动竞态时序。
- `pty-session.ts` 钩子：`disp`（cmd/stdin repr、bg、会话状态、priorCmds）、`w1`（startup 写入的 ret/writableLength/payloadTail + drain 跟踪）、`out`（前 60 个输出块，echo 判别用）、`detach`/`settle`（输出尾部）、`in`（stdin-only 补写）、`start`（argv/pid）、`dead`（diag 尾）。
- dev3 侧观察器 `/tmp/r1-watch.sh`：跟踪 `/tmp/r1/pid` 指向的 login-bash，100ms 采样其 tty 的 FIONREAD（输入队列字节）+ wchan + pts 变化时的 `stty -a` 快照。本轮无丢失复现，观察器未触发判别窗口（iq 采样恒 0：成功轮中字节在采样间隔内即被 read 消费）——如实记录。

## 3. 四轮实测（全部经 rig wire API 模型会话第一人称执行）

| 轮 | 构建 | 组合 | 结果 |
| --- | --- | --- | --- |
| 1 | 0.3.3-e | inline cmd 丢失形状 bg ×10 + `read -t` ×4 + fg(timeout:10) ×3 | **17/17 全达**（`BG-GOT:[hello-*]`，echo 可见，exit 0） |
| 2 | 0.3.3-e | scriptPath（bash -c 载体）丢失形状 ×8 + read-t ×2 + inline 对照 ×2 | **12/12 全达**（值完整） |
| 3 | 0.3.3-e | **精确复刻**：`/tmp/fix-c/bg-read.sh` 原脚本、连续 bg、stdin `s1..s8`、无 marker | **8/8 秒级完成** + fg read.sh 2/2 值可见（`READ:GOT:fg*`） |
| 4 | **纯净 0.3.3-d**（无插桩） | 同上原脚本 ×8 + 值可见变体 ×6 | 原脚本 8/8 完成；**值可见 6/6 值完整送达**（`BG-GOT:[v1..v6]`，no-kill） |

trace 侧证（轮 1）：startup 载体单次写入 `...unset __superd_e\nhello-L1\n`（251 字节，`ret=true`、wl0=wl1=0，无背压），`hello` 的 echo 在输出块中出现——字节进过 tty 行规程且被脚本 read 正常消费。

对照历史：c 进程上同组合 19/19 丢失（read 得空或永等）。**c→d 的行为差与代码差一一对应：两段 write → 合并单段 write。**

## 4. 机制定性（与全部证据一致）

c 时代：framed 命令与 startup stdin 是**两次独立 stream write** → 两批到达远端 tty。多行 wrap（`{`/cmd/`}` 续行读取）下，交互 bash 的行读取存在把第二批字节并进自身缓冲的窗口（readline 整块预读），导致脚本 `read` 得空行（快速完成、值为空）或永等（字节被 shell 缓冲、tty 队列空）。d 的合并单写让两行同批入队，由 shell 逐行消费，stdin 行留在 tty 队列等脚本的 `read`——与 rig-only（真 ssh 时序）、bg 相关（fg 同写路径但等待窗口不同）、以及「read -t 变体通过」（-t 到期后 shell 状态推进，缓冲行最终被 shell 自己执行并可见）的历史观察相容。

## 5. 处置建议（待裁决）

1. **surface**：移除 `run_in_background` 参数与工具描述两处的 "Known defect: startup stdin is NOT reliably delivered..." 披露（0.3.3-f）；替换为正向说明（startup stdin 与命令单批送达）。
2. **勘误**：spec `remote-default-pty` §7.5 与修复轮报告 §3 追加构建归属勘误（已在本文 §1/§3 给出证据链）。
3. **插桩去留**：trace.ts 建议**保留**（env 门控、默认零成本），`SUPERD_REMOTE_TRACE` 作为诊断设施记入 docs；如要求交付面最小，可在发布构建移除。
4. dbl.sh 现版（`read -t 15`×2）在单行 stdin 下需 15s 才超时，8s 观察窗内 running 属正常——轮 3 的 d1/d2 被 driver 过早 kill，不构成丢失证据（如实记录）。

## 6. 现场收线

- rig 现装 0.3.3-e（叶 better/super 同 tarball 通道），trace drop-in 保持，`public:200`。
- dev3 观察器进程仍在（`pkill -f r1-watch.sh` 收线）；`/tmp/r1`、`/tmp/r1p`（pc 与 dev3 两侧）、`/tmp/fix-c` 保留供复核。
- 本轮会话记录：r1 轮 1–4 共 5 个模型会话（.tests/superd/sessions）；trace 存于 `.tests/remote-trace/trace.jsonl`（171+ 事件，轮 1–3）。
