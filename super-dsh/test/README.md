# super-dsh 测试 rigs（种子侧）

唯一种子 = 本目录 [`start-4999.sh`](./start-4999.sh)（入库、幂等；运行 home 在 `.tests/`，gitignored）。
规范、rig 语义与验收层级一律见 **[`docs/07-cordis-dsh-dev-test-guides.md`](../../docs/07-cordis-dsh-dev-test-guides.md)**（本仓唯一通用测试指引）——本文件只留速查，不另立规范。

- **启动**：`bash super-dsh/test/start-4999.sh`（默认 4999 + `.tests/superd` 长寿命 home）
- **双包固定来源**：每次启动都从本地构建 本仓 `super-dsh/` 与 `better-dsh/` 两份 tarball。缺少源码或 exact-pin 不匹配立即失败，不回退兄弟仓或 registry，不用源码 symlink。`SUPERD_TEST_TARBALL` 已退役。
- **组合范围**：只安装/启用 Super Dash，内嵌的本地 Better Dash 由 Super Dash bundle 的有序 patch 激活。不声明 Better Dash 直接依赖，也不通过 pnpm override 补包。版本、路径与 SHA256 记录在 `.scratch/superd-pack/pair.json`。
- **原生策略**：默认 `0.0.0.0`、WebTrust 与 onboarding/welcome 由 Better Dash 提供；launcher 用官方 `--port` 指定测试口，仅显式 `SUPERD_BIND=127.0.0.1` 才传 `--host`。
- **登录**：Better Dash 的密码页提供新客户端登录，已持有共用 seed 签发 cookie 的浏览器继续直接使用；不再用 native `?token=` URL 作为本线登录入口。
- **旋钮**：`SUPERD_PORT` / `SUPERD_HOME_DIR` / `SUPERD_PROFILE`（+ `SUPERD_TRACE`）；全新 home 临时指 `SUPERD_HOME_DIR=` 即得（用完即删，见 docs/07 §3.2）
- **速记**：端口无主化（测试 unit 占口自动接管）· seed 持久 ⇒ cookie 30 天免重注入 · 重置只动 profile，user data 保留 · session schema **v4**（v4-reader 兜底校验器：`superd-hub/test/system-head*`）

- **独立小包**：`SUPERD_TEST_CONSUMER=better-dsh SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/better-dsh`。双构建，单独消费 Better Dash。
- **目标交付**：`SUPERD_TEST_PACK_DIR=<received-pair-dir>` 只消费已构建的双产物，经 SHA256、manifest、有序 YAML 与内嵌文件校验后安装；不走 registry Better Dash。
