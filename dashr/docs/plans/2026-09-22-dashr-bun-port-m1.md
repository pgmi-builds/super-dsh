# dashr bun port M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 `dsh-v0.1.6-alpha.2` fork 出 `dashr/port/` 仓库，以 port commit 形态产出一个**单文件二进制**：干净 VM 上只放一个可执行文件 + 空 `DSH_HOME` 即可 boot、对话、落盘。

**Architecture:** port 仓库（D1）持有全部改动：自有组合 `dashr.cordis.yml`（D3）喂给 registry 生成器（N1），编译期冻结宇宙 + `--asset` 内嵌 client halves/前端 dist/组合（D2）；loader 桥 M1 版（N2）只做 registry 层；上游磁盘耦合点按 R1-R7 逐个重写。M1 无插件装载（D4）。

**Tech Stack:** bun 1.4.0（`--compile`/`--asset`）、pnpm workspace（构建期）、vitest（port 仓库测试）、zod（随编译器打入）。

**Spec:** `dashr/docs/specs/dashr-bun-port/spec.md`（本计划从 spec 立论，执行者两份都读）

## Global Constraints

- 上游基线：tag `dsh-v0.1.6-alpha.2`（sha `ddefc45fbc`，remote `https://github.com/deepseek-ai/deepseek-harness.git`）
- 硬契约（spec §1）：stock 产物 = 一个可执行文件；磁盘仅 DSH_HOME 用户数据
- 资产三分法（spec §3）：bundled=宿主 JS（registry）；asset=`--asset`（client halves/dist/yml/presets/badge）；disk=DSH_HOME
- 删行账本（spec §4 D）：删行必须逐行注 `# dashr: drop <理由>`；禁止静默继承上游新行
- bun 路径：`/home/u1/workspaces/dashr/.scratch/bun-install/bin/bun`（1.4.0）
- 外层仓规则：`dashr/port/` 是独立 git 仓库，外层仓 `.gitignore` 它；外层 `upstream/deepseek-harness` 保持 pristine
- 每个任务在 port 仓库内 commit；构建验证命令统一在 port 仓库根执行
- 发布三闸（spec §5）：本计划只到"可验收产物"，不 publish

---

### Task 1: port 仓库落地（fork + 分支 + 外层 ignore）

**Files:**
- Create: `dashr/port/`（独立 git 仓库，branch `port/main`）
- Modify: `.gitignore`（外层仓，加 `dashr/port/`）

**Interfaces:**
- Produces: `dashr/port` 仓库，`port/main` 分支 = `dsh-v0.1.6-alpha.2`，remote `upstream` 指真实 URL，remote `upstream-local` 指本地 pristine checkout（快速 fetch 用）

- [ ] **Step 1: clone 出 port 仓库并整 remote**

```bash
cd /home/u1/workspaces/dashr
git clone --no-hardlinks upstream/deepseek-harness dashr/port
cd dashr/port
git checkout -b port/main dsh-v0.1.6-alpha.2
git remote set-url origin https://github.com/deepseek-ai/deepseek-harness.git
git remote rename origin upstream
git remote add upstream-local /home/u1/workspaces/dashr/upstream/deepseek-harness
```

- [ ] **Step 2: 外层仓忽略 port 目录**

`/home/u1/workspaces/dashr/.gitignore` 追加一行：

```
dashr/port/
```

- [ ] **Step 3: 验证**

```bash
git -C dashr/port log --oneline -1   # = ddefc45fbc release(dsh): 0.1.6-alpha.2
git -C dashr/port remote -v          # upstream=github, upstream-local=本地
git -C /home/u1/workspaces/dashr status --short | grep -c "dashr/port" # 0（被 ignore）
```

- [ ] **Step 4: Commit（外层仓）**

```bash
cd /home/u1/workspaces/dashr && git add .gitignore && git commit -m "dashr: ignore port repo checkout"
```

---

### Task 2: standing build patches 转正（S）

**Files:**
- Modify (port): `packages/client/tsdown.client.ts`、`pnpm-workspace.yaml`、`package.json`、`apps/web/package.json`、`apps/web/vite.config.ts`；删除 `vendor/{AGENTS,CLAUDE,README}.md`

**Interfaces:**
- Produces: port 仓库在无 bundle 环境外也可构建的基座（storeDir/verifyDeps/zeromq allowBuilds/preact pin/REPOSITORY_ROOT）

- [ ] **Step 1: 从本地 pristine checkout 导出 standing diff**

```bash
cd /home/u1/workspaces/dashr/upstream/deepseek-harness
git diff HEAD -- package.json pnpm-workspace.yaml packages/client/tsdown.client.ts apps/web/package.json apps/web/vite.config.ts > /tmp/standing.patch
```

