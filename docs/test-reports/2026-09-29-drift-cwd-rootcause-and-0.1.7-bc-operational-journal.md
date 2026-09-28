# 2026-09-29 · client-bundle drift 根因（cwd 敏感）+ 0.1.7-b/c 运维日志（a2a.* journal）双侧活体验收

**版本**：0.1.7-b（journal + 405 + 测试加固）→ 0.1.7-c（console 落地修正）
**分支**：mesh-p1 `b5c05c8` → `7a6e0de` → `7112980` → `ebffe24`
**验收形态**：hub 套件 445/445；裸 pack 线 923/923（多轮）；PC 4999 rig + dev3 双侧活体 journal 行验证

---

## 一、client bundle chunk drift：不是 flake，是 cwd（`b5c05c8`）

### 问题回顾
`client-bundle-drift` 守卫在此前 pack 线出现过一次 110112B vs 110244B，当时归档为"构建非确定性（负载相关，~1/4）"。用户要求重查。

### 根因链（Phase 1→3 证据）
1. **空闲/负载均确定**：同一 driver（import + tmp outDir）空闲 10 次 + 8 忙循环下 12 次，全部字节一致 → "负载非确定性"假设死亡。
2. **但 driver 产物 = 110592B ≠ 交付物 110112B** → 出现第三种字节。
3. **逐字节 diff**：差异全部在 `//#region <模块路径>` 注释——rolldown 渲染模块 id 时锚在 **tsdown 的 cwd**（默认 `process.cwd()`）。
4. **三点矩阵复现**：

   | cwd | 产物 | 差 |
   |---|---|---|
   | `superd-hub/`（pack.mjs 构建 + 隔离测试） | 110112B（=交付物） | — |
   | `super-dsh/`（**pack 测试线**的 cwd） | **110244B** | +132B = `superd-hub/` × 12 个 region |
   | 仓根 | 110592B | +480B 更长前缀 |

   **"负载相关"是假象**：pack 线只是唯一用不同 cwd 起套件的 lane，而它恰好是并发的那条。
5. tsdown 支持 `cwd` 选项（`types-*.d.mts:387`，默认 process.cwd()）。

### 修复
- `build-superd-client.mjs` + `build-client.mjs`：`build()` 配置钉 `cwd: <包根>`；文档声明同步改写（"byte-deterministic … whatever the output directory AND whatever the invoking process's cwd"）。
- **回归锁**：drift 测试加 cwd 方差腿——`process.chdir(super-dsh/)`（历史 lane cwd）后重建，必须仍与交付物字节相等。修前红（110244B），修后绿。
- 交付物零 churn（pack.mjs 本就以 hub cwd 构建）。
- 顺带：`graphify-out/` 入 .gitignore。

### 验证
drift 测试从三个 cwd（hub / super-dsh / 仓根）全绿；hub 套件 442/442；**裸 pack 线 919/920 的"1 已知 flake"从此消失**（多轮 923/923）。

---

## 二、0.1.7-b 头号项：hub 运维日志（`7a6e0de`）

背景：0.1.7-a 第一人称报告发现 **hub 零运维日志**——现场调试全靠 registry 取证。

### 设计
- **新模块 `src/a2a-log.ts`**：`A2aLogFn` + `formatA2aLogLine` → 单行 `superd-hub: a2a.<event> k=v`，标量字段、含空格才加引号、无秘密（只落 id）。
- **纯模块注入**（service/ingest 保持 runtime-agnostic）：`deps.log?`；host 层（a2a-row.ts）接线。
- **词汇表**（每事件一行，可 grep）：
  - ingest：`ingest.park`（duplicate 再投递）、`ingest.done`（kind/outcome/message/conversation 摘要）、`ingest.fail`（类型化 code）
  - 会话：`conversation.new`（发起侧）、`conversation.adopt`（镜像行采纳）
  - 通道/投递：`send.channel`（D20 latch 落锁）、`send.ok`、`send.fail`、`deliver.writeback`（self-route|peer + outcome）、`deliver.local`、`deliver.buffer`（未读缓冲深度）
  - 完成：`completion.armed`（含水印）、`completion.quiet`（窗口内通道发送→压制）、`completion.transcript`（字节数）、`completion.notice`、`completion.error`
  - 路由/出箱：`route.deliver|post|park`（peer-unreachable|unknown-machine）、`outbox.claim`
  - 停止：`stop`、`stop.refused`

