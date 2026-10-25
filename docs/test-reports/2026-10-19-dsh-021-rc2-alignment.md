# DSH v0.2.1-rc.2 上游对齐轮（2026-10-19）

## 范围与结论

user 指令：仅把开发分支的上游源码更新到 rc.2，4999 测试实例换用新上游；自有代码不动、双包不重发（rc.1↔rc.2 diff 已由其他 agent 核对与本项目代码无关；PC/DEV3 production 已在上游 rc.2 + 本工具最新版运行无碍）。

**结论：对齐完成，零自有代码改动，双包未重发（npm registry 未动）。**

## 执行记录

| 步骤 | 结果 |
| --- | --- |
| fetch tag | `dsh-v0.2.1-rc.2` = `687f282e8625c6b8d11ff58211a90524be2e4317`（GitHub 直取；origin=dashr 镜像止于 0.2.0-rc.2） |
| delta 勘察 | 456 文件 +4921/−845（含全量 package.json 版本 bump） |
| 硬切 | `git checkout -f` + `git clean -xdf`，工作树干净 |
| sanctioned 补丁 | 单补丁原样重放：`pnpm-workspace.yaml` 尾部追加 `storeDir`/`verifyDepsBeforeRun`（rc.1→rc.2 该文件无变化，上下文零失配） |
| install+build | `npx pnpm@11.7.0 install && run build` → **pnpm 自切 11.28.5**（rc.2 起 packageManager 升级；manage-package-manager-versions），**9/9 gates PASS**（140s），`node apps/cli/lib/bin.js --version` = `0.2.1-rc.2` |
| farm 同步 | `sync-dsh-farm.mjs`：kept=349 relinked=2 removed=0 **total=351**；scope 全 symlink（单实例纪律过） |
| 4999 重启 | `super-dsh/test/start-4999.sh` 整包模板：pack pair 0.3.2 本地重打（registry 冻结不动）→ registry/test/relay 三 unit 幂等重启 → 全 active |

## 环境变化（本轮新踩）

- **系统 node 已升 v26.10.0**：`/opt/node-v22.23.2` 已删除（文档旧路径失效）；rc.2 在 node 26 构建运行正常，生产 dsh.service 同 node 26。
- **`npx` 默认缓存 EROFS**：沙箱下 `~/.npm` 只读，需 `npx --cache <仓根>/.npm-cache/npx`。

## rc.1→rc.2 破坏面勘察（零契约漂移）

实质变更全部在 DeepSeek web 搜索 feature 域：

- `packages/web/web-deepseek-api`：fetch/search/transport 重构 + 新增 egress/redirect/credentials 测试；
- 新 UI 包 `packages/client/ui-deepseek-model-label-1017`（模型标签）；
- `packages/client/ui-settings-web-search` 卡片；
- `packages/web/web-search-deepseek` provider、workflow 三包、`bundle/{base,web-app}/cordis.patch.yml` 行注册。

`client/connection`、gateway/stream、session、boot/webserver/frontend-static 的 **src 零改动**（web-app 侧仅 cordis.patch.yml +3 行与 package.json）。对 super-dsh 全部接缝零契约漂移——与 user「diff 与我们的代码无关」的预核结论一致。

## 4999 线验收（boot 级）

- 三 unit（`superd-4999-test` / `superd-lan-4999-relay` / `superd-4999-pair-registry`）全 active；4999（loopback + LAN relay）与 14999 监听就绪。
- boot 日志形态与 rc.1 轮**逐行同型**：6 world 的 `harness-dev-context` pending 警告为既有状态（同一日志中 rc.1 时期 boot 同样存在），零 world-failed、零新增错误。
- 认证门：`/` 密码表单 200（Better door）+ 匿名 `POST /api/session/list` 401（`check-pair-login.mjs` 过）；原生 `/connect?token=` 兑换 302 + operator cookie 正常，带 cookie `POST /api/session/list` **200**——rc.2 上原生认证层与会话 API 面工作正常。
- 共享 credentials seed 持久（`~/workspaces/.dsh-test-credentials.yaml`）：user 浏览器既有 cookie 跨重启有效。
- **浏览器亲手验收交 user**：`https://test.pc.internal.test/`（cookie 直入；新客户端走 Better 密码页）。

## 备注

- world 页面 mount（`/<label>`）对 API-operator cookie 返回 404：mount/gateway 机制 rc.1→rc.2 零改动，生产同栈无碍，判定为既有 hub 侧状态（非本轮回归），不在本轮处置范围。
- 双包版本现为 0.3.2（pack 本地重打，registry `latest` 冻结不变）。