（内容即根 AGENTS.md §二所列四件套；`vendor/*.md` 的删除单独处理。）

- [ ] **Step 2: 在 port 应用并补 vendor 文档删除**

```bash
cd /home/u1/workspaces/dashr/dashr/port
git apply /tmp/standing.patch
git rm -q vendor/AGENTS.md vendor/CLAUDE.md vendor/README.md
```

- [ ] **Step 3: 构建验证（port 仓库全量 build 绿）**

```bash
pnpm install   # storeDir 已被 patch 指到 .scratch/pnpm-store（port 内相对路径按 tsdown patch 的 cwd 语义生效）
pnpm run build > /tmp/port-build.log 2>&1; echo $?
tail -3 /tmp/port-build.log   # 期待 248 client artifacts 量级
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "port: adopt standing build patches (tsdown root, pnpm store/verify/allowBuilds, preact shell)"
```

---

### Task 3: R4/R5/R6 根因修复转正（已验证语义，小 diff 全文内嵌）

**Files:**
- Modify (port): `packages/session/session-persistence-jsonl/src/lease.ts`、`packages/core/scope/src/index.ts`、`packages/preset/agent-presets/src/discovery.ts`、`packages/skill/skill-badge/src/index.ts`

**Interfaces:**
- Produces: `tryLockExclusive` 编译态单进程替身；`kScope` 进程单例 Symbol；两处资产根锚（消费 `DSH_BUN_ASSET_ROOT`，Task 5 的 N1 设该值）

- [ ] **Step 1: lease.ts —— import 改名 + 单进程替身**

```ts
// packages/session/session-persistence-jsonl/src/lease.ts
import { tryLockExclusive as tryLockExclusiveNative } from '@deepseek-ai/node-addon-system/flock'
```

在 `export const LEASE_FILENAME = 'session.lock'` 之后加：

```ts
/**
 * Exclusive-lock request used by this process.
 *
 * bun --compile: the platform `.node` binding cannot be resolved from inside the
 * /$bunfs image, so the compiled binary grants the request immediately — the
 * same single-process substitution the browser worker uses, valid because the
 * backend's in-process write claim already excludes every writer.
 */
const tryLockExclusive: typeof tryLockExclusiveNative = process.env.DSH_BUN_COMPILED === '1'
  ? () => Promise.resolve()
  : tryLockExclusiveNative
```

- [ ] **Step 2: scope/index.ts —— Symbol 进程单例**

```ts
// packages/core/scope/src/index.ts —— 替换 `const kScope = Symbol('dsh.scope')`
// bun --compile: the compiled module graph can carry more than one copy of this
// module; a copy-local Symbol splits tag identity between createScope's writer
// and scopeOf readers. Mint once per process through globalThis (Symbol keys
// stay opaque to cordis property resolution; string keys route through the
// inject registry and break boot — verified).
const kScope: symbol = (globalThis as typeof globalThis & { __DSH_SCOPE_KEY__?: symbol }).__DSH_SCOPE_KEY__
  ??= Symbol('dsh.scope')
```

- [ ] **Step 3: discovery.ts（agent-presets）—— 资产根**

```ts
// packages/preset/agent-presets/src/discovery.ts —— 替换 SHIPPED_PRESET_ROOT 行
export const SHIPPED_PRESET_ROOT = process.env.DSH_BUN_ASSET_ROOT !== undefined
  // bun --compile: import.meta.url-based relative URLs over-resolve inside /$bunfs
  // (bun 1.4 drops one extra path segment); the boot wiring publishes the asset root.
  ? join(process.env.DSH_BUN_ASSET_ROOT, 'presets') + sep
  : fileURLToPath(new URL('../presets/', import.meta.url))
```

（import 行加 `sep`：`import { dirname, join, resolve, sep } from 'node:path'`。）

- [ ] **Step 4: skill-badge —— 同款资产根**

```ts
// packages/skill/skill-badge/src/index.ts —— PROVIDER_NAME 之后
const ASSET_ROOT = process.env.DSH_BUN_ASSET_ROOT !== undefined
  ? `${process.env.DSH_BUN_ASSET_ROOT}/assets`
  : fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_BODY_URL = process.env.DSH_BUN_ASSET_ROOT !== undefined
  ? new URL(`file://${ASSET_ROOT}/dsh-badge.md`)
  : new URL('../assets/dsh-badge.md', import.meta.url)
const RESOURCE_BASE = { kind: 'directory', path: ASSET_ROOT } as const
```

（替换原 `SKILL_BODY_URL`/`RESOURCE_BASE` 两个常量。）

- [ ] **Step 5: 单测 + 类型验证**

```bash
node_modules/.bin/tsc -b packages/core/scope packages/preset/agent-presets packages/skill/skill-badge packages/session/session-persistence-jsonl
pnpm exec vitest run packages/core/scope
```

期待：测试绿（scope 语义未变——同进程内单例恒等）；tsc 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "port: single-process lease, process-singleton scope key, asset-root anchors (R4/R5/R6)"
```

