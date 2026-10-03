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

**⚠ 更正（同日复测）：上一条结论是错的，rig 里这个变量是有的。** `app-boot` 会把 line home 的 `.env` 层**物化进 `process.env`**（`packages/boot/app-boot/src/index.ts:232-250`，home 层 = `$DSH_HOME/.env`，而本 launcher 的第一步就是把 prod `.env` copy 过去），所以 codex 子进程能正常继承到 key。我先前之所以看到 `Missing environment variable`，是因为探针在 **agent shell**（harness 之外）里直接跑 —— 那是我的 shell 的 env，不是 rig 的 `process.env`；`/proc/<pid>/environ` 也查不到，它只反映 exec 时的环境，看不到运行期 `process.env[name] = …`。**复测**：把 `.tests/superd/.env` 按 harness 的方式载入后再跑同一个二进制 → `tokens used 27,218` / **`PLUM`**。结论：codex 两线在 4999 上都能拿到 provider key，无需额外动作。

---

## 五、这次实验留下的状态与收尾

- 4.3–4.5 的探针产物**已全部清除**（临时 profile patch、`.tests/sdkfetch-probe/`、`agents/codex-sdk/`、两条探针会话目录与 `dsh-sessions.json` 条目），4999 已重启回**实际交付的默认态**（`codex-sdk` 不在 roster）。
- 顺带在真机上确认了合并后的多 provider 面：主线 home 启动同步自己建出了 `.tests/superd/agents/codex/codex-providers.json`（0600），折进 `deepseek` + `zhipu-cn`（label = endpoint URL，`origin: native`），并按 provider 写了 `codex-catalogs/`。
## 六、附带：共用 credential seed（2026-10-04 user 裁决，同一轮追加）

user 现场反馈：不同 repo 的 rig 都抢 4999，而每个 home 自带一份 `.credentials.yaml`，secret 不同 ⇒ 浏览器 cookie 每次换 rig 都要重铸。

本仓落法（`test/start-4999.sh`）：给 upstream `credentials` 行套 profile patch，把 `path` 指到**全机共用**的 `$(dirname $REPO)/.dsh-test-credentials.yaml`（`DSH_TEST_CREDENTIALS` 可覆盖）；文件不存在时先由本 home 旧文档播种，所以**采纳这个约定不会让用户手上那个 cookie 失效**（本仓 `.tests/superd` 与 dashr `.test/home` 本就是同一个 secret）。

⚠ 实测 A/B（同一个 home、同一个 cookie，只换 seed 源）：

| seed 源 | secret | 结果 |
|---|---|---|
| 该 home 自己的 `.credentials.yaml`（模拟旧行为） | `b703c974…` | **401** |
| 共用文件 `/home/u1/workspaces/.dsh-test-credentials.yaml` | `aebac32c…` | **200** |

过程中还跨了三次 rig 重启与一次换 home 接管 4999，**最初那一枚 cookie 始终 200**；该 home 自己的 `.credentials.yaml` 全程未被读写（sha 不变）。机制：cookie 名由 authority 派生（`dsh-auth--<sha256(authority)>`），签名只吃 seed ⇒ 同 authority + 同 seed 的 cookie 跨 rig 通用。文档：`docs/07` §3.3、`super-dsh/AGENTS.md`。

## 八、追加：SDK 线拿到同一条多 provider 面（2026-10-04 同日，user 指令）

user：「Both adapters work, but can we bring the same multi provider to codex-sdk?」

**结论：成立**，而且比 app-server 线更省。做法照抄仓内既有形态（`agent-omp`/`agent-omp-sdk`：16 个同名 src 文件里 11 个逐字节相同，只有传输件不同）：

| 分类 | 内容 |
|---|---|
| **逐字节复制**（`cmp` 全绿） | `adapter.ts`(117) / `codex-providers.ts`(487) / `codex-native-config.ts`(438) / `codex-provider-gateway.ts`(446) / `codex-route.ts`(103)——只 import node 内建、彼此、`@deepseek-ai/*`，**零** app-server 传输耦合 |
| **新写**（唯一传输件） | `codex-sdk-launch.ts`：同一 provider 表 → SDK `CodexOptions.config`。SDK 的 d.ts 明说它把这些 override「flatten into dotted paths … compatible with the CLI's `--config` parsing」——**与 app-server 线的 `-c` 是同一条通道**，三种 auth 分支原样复刻 |
| **接线** | `index.ts` 搬 CLI 线的 provider 机械（store 正本 / 10 min 原生同步 / `codexProviders` gateway / 每 provider 一条 `ctx.llm` route / `seedRoute`）；`agent.ts` 换成 `#resolveRoute`+`#turnRoute`+`launchFor`；`codex-sdk-client.ts` 把单例 handle 改成**按 provider 分键**的 refcount 注册表 |

**换 provider 比 app-server 线简单**：SDK 每个 turn 都 spawn 一个 `codex exec`（`dist/index.js:263`），provider 只是「这一轮用哪个 handle」的属性，所以不 kill 子进程——换 handle + `resumeThread(同一 thread id)` 即可（thread id 是磁盘上的 rollout，两个 handle 都读得到）。turn 中切换自然落下一轮。

**实测**（真 SDK、真网络、真 provider 表）：

| 探针 | 结果 |
|---|---|
| `providerSdkLaunch(store.entry)` | `{model_providers: {zhipu-cn: {name,base_url,wire_api,env_key}}, model_provider, model_catalog_json:<绝对路径>}` |
| `new Codex({config, env:{...process.env}}) → startThread → runStreamed` | **`MANGO`** + usage + thread id `01a101ee-…` |
| **换 handle**（新构造）+ `resumeThread(同一 id, {model:"glm-4.7"})` | **`MANGO`** —— 实例换了、模型换了，上下文仍在 |

**测试**：`agent-codex-sdk` **170/170**（原 95 + 复制的 provider 面测试；其中 `codex-provider-gateway-wiring` 与 `codex-session-route` 当初因 `dist/index.js` 未就绪被暂缓，接线后**原样通过**——它们本是照 app-server 线写的，能直接用就是两条线同形的证据）；`superd-hub` **514/514**（面板映射 `codex-sdk → codexProviders`）。

## 七、版本与发布

- pack 版本 `0.1.9-a`（测试迭代字母后缀，registry 仍冻在 0.1.9）；`npm publish` 未授权、未执行。
