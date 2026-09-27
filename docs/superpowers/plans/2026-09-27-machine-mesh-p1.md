# Machine Mesh P1（地基：注册表 + 配对 API + agent ID + roster 扩展）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 0.1.6 单 hub 装上 machine mesh 的地基：服务端机器注册表（持久化）、add-machine API（token mint + roster 探测 + 远端 ID 采纳）、本地 agent 的 a6 短 ID、roster 响应加性扩展，HubPage machines 区换接真 API。

**Architecture:** 全部落在 `superd-hub` host 半边的新模块（`machines.ts` 注册表、`mesh-link.ts` mint+probe、`mesh-rpc.ts` API 路由、`agent-ids.ts` ID 铸造），沿 roster.ts 的模块级注册表惯例；API 经 `ctx.connection.fetch` 注册（继承 browser-trust fence + 持久 auth，rpc.ts 同款）；roster 扩展为加性字段（`hub.machineId` + `agents[].id`），旧客户端零感知。

**Tech Stack:** TypeScript（superd-hub）、`@deepseek-ai/dsh-home-paths`（resolveDshHome）、Node 内建 fetch（mint/probe）、schemastery（Config）、node:test + node:http fixture。

**Spec:** `docs/specs/machine-mesh-a2a/spec.md`（§3 寻址与注册表、§4 信任模型、§6.2 roster 扩展）；ADR 0009。

## Global Constraints

- 上游源码零修改；一切改动在 `super-dsh/superd-hub`（+ client bundle 重建）。
- `@deepseek-ai` 单实例纪律：永不子包内 `npm install @deepseek-ai/*`；scope = `super-dsh/node_modules/@deepseek-ai`。
- 测试 home 一律 tmpdir 或 `.tests/…`，绝不触碰 `~/.dsh` / `~/.superd`；测试导入 `dist/`（先 `npm run build` 再 `node --test test/<file>.test.mjs`，在 `super-dsh/superd-hub` 目录下）。
- 构建/打包唯一入口 `node super-dsh/scripts/pack.mjs`；daemon 一律 `systemd-run --user`（rig = `super-dsh/test/start-4999.sh`）。
- 版本纪律：本 phase 开发期不 bump（字母后缀在 release 时定）。
- 持久化文件全部落 `<dshHome>/superd/`，`mode 0600`，原子写（tmp+rename）；token 永不出现在 GET 响应里。
- ID：machine 4 位 / agent 6 位，alphabet `[a-z0-9]`，crypto 随机；铸造时对已知名查重。
- 客户端半边类型检查走 `tsconfig.client.json`；bundle 纯度门禁照旧。

---

### Task 1: machines 注册表（self ID + remotes，持久化）

**Files:**
- Create: `super-dsh/superd-hub/src/machines.ts`
- Test: `super-dsh/superd-hub/test/machines.test.mjs`

**Interfaces:**
- Produces:
  - `interface MachineRow { id: string; name: string; label: string; origin: string; token?: string; enabled: boolean; addedAt: number }`
  - `interface MachinesFile { self: { id: string; label: string }; remotes: MachineRow[] }`
  - `mintShortId(len: 4 | 6, taken: Iterable<string>): string` — crypto 随机、查重重铸（上限 32 次后 throw）。
  - `loadMachines(home: string): MachinesFile` — 文件缺失/损坏 → `{self: {id: '', label: ''}, remotes: []}`（self.id 空 = 未铸，调用方经 `ensureSelf(home, fallbackLabel)` 补铸）。
  - `ensureSelf(home: string, fallbackLabel: string): { id: string; label: string }` — 惰性铸造 + 持久化。
  - `saveMachines(home: string, file: MachinesFile): void` — 原子写 + chmod 0600。
  - `upsertRemote(home: string, row: MachineRow): void` / `removeRemote(home: string, id: string): boolean` / `listRemotes(home: string): MachineRow[]`（读-改-写全量持久化；进程内无缓存，P1 规模足够）。

- [ ] **Step 1: 写失败测试**（test/machines.test.mjs）

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintShortId, ensureSelf, upsertRemote, removeRemote, listRemotes, loadMachines } from '../dist/machines.js'

const home = () => mkdtempSync(join(tmpdir(), 'superd-machines-'))

test('mintShortId: 长度、字符集、查重重铸', () => {
  const taken = new Set(['ab12'])
  const id = mintShortId(4, taken)
  assert.match(id, /^[a-z0-9]{4}$/)
  assert.notEqual(id, 'ab12')
  const a6 = mintShortId(6, [])
  assert.match(a6, /^[a-z0-9]{6}$/)
})

