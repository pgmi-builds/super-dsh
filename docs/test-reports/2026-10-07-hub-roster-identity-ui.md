# Hub roster 统一标识 / 图标资产包 / token URL / machines 行 UI 清理（2026-10-07）

- 线：**主线** `/home/u1/workspaces/superd`（分支 `master`，工作树未提交——待 user 验收）
- 触发：user 2026-10-07 四部分指令（remote runtime 图标匹配 + 包名统一标识 / 图标资产包 / local token URL copy 入口 / UI 清理四则）
- 形态：**交付形态验收**（pack 线）——`node super-dsh/scripts/pack.mjs` → tarball → 全新 home `.tests/superd-4993`（端口 4993；4999 是 user 在役 GUI 会话，本轮不动）→ 两台实例（4993 + 4994 模拟 remote dev3）真配对
- 结论：**四部分全部成立**，`superd-hub` 555/555 单测绿，整包线探针全绿（shell 200 / roster runtimeId / 联邦行 / tokenUrl mint / world failed 0）。

---

## 一、统一标识 runtimeId = adapter 包名（Part 1.1）

- 约定落点：`superd-hub/src/roster.ts` 新增纯函数 **`runtimeIdOf(key)`**——`native` → `native`，否则 `` `agent-${key}` ``。九条 adapter 线的 roster key 与包名后缀全部同构（`omp`↔`agent-omp` … `codex-sdk`↔`agent-codex-sdk`），一个派生点即共同约定，adapter 零改动（S2「roster = 插件加载态投影」不变）。
- 全链路携带：`RosterEntry.runtimeId?`（registration 可选）→ `AgentLink.runtimeId`（`/api/agent-runtime` 每行必带）→ `ProbeAgent.runtimeId?`（hub 间 probe 载荷）→ federation desired 行 materialize。**旧 peer 兼容**只在 mesh-federate parse 边界：wire 缺 runtimeId 时由 runtime key 归一；**本地行**由 key 派生。
- 实测：4993→4994 配对后，4993 的 roster 联邦行全部携带 `native` / `agent-agy` / `agent-claude` / `agent-codex` / `agent-hermes` / `agent-omp` / `agent-pi`（m=a7ui）。

## 二、图标资产包（Part 1.2）

- 新目录 **`superd-hub/assets/icons/`**（43 资产 + `manifest.json` + `README.md`）：
  - **ORCA（stablyai/orca `src/shared/agent-icons/` @ `c8dcffc`）38 枚 PNG 全量采集**（保持 ORCA 原名便于整目录再同步）；既有 inline 的 hermes/agy 与该集合 **byte-identical**（已 cmp 验证），证实出处即 ORCA；
  - `claude/codex/omp/pi.svg` 自既有 inline base64 落盘（omp/pi 与 ORCA `agent-icon-glyphs.tsx` 内联手稿同源；claude/codex 为早期采集，出处未记录——README 如实标注）；
  - `dsh-fish.svg` = 本线自绘 FishLogo 几何（非 ORCA 资产）。
- `manifest.json`：`runtimeId → {file}` **多对一映射**——`agent-omp`+`agent-omp-sdk` → `omp.svg`，codex/agy 两对 SDK 同理（「OMP 与 OMP-SDK 同一图标」）；`tiles` 声明深底衬底（codex 白 / pi 黑）。
- 生成器 `scripts/build-icon-assets.mjs`（`npm run build-client` 前置）：只内联 manifest 引用到的 10 个 ID → `src/client/icon-assets.gen.ts`（生成物 commit；bundle 不背未映射资产）。整包 npm files 增加 `superd-hub/assets`（tarball 实测 47 个 asset 条目）。
- 渲染层 `runtime-icons.tsx` 重写：`RuntimeMark({runtimeId?, agentKey?, size})` 按 runtimeId 查表，查无 → subagent fallback（**remote 带来本地没有的 adapter 时自动回退**）；native 按资产固有宽高比渲染 fish。侧栏 selector 的 active mark 经 roster 行解析 runtimeId——修复了「active federated 行一直是 generic 图标」的既有缺陷。
- 测试：新增 `test/client-icon-pack.test.mjs`（manifest 覆盖 9 adapter + native、文件存在、生成物与 manifest 一致、SDK 共用 mark、ORCA 全量在库且未映射）。

## 三、Local machine token URL（Part 2）

