# Machine Mesh P2 — Remote Gateways 实测报告

> 日期：2026-09-28 · 分支 `mesh-p1`（T1 `1b586fd` → T2 `302fe31`+R1 `ad52a06` → T3 `ddc6292` → T4 `4186cf2` → native-face 修复 `a9705f3`/`51cc5dd` → `0.1.6-e`）
> 形态：交付形态 pack 线（worktree 构建，共享主 home）；对端 = **dev3 生产 3080**（super-dsh 0.1.6-b，Caddy gate 已拆除）
> Spec：§6（RemoteGatewayFace/roster 联邦/降级）+ §3.2（a6 demux）；计划 `docs/superpowers/plans/2026-09-28-machine-mesh-p2.md`

## 脚本层探针（全部第一人称实测）

| # | 探针 | 结果 | 证据 |
|---|---|---|---|
| 1 | **roster 联邦** | ✅ | reprobe dev3 → `GET /api/agent-runtime` = **14 agents**：local 7 + `bfwu` 7（`Codex · dev3` 等，label 后缀 + machine=m4）——UI switch 将渲染 This machine + DEV3 两组 |
| 2 | **foreign 面 wire 往返** | ✅ | `POST /hub/api?agent=92tgxg`（dev3-codex a6）bogus envelope → **200 server-response 携 dev3 侧网关原生错误** `gateway/internal: invalid Remote endpoint "mesh.e2e.nonexistent"`——信封双跳（本机 hub → wire → dev3 /hub → codex world gateway → 回程）全通 |
| 3 | **native 面 URL 真相** | ✅ | 两轮修复：face 选择器（对端 native 行 → 对端 `/api` 面，非 foreign-only 的 /hub）+ endpoint-in-path（`POST /api/<endpoint>` raw、mux `/api/remote.mux`，上游 `endpointFromPath` 字节镜像，单测钉死） |
| 4 | **native 面可达性** | ✅ | 存量 cookie 直 GET `https://dsh.dev3.internal.test/api/agent-runtime` → dev3 roster JSON（jar 认证全通）；未声明端点 POST → 404 body `not found` = 上游设计内行为（拦截器只认已声明端点），链路无恙 |
| 5 | 浏览器会话面（switch → dev3 agent → 列会话/新建/收发） | ⏳ 交 user | 见下节验收清单 |

## 单元测试台账

全 suite 282/283 绿 + 1 已知预存失败（`spawn-world`：worktree seed home 缺 `.tests/profiles/ctx1-min`，主线同缺，与本线零耦合——多轮 stash/mutation 复核）。评审记录：T1 四裁决全受；T2 R1（ws error 监听崩溃修复）mutation 验证判别性；T3 双 demux wire 实证；T4 三披露项全核。

## 本轮 Rulings

1. **对端 native 行不跳过、给 face 选择器**——federate 原跳过条件查错字段（a6 vs key）本会漏注册死行；修为 native face（对端浏览器同款消费路径），7 行全真。
2. **endpoint-in-path raw 不编码**——实现者正确否决我指令里字面的 encodeURIComponent（上游服务端 segment pattern 不认编码字节，"字节级镜像"优先）。
3. **bogus-404 判读**——native 面未声明端点 404 是上游设计内行为，非缺陷；happy-path 会话流量属浏览器验收层。

## 浏览器验收清单（user）

1. switch 菜单出现 **DEV3 分节**（7 行：DSH/Claude/Codex/OMP/Pi/Hermes/Antigravity · dev3），local 组在前。
2. 点 `Codex · dev3` → 会话列表（dev3 侧 codex world 的会话）→ 新建 → 发一轮消息 → 流式回复（全走 wire：本机 `/hub?agent=<a6>` → dev3）。
3. 点 `DSH · dev3`（native 面）→ dev3 原生 DSH 的会话列表。
4. 断 dev3（如 `systemctl --user stop dsh.service` 于 dev3）→ 行降级（探针 unreachable → ready=false 保留），恢复后 reprobe 复活。

## 遗留

- 会话 create/prompt 的脚本级 E2E（真实 endpoint 词汇）未做——浏览器层覆盖；A2A/P3 将以 `new_conversation` 从我们自己的面发起，届时自然补上。
- T3 评审四 minor + T1/T2 parked 清单见 ledger，final review 统一分诊。
