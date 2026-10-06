# Foreign Agent 接入 Substrate Hub：交付验收

日期：2026-10-06。状态：实现、整包自动行为验收完成；人工 Web 验收与发布放行待 user。无 commit / tag / push / npm publish。

## 结果与交付

PI / OMP 使用同一个原生扩展主体；PI 经 SDK `additionalExtensionPaths`，OMP 经增量 `-e`。Codex 使用已获 user 同意的 app-server `dynamicTools`，工具执行交回 Super D callback。三者均不安装全局插件、不改原生插件目录，不重定向原生 runtime home。普通 native 新会话不会因此出现 Hub facility。运行时正常保存自身会话不等同于全局插件安装。

Hub 工具的 schema、描述与业务执行复用既有 factory。caller 身份由 session binding 决定；PI / OMP wrapper 位于 Super D 测试 home，通过带 session capability 的同机 loopback HTTP 调用。关闭会话撤销 capability 并清除 wrapper。Codex callback 校验 tool / thread / namespace，沿用既有原生 approval 路径。

- Worktree：`/home/u1/workspaces/superd/.worktrees/foreign-substrate`；branch `foreign-substrate`；基线 HEAD `7410543`。
- 主目录上一阶段未提交的 Codex CLI-first / runtime-fetch / provider 工作被复制为基线；本报告不把它们全部计为本轮新增功能。主目录未改动。
- 最终整包：`super-dsh-0.1.11-g.tgz`，位置 `.scratch/superd-pack/`；b 至 f 为本轮中间消费者验收包。
- SHA256：`f274e0794fb8651cdf5bc9feaaa14ce8718fbe4e5d986ec2c18b525022043618`。本机与 dev3 安装的是同一文件，校验一致。
- 官方 DSH 源码与 dev3 安装宿主均为 `0.2.0-rc.2`。上游源码零修改。
- PI adapter 实际使用交付依赖 SDK `0.84.2`；OMP 本机 `18.4.9` / dev3 `18.1.16`；Codex 两端 `0.160.0`。

## 实际模型行为

每个已通过会话均完成：create → prompt → Hub `agents` / `exec` → 原生读取工具 → Hub `send` → 自动收到 Pi 回信 → 测试宿主重启 → cold resume → Hub `exec` → 从保留历史报告原先的准确回信。未把 boot / 工具注册成功算成行为通过。

| 环境 | Runtime / 模型 | 最终验收 session | 重启后输出 | 历史中的自动回信 |
|---|---|---|---|---|
| 本机 4999 | PI / deepseek-v4-flash | `session-68fb334e-b01f-462e-961d-bc613692ba62` | `LOCAL-FINAL-PI-RESUME` | `LOCAL-PI-FINAL-REPLY` |
| 本机 4999 | OMP / deepseek-flash | `session-3860fbd6-9e27-4576-bca1-bf59d248538d` | `LOCAL-FINAL-OMP-RESUME` | `LOCAL-OMP-FINAL-REPLY` |
| 本机 4999 | Codex / openai-oauth gpt-6.1-sol | `session-b00067d0-052b-4777-a6e1-5757c91dd1cd` | `LOCAL-FINAL-CODEX-RESUME` | `LOCAL-CODEX-FINAL-REPLY` |
| dev3 4998 | PI / deepseek-v4-flash | `session-ecc26f01-f4b5-4399-a624-e7fdd8e9a3f7` | `DEV3-FINAL-PI-RESUME` | `DEV3-PI-FINAL-REPLY` |
| dev3 4998 | OMP / deepseek-flash | `session-4d00da25-1d57-486e-90ee-73e55f7fa7cb` | `DEV3-FINAL-OMP-RESUME` | `DEV3-OMP-FINAL-REPLY` |
| dev3 4998 | Codex / openai-oauth gpt-6.1-sol | `session-d4be587b-e015-4d92-bdb5-2b267e3631ee` | `DEV3-FINAL-CODEX-RESUME` | `DEV3-CODEX-FINAL-REPLY` |

六个最终会话均有三个 `turn/end completed`，Hub exec exit 0。模型实际可见的 surface：PI 直接 `superd-hub`；OMP 原生将扩展呈现为 `xd://superd-hub`，先 read 设备指引再 write JSON 调用；Codex 为动态函数 `superd-hub`。原生 read / bash / command execution 和已有资源与 Hub 共存。

证据：本机 `.scratch/local-g-{pi,omp,codex}-summary.json`，目标机及回收副本 `.scratch/dev3-g-{pi,omp,codex}-summary.json`；原始日志继续留在各自长寿命测试 home。summary 是 session/page 的过滤视图，包含模型消息、真实 tool call/result 与 turn/end，不代替原始日志。

