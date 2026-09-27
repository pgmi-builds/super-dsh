# Machine Mesh P2（Remote Gateways：远端 agent 进原生 UI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 配对的远端机器上的 agent 运行时出现在本机原生 UI 的 switch/roster 里，可以像本地 agent 一样点开、列会话、新建、收发——数据面经 RemoteGatewayFace（envelope POST + mux WS）转发到远端 `/hub` 家族。

**Architecture:** 复用 0.1.6 的 `/hub?agent=<key>` demux 与 carrier 转发内核，零新路由：远端 agent 在**本机 gateway 注册表**里注册为一个 wire 形态 GatewayFace（`targets.ts` 既定预言的实现），key = 远端 a6；probe 采纳时登记、机器移除/不可达时注销/降级。浏览器侧零机制新增——switch 按 `agents[].machine` 分组渲染即可。

**Tech Stack:** superd-hub TypeScript、`ws`（既有 dep）、node:test + node:http/ws fixture。

**Spec:** `docs/specs/machine-mesh-a2a/spec.md` §6（6.1 RemoteGatewayFace、6.2 roster 扩展、6.3 健康与降级）+ §3.2 寻址（a6 demux、label 别名）。

## Global Constraints

- 上游源码零修改；改动只在 `super-dsh/superd-hub`（+ client 半边 + 交付 bundle）。
- 既有纪律全部沿用：单实例 farm、`.tests` 共享 home（worktree symlink 已就位）、build 先于 test、字母版本迭代、交付形态验收（rig + dev3）。
- mux 帧协议以 `src/world-mux.ts` 头注为规范（client 半边）：client→server `open/item/end/cancel`，server→client `item/end/error`，心跳 2s 两次丢包 terminate；迟到帧丢弃；重复 open → 1008。
- envelope 形状以 `src/envelope.ts` 为准，逐字节透传零翻译。
- cookie 沿 mesh-link 的 per-machine jar（row.cookie 持久化）；401 → auth-expired 降级（机器级），单请求 fail-loud。

---

### Task 1: MuxClient（mux 协议 client 半边）

**Files:**
- Create: `super-dsh/superd-hub/src/mux-client.ts`
- Test: `super-dsh/superd-hub/test/mux-client.test.mjs`

**Interfaces:**
- Produces:
  - `type MuxClientFrame = {type:'open',streamId:number,endpoint:string,payload:unknown} | {type:'item',streamId:number,value?:unknown} | {type:'end',streamId:number} | {type:'cancel',streamId:number}`（client→server 全集）
  - `class MuxClient` — 构造注入 `socket: {send(data:string):void; onMessage(cb:(data:string)=>void):void; onClose(cb:()=>void):void; close():void}`（纯协议，无 ws import；ws 装配在 Task 2）：
    - `openStream(endpoint: string, payload: unknown): {items: AsyncIterable<unknown>; upstream: AsyncIterable<unknown>; end():void; cancel():void}`——`items` 在 `error`/`end`/socket 关闭时结束（error 以 `{muxError}` 尾项或 AsyncIterable 抛出均可，测试钉死一种）
    - 协议心跳：收到 server `ping` 帧（JSON `{type:'ping'}`）立即回 `{type:'pong'}`；2 个 ping 周期未收到任何帧 → 主动 close 全流终止
    - 迟到帧（已 end/error 的 streamId）静默丢弃；重复 open（同 streamId 复用中）→ close socket（对齐 server 1008 语义）
    - uplink 背压：upstream iterable 的 item 读取即发送（无积压缓冲，读多少发多少）
    - `dispose(): void` — 关全部流 + socket
- 测试用 fake socket（数组驱动 + 事件捕获）钉：open→items 流、uplink item/end 半关闭、server end/error 收尾、迟到帧丢弃、ping→pong、双 ping 丢失→close、重复 open→close、dispose 幂等。

### Task 2: RemoteGatewayFace（wire 形态 gateway）

**Files:**
- Create: `super-dsh/superd-hub/src/mesh-gateway.ts`
- Test: `super-dsh/superd-hub/test/mesh-gateway.test.mjs`

**Interfaces:**
- Consumes: Task 1 `MuxClient`（协议核）；`envelope.ts` 的 `parseClientRequest/serverResult/serverError`；machines/mesh-link 的 row（origin/cookie）。
- Produces:
  - `createRemoteGateway(opts: {origin: string; agentKey: string; cookie: () => string; fetchImpl?: typeof fetch; wsFactory?: (url: string, headers: Record<string,string>) => MuxClientSocket}): GatewayFace`——
    - `dispatchRpc(endpoint, payload, signal)`：`POST <origin>/hub/api?agent=<agentKey>`，body = 标准 client-request envelope（rpcId 自增），Cookie 头 = `cookie()`；应答 envelope 的 `result` 原样返回；非 200/坏 envelope → throw `{code:'gateway/unreachable'|'gateway/bad-response', message}`
    - `openWireStream(endpoint, payload, signal)`：经 per-(origin,agentKey) 复用的 ws 连接（懒建立，idle 30s 关闭，断线重建）开一条 mux 流；`uplink` 桥接进 `upstream`；错误帧映射为流终止
    - canonical 参数序契约（carrier 教训）：面向 carrier 的适配签名保持 `(endpoint, payload, signal)`（GatewayFace 面），内部再补 control/signal
  - ws 装配：`defaultWsFactory` 用 `ws` 包连 `<origin>/hub/api/remote.mux?agent=<key>`（origin https→wss），Cookie 头随 upgrade。