---

### Task 4: 组合 `dashr.cordis.yml` + 删行账本（D3）

**Files:**
- Create (port): `composition/dashr.cordis.yml`
- Create (port): `composition/README.md`（账本说明：merge tag 冲突即复审）

**Interfaces:**
- Produces: 行集 = base ∪ web-app 全部行 − 账本删行；每行 `# dashr: keep|drop <理由>` 前缀注释（keep 行可省注释，drop 行必注）。**N1（Task 5）以 `keep` 行集合为输入**。

- [ ] **Step 1: 生成初版并标注**

```bash
cd /home/u1/workspaces/dashr/dashr/port
python3 - <<'EOF'
import re
rows = []
for f in ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml']:
    for m in re.finditer(r'^\s*-?\s*name:\s*([^\s#][^#]*?)\s*$', open(f).read(), re.M):
        v = m.group(1).strip().strip("'\"")
        if not v.startswith(('.', '/', '!!')):
            rows.append(v)
drop = {
  '@deepseek-ai/dsh-pwsh-sandbox': 'Windows-only; M1 targets linux-x64',
  '@deepseek-ai/dsh-tool-pwsh': 'Windows-only; M1 targets linux-x64',
  '@deepseek-ai/dsh-host-directory-picker-browse': 'absent from frozen universe; load errored in stage-1',
  '@deepseek-ai/dsh-api-terminal-controller': 'terminal feature out of M1 lean set; revisit M2',
}
seen = set()
with open('composition/dashr.cordis.yml', 'w') as out:
    out.write('# dashr composition — the distro-owned row ledger (spec §4 D).\n')
    out.write('# Every row: `# dashr: keep|drop <reason>`. Upstream tag merges conflict here on purpose.\n\n')
    for r in sorted(dict.fromkeys(rows)):
        if r in seen: continue
        seen.add(r)
        if r in drop:
            out.write(f'# dashr: drop {drop[r]}\n#- id: {r}\n#  name: {r}\n\n')
        else:
            out.write(f'# dashr: keep\n- id: {r}\n  name: {r}\n\n')