- **机制核实（修正了选项 ② 的前提）**：launch token **不是** seed 派生——`.credentials.yaml` 的 `client-connection/browser-session` grant 只是 cookie HMAC 签名密钥；token 是进程启动 `randomBytes(32)` 的内存值（upstream `browser-auth.ts` `processLaunchToken`）。自制 token 进不了 `authorizeIndex` 的精确匹配。
- 正确入口 = connection service 公共方法 **`authenticatedUrl(baseUrl)`**（upstream `rpc.ts:237`）：把进程现役 token 附到给定 origin。`registerMeshRpc` 经既有 `ctx.inject(['connection'])` 取该 face（`.bind(connection)` 保 receiver——真实现读 `this.launchToken`，有测试钉住），零 log 抓取、零自制 token、零上游修改。
- API：`POST /api/superd/machines` `{op:'tokenUrl', origin}` → `{tokenUrl}`；`parsePairingOrigin` 校验（绝对 http(s)、裸 origin、无 credentials）；face 缺方法 → 明确 400。GET 投影仍永不带 token。实测 mint 返回值与 launcher 打印的 boot token **逐字节一致**。
- UI：self 行新增 copy 图标按钮（`IconCopyOutlineRegular`）→ `fetchPairingUrl(location.origin)` → primitives `writeClipboard` → toast「Pairing URL copied — paste it into Add machine on the other machine」。配对语义注记：当前实现 add 是**单向登记**（两侧各持对方 token URL 各加一次即对称 P2P；copy 按钮正是给对侧用的）——若要「加了对方就自动双向」需再设计反向配对调用，本轮未做，待裁决。

## 四、UI 清理（Part 3）

1. **后缀**：`mesh-federate.federateAgents` 不再拼 `· <machineName>`；remote label = peer 原名（Hub 页行、侧栏菜单、切换 title 同步变净）。收敛机制按新 label 幂等重登记一次（升级即净）。
2. **大写中间态（DEV3）**：确认代码依赖仅展示/分组/排序三处、无业务逻辑依赖 → **砍**。`MachineRow.label` 退役：wire/视图/分组/排序（含 a2a roster 视图、machine-down toast）全部改用 `name`；machines.json **容错读**旧文件（label 列下次写盘自然消失，有测试）；pairing 输入不再收 label。CONTEXT.md Machine 词条同步改（dev3 小写示例 + 双标识纪律）。
3. **行内动作图标化**：status 文案 chip → 新自绘 **Wi-Fi 式 signal mark**（`client/status-mark.tsx`；ui-primitives 目录核实无 wifi/antenna 图标——按「官方原语优先，否则 bundle 内重绘」先例），四态着色（reachable 绿 / pending 灰 / unreachable 琥珀+斜杠 / auth-expired 红+斜杠）+ `title`/aria 保字；原状态点删除。`Updated … ago` 行删除（`lastFetchLabel` 退役；wire `lastProbeAt` 保留为服务端事实字段，视图不再消费）。`refresh` → `IconRefreshOutlineRegular`，remove ✕ → `IconTrashOutlineRegular`（aria-label 保留）。
4. **排序统一**：host `agentLinks`——locals DSH 恒首 + label 字母序（key 决胜）；federated = (机器名， 组内 native 优先， label, key)。client `groupByMachine`——每组内 DSH 恒首 + 字母序（flat fallback 吃 wire 序）。实测两侧组均为 `DSH, Antigravity, Claude, Codex, Hermes, OMP, Pi`。

## 五、验收证据（4993 pack 线，交付形态）

| 检查 | 结果 |
|---|---|
| `superd-hub` build（host tsc + client lane typecheck） | 绿 |
| `superd-hub` 全测（含新增 icon-pack / tokenUrl-op / 旧 pinned 更新） | **555 / 555** |
| `super-dsh/test/pack-contract.test.mjs`（禁 install hook / 禁 codex 依赖 / 纯 JS deps） | 3 / 3 |
| 整包 `pack.mjs` → `super-dsh-0.1.12.tgz`（assets 47 条目在内） | 成 |
| 4993 全新 home boot（tarball → pnpm add file: → repo CLI） | shell **200**，`world failed` **0** |
| roster（配对 4994 后）：14 行全部带 runtimeId；联邦行 label 无后缀；两组 DSH 首 + 字母序 | 实测一致 |
| machines GET：行仅 `{id,name,origin,enabled,addedAt,status,lastProbeAt[,versionWarning]}`（无 label；lastProbeAt 仅服务端） | 实测一致 |
| `tokenUrl` op：合法 origin → `{tokenUrl}` 与 boot token 逐字节一致；坏 origin/裸 origin 校验/缺 face → 400 | 实测一致 |
| 交付 bundle（`super-dsh/client.js`）：runtimeId 查表 + 图标 data URI + StatusMark + pairing toast 在包 | grep 实证 |
| 重启复验（boot 立即 sweep 重联邦）：roster/machines 与重启前一致 | 通过 |

## 六、边界与移交

- **4999 未动**：那是 user 在役 GUI 会话（也是本轮 agent 的宿主进程）。新包已在 **4993**（`.tests/superd-4993`，配对 4994 模拟 dev3）运行，待 user 亲手验收 UI（图标 / copy 按钮 / 图标化动作 / 排序 / 无后缀菜单）后再决定是否用同一 launcher 接管 4999。
  - 4993 入口：`http://127.0.0.1:4993/?token=<redacted>`（boot 一次性；cookie 与 `test.pc.internal.test` 同 seed 但 authority 不同，需重新 mint）。