- fixture：node:http + `ws` 起一个最小 server（收 envelope POST → 回 server-result JSON；收 mux upgrade → 按协议回 item/end）；测试钉：dispatchRpc 透传往返、envelope 字节保真（payload 含 unicode/嵌套）、401 → auth-expired 错误码、mux 流式往返、断线后下一次调用重建连接。

### Task 3: 联邦注册（远端 agent 进 gateway/roster 注册表）

**Files:**
- Create: `super-dsh/superd-hub/src/mesh-federate.ts`
- Modify: `super-dsh/superd-hub/src/roster.ts`（RosterEntry += `machine?: string`（缺省 local）——加性）、`super-dsh/superd-hub/src/agent-roster.ts`（agentLinks 以 entry.machine 填行）、`super-d-sh/superd-hub/src/hub-route.ts` 的 gatewayOf 提供方（`src/index.ts` 挂 hub route 处：lookup 顺序 = 现有本地解析 → mesh 联邦表）、`mesh-link.ts`（pair/reprobe 成功/失败、remove 时发 federation 回调）、`mesh-rpc.ts`（DELETE/失效时触发注销）
- Test: `test/mesh-federate.test.mjs` + 扩 `roster.test.mjs`/`rpc.test.mjs`

**Interfaces:**
- Produces:
  - `federateAgents(machine: {id, name}, agents: Array<{id, key, label, ready, failed}>, gatewayOf: (a6) => GatewayFace): void`——为每个远端 agent：`registerForeignTarget({key: a6, gateway})` + roster 行 `{key: a6, label: '<Label> · <name>', machine: m4, ready, failed}`（roster.registerAgent 对 duplicate key throw → federate 先 unregister 再 register，幂等替换）
  - `defederateMachine(m4): void`——逐个 unregister
  - `defederateStaleMachine(m4, liveA6s: Set<string>): void`——远端 roster 收敛（消失的 agent 注销）
  - 本地 demux 兼容：hub-route 的 gatewayOf 查找 = 本地 targets/hostMounts → 联邦表；`?agent=<a6>` 与本地 label 别名并存（a6 优先精确匹配）
  - roster 响应/AgentLink：agents[].machine = m4（local 行维持 'local'）；排序 native → local → 远端按机器名
- 测试钉：pair 成功 → 联邦注册（targets + roster 均可见 a6 行）、reprobe roster 变化 → stale 注销、machine DELETE → 全注销、probe unreachable → roster 行 ready=false + failed=false 且保留（orchestra 降级语义）、本地 label 与 a6 双 demux 命中同一 gateway。

### Task 4: client roster/switch 机器分组

**Files:**
- Modify: `super-dsh/superd-hub/src/client/roster.ts`（AgentLink += `machine?: string`，coercion 透传）、`RuntimeSeat.tsx`/`HubPanelIcon.tsx`/`HubPage.tsx`（菜单按 machine 分组：native+local 一组「This machine」，远端按 machine label 分节）
- Test: 扩 `test/client-switch.test.mjs`（纯分组函数 `groupByMachine(agents)`）

**Interfaces:**
- Produces: `groupByMachine(links: AgentLink[]): Array<{machine: string; label: string; agents: AgentLink[]}>`（local 组首、远端组按 label 排序、machine 缺失归 local）；三个 UI 面全部经它渲染；不改变点击/切换逻辑（仍是 setAgent(label)）。

### Task 5: rig + dev3 E2E（交付形态验收）

**Files:**
- Create: `docs/test-reports/2026-09-28-machine-mesh-p2.md`
- 交付链：版本字母推进 → `start-4999.sh` 重建 → 自环双实例（4996 mesh-remote）验证 `?agent=<a6>` 会话面 → dev3 实机：roster 出现 7 个远端 agent（分组 DEV3）、switch 点开 dev3-codex、会话列表/新建/一轮收发全走 wire、UI 截图性描述落报告 → 保持运行交 user 亲测。

## Self-Review

- Spec 覆盖：§6.1（T1/T2）、§6.3 降级（T3）、§3.2 demux（T3）、roster machine 维度（T3/T4）、E2E（T5）。§6.2 已在 P1 交付。
- 无占位符；帧协议/envelope 引用既有正本文件；类型在任务间一致（GatewayFace/MuxClientSocket/a6 键）。