print('rows:', len(seen), 'dropped:', sum(1 for r in seen if r in drop))
EOF
```

- [ ] **Step 2: 人工复核 diff 要点**

`grep -c "^- id:" composition/dashr.cordis.yml` 应 ≈ 168 量级；`grep -B1 "^#- id:" composition/dashr.cordis.yml | grep drop | wc -l` = 4。config 行（如 session-title 的 config、sandbox 的 `disabled: !!js` 平台门）从上游 yml 手工搬进对应 keep 行——terminal/pwsh 相关 `!!js process.platform` 门随删行消失。

- [ ] **Step 3: Commit**

```bash
git add composition && git commit -m "port: dashr composition ledger (base ∪ web-app − 4 dropped rows)"
```

---

### Task 5: N1 registry 生成器 + 资产集结（port 核心工具）

**Files:**
- Create (port): `scripts/dashr/gen.ts`（进化自外层 `dashr/src/gen-bun-registry.ts`，输入改为 `composition/dashr.cordis.yml`）
- Create (port): `scripts/dashr/stage-assets.mjs`（资产集结：presets、badge、composition、web-dist、client halves、`dashr-assets.json` 清单）
- Create (port): `packages/boot/app-boot/bun-registry/.gitkeep`（生成物目录，生成物本身 gitignore）
- Modify (port): `.gitignore` 加 `packages/boot/app-boot/bun-registry/*.generated.*`
- Test (port): `scripts/dashr/gen.spec.ts`

**Interfaces:**
- Produces:
  - `gen.ts`：读组合 keep 行 → `found`（workspace 包遍历，skip `.node` 包与 better-dsh）∪ 子路径行（`/` 含子路径的行拆 base+sub，按 exports map 定位 entry；**并自动补每包 `./typert` 子路径**——exports map 有该子路径者）→ 写 `packages/boot/app-boot/bun-registry/bun-registry.generated.ts`（格式同 v1：`globalThis.__DSH_BUN_REGISTRY__ ??=` + `registryNames`）
  - `stage-assets.mjs <assetRoot>`：产出布局（编译 CWD=assetRoot，`--asset` 保持相对路径 → 运行时 `/$bunfs/root/<rel>`）：
    ```
    presets/                      ← packages/preset/agent-presets/presets
    assets/                       ← packages/skill/skill-badge/assets
    composition/dashr.cordis.yml  ← composition/
    web-dist/                     ← apps/web/dist
    client/<pkg-dir-name>/...     ← 每个含 client 半的包：其 lib/client.js + web/ + lib/client*（按包相对布局整拷 lib 内 client 相关文件）
    dashr-assets.json             ← {"version":1,"clientHalves":{"@deepseek-ai/dsh-foo":"/client/dsh-foo"},"dist":"/web-dist","composition":"/composition/dashr.cordis.yml"}
    ```
  - `DSH_BUN_REGISTRY_BUNDLES`/`EXTRA` env 语义废弃（组合即输入）

- [ ] **Step 1: 失败测试（gen.spec.ts 核心断言）**

```ts
// scripts/dashr/gen.spec.ts
import { describe, expect, it } from 'vitest'
import { extractRows, subpathEntry, clientHalves } from './gen.ts'

describe('composition row extraction', () => {
  it('keeps keep-rows, drops drop-rows', () => {
    const yml = '# dashr: drop x\n#- id: a\n#  name: @scope/a\n\n# dashr: keep\n- id: b\n  name: @scope/b\n'
    expect(extractRows(yml)).toEqual(['@scope/b'])
  })
  it('splits subpath rows', () => {
    expect(extractRows('- id: t\n  name: "@scope/pkg/tools"\n')).toEqual(['@scope/pkg/tools'])
  })
})
describe('asset manifest', () => {
  it('maps client halves package names to staged paths', () => {
    expect(clientHalves([{ name: '@deepseek-ai/dsh-client-ui-chat', dir: '/x/ui-chat' }]))
      .toEqual({ '@deepseek-ai/dsh-client-ui-chat': '/client/dsh-client-ui-chat' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run scripts/dashr/gen.spec.ts
# 期待 FAIL: Cannot find module './gen.ts'
```

- [ ] **Step 3: 实现 gen.ts**

以外层 `dashr/src/gen-bun-registry.ts` 为底稿（执行者先读该文件），改动：
1. `rowNames` 来源改为 `extractRows(readFileSync('composition/dashr.cordis.yml'))`
2. 追加 `./typert` 子路径：对每个 `found` 包，若其 package.json `exports` 含 `"./typert"`，加入行集（R3 的输入）
3. 导出 `extractRows`/`subpathEntry`/`clientHalves` 供测试
4. `OUT` 固定为 `packages/boot/app-boot/bun-registry/bun-registry.generated.ts`
5. 失败必须 loud：行集中存在 `found` 未命中且无磁盘实体 → 抛错并打印行名（spec R1 断言组合闭包）

`stage-assets.mjs` 实现要点（node，port 仓库根运行）：
```js
// 遍历 found 包：package.json 存在 "exports['./client']" → 该包有 client 半
// 拷贝 <pkg>/lib/client.js、<pkg>/lib 内 client* 同目录资产、<pkg>/web/（存在则）
// 到 <assetRoot>/client/<pkg 目录名>/，清单记录 name→'/client/<pkg 目录名>'
// 另拷 presets、assets、composition、apps/web/dist → web-dist；写 dashr-assets.json
```

- [ ] **Step 4: 跑测试确认过 + 生成物自检**

```bash
pnpm exec vitest run scripts/dashr/gen.spec.ts     # PASS
node_modules/.bin/tsx scripts/dashr/gen.ts          # 尾行打印 registry: N entries embedded（N ≈ 180+，含 typert 子路径）
node scripts/dashr/stage-assets.mjs /tmp/ar && cat /tmp/ar/dashr-assets.json | head -5
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "port: N1 composition-fed registry generator + asset staging (dashr-assets.json manifest)"
```

---

### Task 6: N2 loader 桥 M1（registry-only）

**Files:**
- Create (port): `packages/boot/app-boot/src/bun-internal-bridge.ts`
- Modify (port): `packages/boot/app-boot/src/index.ts`（boot 接线：`await ctx.plugin(Loader)` 后）
- Modify (port): `packages/boot/app-boot/package.json`（files 加 `bun-registry/`；node_modules 符号链接 `dsh-bun-registry-entries → ../bun-registry` 由 build 脚本建，不进 git）

**Interfaces:**
- Consumes: Task 5 的 `bun-registry.generated.ts`（经 `import('dsh-bun-registry-entries/bun-registry.generated')`）
- Produces: `initBunRegistry(): Promise<void>`、`createBunInternalImport(): { version:'v1'; loadCache: Map; register(): void; resolve(spec,parent?): {url}; resolveSync(spec,parent?): {url}; load(); import(name,baseUrl,opts) }`；M1 版 `import` **仅 registry 命中**，miss 即 throw（磁盘 walk 层删除；接口留 `import` 单入口，M2 在此函数内加层）

- [ ] **Step 1: 移植 + 瘦身**

以外层 `dashr/src/bun-internal-bridge.ts` 为底稿（执行者先通读），M1 改动：
1. 删除 `walkResolveEntry`/`bundleAndImport`/`bridgeChunkFile`/`BunBuild*` 整段（runtime-bundle 层）
2. `import(name, baseUrl)`: `const hit = registry()[name]; if (hit === undefined) throw new Error(\`dashr bridge M1: \${name} not in frozen registry\`); return hit`
3. 保留 `version:'v1'`、`resolveSync` 返回 `{url}`（client-modules 按 v1 形参序调用——已实证）、`loadCache` 空 Map
4. `DSH_BUN_ALIAS_TRACE` 调试日志保留

- [ ] **Step 2: boot 接线（app-boot/src/index.ts）**

`await ctx.plugin(Loader)` 之后：

```ts
if (process.env.DSH_BUN_COMPILED === '1') {
  // dashr port M1: Node internals are unreachable in /$bunfs; the bridge serves
  // ctx.loader.internal from the frozen registry. Asset root publishes before the
  // bridge import: the registry graph evaluates module-scope anchors on load.
  process.env.DSH_BUN_ASSET_ROOT ??= '/$bunfs/root'
  const { initBunRegistry, createBunInternalImport } = await import('./bun-internal-bridge.ts')
  await initBunRegistry()
  ctx.loader.internal = createBunInternalImport() as unknown as typeof ctx.loader.internal
}
```

- [ ] **Step 3: 构建验证 + registry 联动**

```bash
node_modules/.bin/tsx scripts/dashr/gen.ts
mkdir -p packages/boot/app-boot/node_modules
ln -sfn ../bun-registry packages/boot/app-boot/node_modules/dsh-bun-registry-entries
pnpm run build > /tmp/b.log 2>&1 && grep -c "registryNames" packages/boot/app-boot/lib/*.js | head -2
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "port: N2 registry-only loader bridge (M1; plugin tier reserved)"
```

---

### Task 7: R1/R2/R7 组合装载与 dist 根重写

**Files:**
- Modify (port): `packages/boot/app-boot/src/profile.ts`（`resolveBundleDir`/`loadProfileDirectory` 编译态分支）
- Modify (port): `packages/boot/app-boot/src/profile-resolution/resolver.ts`（internalModules 守卫——Task 3 同款 diff，从外层 seams patch 取 `resolver.ts` hunk 应用）
- Modify (port): `packages/bundle/web-app/src/index.ts`（`resolveDistIndex` 编译态默认 `/$bunfs/root/web-dist`，`DSH_WEB_FRONTEND_DIR` 降为覆盖）
- Create (port): `packages/boot/app-boot/src/dashr-composition.ts`（编译态组合装载：读 `${DSH_BUN_ASSET_ROOT}/composition/dashr.cordis.yml` + `dashr-assets.json`，供 profile 与 N3 消费）

**Interfaces:**
- Produces: `loadDashrComposition(): { layers: ProfileLayer[]; assets: DashrAssets }`（编译态）；非编译态走原 bundle 路径（port 仓库 node 运行/测试不破坏）

- [ ] **Step 1: dashr-composition.ts**

```ts
// packages/boot/app-boot/src/dashr-composition.ts
/** Compiled-mode composition: the embedded dashr layer replaces disk bundle resolution. */
export function dashrAssetRoot(): string | undefined {
  return process.env.DSH_BUN_COMPILED === '1' ? (process.env.DSH_BUN_ASSET_ROOT ?? '/$bunfs/root') : undefined
}
```

`loadProfileDirectory` 内、`bundles.map(...)` 前插分支：编译态时 `layers` 改为单层 `{ packageName: '@dashr/composition', packageDir: root, patchPath: root+'/composition/dashr.cordis.yml', patches: loadOverlayPatches(binName, patchPath) }`；`resolveBundleDir` 在编译态不再被调用（组合行模块装载走 N2 registry）。

- [ ] **Step 2: profile.ts/`loadProfileDirectory` 改动落位**

在 `const bundles = manifest.dsh?.profile?.bundles ?? []` 后：

```ts
const dashrRoot = dashrAssetRoot()
const layers = dashrRoot === undefined
  ? bundles.map((packageName): ProfileLayer => { /* 原实现原样保留 */ })
  : [{ packageName: '@dashr/composition', packageDir: dashrRoot, patchPath: join(dashrRoot, 'composition/dashr.cordis.yml'), patches: loadOverlayPatches(binName, join(dashrRoot, 'composition/dashr.cordis.yml')) }]
