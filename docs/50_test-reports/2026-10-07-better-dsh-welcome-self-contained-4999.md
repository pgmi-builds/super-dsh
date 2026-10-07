# 2026-10-07 Super Dash 自包含 Better Dash / 动态 welcome 验收

本轮为本地 4999 消费者验收，不是 npm 发布或 dev3 放行。两仓物理独立，Better Dash 本地源码始终参与构建。

## 交付物

| 包 | 本地版本 | SHA256 |
|---|---|---|
| Super Dash | 0.1.12-e | `243951a2ed5bfbaa6139aa045bd4314ac96f91bf6420159b940c34b2da6ab52d` |
| Better Dash | 0.2.5-h | `3ab52507f738e3c74fb1142cc41aae9544e1f78453e80d573baa686d0885af8d` |

路径为Super Dash 仓 `.scratch/superd-pack/`；完整来源、绝对路径与时间见 `pair.json`。pack 从 `/home/u1/workspaces/dashr/better-dsh` 清理并构建 lib，统一普通 npm pack，再物理展开该 tarball 供 bundledDependencies 打包。不存在 registry Better Dash 回退。每次 pack 自动对独立与内嵌 Better Dash 的 **741 个文件逐字节核验**，缺失或陈旧内容不能写入成功记录。

消费者 profile 直接依赖只有 Super Dash tarball 与开发附加 WebMCP；没有 Better Dash 直接依赖/bundle、没有 pnpm Better Dash override、没有 profile-root Better Dash。实际安装的 `super-dsh/node_modules/better-dsh` 与独立本地 tarball 逐文件一致。有序 patch 文件先读内嵌 Better Dash YAML，再读 Super Dash YAML；无组件清单复制。

## 用户可见行为

- WebTrust 与 WebServer/default bind、credential onboarding、welcome 均归 Better Dash。Super Dash 删除重复 WebTrust 源码、导出和行。dev WebMCP 移到兄弟仓 `dev-webmcp/`，不进入两包正式 tarball。
- `dashr-welcome-notice` 从**实际运行宿主**的 WebApp → Models client 路径读当前版本；本次读到 `2026-09-28.1`，实际 settings/describe 的 General value 相同。没有在 profile patch 写死 welcome 值；组件用 Loader 的公共 internal/config/Entry.update 对原 namespace 做可逆投影。`disabled: true` 恢复原生确认行为。
- 发现并修复真正的首次 HTTP 竞态：原生 Models 页面 settings mirror 的 unary HTTP 不受 WebSocket appReady 门约束。Better Dash 禁用原 webserver 行，插入 `dashr-webserver` 继承原生 Service，等待 welcome settle 后才执行原生 init/bind。延迟 General 激活的真实 Loader/HTTP fixture 先复现首读 null，修复后首个 200 快照含当前版本。禁用/重启组件恢复原值且不重建 General fiber；曾复现双挂载后已修复为只在 fiber 不存在时 init。
- 普通版本 bump 自动适配下一次启动。私有常量重命名、布局变化或多匹配时明确报错；不承诺任意未来上游结构变化也无需维护。没有直接 Settings.update 等自身 root reconciliation、没有替换 Models UI、没有本地 localStorage 假确认。
- 默认监听实际为 `0.0.0.0:4999`，由 Better Dash YAML 提供。测试 profile 只补共用 credentials 路径，端口走原生 CLI `--port 4999`。保留压缩与显式 loopback CLI override。
- 真页面发现异步模块挂载能颠倒 FIFO 排序。Better Dash 的 ownership 脚本现 prepend 公共 injection table；实际认证后 HTML 中 trust 先于 fusion，credentialOnboarding 为 false。公开 client graph 的 67 个 id 无重复，Better Dash 与 Super Dash client 各一份。

## 实际运行验收

- `bash super-dsh/test/start-4999.sh` 完整双源码构建、tarball 安装、原生 CLI 启动 exit 0；`superd-4999-test` active。使用 Node26.10.0、npm12.2.0、pnpm12.9.1。安装期脚本保持禁用，没有 approve-builds。
- 新客户端密码页 POST 登录303、cookie签发；认证后原生 app 与 API 正常。WAN 与 LAN 匿名首页为密码表单，受保护 API 均401。共用 seed 与测试用户会话保留；生产3080/3081和上游源码未修改。
- roster = native、agy、claude、codex、hermes、omp、pi，**7个均 ready:true、failed:false**。本轮没有重跑六个未改动 foreign adapter 的真实模型会话，不把 roster 代称其 prompt 验收。
- 最终产物新建 standard native 会话 `session-a601281b-2ce2-42bc-86c4-7e3753609b57`：DeepSeek真实模型看到并实际调用 Better Dash `eval`，v4日志 tool/call seq17、tool/result seq18 得到 `SELF-CONTAINED-EVAL-42: 42`，turn/end completed。没有用注入探针冒充模型工具调用。
- 服务重启及最终新产物重启后，既有会话 `session-3f8564c9-e846-4506-ac54-95bb0599dd2e` 实际续接，读取上一轮工具输出并正确回复 `LOCAL-BETTER-FOREVER`，第三轮 turn/end completed；验证了持久会话 resume。
- CUA inventory 为 apps[]/browsers[]，无法完成视觉/交互浏览器验收；首个 HTTP fixture、真实 settings 与 client graph 是已验证范围，用户视觉复核仍需访问下面 URL。dev3 未实施，本报告不作其通过声明。

## 检查

- Better Dash welcome/WebTrust/connection：19 tests通过；host/client typecheck通过。
- Super Dash fusion-transport/fusion-flag/world-mount-patches：38 tests通过。
- Super Dash composition/login/pack-contract：7 tests通过。
- 实际 npm pack fixture与内嵌缺失/陈旧拒绝：2 tests通过。
- 迁移 dev WebMCP build与script测试：2 tests通过。
- 独立审查无 Important/Critical 遗留；修正了异步脚本顺序与文档旧结论。git diff --check、launcher shell syntax通过。
- LSP：检查上游配置更新关系、定义/引用；最后针对 Better Dash trust builder 返回真实定义及引用。TypeScript AST确认唯一注入push调用后改为prepend；无假类型/上游修改。

证据保留在 `.scratch/self-contained-install-proof.json`、`self-contained-live-proof.json`、`self-contained-session-proof.json`、`self-contained-roster-proof.json`、`self-contained-client-graph-proof.json` 与 `self-contained-launch-delivery.log`。不记录 cookie、密码签名密钥或 provider keys。

## 留运行线

- WAN: https://test.pc.internal.test/
- LAN: http://192.0.2.130:4999/
- local: http://127.0.0.1:4999/

未 npm publish，未 commit/tag/push；4999 保持运行，供 user 实际页面复核。
