# Codex official 与原生 binary 选择

2026-10-05 user 已批准继续实现 OpenAI official，并明确 desktop 优先、CLI fallback。以前的 User Default-only 方向被此裁决替代。

- 在原生 Codex home 发现 ChatGPT OAuth，provider store 仅持久化 OpenAI OAuth 身份，不复制 token、不要求 URL 或手填模型。
- UI 选择此 route 后，子进程覆盖 builtin model_provider=openai；第三方原生选择不得胜出。原生 config/auth 永不由 adapter 写入。
- 桌面核心优先。显式 CODEX_BIN 保持最高优先以支持 operator/test override；其次发现已安装桌面核心；无可执行桌面核心才发现用户 CLI，再回落到包内 exact-pin npm Codex。JS 入口用 Node，ELF/原生程序直接 spawn。fallback 是启动来源选择，不得在官方认证/模型/生成失败后静默换 provider。
- 不伪装官方客户端身份。Super D 继续以自有 initialize.clientInfo 归属；不因 desktop 路径宣称 browser/computer use 可用。桌面额外工具服务只有在确认可用且实现对应接线后才可声明。
- 模型来源是原生官方 models_cache.json 与原生官方默认选择，不能读取第三方 custom catalog 当 official 目录。不得将 parseable 但 binary 无法消费的目录强行注入。原生 binary 自动维护 cache 属其自身行为。
- 保留 lazy spawn：create() 不生成子进程；真正 prompt 才启动。用户默认配置 fallback 保持历史行为，显式 OAuth 选择在 logout 后必须失败，不能转第三方。
- 两条 Codex adapter 的传输无关 provider 模块继续保持同形；SDK 世界默认 disabled，主要交付验证 app-server 世界。
- 测试 proxy 仅配置在 rig，使用 dev3 GOST；adapter 不内置代理。0.1.10-l → m（评审隔离修复）→ n（native cache 刷新）→ o（第三方 comp_hash 修正）经 tarball 通道，先 4999 实装 browser create/prompt、third-party→OAuth switch、world handoff replay/resume，再交给 user 保持在役。无 npm publish。

2026-10-05 隔离修复裁决：官方 child 经 `openai_base_url=""` 恢复 Codex builtin 默认 endpoint（已以真实 0.160 请求捕获验证），不改原生文件；冲突的 `forced_login_method` 在 launch 前明确失败。显式 OAuth factory 请求保留 provider/model pair，缺 auth/cache 不转原生第三方。既有第三方 `openai-oauth` ID 与密钥、会话路由保留，OAuth discovery 跳过并提示 ID conflict；store 仅附 `blockedNativeIds:["openai-oauth"]`，防止删除第三方后把历史会话同名 ID 回收成官方身份。已存在 OAuth identity 时遇原生同名第三方表，跳过该 import 并提示显式 rename；异常同名重复 store 条目从有效路由中隔离，失败关闭。用户未明确修复历史路由前不自动迁移 ID。

2026-10-05 实测修正：普通官方配置不强制 native cache 为 static catalog，由 selected binary 自行刷新；UI 保留原生配置的官方默认模型 ID，无伪造元数据。第三方 catalog 不继承 OpenAI opaque comp_hash，原生官方 metadata 不变；正常 context-limit / model-downshift 压缩保留。旧 rollout 已记入的错误 hash 不追改，本轮按 user 同版本新会话验收标准测试。

2026-10-05 user 最终裁决：各 provider 有权使用自己的消息、reasoning 和加密状态格式。跨端点历史兼容、延续与 resume 不在 adapter 的保证范围；实测成功仅属当时恰好可用的 flexibility。adapter 负责透明传递失败并在 documentation 中说明边界。不兼容时建议在目标 provider 另起会话。取消跨 provider 自动 compact 候选，不实现、也不建议把 compact 当成格式兼容的补救措施。此前隔离探针仅作历史观察，不能据此承诺兼容性。

2026-10-05 阶段收尾裁决：用户确认测试通过，并明确授权停止 4999、清理现场及 push / publish 0.1.11。此前测试迭代“不 publish / 保持在役”仅描述迭代阶段，不再约束此次发布。跨 provider 格式兼容不属于交付承诺；遇到不兼容时建议在目标 provider 新建会话。见发布收尾记录。