```

编译态 `dsh.profile.bundles` 不再要求（空数组即可 boot）。

- [ ] **Step 3: web-app dist 根**

`resolveDistIndex()` 首行（现有 env override 之前）：

```ts
const compiled = process.env.DSH_BUN_COMPILED === '1' ? (process.env.DSH_BUN_ASSET_ROOT ?? '/$bunfs/root') : undefined
if (compiled !== undefined) return join(compiled, 'web-dist', 'index.html')
```

- [ ] **Step 4: tsc + 现有测试面**

```bash
node_modules/.bin/tsc -b packages/boot/app-boot packages/bundle/web-app
pnpm exec vitest run packages/boot/app-boot 2>&1 | tail -3   # 原有测试全绿（非编译态路径未变）
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "port: R1/R2/R7 embedded composition layer + compiled dist root"
```

---

### Task 8: N3 client 资产伺服 seam

**Files:**
- Modify (port): `packages/client/modules/src/index.ts`（`locatePkgJson` 编译态分支）

**Interfaces:**
- Consumes: `dashr-assets.json`（Task 5 清单，经 `dashr-composition.ts` 暴露 `clientHalves: Record<name, stagedPath>`）
- Produces: client-half 定位不再走磁盘 node_modules walk；host-webserver 以 packageDir 相对读文件（`/$bunfs` fs 读取已实证可用）

- [ ] **Step 1: locatePkgJson 分支**

`private locatePkgJson(loaderName, baseUrl)` 首段（`internal === undefined` 判定之前）：

```ts
const halves = dashrClientHalves()   // dashr-composition.ts 导出：编译态读 dashr-assets.json.clientHalves，非编译态 undefined
if (halves !== undefined) {
  const staged = halves[loaderName]
  if (staged === undefined) return undefined
  return { path: `${dashrAssetRoot()}${staged}/package.json`, packageName: exactPackageSpecifier(loaderName) }
}
```

`dashr-composition.ts` 增补：`dashrClientHalves()`（模块级缓存读 `dashr-assets.json`；文件缺失返回 undefined——非编译态）。

- [ ] **Step 2: staged 目录补 package.json**

`stage-assets.mjs`（Task 5）对每个 client 包在 `<assetRoot>/client/<dir>/` 同步拷贝原 `package.json`（nearestPackage 上溯需要 manifest 存在）。补丁同 commit。

- [ ] **Step 3: 验证（node 侧单元 + 构建）**

```bash
node_modules/.bin/tsc -b packages/boot/app-boot packages/client/modules
pnpm run build > /tmp/b2.log 2>&1; echo $?
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "port: N3 client-half serving from staged assets (manifest-driven)"
```

---

### Task 9: R3 typert registry 覆盖

**Files:**
- Modify (port): `packages/typert/loader/src/index.ts`（`./typert` 装载走 internal.import）

**Interfaces:**
- Consumes: Task 5 已把 `./typert` 子路径行进 registry（键 `@deepseek-ai/<pkg>/typert`）
- Produces: typert 宿主不再从磁盘 import（zod 随编译器打入，磁盘 zod 消失）

- [ ] **Step 1: registry 分支**

`index.ts` 中 typert entry 解析处（`ctx.get('pluginPackages')`/`require.resolve` 一段，约 330-345 行）前插：

```ts
const dashrRoot = dashrAssetRoot()
if (dashrRoot !== undefined && this.ctx.loader.internal !== undefined) {
  return await this.ctx.loader.internal.import(`${pkgName}/typert`, this.ctx.loader.internal === undefined ? baseUrl : baseUrl) as TypertContributor
}
```

（以实际函数形态为准：执行者先读该文件 320-350 行确认函数签名与返回包装；目标是把"exports map → 磁盘 require.resolve"替换为"registry 子路径键 import"，zod 等 import 由编译器在 bundle 期解析进二进制。）

- [ ] **Step 2: 生成器联动验证**

```bash
node_modules/.bin/tsx scripts/dashr/gen.ts | tail -2   # entries 数较 Task 5 增（typert 子路径已含）
pnpm run build > /tmp/b3.log 2>&1; echo $?
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "port: R3 typert entries via registry subpaths (disk zod eliminated)"
```

---

### Task 10: 构建管线（一键出产物）

**Files:**
- Create (port): `scripts/dashr/build.sh`（外层 `dashr/src/build.sh` 进化：无 patch apply/restore——port 仓库即源；无 anchor——组合内嵌）
- Create (port): `scripts/dashr/package-npm.mjs`（把产物填进 `scripts/npm/`（自外层 `dashr/src/npm/` 迁入）的 umbrella+平台包骨架）

**Interfaces:**
- Produces: `dist/dashr-<version>-linux-x64`（单文件）+ `dist/npm/`（可 publish 的包目录）；version 取 port 仓库 `apps/cli/package.json`

- [ ] **Step 1: build.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
PORT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="${BUN:-/home/u1/workspaces/dashr/.scratch/bun-install/bin/bun}"
VER="$(node -p "require('$PORT/apps/cli/package.json').version")"
cd "$PORT"
echo "[dashr] 1/4 registry + build"
node_modules/.bin/tsx scripts/dashr/gen.ts | tail -1
mkdir -p packages/boot/app-boot/node_modules
ln -sfn ../bun-registry packages/boot/app-boot/node_modules/dsh-bun-registry-entries
pnpm run build > dist/.build.log 2>&1 || { tail -20 dist/.build.log; exit 1; }
echo "[dashr] 2/4 stage assets"
rm -rf dist/.assetroot && node scripts/dashr/stage-assets.mjs dist/.assetroot
echo "[dashr] 3/4 compile"
( cd dist/.assetroot && "$BUN" build --compile --target bun \
    $(printf -- '--asset ./%s ' presets assets composition web-dist client dashr-assets.json) \
    --outfile "$PORT/dist/dashr-$VER-linux-x64" "$PORT/apps/cli/lib/bin.js" ) > dist/.compile.log 2>&1 \
  || { tail -20 dist/.compile.log; exit 1; }
rm -rf dist/.assetroot
echo "[dashr] 4/4 $(du -h "dist/dashr-$VER-linux-x64" | cut -f1) -> dist/dashr-$VER-linux-x64"
```

