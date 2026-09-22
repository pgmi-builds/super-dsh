# dashr bun port — M1 验收报告（spec §7）

- 日期：2026-09-23（本地验收 04:58 +0800；dev2 换装与域名验收 05:22–05:25 +0800）
- port 仓：`dashr/port`，验收时 HEAD `6a2cd1f9c4`（port/main；前置 `bf2f3d3546` 验收 harness、`09517f493c` E2E seams）
- 本报告 = 发布三闸之**第二闸**（报告）。第三闸（user 放行）PENDING——见文末。

## 1. 产物身份

| 项 | 值 |
|---|---|
| 文件名 | `dashr-0.1.6-alpha.2-linux-x64` |
| 大小 | **140,858,568 B**（≈134.3 MiB / 140.9 MB） |
| sha256 | `538c8106253351bd722520dfd79dcbe15bee58e69782a67b0680a5c8cd7bd18d` |
| 形态 | ELF 64-bit x86-64 单可执行文件（`bun build --compile`，entry = `apps/cli/lib/bin.js`） |
| 构建 | port 仓 `scripts/dashr/build.sh`，2026-09-22 23:05 (+0800)；248 client artifacts，1721 modules，compile 937ms |

产物目录单文件断言（spec §7 A1）：`find dist -maxdepth 1 -type f ! -name '.*' | wc -l` = 1（仅本二进制 + 隐藏构建日志）。

## 2. 本地验收证据（第一闸·本机，2026-09-23 04:58 +0800）

`bash scripts/dashr/acceptance.sh dist/dashr-0.1.6-alpha.2-linux-x64` 全绿，末行：

```
PASS: M1 acceptance
EXIT=0
```

- **真实对话轮**（headless Chromium 经 composer 发送，LLM 路由 `deepseek-official/deepseek-flash`，793ms 回复；session log 22 事件核验 user/message → assistant/message）：

```
"marker": "m1acc-ae79b1",
"replyExcerpt": "PONG — m1acc-ae79b1 acknowledged.",
"toasts": [],
```

- **持久化**：`/tmp/dashr-acc/sessions/--tmp-dashr-acc-ws--/session-d0a8beb4-6ba7-4e70-815f-292a311637bb/session.v3.jsonl.zstd` — **15,589 B**，settle 后在位。
- **重启存活**（boot 2 同 home、新 token、`--resume-only`）：侧栏出现持久会话条目 `"… New Session | M1 acceptance ping reply | now | …"` → PASS；无 toast、无 console error。
- 唯一 console 项为浏览器自动 `/favicon.ico` 404（`favicon.svg` 为 200）——外观性，M2 候选。

## 3. dev2 换装证据（第一闸·域名，2026-09-23 05:22–05:25 +0800）

部署单元 = **二进制 + home**（spec §2 D2/D3：anchor/tree/web-dist 部署形态整体消灭；caddy/DNS 复用，未改）。

### 3.1 目录形态（单文件断言，远端）

```
$ ls -la /opt/dashr/          # 换装后
-rwxr-xr-x 1 admin admin 140858568 Sep 23 05:22 dashr-linux-x64
drwxr-xr-x 5 admin admin      4096 Sep 22 13:39 home
```

旧布局（anchor/ 94.6MB 旧 PoC 二进制 + tree/ + web-dist/）已整目录移除；`/opt/dashr/home`（用户数据 + `.env` + `.credentials.yaml`）保留。

### 3.2 systemd unit env 差分

```diff
 Environment=DSH_BUN_COMPILED=1
-Environment=DSH_INSTALL_ANCHOR=/opt/dashr/anchor/package.json
-Environment=DSH_WEB_FRONTEND_DIR=/opt/dashr/web-dist
 Environment=DSH_HOME=/opt/dashr/home
```

删除的两项均为编译态 in-binary 默认（`DSH_BUN_COMPILED=1` 下 asset root = `/$bunfs/root`）；端口 4970 与 `--trusted-host dashr.dev2.internal.test` 不变。`systemctl is-active dashr` = **active**。