- **dev3 实装未做**：目标机（真 dev3）部署按惯例在 user 验收本线后连同 4999 接管一起排程。
- **发布（2026-10-08 user 放行「push, publish, v0.1.12a」）**：版本 **0.1.12-a**（仓惯例字母迭代；registry dist-tag 走 **`next`**，`latest` 保持 0.1.12——与 0.1.5-a/0.1.11-a/b 先例一致）。最终整包由版本 bump 后的 `pack.mjs` 构建：`super-dsh-0.1.12-a.tgz` SHA-256 `30c1bbb8af9e3279b4ff5ef56cd2ecaa404ad9dde1c4603fe4dac3d4835153f8`；全组件测试 sweep 1,769 pass / 1 skip / 0 fail。**已发布**：`npm publish --tag next`（registry shasum `eda50cfa…`，411 files），registry 状态 `next: 0.1.12-a / latest: 0.1.12`。
- 已知残留：`agent-agy*` / `world-join` 的 fiber-scoped 卸载契约补齐仍是同族遗留（本次未触碰，见 super-dsh/AGENTS.md 卸载契约节）。

## 七、验收期修复两则（2026-10-08 user 实测反馈）

1. **LAN 直连被 ufw 拦截（非 bind 问题）**：launcher 按 2026-10-07 裁决默认 `host: 0.0.0.0` 后，host 内探针全绿但 LAN 设备连不上——根因是宿机 **ufw default-deny incoming 且无 499x 放行规则**（旧 socat relay 形态同样被拦；此前 4999 可达靠 Caddy 443）。修复：`ufw allow from 192.0.2.0/24 to any port 4990:4999 proto tcp`（LAN-scoped，iptables 规则匹配已验证）。同时核实 docs/07 旧「webserver 硬拒 0.0.0.0 RCE 门」记载对现上游基线已失效（schema 接受双字面量并直接 bind），文档已更正。
2. **切到 remote agent 后 Hub 页 machines 404 / 分组消失**：fusion transport 的 fetch 重写只豁免 `/api/agent-runtime`，`/api/superd/machines` 被 ROOT 到 `/hub/api/superd/machines?agent=<a6>` → 落到 peer 平面 → **404**（实测复现该路径 404），Hub 页丢机器表 → 分组退化 + 每行裸 machine id（`a7ui`）。修复：控制面豁免扩到整个 **`/api/superd` 前缀**（machines/a2a/exec 全是 ctx0 控制面，外部平面本就不可能应答）；新增测试钉住 federated label 下三个 superd 路径不重写 + 前缀边界（`/api/superdoxx` 仍重写）。单测 **556/556**；修复包已重发 4993 实测：旧路径 404、新路径 200、页面 head 脚本携带新豁免。
3. **self 行 token 预览（user 微调）**：GET self 块新增 `tokenPreview`（live token 前 10 字符 + 省略号；mint face 抛错即静默降级无预览），完整 token 仍只走显式 `tokenUrl` op；self 行 URL 渲染 `…/?token=<preview>` 且 copy 图标紧跟其后（不再挂行尾）。单测 **558/558**。随后 4993 的 dev3 配对已按 user 指令移除（`DELETE ?id=a7ui`，machines 归零、roster 回 7 本地行），两台实例（4993/4994，同最新包、machines 均空）交 user 做「copy 自家 token URL → 对端 Add machine」的原始设计流实测。
4. **Mutual pairing 落地（2026-10-08 user 实测裁定「加了对方就等于双方都加了」）**：此前实现是单向登记（pair 只建本侧行，从不通知对端）——user 实测确认后按裁决补齐反向腿：`pairMachine` 成功后，发起方把**自己的配对输入**（请求 Host header 的 authority 经 `authenticatedUrl` 令牌化 + 主机名:端口）作为普通 pair POST 打给对端（ riding 刚 mint 的 cookie），body 带 `mutual: true`——对端按普通配对处理但**不再触发自己的反向腿**（递归止于构造）；对端答 duplicate-machine-id = 已互持（ok:true）。反向失败永不失败配对本身（outcome.mutual 带因，client toast 提示可手动补）。**踩坑**：connection 载体派发的 Fetch Request URL 是内部占位 origin（`dsh.internal`），真 authority 在 Host header（`http-bridge.ts` 原 headers 透传）——首版读 URL origin 即被打脸，已改读 Host。实测（4993+4994 全新态）：4994 一次 user 形态 pair → 201 `mutual.ok:true`，4993 自 动出现 `homepc:4994` 行。单测 **562/562**。
