# 2026-11-02 两包独立交付解耦（remote 工具归 Better、companion 移除、Hub UI 移动端适配、兼容范围统一）

本轮为工作树改动轮（v0.3.3-b 基础上，未发布、未 publish）。裁决正本：ADR 0016（`docs/adr/0016-two-independent-packages-no-companion.md`）。

## 改动面

1. **remote 工具只留 Better Dash**：`superd-remote` 组合行与公开 `super-dsh/remote` 导出删除；`verify-package-pair.mjs` 反向断言（出现即 fail）。生成的 `super-dsh/remote/` 闭包**收窄为 hub 内部私有依赖**——hub exec/PTY/task/file lanes（`exec.ts`、`remote-provider.ts`、`remote-job-rpc/client`、`remote-file-rpc.ts`、`hub-tool.ts`）import 其进程原语（`PtySession`、oneshot/binary process、rings、argv、helper assets），闭包与 provenance 管线不变（`build-remote.mjs` 保留，pack 在 hub tsc 前重生成）。
2. **companion 移除**：`companions.ts` / `companion-contract.ts` / `bundle-setup.ts`（`superd-bundle-setup` 行、`superdCompanions` 服务、`./setup` 导出）、client `CompanionSettings.tsx` / `companion-api.ts` 全删；fusion transport 的 `/api/superdCompanions` 豁免删除；`start-4999.sh` 的 companion 状态保留块删除（profile previous dependencies 原样带过，不增不减）。旧 `$DSH_HOME/superd/companions/` 残留文件惰性无害。
3. **Hub Settings 手动安装入口移除**：Settings tab 唯一内容即 companion 卡片，随 companion 一并删除——tab strip 收敛为 Home / Workflows。
4. **Better remote 的 Super hub target 不动**：`better-dsh/src/remote/` 零逻辑改动（仅 `helper.ts` 一处提及 Super 闭包的注释收窄）；`agent-registration.ts` 经 `superdRemoteTransport` 服务的检测逻辑原样。
5. **Hub tab Machines 行移动端自适应**：`HoverRow` 增加 `wrap`（`flexWrap: wrap` + 行距 4px/列距 12px）；origin 列 `flex: '1 1 150px'`（宽屏等价 `flex:1`，窄屏换行为整行并省略号）；machine/self 名称可收缩省略。agent roster 行不动。
6. **DSH 兼容范围统一 `>=0.2.0-0 <1.0.0-0`**：两包 + 全部子 manifest（super-dsh 根/superd-hub/9×agent-*/better-dsh 及各自 package-lock），共 180 处 peer 声明。

## 验证（交付形态）

- **构建**：`node super-dsh/scripts/pack.mjs` 双包通过；pair 校验含新断言（Super 无 `./remote`/`./setup` 导出、patch 无 `super-dsh/remote` 行、闭包 provenance 逐叶子哈希通过）。产物 SHA256（本机 .scratch/superd-pack）：better `82723a75…`，super `74f5f706…`（每次 pack 重建以实际为准）。
- **单测**：根 `npm test` 28/28；superd-hub `node --test test/*.test.mjs` 640 pass / 0 fail / 1 skip（既有）；`super-dsh/test/remote-delivery.test.mjs` 4/4（顺带修复其 `readdirSync` 遍历把 `helper-bin/` 目录当文件读的既有 EISDIR 缺陷——该文件不在默认套件列表内）；better-dsh `test/remote/agent-registration.spec.ts` 14/14（hub-target 检测路径未回归）。
- **4999 joint 线**（`.tests/superd` 保留 home，既有 better-dsh 依赖照旧保留）：boot 通过、`world failed` 0、门检 `passwordForm:true`（Better 行活）；本轮日志 companion/installBundle 提及 **0**。重启窗口出现过一次 `skipping profile bundle "better-dsh"`（重建 tarball 后 retained `file:` 依赖的既有重启语义，最终进程 Better 已挂载、稳定）。
- **4997 super-only 干净线**（throwaway home，验证后已停并删除）：profile 依赖仅 `super-dsh` + dev-webmcp，**无任何 companion 安装尝试**；无密码页（原生 401 门，`passwordForm:false`）＝两包独立形态；hub 页面 tab = **Home / Workflows（无 Settings）**，body 无 "Better Dash" 字样；Machines self 行（origin + token preview URL）在 **390px 与 320px** 视口 `scrollWidth == clientWidth`（0 溢出）、行内 0 溢出、行高 80px（换行成两行布局）、URL 省略号截断；桌面宽度无回归。宿主 0.2.2-alpha.2 上两包正常加载（新范围兼容现役宿主）。
- **发布前置项已于本轮放行后执行**（见下节）；dev3 目标机实装归入后续常规轮。

## 遗留

- 4999 线保持运行供 user 亲验：https://test.pc.internal.test/ （Better 密码页登录后 Hub tab 复核 tab 收敛与移动端布局；手机浏览器直接访问 LAN/ WAN 口即可复现自适应）。

## 发布记录（0.3.3-c，2026-11-02 user 放行）

- `npm run version:release -- 0.3.3-c` 同步根 + 两包 + 锁文件；重新 pack（SHA256：better `aa4169f8…`，super `d65924f1…`）；根 `npm test` 28/28。
- 发布顺序 Better → Super，`--tag latest`（user 裁决：每次发包 latest 随最新批准版本移动；npm 对 prerelease 字母版本要求显式 tag）。**事件**：super 即时落地；better 首发受理后卡 npm staging ~25 分钟（重试得 E409 "previously staged version" 证明确已受理、不可重发），自行落地后 latest 双双指向 0.3.3-c。`next` tag（super `0.1.12-a`）未动。
- 字节对账：registry 下载 tarball 与本地 pack 逐字节一致（两包 sha256 同上）。registry 版本不可重用：0.3.3-b/c 已定版。
- 语义提示（user 问答归档）：npm semver 下 `0.3.3-c` 是 prerelease，字母间 a<b<c<d 递增，但**一律小于裸版本 0.3.3**；Plugin Manager 更新判定用 `semver.gt`，故裸版本安装者不会收到字母版「更新」提示，`latest` tag 决定新装/`@latest` 取到的版本。裸数字版本继续保留给真实 feature 发布（根红线 §〇.1.d）。
