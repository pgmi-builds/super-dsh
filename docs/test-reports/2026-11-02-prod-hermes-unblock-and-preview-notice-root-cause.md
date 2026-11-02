# 2026-11-02 — prod 双机 hermes 解堵与 Preview Notice 根因修复（0.3.4-b）

结论：**通过。** PC prod 与 dev3 的 hermes 聊天全部打通（浏览器第一人称实测逐字回复）；dev3 六档腐蚀修复；Preview Notice 根因定位为 **world composition 缺失 `ui-settings-general` ack 行**，修复随 0.3.4-b 发布（dev3 已装，4999 已验，PC/npm 待放行）。

关联：[回合同日报告](2026-11-02-hermes-ws-attach-turn-mapping-and-ui-acceptance.md)。

## 1. dev3 六档腐蚀修复（新建会话被堵的直接原因）

真实 reader 扫描：v4=33，**corrupt=6**（codex×3、hermes×2——含手机撞到的 `session-bee4c5cd`（11-01 23:11 裸 turn/end）与 `session-aa6f7ef5`（10-04 修复档被现行 reader 再报 tool/call 无 advertised lifecycle）——、pi×1），另 2 档 LEGACYv3 为旧版格式非腐蚀，未动。repair.mjs 克隆+remap 重写（fixes=0 但重编号即消除违约），**复扫 33/33 全绿**。备份 `.corrupt-bak-*` 照旧；工作台已复制到 dev3 `/home/u1/hermes-repair-20261102/`。

## 2. Preview Notice 根因（本轮活体定位）

dev3 浏览器活体复现链：**hermes 回合 GATEWAY_CRASH（「owned by a running gateway」拒绝）→ 错误面挂出 Preview Notice + "The acknowledgement could not be saved." + Session unavailable**。深挖后修正早前判断：弹窗的充要条件是**所在 world 的 settings namespace 缺 ack 值**——native `ui-settings-general` 命名空间的值来自 **composition 行**（两台机器的 settings storages 均无该字段的可变存储），而 `provisionWorldProfile` 的 world patch 模板从不镜像 CTX0 的 `ui-settings-general` 行 → 一切 world 都读成未确认；Continue 的写盘后回读投影同一 composition → 永远"保存失败"。CTX0 默认页无弹窗（CTX0 patch 带行）；PC 的 hermes world 此前无弹窗属 Better skip 策略在其 client 上下文生效的组合态，非结构保证。

**修复（0.3.4-b）**：[world-provision.ts](../../../super-dsh/superd-hub/src/world-provision.ts) 落 world patch 时从 CTX0 profile patch（`profileContext.home/name`）**逐字镜像 `ui-settings-general` 行**（best-effort，无行则维持旧行为；上游版本更迭自动跟随）。九处调用点全部穿入 `host: ctx`。4999 验证：hermes world patch 出现镜像行、世界正常、无弹窗。

## 3. 三机实测（全部浏览器第一人称，口令走页面）

| 机器 | 动作 | 结果 |
|---|---|---|
| **PC prod**（dsh.pc，0.3.4-a 热升级） | `~/.hermes/.env` 拨 `SUPERD_HERMES_TRANSPORT=attach`（备份在档）→ hermes 世界发 prompt | **`PROD-HERMES-ATTACH-OK` 逐字回复，Completed in 4s** |
| **PC prod** 弹窗 | 全新加载默认页/各世界 | 无弹窗；12:14 用户手机所见 = 热升级后 stale client 瞬态，刷新即消（0.3.4-b 装上后结构性消除） |
| **dev3**（0.3.4-a→b） | 六档修复 + `.env` 拨 attach（备份在档）+ 装 0.3.4-b + `systemctl --user restart dsh.service`（worlds 重 provision；**已向用户披露的 prod 线重启**） | **`DEV3-HERMES-ATTACH-OK` 逐字回复，Completed in 4s，无弹窗** |
| **4999**（0.3.4-b） | 重挂 + hermes 世界 | 历史 3 回合可读、无弹窗、patch 带镜像行 |

dev3 的 resident gateway（`hermes-gateway.service` active）此前把每次 stdio spawn 拒之门外——与 PC 同一病因；attach 后共用该 gateway。

## 4. 版本与放行状态

- `0.3.4-a`：已 commit/push/publish（上一轮，npm latest）。
- `0.3.4-b`（world ack 行镜像）：**已构建、已部署 4999 与 dev3（tarball），未 publish、未在 PC 安装——npm publish 与 PC 升级待 user 放行。** PC 现为 0.3.4-a：功能完整（hermes 已通），仅其 world 们仍缺 ack 行的兜底（Better skip 在多数场景遮蔽；换 runtime 探索时可能见到弹窗，刷新即可绕过——升级 0.3.4-b 后根除）。
- 测试会话与 draft 均保留；dev3 工作台与 sweep/repair 日志在档。