- [ ] **Step 2: 首个产物冒烟（本机 loopback）**

```bash
bash scripts/dashr/build.sh
rm -rf /tmp/m1-home && mkdir -p /tmp/m1-home/profiles/web
printf '{"name":"web","private":true}\n' > /tmp/m1-home/profiles/web/package.json
DSH_BUN_COMPILED=1 DSH_HOME=/tmp/m1-home DSH_BUN_COMPILED_VERSION=$VER \
  dist/dashr-$VER-linux-x64 web --no-open --port 4991 2>&1 | grep -m1 token
```

期待：token URL 打印；`/tmp/m1-home` 内自动生成 profile 组合（编译态不依赖 bundles 声明）。杀掉进程。

- [ ] **Step 3: package-npm.mjs + Commit**

```bash
node scripts/dashr/package-npm.mjs dist/dashr-$VER-linux-x64   # 产出 dist/npm/{dashr,@dashr}/…
git add -A && git commit -m "port: one-shot build pipeline + npm packaging fill"
```

---

### Task 11: M1 验收 harness（spec §7 自动化）

**Files:**
- Create (port): `scripts/dashr/acceptance.sh`

**Interfaces:**
- Consumes: Task 10 产物；目标机 = dev2（ssh 别名 `dev2`，sudo -n 可用；DNS `dashr.dev2.internal.test` 与 caddy 站点已在）

