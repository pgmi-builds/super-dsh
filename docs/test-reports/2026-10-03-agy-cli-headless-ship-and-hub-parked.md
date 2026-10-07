# 2026-10-03 — agy adapter：CLI headless 发包，Hub 后端面归档

## 结论

`agent-agy` 以**纯 CLI headless**（`agy --input-format=stream-json`）为唯一发货形态；
`agent-agy-sdk` 仍是独立包、`disabled: true`（未动）。
今天探索的 `agy --hub` 后端面**全部代码 + 实测契约 + 地面真相**归档到
[`docs/parked/agy-hub/`](../parked/agy-hub/README.md)，可从文档里原样捞回。

## 范围

| 项 | 处置 |
|---|---|
| CLI headless | **发货路径，零改动** |
| `agy --hub` 后端 transport | 已写出并测通，**parked**（不 import、不打包） |
| SDK（`agent-agy-sdk`） | 独立包，`cordis.patch.yml` 行 `disabled: true`，今日未动 |
| Antigravity 2.0 桌面端 | 2.0.1 → **2.19.1**（调查副产物，非发货物） |

## 验证（发货形态）

```
agent-agy 单元测试       74/74        （26 条 hub 测试随代码归档）
pack.mjs                 259 files    （较 263 少 4 = 移除的 hub dist 产物）
tarball 内 agy-hub 残留   无
tarball 内 agent-agy     dist/{adapter,agent,agent-preset-agy,agy-auth,agy-auth-gateway,
                          agy-cli-client,agy-sessions,agy-store,inbox,index,models,world-plugin}.js
cordis.patch.yml         agent-agy-sdk → disabled: true  ✅
```

4996 线（`SUPERD_PORT=4996 bash super-dsh/test/start-4999.sh`，新 tarball 重挂）：

```
无 cookie                    → 401     （认证栅栏在）
token 铸 cookie（127.0.0.1） → 200  47146b
带 cookie 本地               → 200
token 铸 cookie（LAN）       → 200
带 LAN cookie LAN            → 200  47146b   （cookie 按 Host 绑定，符合设计）
/hub/api 无参                → 404     （foreign-only 语义）
world failed 计数            → 0
unit                         superd-4996-test + superd-lan-4996-relay  均 active
```

访问：

- 本地 `http://127.0.0.1:4996/?token=<redacted>`
- LAN `http://192.0.2.130:4996/?token=<redacted>`

（seed 持久，浏览器 cookie ≤30 天免重注入；LAN 需用 LAN 那条 URL 铸一次 cookie。）

## 关键发现（归档原因）

1. **`agy` 一份 binary 三个面**：TUI / `--input-format=stream-json` / `--hub`。
   `--hub` 是**未公开 flag**（`agy --help` 不列），且 family 内其他 binary
   全部拒绝它（`flags provided but not defined: -hub -hub-port`）。
2. **hub 面无法执行工具**（本环境）：
   `RUN_COMMAND → ERROR "connecting to sandbox server: … connection reset by peer"`，
   而同一 prompt 走 CLI headless 正常（`uname -s → Linux`）。
   根因：执行策略由**项目/用户设置**在服务端决定，客户端塞进
   `cascadeConfig…autoExecutionPolicy` 会被剥掉（`userInput.userConfig` 回显
   `autoCommandConfig: {}`）；CLI headless 之所以没事是因为
   `--dangerously-skip-permissions` 绕过整条权限/沙箱路径。
   而 `GetUserSettings → unimplemented`、`GetProjects → 404`，API 侧改不动。
3. **认证不是障碍**：hub 继承同一条梯子 —— `GetAuthStatus` →
   `hasValidAuth: true, projectId: "crafty-run-501613-m0"`，
   `GetGrantedScopes` → 含 `cloud-platform` 的 8 个 scope。Agent Platform OAuth +
   system keyring 直通，无需额外工作。
4. **产物谱系（三份，两条独立发布分支）**：

   | 产物 | 版本 | 构建 | 分支 |
   |---|---|---|---|
   | `agy`（CLI，在用） | 1.2.15 / engine 2.19.1 | 2026-10-03 | `agy_ls_release_branch` |
   | Antigravity 2.0 桌面端 | 2.19.1（原 2.0.1） | 2026-10-01 | `antigravity_web_release_branch` |
   | Antigravity IDE | 1.107.0 | 2026-08-13 | `agy_ls_release_branch/2.7` |

   CLI 是三者里最新的一份 —— 更新桌面端拿不到更新的 LS。
5. 官方产物基址（非 auto-updater 服务，那些只回版本号）：
   `storage.googleapis.com/antigravity-public/antigravity-hub/<version>-<build>/<platform>/Antigravity.tar.gz`

## 归档资产

`docs/parked/agy-hub/`：`agy-hub-client.ts`、`agy-hub-supervisor.ts`、
两个测试（16 + 10 条，均通过且红测验证过）、两个 mock fixture、README
（含完整 wire 契约、step→DSH 事件映射地面真相、复活步骤、遗留缺陷清单）。

**复活时必须先修的已知缺陷**：`stepKind()` 对工具 step 有损
（`RUN_COMMAND` 同时带 `error` 与 `runCommand`，它返回 `error`）——
要改成从 `type` 反推 payload key。

## 遗留开放项

- hub 工具执行需打通权限/沙箱路（桌面设置界面，或找到正确的
  `SetUserSettings` method 名）。
- `agy-hub-transport.ts`（实现 `LiveAgyClient`）+ hub↔headless 路由**未写**。
- `docs/parked/agy-hub/README.md` §6 是完整的复活与接线清单。