补充 Codex DeepSeek 检查：本机新会话 `session-8722de45-6cbb-4572-a930-12394a60a196` 成功调用 Hub agents / exec `LOCAL-DEEPSEEK-DIRECT` 及原生命令读文件。dev3 新会话 `session-c19c051e-aefe-4c29-99f5-e067106844fc` 首轮输出 DSML 文本而未实际调用工具，明确提示后仍未形成已验证调用；此组合未通过，不计入上表。第三方模型工具协议兼容仍有差异，不能由本机成功推导 dev3 成功。另一次 DeepSeek 历史切到 OpenAI 的试验返回 reasoning 格式错误；完整 Codex 验收使用新的原生 OpenAI 会话，未宣称跨 provider 历史切换兼容。

## 验收中修复的真实问题

1. PI / Codex 提前打开 step，与自动回信队列的 user echo 时序冲突；错误结束又可能漏 turn/start。改为在实际内容开始时提交 step，收尾始终保留合法 turn/step 关系。
2. OMP `get_state.systemPrompt` 实际可能是字符串数组，旧投影产生非法 message text，持久化只保存到前缀。现在规范化为文本，真实 cold resume 已读回原历史。
3. PI / OMP 原生自动标题缺少人类消息来源序号，真实 V4 持久化拒绝。补充合法来源，没有人类消息时不产生该标题。
4. 中断时存在未决 tool call，使用真实上游 `ToolCallRecovery` 生成保守恢复结果，再结束 step / turn；不把未知执行结果当成功或鼓励盲目重试。Codex 延迟 tool advertisement 也在 execution start 前正确提交。
5. dev3 Codex 的唯一可用模型模板来自 `models_cache.json`；旧 fallback 没有读取它，生成条目缺必需字段导致 app-server 退出。补齐官方缓存 fallback、修复稀疏旧条目，移除从 OpenAI 模板复制到第三方 provider 的 `tool_mode` / `comp_hash` 专属元数据（保留正常上下文压缩配置）。用户原生目录不改写。
6. 恢复但尚未调用 Hub 的 foreign handle 原先不可被回信寻址；现在独立内存 binding 在创建 handle 时注册，仍保持 draft 零 IO / spawn。

## 检查与工具证据

- PI 58、OMP 81、Codex 264、Hub 532、跨 runtime 生命周期 12、pack contract 3：共 950 项通过，0 失败。
- 生命周期回归调用真实 V4 released relationship validator，包含完整事件类型；覆盖队列回信、启动失败、突然失败、执行中的未决工具恢复。
- 清理重建 / build-all / pack 完成；消费者 profile 经现行 launcher 从 tarball 安装，未用源码链接替代运行时依赖。
- `git diff --check`、launcher shell syntax 检查通过。独立最终只读复核未发现阻止交付的问题，相关 37 项检查通过。
- 实际 LSP 与 AST 入口调查记录在 [入口探测](2026-10-06-foreign-substrate-entry-probe.md)。LSP 当时取得本地结构声明及引用，未深入真实 SDK 定义；不将此结果扩大为完整 SDK 语义核实。运行时官方入口由实际源码和消费者行为共同验证。

## 测试线与边界

本机复用现行 launcher 长寿命 home `.tests/shared/superd`，Web：<https://test.pc.internal.test/>；测试服务与 relay active。

dev3 使用同一 launcher、已安装官方 DSH anchor、同一个 tarball 和预构建测试 WebMCP helper，home `~/workspaces/superd/.tests/foreign-substrate`，Web：<http://dev3.internal.test:4998/>；测试服务与 relay active。预构建 helper 只属于现行测试夹具，不参与业务 adapter。未改生产 Caddy，未操作 3080 / 3081，未写 `~/.dsh` / `~/.superd`；现行 launcher 的凭据 seed 读取保持原机制。

当前 CUA 返回无可用浏览器，故没有声称完成浏览器视觉 / 点击验收。实际模型 surface 与调用经运行会话核验；两条 Web 线继续留给 user 亲手验收。

Codex 0.160.0 的 `thread/resume` 没有 dynamicTools 增量注册入口。此前没有 Hub 的旧 thread 不会自动升级，需新建 Super D Codex 会话；已带定义的 thread 经本 adapter resume 可重新连上执行 callback。原生 GUI 恢复同一 Hub thread 不具有我们的 callback host，属于未支持、未实测的路径，不能承诺原生 GUI 可用此工具。

单独热卸载再挂载 Hub row 会使已加载 PI / OMP wrapper 保留旧地址。此时工具返回 `E_HUB_UNAVAILABLE`，模型提示重启 Super D 并 resume 更新 session binding；透明重绑未实现。完整测试宿主重启后 resume 已通过。README 已披露此恢复边界。

以上完成开发交付与自动验收，不代表 npm 发布放行；没有执行发布或 Git 定版操作。