- [ ] **Step 1: acceptance.sh**

```bash
#!/usr/bin/env bash
# M1 acceptance (spec §7). Usage: bash scripts/dashr/acceptance.sh <binary> 
set -euo pipefail
BIN="$(readlink -f "$1")"; VER="$(basename "$BIN" | sed 's/dashr-\(.*\)-linux-x64/\1/')"
H=/tmp/dashr-acc; rm -rf $H && mkdir -p $H/profiles/web && cp ~/.dsh/.env $H/.env 2>/dev/null || true
[ "$(find "$(dirname "$BIN")" -maxdepth 1 -type f | wc -l)" -le 2 ] || { echo "FAIL: artifact dir not single-file"; exit 1; }
DSH_BUN_COMPILED=1 DSH_HOME=$H "$BIN" web --no-open --port 4992 > $H/boot.log 2>&1 &
PID=$!; sleep 8
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' $H/boot.log | head -1 | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "FAIL: no token"; kill $PID; exit 1; }
CODE=$(curl -s -o /tmp/acc-shell -w '%{http_code}' -L "http://127.0.0.1:4992/?token=$TOKEN")
[ "$CODE" = 200 ] || { echo "FAIL: shell $CODE"; kill $PID; exit 1; }
grep -q "DSH Local Build" /tmp/acc-shell || { echo "FAIL: shell body"; kill $PID; exit 1; }
node "$(dirname "$BIN")/../../scripts/dashr/accept-chat.mjs" "http://127.0.0.1:4992/?token=$TOKEN" || { echo "FAIL: chat round"; kill $PID; exit 1; }
sleep 2; ls $H/sessions/*/*/session.v3.jsonl.zstd > /dev/null || { echo "FAIL: no persisted session"; kill $PID; exit 1; }
kill $PID; sleep 2
DSH_BUN_COMPILED=1 DSH_HOME=$H "$BIN" web --no-open --port 4992 >> $H/boot.log 2>&1 & PID2=$!; sleep 8
node "$(dirname "$BIN")/../../scripts/dashr/accept-chat.mjs" "http://127.0.0.1:4992/?token=$(grep -o 'token=[A-Za-z0-9_-]*' $H/boot.log | tail -1 | cut -d= -f2)" --resume-only || { echo "FAIL: session survival"; kill $PID2; exit 1; }
kill $PID2; echo "PASS: M1 acceptance"
```

