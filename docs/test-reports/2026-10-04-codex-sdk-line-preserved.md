# Codex SDK 线保留为可选路线（`agent-codex-sdk`，2026-10-04）

- 线：**主线** `/home/u1/workspaces/superd`（分支 `master`）
- 触发：user 2026-10-04 指令——① 把 worktree 合并回主线；② SDK 线**不删**，包名/文件名整体改为 `agent-codex-sdk` 保留为选项；③ 该线在插件里**默认 disable**（CLI/app-server 线优先）；④ SDK 线的**所有 dependency 都不写在包里**（不是 dependency、不是 optional、也不是 peer），只在被选中并启动后由运行时自己 fetch 到本地；⑤ 改完放 4999 让 user 实测
- 形态：**交付形态验收**（4999 pack 线）——`node super-dsh/scripts/pack.mjs` → tarball → 全新 profile `corepack pnpm@10.33.2 add file:` → repo build 的 dsh CLI boot
- 结论：**四条要求全部成立**。SDK 线作为独立可选路线保留且可用；默认不在 roster；安装期零下载（profile `.pnpm` 里连 `@openai+codex-sdk` 都没有）；首次真 prompt 时才把 SDK 树 fetch 进 world home。

---

## 一、合并（要求 ①）

`5493bc9 Merge branch 'codex-app-server'`（父 `2cbd11d` + `6b3ef40`）。唯一冲突在 `super-dsh/package.json` 的 `dependencies`：取主线的 manifest，删掉分支侧重新加回的 `"@openai/codex-sdk": "0.154.0"`（分支侧还错加了 `bun`）。

合并后主线真跑一遍，确认没把两条线搅在一起：

| 检查 | 结果 |
|---|---|
| `super-dsh/agent-codex` 是 app-server 线（`app-server-*.ts` / `codex-launch.ts` / `codex-route.ts`，无 `codex-client.ts`） | 是 |
| `super-dsh/agent-codex` tsc + 全测 | **190 / 190** |
| `super-dsh/superd-hub` tsc（含 client lane）+ 全测 | **514 / 514** |

## 二、SDK 线保留（要求 ②③）

`git archive 2cbd11d super-dsh/agent-codex` → `super-dsh/agent-codex-sdk/`（包 `@pgmi-builds/agent-codex-sdk`，world key **`codex-sdk`**，label「Codex (SDK)」）。三条命名判据：

1. **world key 必须与主路线不同**（`codex-sdk` vs `codex`）——hub 的 `registerAgent` 对重复 key 硬抛，两条行要能同时挂着；
2. **agent preset id 仍是 `codex`**——与 `omp`/`omp-sdk` 同构：能力同名，只有 world key 区分；
3. **只改 SDK 传输对的文件名**（`codex-client.ts` → `codex-sdk-client.ts`，`codex-events.ts` → `codex-sdk-events.ts` + 对应测试）。`codex-store.ts` 等共享 helper **刻意保留同名**：它与 app-server 线的同名文件**逐字节相同**，同名同形是事实，改名反而暗示两者有别。

顺手修掉两个**改名遗漏**，其中一个是真 bug：

| 位置 | 问题 | 修 |
|---|---|---|
| `src/world-plugin.ts` `export const name` | 仍是 `'agent-codex'`（loader 会把本包报成主路线的名字） | `'agent-codex-sdk'`（对齐 `agent-omp-sdk`/`agent-agy-sdk`） |
| `src/session-map.ts` fallback state dir | `join(fallbackHome, "agents", "codex")` → **指向主路线的 world home**，即任何 `home` 缺省路径下本包会去读写 `codex` 的 `dsh-sessions.json` | `"codex-sdk"` |

composite 行（`super-dsh/cordis.patch.yml`，与 `agent-omp-sdk` 同款注释密度）：

```yaml
- id: agent-codex-sdk
  name: 'super-dsh/agents/codex-sdk'
  disabled: true
```

**默认 disable 是行存在性本身**（`plugin-presence IS the roster`）：没有 env 旋钮、没有 config key，打开该行就是开关。hub 侧两处配套：`runtime-icons` 把 `<runtime>-sdk` 归一复用主路线的 mark（SDK 半是**同一个 agent 换个传输**，另造图标等于宣称 agent 不同）；`roster.ts` 的 `FALLBACK_LABELS` 补齐三个 SDK key。**不给 `codex-sdk` 映射设置面板**——该线没有 `codexProviders` RPC。

## 三、零依赖 + 运行时自取（要求 ④）

`agent-codex-sdk/package.json` 的 `dependencies` = `{}`；`@openai/codex-sdk` / `@openai/codex` / `zod` **不在任何依赖表**里（deps / optional / peer / peerMeta / dev 全查），无 postinstall；`package-lock.json` 删除。主 pack 的 `dependencies` 同步不含 `@openai/codex-sdk`。

新增 `src/sdk-runtime.ts`（形态抄 `agent-omp-sdk`，但 Codex 侧简单得多——纯 npm 树，没有 bun / sidecar / 原生绑定）：

```
<worldHome>/sdk-runtime/            npm 树（私有 package.json + node_modules）
<worldHome>/sdk-runtime.json        marker，最后写
<worldHome>/sdk-runtime.lock        mkdir 原子锁，30 min 判陈旧可夺
<worldHome>/sdk-runtime.error.log   只有失败才写
```

- 两个包**一起钉** `0.154.0`（SDK 的唯一依赖就是那个二进制包，只钉 SDK 会让二进制漂移）；
- entry **按解析后的绝对路径 import**，绝不用裸 specifier——runtime 在 world home、插件在 tarball 里，裸名既解析不到、又会把刚删掉的依赖偷偷请回来；
- 装完立刻 smoke `import()` 并断言 `Codex` 构造器存在（坏树在 fetch 时报错，不留到首 prompt）；
- `test/package-contract.test.mjs` 扫**产物 JS**（不是 TS）里的静态 `@openai` import——依赖真正回潮的方式就是这个。

