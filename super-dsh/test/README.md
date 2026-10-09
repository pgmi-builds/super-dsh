# super-dsh 测试 rigs（种子侧）

唯一种子 = 本目录 [`start-4999.sh`](./start-4999.sh)（入库、幂等；运行 home 在 `.tests/`，gitignored）。
规范、rig 语义与验收层级一律见 **[`docs/07-cordis-dsh-dev-test-guides.md`](../../docs/07-cordis-dsh-dev-test-guides.md)**（本仓唯一通用测试指引）——本文件只留速查，不另立规范。

- **启动**：`bash super-dsh/test/start-4999.sh`（默认 4999 + `.tests/superd` 长寿命 home）
- **双包固定来源**：每次启动都从本地构建 本仓 `super-dsh/` 与 `better-dsh/` 两份 tarball。缺少源码或 exact-pin 不匹配立即失败，不回退兄弟仓或 registry，不用源码 symlink。`SUPERD_TEST_TARBALL` 已退役。
- **组合范围**：首次只声明 Super；Super 的 exact Better dependency 由同一次安装从本轮只读测试 registry 下载，包内 coordinator 经宿主原生包操作离线登记已下载 Better 为独立直接依赖/bundle。不通过 pnpm override 补包。版本、路径与 SHA256 记录在 `.scratch/superd-pack/pair.json`。
- **原生策略**：默认 `0.0.0.0`、WebTrust 与 onboarding/welcome 由 Better Dash 提供；launcher 用官方 `--port` 指定测试口，仅显式 `SUPERD_BIND=127.0.0.1` 才传 `--host`。
- **访问域名声明**：每个测试口默认用官方 `--trusted-host` 声明本机主 IP 加端口；仅 4999 额外声明 `test.pc.internal.test`。`SUPERD_TEST_TRUSTED_HOSTS` 可追加其它访问 authority。Caddy 保留真实 Host/Origin，不用 header 改写绕过原生检查；此部署声明独立于 Better 的 WebTrust 策略。
- **对外地址**：4999 默认传 `--public-url https://test.pc.internal.test`，让启动链接、Agent Web 上下文和 `DSH_WEB_URL` 指向实际域名入口。其它测试入口可用 `SUPERD_TEST_PUBLIC_URL` 显式指定；不从 trusted-host 列表猜测对外 URL。该 flag 不授予信任。
- **重复启动**：重建 profile 时保留已有 profile patch/额外依赖、已登记 Better 直接依赖及独立 bundle 启停状态；首次消费仍只声明所选产品，不由 launcher 提升 Better。socat 仅在显式 loopback + relay 模式要求存在。
- **登录**：Better Dash 的密码页提供新客户端登录，已持有共用 seed 签发 cookie 的浏览器继续直接使用；不再用 native `?token=` URL 作为本线登录入口。
- **旋钮**：`SUPERD_PORT` / `SUPERD_HOME_DIR` / `SUPERD_PROFILE`（+ `SUPERD_TRACE`）；全新 home 临时指 `SUPERD_HOME_DIR=` 即得（用完即删，见 docs/07 §3.2）
- **速记**：端口无主化（测试 unit 占口自动接管）· seed 持久 ⇒ cookie 30 天免重注入 · 重置只动 profile，user data 保留 · session schema **v4**（v4-reader 兜底校验器：`superd-hub/test/system-head*`）

- **独立小包**：`SUPERD_TEST_CONSUMER=better-dsh SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/better-dsh`。双构建，单独消费 Better Dash。
- **目标交付**：`SUPERD_TEST_PACK_DIR=<received-pair-dir>` 只消费已构建的双产物，经 SHA256、manifest、有序 YAML 与内嵌文件校验后安装；不走 registry Better Dash。

测试 registry 为 `superd-<port>-pair-registry`，loopback `port+10000`（可用 `SUPERD_TEST_REGISTRY_PORT` 覆盖），只读服务本轮双 tarball。其它包转发 npm configured registry；消费 profile `.npmrc` 保存 endpoint，native Plugin Manager 共用。停止测试时一并 stop registry unit。正式发布先 Better 后 Super；公共 registry 上传仍需单次授权。