### 3.3 域名验收（本机发起，真实 https 域名）

```
$ curl -s -o /tmp/d2-shell -w '%{http_code}' -c /tmp/d2-jar -L \
    "https://dashr.dev2.internal.test/?token=<tok>"
domain shell: 200            # body 30,346 B，含 "DSH Local Build"
```

### 3.4 域名对话轮（port 仓 prober 对 https URL）

```
$ node scripts/dashr/accept-chat.mjs "https://dashr.dev2.internal.test/?token=<tok>"
{
 "verdict": "PASS",
 "mode": "chat",
 "marker": "m1acc-2dc2cd",
 "promptChars": 116,
 "elapsedMs": 3802,
 "settledAtMs": 3802,
 "replyExcerpt": "PONG — M1 acceptance ping m1acc-2dc2cd acknowledged.",
 "newLineCount": 17,
 "toasts": [],
 "consoleErrors": []
}
```

### 3.5 dev2 会话持久化

```
/opt/dashr/home/sessions/--opt-dashr-home-ws--/session-d1301de1-91de-4851-88e5-a1845c59f6ee/session.v3.jsonl.zstd
```

（14,507 B，mtime 晚于新二进制——域名对话轮真实落盘。）

**偏差披露**：换装后首次域名对话轮 FAIL（no composer）——dev2 沿用的 home 处于 first-run 无 workspace 状态（`workspaces: {}`）。按验收 harness 的既定办法（acceptance.sh 种子 = first-run 用户终态）补种 `storages/workspace.json` 记录（指向 `/opt/dashr/home/ws`）并重启一次（token 轮换），随后 3.3–3.5 全绿。home 内其余用户数据未动。

## 4. 体积超限说明（spec §7 A5：~110–130MB 预算）

实际 **140.9 MB**（140,858,568 B），超预算上限 ~8–28MB。归因：预算估算时对 **client 面 web/ 资产按 ~18MB dist 计，未计入 client halves 所引用的 web 共享 chunk 面（~25MiB）**——四资产面（client halves 248 件 + web-dist + anchor + composition）首次全部内嵌进单一二进制。task-10 报告已先行记录同一归因（"the full 74-half client plane + web-dist + anchor + composition assets embedded for the first time"）。判定：功能性成本（单文件 D2 契约）所致，非回归；M2 若需瘦身，候选为 chunk 拆分与 map 剥离。

## 5. 合成 anchor 披露

二进制内含一个**纯数据**合成安装锚（无可执行代码）：`anchor/package.json`（无依赖 `dashr` 名字标记 + 冻结依赖版本表）+ `anchor/node_modules/<pkg>/package.json` × 230（冻结 registry 宇宙逐包清单）。用途：运行时 profile-boot BFS（`pluginPackages.packageOf` 表）在 `/$bunfs` 内解析包身份（agent-preset 发现、typert 工件路径、包身份清点）。沿革：task-10 期为字面 2 文件（标记 + 根 package.json）；task-11 E2E seam 发现裸锚包查找全 miss，扩为全宇宙清单。它是 spec §9"弃 anchor 部署形态"的**编译态内嵌替身**——磁盘上不再有任何 anchor 目录。

## 6. 发布三闸状态（根 AGENTS.md §〇）

| 闸 | 状态 |
|---|---|
| 1. 第一人称实测 | **DONE** — 本机全量 harness PASS（§2）+ dev2 真实域名对话轮 PASS（§3.4），零 toast |
| 2. 报告 | **DONE** — 即本报告（spec §7 验收输出全量收录 §2–§5） |
| 3. user 放行 | **PENDING** — 未放行前**不 publish**（npm 通道打包骨架已就绪：`scripts/dashr/package-npm.mjs` + `dist/npm/`，仅待闸） |

## 7. 外层仓收尾（spec §9）

- 旧 patch-系列机制 `dashr/src/` 已从磁盘移除（本就未跟踪）；旧 94.6MB PoC 二进制已从 `dashr/release/` 移除（gitignore 内、从未跟踪；残留 gitignored `release/anchor/` 1.2M 无害）。
- `dashr/README.md` 构建体系节改指 port 仓（外层仓 commit `d0268dd`）。