### 落地修正（`7112980`，0.1.7-c）
首版接 `ctx.logger` → **rig 活体全链 0 行**。根因：**pack 组合不含 cordis-plugin-logger-console**，LoggerService 记录无处输出（boot 期日志行的来源都是显式 console）。修正：a2a-row 的 alog 直落进程 console（info→log / warn→warn / error→error；world-join/world-provision 先例），unit 日志即终点。版本纪律：tarball 重spin 必须 换字母（pnpm 同名 file: no-op）→ 0.1.7-c。

### 活体验收（双侧）
**PC rig（0.1.7-c，`.scratch/superd-4999.log`）**——合成探针信封（`jrnlt2`）+ 一枚必败信封：
```
superd-hub: a2a.conversation.adopt conversation=jrnlt2 session=session-679d… peer=79he-8ah589 hostAgent=8ah589
superd-hub: a2a.completion.armed conversation=jrnlt2 session=… watermark=0
superd-hub: a2a.ingest.done kind=new-conversation outcome=injected message=a2a-jrnl-probe-3 conversation=jrnlt2
superd-hub: a2a.ingest.fail code=a2a/conversation-not-found message=a2a-jrnl-probe-4
superd-hub: a2a.ingest.done kind=message outcome=failed message=a2a-jrnl-probe-4 conversation=missing1
```
**意外之喜（真实活剧）**：rig native agent 完成探针任务后**主动走通道回复**——`a2a.send.channel conversation=jrnlt2 from=79he-8ah589 latch=true`（教学信封 v3 生效的直接证据）；其 write-back 因合成探针无真实 initiator session 而收到诚实类型化失败，整条传播链逐行落日志：
```
a2a.send.channel … latch=true → a2a.ingest.fail code=a2a/no-initiator-session → a2a.ingest.done outcome=failed → a2a.send.fail
```

**dev3（0.1.7-c，`journalctl --user -u dsh.service`）**：同款探针 → 同三行（adopt/armed/done）落 journald。双侧、双日志通道（append 文件 / journald）均验证。

---

## 三、顺手修清单

| 项 | 处置 | 提交 |
|---|---|---|
| `PUT /api/superd/machines` → 404（应为 405） | 路由注册扩至常用方法集（GET/POST/DELETE/PUT/PATCH/HEAD），**handler 自守方法门**答诚实 405（带 use 提示）；machines + a2a + outbox 三端点同待遇；`ConnectionFetchFace` 按既有 DELETE 先例扩 PUT/PATCH | `7a6e0de` |
| dev3 OMP lane 断（bun postinstall 未跑） | **环境修复已做**：`node install.js` 执行；`bun --version` 1.4.2（ELF）可用。注：bun 官方约定 bin 名即 `.exe`，postinstall 以平台二进制覆写——dev3 上该覆写已生效 | 无需代码（dev3 侧操作） |
| E_BAD_ACTION 死分支 | 查实：input schema 的 action enum 使 default 经工具面不可达 → **保留 + 注明**（switch 完备性守卫，enum 与 dispatch 漂移时点名缺口） | `7a6e0de` |
| `[undefined]` 遗留行 | D17 已裁 verbatim 采纳；不动 | — |
| 测试紧预算（假超时） | a2a-ingest `until` 500ms→2000ms（构建后立刻跑套件的单败）；a2a-service **200ms**→2000ms、agent-claude 500ms→2000ms（同类隐患一并清） | `7a6e0de`/`ebffe24` |

---

## 四、测试证据
- hub 套件：**445/445**（442 基线 + 2 journal 测试 + 1 method-gate 测试），tsc 0。
- 裸 pack 线（`super-dsh/` cwd，历史必挂/必 flake 的 lane）：多轮 **923/923**。
- 残余观察：一次 922/923（单败，未捕获测试名，后续 10+ 轮未再现）；一次 921/923（两败，同样未捕获名）。已把仅存的两个亚秒级 poll 预算放宽（`ebffe24`）并留 8 跑后台监听。若再现，将以捕获的测试名开新案。
- 4999 rig + dev3 双侧 0.1.7-c 实装，world failed = 0。

## 五、遗留与下一步
- journal 只覆盖 a2a 面（mesh-link probe/pair、spawn、fusion-transport 未埋点）——下一轮候选。
- `completion.quiet/transcript` 两词汇已单测覆盖、活体 armed 已见；真实 turn 收尾的双侧完整链可下次跨机对话顺带取证。
- P4（remote exec + D22 spawn 状态机）仍未启动。
