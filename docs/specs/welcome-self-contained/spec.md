# Super Dash 自包含 Better Dash 与 DSH 默认策略

2026-10-07 user 裁决：两仓物理独立；Super Dash 每次打包都构建兄弟仓当前 Better Dash 源码，内嵌本地实际产物，不从 registry 取 Better Dash；WebTrust、dev WebMCP、webserver 默认监听及 onboarding/welcome 策略归 Better Dash。

- Better Dash 独立 build/pack；Super Dash 用 npm bundledDependencies 内嵌该本地 tarball 展开的物理包。依赖版本 exact-pin 与源包一致。
- Super Dash bundle 的有序 patch 文件先读取内嵌 Better Dash YAML，再读取自己的 YAML；消费者 profile 只声明 Super Dash，不单独声明 Better Dash。
- Better Dash 的 WebTrust 默认组合启用 authentication-only，保留 native cookie 校验；Super Dash 删除重复实现及相关覆盖。
- Better Dash 禁用原生 webserver 行、以独立 dashr-webserver 行继承原生 Service，并在监听前等待 welcome entry；默认 host 0.0.0.0，保留原生 port/压缩/CLI 配置机制；测试 launcher 默认仅覆盖 4999 端口，不再提供消费包未有的默认 host。
- Better Dash 关闭 credentialOnboarding，人工模型配置保持可用。
- `dashr-welcome-notice` 是可单行 disabled 的 Host entry：从实际安装锚的 Models 客户端读取当前 WELCOME_NOTICE_VERSION，经官方 internal/config 与 Entry.update 将确认同步投到原 ui-settings-general，不替换 Models UI，不写死版本，不用客户端 localStorage 假确认。
- 静态私有常量没有公开 API；普通版本 bump 自动生效，符号/产物结构变化必须显式报错，不能静默保留旧版本。
- dev WebMCP 移归 Better Dash 仓的开发测试目录，不进入正式插件 tarball；联合 launcher 仅将其作为开发附加 bundle。
- 真实 tarball 安装、登录、native eval/create/prompt/resume、roster、首次 settings 快照、热禁用恢复为本轮验收；浏览器连接与 dev3 按可用环境如实记录。4999 保持运行。无 npm publish、commit/tag/push、上游或生产修改。