零 IO 的 create 与「首个真 prompt 才 fetch」用 `DeferredCodex` 保证：默认 factory 返回一个**零磁盘零网络**的句柄，真实例（以及 fetch）在 `ensureStarted()` / 首次 `runStreamed` 时经 `loadCodexSdk(worldHome)` 物化；失败**不缓存**（marker 不写，下次能自愈）。`test/sdk-lazy.test.mjs` 对着真 factory 钉这条不变量。

## 四、实测（4999 交付形态）

### 4.1 静态面

| 检查 | 结果 |
|---|---|
| tarball 主 manifest `dependencies` | 无 `@openai/codex-sdk`（有 `@openai/codex`，那是**主路线**要的） |
| tarball 内 `agent-codex-sdk/package.json` | `dependencies: {}`、无 `optionalDependencies`、`peerDependenciesMeta` 只含 DSH 宿主包 |
| 产物 JS 静态 `@openai` import | 0（只剩注释与 `SDK_PACKAGE` 常量字符串） |
| profile `.pnpm`（`pnpm add file:super-dsh-0.1.9-a.tgz`） | 有 `@openai+codex@0.154.0`，**没有** `@openai+codex-sdk` |
| `agent-codex-sdk` tsc + 全测 | **95 / 95**（原 70 + 新 25：package-contract 6 / sdk-runtime 15 / sdk-lazy 4） |

### 4.2 默认态（实际交付的 4999 实例）

```
GET /            (无 cookie)   401
GET /            (cookie)      200
/api/agent-runtime             available: [native, claude, pi, hermes, codex, agy, omp]
                               codex-sdk 不在其中（正确）；7 个 world ready=true failed=false
boot 日志 world failed          0
.tests/superd/agents/codex-sdk  不存在 —— 世界没起、SDK 没取（正确）
```

### 4.3 打开开关（验证「选项是真的」）

profile patch 追加一行 `- id: agent-codex-sdk` + `disabled: false`（profile patch 在 bundle patch **之后**合成）→ 重启 service：

```
/api/agent-runtime  available: [… , codex-sdk, …]
  codex        label=Codex         ready=True failed=False
  codex-sdk    label=Codex (SDK)   ready=True failed=False     ← 无重复 key 硬抛
.tests/superd/agents/codex-sdk/  出现（世界自己的 world home）
  sdk-runtime/                   仍然不存在 —— 起了世界但没取 SDK
```

### 4.4 首个真 prompt 才 fetch

在该世界 `session/create`（**零 IO 确认**：建完仍无 `sdk-runtime/`）→ `session/prompt`：

```
[agent-codex-sdk] codex-sdk: installing @openai/codex-sdk@0.154.0 + @openai/codex@0.154.0
[agent-codex-sdk] codex-sdk: smoke-importing @openai/codex-sdk@0.154.0
[agent-codex-sdk] codex-sdk: runtime ready at …/agents/codex-sdk/sdk-runtime
marker: {pluginVersion 0.1.0, packageVersion 0.154.0, binaryVersion 0.154.0, entryPath …}
lock 已释放、error.log 不存在、dsh-sessions.json 写入真 Codex thread id
```

真 npm、真网络、无注入：首次 **10.07 s**，第二次 **0.166 s** 且 `installedAt` 不变（幂等、零网络）。另起探针验证 `loadCodexSdk` 能 import 该树：导出 `Codex` / `Thread`，`new Codex({env})` 成功，`startThread`/`resumeThread` 都在（正是 client 侧 `CodexLike` 期待的 shape）。

### 4.5 SDK 传输真跑一次 turn（探针）

对着 fetch 出来的树直接走 adapter 的同一条链（`loadCodexSdk` → `new Codex` → `startThread` → `runStreamed`）：整条链**机制上通了**——`codex exec` 子进程真起来了，报的是

```
Missing environment variable: `ZHIPU_API_KEY`
```

这不是本轮的缺陷：**裸 `codex` 二进制**在同样环境下报**一模一样**的错。原因在分账设计里：本轮 rig 的 provider 是启动时从原生 `config.toml` 折进来的，形态是 `auth.kind = "env"`（原生文件里写的是 `env_key = "ZHIPU_API_KEY"`），即「值由环境提供」；而当前所有 rig 的进程环境都没有这个变量（`dsh.service` 也没有）。要走通一条 codex turn，需要二选一：把 `ZHIPU_API_KEY` 放进 rig 的 unit 环境，或在 hub 面板里给该 provider 存一个 key（`auth.kind = "apiKey"`，走合成变量名注入）。同步**不会**覆盖已存的 key（`adoptAuth = entry.auth.kind === "env" || entry.auth.value === ""`），所以面板存过就不会被 10 分钟 reconcile 冲掉。

---

## 五、这次实验留下的状态与收尾

- 4.3–4.5 的探针产物**已全部清除**（临时 profile patch、`.tests/sdkfetch-probe/`、`agents/codex-sdk/`、两条探针会话目录与 `dsh-sessions.json` 条目），4999 已重启回**实际交付的默认态**（`codex-sdk` 不在 roster）。
- 顺带在真机上确认了合并后的多 provider 面：主线 home 启动同步自己建出了 `.tests/superd/agents/codex/codex-providers.json`（0600），折进 `deepseek` + `zhipu-cn`（label = endpoint URL，`origin: native`），并按 provider 写了 `codex-catalogs/`。
- pack 版本 `0.1.9-a`（测试迭代字母后缀，registry 仍冻在 0.1.9）；`npm publish` 未授权、未执行。
