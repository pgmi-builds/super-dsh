# Better Dash / Super Dash 本地联合运行

2026-10-07 user 授权：保留两个物理仓库；默认两个包始终由本地最新源码构建 tarball；以 Super Dash launcher 拉起 4999，供 user 手工验收。

- Super Dash 源码在本仓 `super-dsh/`；Better Dash 源码在兄弟仓 `../dashr/better-dsh/`，不复制、不创建目录 symlink。可通过 `SUPERD_BETTER_DSH_DIR` 显式选择兄弟 checkout。
- `super-dsh` 声明 exact-pin `better-dsh` 依赖。每次 launcher 运行都构建两包；缺少兄弟源码或构建失败即停止，不回退 registry。
- 两包统一调用同一个 `pack-package.mjs` 打包函数，执行普通 `npm pack`，核验实际 tarball manifest；不维护 npm JSON 输出格式兼容层。
- 测试安装采用两份本地 tarball，并以 pnpm override 将传递的 `better-dsh` 依赖也指向同一 tarball，保证只有一个 Better Dash 包身份。
- 现有上游只读取 profile 明列的 bundles，不递归启用传递依赖的 bundle。此次 profile 明列 `base → web-app → better-dsh → super-dsh → dev-webmcp`，框架各自读取包内 YAML；Super Dash 不复制 Better Dash YAML。
- Super Dash 覆盖重复的 `dashr-web-trust` 为 disabled，保留已验收的 `superd-web-trust`。其余 Better Dash 组件保持自身组合定义。
- 此次是联合 profile 的本地行为验收，不等价于“registry 消费者仅安装 Super Dash 即自动启用 Better Dash”。后者仍需产品接入设计，不能由测试 launcher 掩盖。
- 重用现有隔离 home、共享 cookie seed、端口接管与 systemd 启动机制。保护生产 3080/3081、生产 home、用户测试会话；4999 保持运行。
- 本轮不发布 npm、不 commit/tag/push；报告写入 `docs/test-reports/`。dev3 / registry 单入口消费验收不属于此次仅本地 4999 的完成声明。

验收证据：两个新 tarball 的版本与 SHA256；安装树中的物理包、同一 Better Dash 解析目标、原生 composition 的组件状态；浏览器实际加载两包客户端；native DSH 会话实际调用 Better Dash 工具；Super Dash foreign roster 可用。

本轮实际证据及未验收项见 `docs/test-reports/2026-10-07-better-dash-local-pair.md`。浏览器自动化实例不可连接，页面交互待 user 手工检查。