配套 `accept-chat.mjs`：外层 `.scratch/bun-stage1/toast-catch.mjs` 迁入（DOM 采样断言 toasts 为空 + 回复文本出现；`--resume-only` 模式只断言会话列表非空）。

- [ ] **Step 2: 本机跑绿**

```bash
bash scripts/dashr/acceptance.sh dist/dashr-$VER-linux-x64   # 期待 PASS: M1 acceptance
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "port: M1 acceptance harness (single-file assert, chat round, persistence, restart survival)"
```

---

### Task 12: dev2 换装 + 外层仓收尾

**Files:**
- 外层仓 `dashr/`：删除 `dashr/src/`（fresh-start 账本：patch 系列退役；README 指向 port）
- dev2：`/opt/dashr` 整目录替换为单文件 + home

- [ ] **Step 1: dev2 换装**

```bash
scp dist/dashr-$VER-linux-x64 dev2:/tmp/ && ssh dev2 '
sudo systemctl stop dashr
sudo rm -rf /opt/dashr/tree /opt/dashr/anchor /opt/dashr/web-dist /opt/dashr/dashr-linux-x64
sudo mv /tmp/dashr-$VER-linux-x64 /opt/dashr/dashr-linux-x64 && sudo chmod +x /opt/dashr/dashr-linux-x64
# unit 改 env：去掉 DSH_INSTALL_ANCHOR / DSH_WEB_FRONTEND_DIR，DSH_HOME 保留
sudo sed -i "/DSH_INSTALL_ANCHOR/d; /DSH_WEB_FRONTEND_DIR/d" /etc/systemd/system/dashr.service
sudo systemctl daemon-reload && sudo systemctl start dashr
sleep 6 && systemctl is-active dashr && sudo journalctl -u dashr -n 3 --no-pager | grep -o "token=[A-Za-z0-9_-]*"'
```

- [ ] **Step 2: 域名验收（外网视角）**

```bash
curl -s -o /tmp/d2-shell -w "domain shell: %{http_code}\n" -c /tmp/d2-jar -L "https://dashr.dev2.internal.test/?token=<上一步 token>"
bash scripts/dashr/acceptance.sh 不适用（域名版）：node scripts/dashr/accept-chat.mjs "https://dashr.dev2.internal.test/?token=<token>"
ssh dev2 'ls /opt/dashr'   # 期待：dashr-linux-x64 与 home/ 而已
```

- [ ] **Step 3: 外层仓退役旧机制**

```bash
cd /home/u1/workspaces/dashr && git rm -rq dashr/src 2>/dev/null || rm -rf dashr/src
# dashr/README.md 的“构建体系（src/…）”节改指向 dashr/port（一段话：构建入口 port 仓库 scripts/dashr/build.sh）
git add -A && git commit -m "dashr: retire patch-series mechanism; port repo is the build source (spec §9)"
```

- [ ] **Step 4: 报告落盘**

`dashr/docs/specs/dashr-bun-port/m1-report.md`：验收输出全量粘贴（产物 sha256、体积、各断言结果、域名对话截图路径）。**发布三闸之二（报告）完成；publish 待 user 放行。**

---

## Self-Review

1. **Spec 覆盖**：§1 硬契约→T11/T12；§2 D1→T1、D2→T5/T10、D3→T4、D4→T6；§3 分法→T5；§4 N1→T5、N2→T6、N3→T8、R1/R2→T7、R3→T9、R4/R5/R6→T3、R7→T7、D→T4、S→T2、K→无需任务（不动）；§5→T10；§6→T1（remote 布置）+T4（账本冲突设计）；§7→T11；§8→T6 接口预留；§9→T12；§10 推迟项不在 M1。无缺口。
2. **占位扫描**：T9 Step1 有"以实际函数形态为准"的执行者自读指令——非占位（给了精确文件行号区间、替换目标与语义）；T5 Step3 的 stage-assets 实现给了布局与判定规则全文。无 TBD/TODO。
3. **类型一致性**：`DSH_BUN_ASSET_ROOT` 语义在 T3/T5/T6/T7/T8 一致（编译态由 boot 接线设为 `/$bunfs/root`）；`dashr-assets.json.clientHalves` 键=包名、值=staged 相对路径，T5 产、T8 消费；registry 键含子路径行，T5 产、T9 消费（`<pkg>/typert`）。