## 8. Addendum — task-12 fix1：browse picker 词汇冻结 + dev2 换装 #2（2026-09-23 05:40–05:50 +0800）

**起因**：§3 偏差披露的种子 workspace 掩盖了 first-run adoption 是否可用的问题；fix round 复核根因并恢复真实验证。

**根因复核（对 T4 裁决的修正）**：stage-1 期旧产物确有 registry miss（dev2 journal 2026-09-22 21:39 +0800：`directory-picker-auto: failed to load @deepseek-ai/dsh-host-directory-picker-browse`），T4 ledger 以 "absent from frozen universe; load errored in stage-1" 记录——当时为真。但 **M1 验收产物（`538c8106`）的冻结 registry 实际已含全部 6 个 directory-picker 包**：gen.ts 的传递闭包经 `directory-picker-auto` 的 peerDependencies（browse/native 后端 + client 面）早已覆盖，dead-picker 日志属旧产物。fix1 把这一"侥幸"转为契约：`gen.ts` 新增 **ALWAYS_FROZEN** 专用列表（引用 directory-picker-auto 导出的 BACKEND_PACKAGES/SURFACE_PACKAGES 固定词汇；非 composition 行——它们是 boot 期动态 loader-create 的），loud unresolved-rows 自检覆盖之；`gen.spec.ts` 增 2 测试；ledger drop 理由改写为 "auto-mounted fixed vocabulary … never a composition row"。port commit `556ebddf18`。

**产物不变式核实**：registry 输出字节不变（253 entries / universe manifests 230）；`clientHalves` **仍为 74**——两个 picker client 面本就在 stage-assets 的 `exports['./client']` 检测内（该检测遍历全部 workspace 包，与冻结宇宙无关），任务预期的 74→76 不成立，无增长、无遗漏。

**新产物（换装 #2）**：`7cd0e6c60745a33f8bc15cc981c8419a839a2f826406849c72c73329aab7c383`，**140,858,568 B——与旧产物同字节大小（delta 0）**，符合"词汇早已在宇宙内、仅转契约"的预期。dev2：stop（`pidof` 验证进程死亡）→ 换 `/opt/dashr/dashr-linux-x64` → start，`systemctl is-active` = active。

**first-run 状态发现的机制**：storages/workspace.json 删除后旧 `ws` 记录会在下次 boot 复活——`workspaceRegistry` 的 `indexLiveSessions` 从持久 session 的 cwd 重建 workspace 记录（产品行为，非缺陷）。故真实 first-run 复核把旧验收 sessions/workspace.json/projcache 移至 `/opt/dashr/task12-fix1-backup/`（保留可查）。

**第一人称 adoption 证据（域名，全新 home，headless Chromium）**：

```
EVIDENCE workspaces-before: … Workspaces | No sessions yet | Choose a workspace to start   # 真 first-run hero
EVIDENCE browse-dialog: opened: Select Workspace Directory                                   # browse 目录面
EVIDENCE listing-rows-home: ["media","workspaces"]                                           # /home/admin 列目
EVIDENCE path-editor-seed: /home/admin/  →  type /opt/dashr/home + Enter                     # 路径编辑跳转
EVIDENCE folder-created: ws-fix1-adopt        EVIDENCE selected-row: ["ws-fix1-adopt"]       # New folder + 选中
EVIDENCE workspaces-after: Workspaces | ws-fix1-adopt   （hero 切换至该 workspace，composer 激活）
EVIDENCE toasts: []   EVIDENCE consoleErrors: []
verdict: PASS — 盘上 /opt/dashr/home/ws-fix1-adopt/ 在位；storages/workspace.json 仅此一条记录
```

**对话轮回归（域名，新二进制）**：`accept-chat.mjs` PASS——marker `m1acc-f03317`，4.0s，reply `PONG m1acc-f03317 — acceptance ping received.`，零 toast、零 console error。发布三闸状态不变（第三闸仍 PENDING，未 publish）。