test('ensureSelf: 惰性铸造 + 持久 + 幂等', () => {
  const h = home()
  try {
    const first = ensureSelf(h, 'pc')
    assert.match(first.id, /^[a-z0-9]{4}$/)
    assert.equal(first.label, 'pc')
    const again = ensureSelf(h, 'changed')  // 已铸：不重铸不改 label
    assert.equal(again.id, first.id)
    assert.equal(again.label, 'pc')
    const raw = JSON.parse(readFileSync(join(h, 'superd', 'machines.json'), 'utf8'))
    assert.equal(raw.self.id, first.id)
    const mode = statSync(join(h, 'superd', 'machines.json')).mode & 0o777
    assert.equal(mode, 0o600)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('remotes CRUD 全量持久化；损坏文件降级为空', () => {
  const h = home()
  try {
    upsertRemote(h, { id: 'k3f9', name: 'dev3', label: 'DEV3', origin: 'http://192.0.2.3:4999', token: 'x', enabled: true, addedAt: 1 })
    assert.equal(listRemotes(h).length, 1)
    upsertRemote(h, { id: 'k3f9', name: 'dev3', label: 'DEV3b', origin: 'http://192.0.2.3:4999', enabled: true, addedAt: 1 }) // 同 id 覆盖
    assert.equal(listRemotes(h)[0].label, 'DEV3b')
    assert.equal(removeRemote(h, 'k3f9'), true)
    assert.equal(removeRemote(h, 'k3f9'), false)
    assert.deepEqual(listRemotes(h), [])
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('loadMachines: 缺失与损坏都降级', () => {
  const h = home()
  try {
    assert.deepEqual(loadMachines(h), { self: { id: '', label: '' }, remotes: [] })
  } finally { rmSync(h, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**（`node --test test/machines.test.mjs` → module not found）
- [ ] **Step 3: 实现 machines.ts**（要点：`randomInt` from `node:crypto`；`mkdirSync(dir, {recursive:true})` + `writeFileSync(tmp)` + `renameSync` + `chmodSync(0o600)`；写入前 JSON 校验——id/origin/name 必填字符串）
- [ ] **Step 4: 测试转绿 + `npm run build` 全绿**
- [ ] **Step 5: Commit**（`hub: machine registry store (self id + remotes, persisted)`）

### Task 2: mint + probe（mesh-link.ts，远端连接管理）

**Files:**
- Create: `super-dsh/superd-hub/src/mesh-link.ts`
- Test: `super-dsh/superd-hub/test/mesh-link.test.mjs`

**Interfaces:**
- Consumes: `loadMachines/saveMachines/upsertRemote/listRemotes`（Task 1）。
- Produces:
  - `parseTokenUrl(tokenUrl: string): { origin: string; token: string }` — 校验 `?token=` 存在、origin 是 http(s)，否则 throw `Error('invalid token url …')`。
  - `async mintCookie(origin: string, token: string, fetchImpl?): Promise<string>` — `GET <origin>/?token=<t>`，`redirect: 'manual'`，读 `set-cookie` 里的 `dsh-auth-*` 返回 cookie 串；非 303/2xx 或无 cookie → throw（附状态码）。
  - `interface ProbeResult { ok: true; machineId: string; version?: string; agents: Array<{ id: string; key: string; label: string; ready: boolean; failed: boolean }> } | { ok: false; status: 'unreachable' | 'auth-expired'; error: string }`
  - `async probeMachine(origin: string, cookie: string, fetchImpl?): Promise<ProbeResult>` — `GET <origin>/api/agent-runtime`，Cookie 随行；401 → `auth-expired`；网络错误 → `unreachable`；200 解析 `hub.machineId` + `agents[]`（缺 `hub.machineId` 视为非 super-dsh 0.1.6+ 对端 → `{ok:false, status:'unreachable', error:'peer roster has no hub block'}`）。
  - `interface PairOutcome { machineId: string; row: MachineRow; probe: ProbeResult }`
  - `async pairMachine(home: string, input: { name: string; label?: string; tokenUrl: string }, deps?): Promise<PairOutcome>` — 编排：parseTokenUrl → mintCookie → probeMachine → 校验 machineId 不与 self/既有 remotes 碰撞（碰撞 throw `duplicate-machine-id`）→ upsertRemote（token 存行）→ 返回。
  - `async reprobeMachine(home: string, id: string, deps?): Promise<ProbeResult>` — 取行 → 用存量 cookie 探测；`auth-expired` 时若行内有 token 自动重铸一次再探，成功则回写新 cookie。
  - `deps?: { fetchImpl?: typeof fetch; load?: typeof loadMachines; save?: typeof saveMachines }` — 测试注入口。

- [ ] **Step 1: 写失败测试**（node:http 起真 fixture：mint 303 + Set-Cookie、roster 200 JSON、401 分支）

```js
// fixture：一个"远端 hub"——GET /?token=ok → 303 + set-cookie dsh-auth-x；
// GET /api/agent-runtime 带 cookie → 200 {hub:{machineId:'k3f9',version:'0.1.6'}, agents:[...]}；无/错 cookie → 401
import { createServer } from 'node:http'
// …启动于 127.0.0.1:0，取 port 拼 origin …

test('parseTokenUrl 校验与提取', () => { /* http://h:1/?token=abc → {origin:'http://h:1', token:'abc'}；无 token → throw */ })
test('mintCookie 拿到 dsh-auth cookie', async () => { /* assert cookie 含 'dsh-auth-' */ })
test('probeMachine：200 → ok + agents；401 → auth-expired；拒连 → unreachable', async () => { /* 三分支 */ })
test('pairMachine 全链：mint→probe→持久化→采纳 k3f9；重复 id 碰撞 throw', async () => { /* home=tmpdir；pair 两次同 id → 第二次 duplicate-machine-id */ })
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（fetch 默认用 globalThis.fetch；cookie 解析只取第一个 `dsh-auth-*` name=value 对；超时 AbortSignal 10s）→ **Step 4: 转绿 + build** → **Step 5: Commit**（`hub: mesh link — token mint, roster probe, pairing`）

### Task 3: add-machine API 路由（mesh-rpc.ts）

**Files:**
- Create: `super-dsh/superd-hub/src/mesh-rpc.ts`
- Modify: `super-dsh/superd-hub/src/gateway.ts`（apply 里 `registerMeshRpc(ctx)`，rpc.ts 同款 inject(['connection'])）
- Modify: `super-dsh/superd-hub/src/index.ts`（export mesh-rpc 面）
- Test: `super-dsh/superd-hub/test/mesh-rpc.test.mjs`

**Interfaces:**
- Consumes: Task 1/2 全部；rpc.ts 的 `ConnectionFetchFace` 注册形状。
- Produces:
  - `MESH_API_BASE = '/api/superd/machines'`
  - `async function handleMeshMachines(request: Request, deps: MeshDeps): Promise<Response>`——
    - `GET /api/superd/machines` → `{self: {id, label}, machines: [{id,name,label,origin,enabled,addedAt, status, lastProbeAt?, error?}]}`（**永不含 token**；status 由探测缓存供，P1 由 pair/reprobe 时写入的内存表 `machineStatus()` 提供，缺省 `'pending'`）。
    - `POST /api/superd/machines` body `{name, label?, tokenUrl}` → pairMachine → 201 + 行；失败 → 400 `{error}`。
    - `DELETE /api/superd/machines?id=<m4>` → `{removed: true|false}`。
    - `POST /api/superd/machines/reprobe` body `{id}` → `{probe: ProbeResult}`（更新 status 表）。
  - `registerMeshRpc(ctx: Context, deps: MeshDeps): void` — `connection.fetch.register({path: MESH_API_BASE, methods:['GET','POST','DELETE'], requestBody:'buffered', fetch})`（path 精确匹配 + body 路由，沿 rpc.ts 模式；reprobe 走 POST + body 分派）。
  - `machineStatus(): Map<string, {status: string; lastProbeAt: number; error?: string}>`（模块级，pair/reprobe 写）。

- [ ] **Step 1: 失败测试**：fake `ConnectionFetchFace`（rpc.test.mjs 同款 fake ctx 注入法）——POST 好 tokenUrl（fetchImpl 指向 fixture）→ 201 且持久化出现该行；GET 无 token 字段断言；DELETE 生效；POST 坏 URL → 400。
- [ ] **Step 2-5**: 确认失败 → 实现 → 转绿+build → Commit（`hub: add-machine API (pair/reprobe/list/remove) behind connection.fetch`）。

### Task 4: agent a6 ID + roster 加性扩展

**Files:**
- Create: `super-dsh/superd-hub/src/agent-ids.ts`
- Modify: `super-dsh/superd-hub/src/agent-roster.ts`（AgentLink += `id: string`；agentLinks 填 a6；NATIVE 同样有 id）
- Modify: `super-dsh/superd-hub/src/rpc.ts`（GET 应答 += `hub: {machineId, version}`；version 取 superd-hub 自身 package.json）
- Test: 扩 `test/roster.test.mjs`、`test/rpc.test.mjs`；新建 `test/agent-ids.test.mjs`

**Interfaces:**
- Produces（agent-ids.ts）:
  - `ensureAgentId(home: string, label: string): string` — 惰性铸造（6 位，对映射内已用 id 查重）+ 原子持久化 `<dshHome>/superd/agent-ids.json`（0600）；幂等。
  - `agentIdMap(home: string): Record<string, string>`
- agentLinks 依赖 `ensureAgentId`（home 由 gateway.ts apply 时注入一次的模块级 `setMeshHome(home)` 或直接每调 `resolveDshHome()`——**选后者**，与 world-join 同源，零新状态）。
- rpc.ts：`hub` 块 = `ensureSelf(resolveDshHome(), hostname fallback 'local')` + version。**注意**：测试 env 的 `DSH_HOME=~/.dsh` prod 值陷阱（§二环境坑）——rpc 测试注入 fake source 的同时注入 fake home/label。

- [ ] **Step 1: 失败测试**：agent-ids 铸造/幂等/查重/0600；agentLinks 每行带 `id` 且 NATIVE 有 id；rpc GET 应答含 `hub.machineId`（fake home tmpdir）且 `agents[].id` 在场——同时断言旧字段 `available` 原样（加性证明）。
- [ ] **Step 2-5**: 失败 → 实现 → 转绿+build → Commit（`hub: agent short ids + additive hub block on the roster face`）。

### Task 5: HubPage machines 区接真 API

**Files:**
- Create: `super-dsh/superd-hub/src/client/mesh-api.ts`（纯逻辑：类型 + fetch 包装 + 行视图模型）
- Modify: `super-dsh/superd-hub/src/client/HubPage.tsx`（machines 区数据源换 `mesh-api`；add 表单 POST；remove DELETE；status 点色）
- Delete: `super-dsh/superd-hub/src/client/machines-store.ts`（localStorage 层退役；类型并入 mesh-api）
- Test: 新建 `test/client-mesh-view.test.mjs`（纯函数部分：响应→行视图 coercion、token URL 预校验）

**Interfaces:**
- Produces（mesh-api.ts）:
  - `interface MeshMachineView { id: string; name: string; label: string; origin: string; status: 'pending'|'reachable'|'unreachable'|'auth-expired'; lastProbeAt?: number; self: boolean }`
  - `coerceMachineList(raw: unknown): { self?: { id: string; label: string }; machines: MeshMachineView[] }`（坏数据降级空表，UI 不崩）
  - `async fetchMachines(): Promise<…>` / `async addMachine(input: {name; label?; tokenUrl}): Promise<void>`（非 2xx throw Error(body.error)）/ `async removeMachine(id)` / `async reprobeMachine(id)`
  - `validTokenUrl(input: string): boolean`（提交前本地预校验）
- HubPage：`useEffect` 初载 + 操作后刷新；self 行由 API 的 `self` 块渲染（origin 显示 `location.origin`）；add 表单加一个 token URL 字段（现有 Name/URL 两字段改为 Name + Token URL——URL 从 token URL 解析，不再单填）。

- [ ] **Step 1: 失败测试**（coercion：完整/缺字段/坏类型/空 → 行为；validTokenUrl 正反例）
- [ ] **Step 2-5**: 失败 → 实现（client bundle 重建 + purity gate 过）→ `npm run build` 全绿 → Commit（`hub client: machines panel on the real add-machine API`）。

### Task 6: 自环 rig 冒烟 + 报告

**Files:**
- Modify: `super-dsh/test/README.md`（mesh 自环步骤）
- Create: `docs/test-reports/2026-09-27-machine-mesh-p1.md`

- [ ] **Step 1**: `bash super-dsh/test/start-4999.sh` 起 pack 线（499x 口按 ss 预检动态）。
- [ ] **Step 2**: 自环配对——取本实例 token URL，`curl -b jar -c jar` 走浏览器 cookie 流程后：
  `curl -b jar -X POST <origin>/api/superd/machines -d '{"name":"self-loop","tokenUrl":"<origin>/?token=<t>"}'` → 201；
  `GET /api/superd/machines` → self-loop reachable + agents 采纳（含 a6）；
  `GET /api/agent-runtime` → `hub.machineId` 在场、`agents[].id` 在场、旧字段不变。
- [ ] **Step 3**: 浏览器面：HubPage machines 区显示 self-loop 行（reachable），删除生效。
- [ ] **Step 4**: `systemctl --user stop superd-<port>-test`；**保持运行交 user 亲测后再收尾**（§三验收模式）。
- [ ] **Step 5**: 报告落盘 + Commit（`docs: machine-mesh P1 rig report`）。

## Self-Review

- Spec coverage：spec §3.1（ID 铸造/传播=Task 1/2/4）、§3.3（持久化=1/4）、§4（mint/重铸/auth-expired=2）、§6.2（roster 扩展=4）、§6.3（探测/降级=status 表=2/3，周期兜底与 switch 联动留 P2——spec P1 行未含，✓）、HubPage 接线（=5）、自环验收（=6）。P1 范围外（RemoteGatewayFace/roster 联邦/A2A/exec）属 P2-P4，无遗漏。
- Placeholder 扫描：无 TBD/裸"适当处理"；Task 2/3 测试代码给了结构与断言要点（fixture 骨架完整、逐断言列明）。
- 类型一致性：`MachineRow`/`ProbeResult`/`PairOutcome`/`MeshMachineView` 各 Task 间引用一致；`deps.fetchImpl` 注入统一。
