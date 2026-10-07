# agent-omp RPC transport — 4997 pack-line acceptance（自动段）

- 日期：2026-10-03
- 计划：`docs/superpowers/plans/2026-10-03-agent-omp-rpc-transport.md`（Task 6）
- 规格：`docs/specs/omp-rpc-transport/spec.md`
- 形态：**交付形态**（`npm pack` 出的 tarball → pnpm `file:` 装进全新 profile → repository 内 dsh CLI 启动）

## 0. 端口与现场

`4999` 在本轮被**并发 worktree** 的测试线占用（`superd-4999-test.service`，cgroup 实证，运行自
`.worktrees/codex-app-server/...`，已 active 30 分钟）。端口纪律允许测试 unit 让位，但强行接管会打断
另一个 agent 正在跑的验收，故本轮落在同族测试口 **4997**（同一 pack 线、同一交付形态，launcher 自动拉
LAN relay）。

```
unit : superd-4997-test.service  +  superd-lan-4997-relay.service（仍在运行）
local: http://127.0.0.1:4997/?token=<redacted>
lan  : http://192.0.2.130:4997/?token=<redacted>
```

## 1. 交付物（唯一入口 `node super-dsh/scripts/pack.mjs`）

| 读数 | 值 |
|---|---|
| tarball | `super-dsh-0.1.9.tgz`，packed **628.6 kB**，unpacked **2.2 MB**，**256 files** |
| tarball 内 `sidecar` / `@oh-my-pi` / `bun` 条目 | **0** |
| 安装 | `Packages: +215`，pnpm v10.33.2，profile `node_modules` 合计 **690 M** |
| 装出来的 `agent-omp/` | 只有 `README.md` `cordis.patch.yml` `dist/` `package.json` —— **无 `sidecar/`** |

**838 M 的离场（本改动的主收益）**：装出来的 profile 里 **没有 `@oh-my-pi`、没有 `bun`**
（`.pnpm` 列表实证）。参照物是改动前 prod profile 的实测：`@oh-my-pi` 762 M + `bun` 76 M = **838 M**。
OMP 从此走用户本机 `omp`，插件不再自带第二份。

仍在图里的 vendor（本计划**有意保留**）：`@earendil-works/pi-*`（PI codiing agent，32 M 级，user 例外放行）、
`@openai/codex*`、`@anthropic-ai/claude-agent-sdk`。

## 2. 探针（自动段，全绿）

| 探针 | 期望 | 实测 |
|---|---|---|
| `GET /`（无 token/cookie） | 401 | **401** |
| `GET /?token=…`（铸 cookie） | 303 | **303** |
| `GET /`（带 cookie） | 200 | **200** |
| `GET /hub`（无参，foreign-only） | 404 | **404** |
| `GET /omp/` `/codex/` `/claude/`（0.1.5 前的旧世界页） | 404 | **404 ×3** |
| 启动日志 `world failed` | 0 | **0** |
| `omp binary not found` 诊断（world-plugin 新探针） | 不出现 | **未出现**（本机 `omp` 解析成功） |
| 启动警告集 | 与基线逐行相同 | `superd-hermes: warning: 1 entry did not activate` + `session-controller … pending (waiting for service: fileUploads)`（均为既有基线噪声） |

## 3. 待 user 亲手验收（端到端一轮真会话）

自动段只能证明「装得对、起得来、不降级」；**协议真的走通**必须有真模型的一轮：

1. 打开 LAN URL（上面那条），进 OMP world；
2. 新建会话 → 发一轮 prompt（例如「只回复 OK」）→ 看到流式输出；
3. 同一会话再 resume 发第二轮；
4. 期间可 `pgrep -af 'omp --mode rpc'` 应看到子进程；`pgrep -af bun` 应为空。
5. **额外一条（最终审查建议）**：这一轮请顺带确认 OMP 会话的 resume 采用路径真的成立——即 `get_state` 返回 `sessionFile` / `sessionId`，`adoptSpawnedChild` 据此把 DSH session 映射到 OMP session。这是全链唯一没有单测覆盖的一环（mock 的 `get_state` 不带 `sessionFile`），也是最可能在真机上暴露协议漂移的地方。观察到第二轮能重新挂上同一 OMP 会话即算通过。

这条过了，Task 6 才算完成；我会把结果补进本报告。
这条过了，Task 6 才算完成；我会把结果补进本报告并跑最终整支审查。

## 4. 已知 gap / 遗留（不阻塞）

- **协议 v2 分帧未实现**（spec §4）：本线停在 v1 纯 NDJSON；单帧 >1 MiB 才需要 v2 重组。
- tick 之外的 idle spawn：boot 时 `loadOmpModels()` 仍会尝试一次 CLI（盘上缓存兜底），DSH 模型选择变更时 `#syncModelDefaultTick` 会读/写 `modelRoles`——都是「真实需要」路径，不是每 tick。
- 注释与文档残留 "SDK sidecar" 字样：`agent.ts` / `models.ts` / `knobs.ts` / `adapter.ts` / `discovery.ts` / `omp-disk-discovery.ts` / `omp-store.ts`，以及 `agent-omp/package.json` 的 description、`agent-omp/README.md`、`agent-omp/AGENTS.md` §五·五（后者还把已删的 `test/sidecar-decouple.test.mjs` 写成在役守卫）。已登记为 deferred minor，交最终审查裁量。
- 宿主机 `/` 使用率 **96%**（余 9.9 G）——与本次改动无关，但会威胁后续 pack/install 轮次。
