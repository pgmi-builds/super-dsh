# World Resolution Upstream Alignment — 拆 farm，走宿主解析流程

- 日期：2026-09-25
- 状态：已裁决（user 2026-09-25 下令：结构重做，replace/linkedRoots 路线，先 spec 后实施）
- 范围：`superd-hub/src/{spawn-world,world-provision,world-join}.ts`、各 `agent-*/src/world-plugin.ts` 的 anchor 调用、hub 测试

## 0. 动机（user 裁决原话）

> superd is a plugin (generic meaning of embedding into something, that something is `dsh`)。
> the superd re-use the native dsh `boot()`, why not just fucking follow the same process?
> do you have another dsh nodes other than the dsh host? — 没有。一台都没有。

0.1.3-r 事故（prod farmless 六世界全灭）暴露：世界树的物理 farm 机器是 ADR-0008 PoC 血统的补偿层，
其「能跑」一直依赖消费机上恰好存在的旧版 farm 残迹（dev3 244 条、prod 删除前 198 条）。
**干净 0.1.7 机器从第一天起就跑不了世界**。修法不是继续给推导打补丁，是让世界派生走宿主自己的解析流程。

## 1. Ground truth（上游 0.1.7-rc.1 源码锚点）

| 事实 | 锚点 |
|---|---|
| 表在 boot() 的 **prepare hook** 里装：`hostCtx.plugin(PluginPackages, { resolution })`，先于一切 config-tree entry | `apps/cli/src/profile-boot.ts:298` |
| `anchor` 就在 **`profileContext` service** 里：`hostCtx.provide('profileContext', { …, installAnchor })` | `profile-boot.ts:289-291` |
| 裸名 row 的装载 = root config 自身是被作用域覆盖的 importer（相对名 resolve 在 config 旁，裸名走 ambient pipeline → 拦截表） | `packages/boot/app-boot/src/index.ts:534-556` |
| **一个 isolate 只有一份活表**；`replace(successor)` 原子发布后继：linked roots 可增删、既有映射/local names 不得变 | `profile-resolution/resolver.ts:395-411`、`service.ts:80-84` |
| 作用域分层：`profilesDir` 树内 = profile 层（**installation entries 免 peer 门**、local-physical 先行）；树外 = 须 linked root（**routeLinked 有 peer 门**：请求名须出现在 importer 祖先某 package.json 的 peerDependencies） | `resolver.ts:190-260, 445-530` |
| `ctx.pluginPackages.packageDir/packageOf(specifier, parentURL)` = 官方包定位 API（有表走表，无表退物理 walk） | `profile-resolution/service.ts:100-115` |
| 世界的 composition 是 spawn-time 事实：世界 hmr 已禁（零监听 posture 持久化），**不会因 ctx0 重组而重导入** | `world-provision.ts:186-209` |

## 2. 设计

### 2.1 选定：Design B″ — 世界作为宿主活表的 **linked root**（合同内形式）

> **实施期合同发现（2026-09-25）**：`RuntimeInterception.replace` 明文冻结 `profilesDir`/`profileDir`
> （`resolver.ts:375` "a successor cannot change its profile scope"）——原 Design A（profilesDir 加宽到
> home 根）**被合同否决**。合法变更面 = **加 linkedRoots + 加 entries + 加 localPackageNames**
> （移除/改既有映射均 throw）。

世界 spawn 时（boot 导入发生前）向宿主的活表发布后继：

```ts
successor = {
  ...reconstructedCurrent,                                    // profilesDir/profileDir/既有 entries 不动
  entries: [...current.entries, 世界 @pgmi-builds 包 entries], // routeLinked 从表取 target
  linkedRoots: [...current.linkedRoots, { name: `superd-world-${appName}`, realPath: worldHome }],
}
```

配套三件事：

- **peer 门供给**：routeLinked 要求被拦截名出现在 importer 祖先某 manifest 的 `peerDependencies`。
  spawnWorld 从 composed rows **收集裸名**（`name` + `inject` 列表），生成 peers 写进世界 profile 的
  `package.json`——确定性集合、每次 spawn 幂等再生成，**上游加行 → 下次 spawn 自愈**（原 B 方案
  「手工枚举不可维护」的否决理由由生成式解除）。**实施期发现①**：`ctx.baseUrl` 是**带尾斜杠的目录
  URL**，resolver 的 `dirname()` 会掉一层——peers 必须同时写进 `<worldHome>/profiles/package.json`
  （尾斜杠恰好命中的位置），只写 profile manifest 读不到；
- **`@pgmi-builds` entries**：target = provision 已写的 profile-local 链接的 realpath（pack 内兄弟
  目录——与 ctx0 同一物理实例）。**实施期发现②**：`declarer` 必须是 manifest **路径**——ESM 拦截会把
  resolve parent 重写为 `pathToFileURL(route.entry.declarer)`，填包名会炸；
- **忠实重建**：服务不暴露 `current`，按 `profileContext` 事实 `loadProfile` +
  `createRuntimeResolution` 重算（plugin add 后的磁盘态被下次 spawn 自动拾取）。
- **实施期发现④（跨 spawn 累加）**：重建从净底座出发，successor 若**丢掉先前世界的 additions**
  → 合同 throw（"replacing X requires a process restart"）→ 首个世界存活、其余全灭（dev3 0.1.3-t
  实证 1/6）。修法 = 进程级累加器，successor 恒携带并集。
- **实施期发现⑤（共享名 + 并发）**：每个世界都发布 `@pgmi-builds/superd-hub`，unconditional
  覆盖会漂移 declarer（dev3 0.1.3-u 实证仍 5/6 失败）；且六 spawn 并发互踩。修法 = **首写保留**
  （共享名保持首发布者的 entry——任何 manifest 路径都满足 ESM 重定向，peer 门读的是 importer
  祖先而非 declarer）+ **发布串行化**（队列化，失败不阻塞后续）。dev3 0.1.3-v 实证 6/6 全绿。

### 2.2 否决的替代

| 方案 | 否决理由 |
|---|---|
| A：profilesDir 加宽后继 | **合同否决**（`resolver.ts:375`：successor 不得改 profile scope；实施期实证 throw） |
| B（原始形态）：linkedRoots + 手工枚举 peers | 生成式 peers（§2.1）解除维护性 objection 后被 B″ 吸收 |
| C：世界 root config 挪进 ctx0 活动_profile 树 + row 改 `super-dsh/*` 子路径 | 组合根所有权泄漏进 ctx0 profile；loadProfile(worldHome) 的 per-world 定位（dshHomePath pinning、patch 层）被破坏 |
| 维持 farm 只换源料（b0fd3a2 现状） | 干净消费机仍然全灭；farm 本身就是要拆的补偿层 |

### 2.3 anchor 推导退役

`resolveInstallAnchor()` 的调用链全部改走宿主事实：

1. `ctx.get('profileContext')?.installAnchor`（world plugin 跑在 ctx0，service 伸手即得）；
2. 缺席（表-less harness / 测试）→ 保留 `SUPERD_DSH_ANCHOR` env 与 realpath 上溯兜底。

## 3. 变更清单

**删除**：
- `world-provision.ts`：`workspaceHarnessScopes` + `scopeSources` 并集 + `<worldHome>/profiles/node_modules/@deepseek-ai` 303 链接构造（整个 harness-scope 段）；
- `spawn-world.ts`：`bareModuleBaseUrl` 形参、boot 第 5 参、`rawBase` 默认值推导；
- 调用侧 `bareModuleBaseUrl:` 传参（world-join / 各 adapter world-plugin）。

**保留**：
- 世界 profile 的 manifest / `cordis.patch.yml`（零监听 posture）写作；
- `profDir/node_modules/@pgmi-builds/{adapter,hub}` 链接（plugin-add 形状，local-physical 腿消费）。

**新增**：
- `spawnWorld` 内（boot 前）：读 `ctx0.pluginPackages` 当前表 → 构造加宽后继 → `replace()`；无 service（测试/嵌入态）时静默跳过（与现状等价：物理 walk）；
- anchor：`profileContext` 优先链（§2.3）。

## 4. 已知边界（记录，不处理）

- **ctx0 plugin add 热替换会收窄表**：launcher 的 HMR replace 用 `createRuntimeResolution` 原样输出（profilesDir = `<home>/profiles`）。已被加载的世界模块不受影响（module cache + 世界无 hmr）；**下一次 spawn 会重新加宽**（幂等）。世界 spawn 后 ctx0 加插件、旧世界再懒加载新 row 的窗口是理论缺口——世界 composition 是 spawn-time 事实（§1 末行），不接受该路径。

## 5. 测试与验收

1. 单元（hub）：world-mount / spawn-world 测试改为**装真拦截**——`ctx.plugin(PluginPackages, { resolution: 加宽后继 })`（或 `installRuntimeInterception` 直装），删除 farm 投影夹具；断言世界 row 裸名经表解析、`@pgmi-builds` 走 profile 本地链接；
2. hub 全绿 + 各 adapter 套件（未触碰面）；
3. 4999 pack 线（compat + clean rig）全绿；
4. prod 升级安装（0.1.3-t）→ **重启仅凭 user 明确下令**（2026-09-25 红线：prod 有其他 agent 在役，不得自行重启）→ journal `world failed` = 0 + 六 mount + roster ready。

## 6. 验收后的文档同步

根 AGENTS §二/§三、super-dsh/AGENTS「锚与解析契约」、docs/07 §5.4：世界树解析改述为「宿主活表 + profilesDir 加宽后继」，farm 叙述整体进历史。
