# AGENTS.local.example.md — 本机事实 overlay 模板（入库；复制为 AGENTS.local.md 后填本机真实值）

> `AGENTS.local.md` 不入库（已在根 `.gitignore`）。分层判据：**原则 = 任何克隆者都该遵守 → 入库 AGENTS.md；事实 = 只关于这台机器 → 本文件。**
> 维护约定：真实敏感串同时登记进 `scripts/leak-patterns.local.txt`（同样不入库），由 `scripts/check-leaks.sh` 在 pre-commit / CI 拦截再入库。

## 1. npm 凭据

- 位置：`<仓外受控路径>/npm.env`，变量 `NPM_ACCESS_TOKEN`（账号 `<org>`）。
- 发布时把 token 写进 0600 临时 npmrc 并以 `NPM_CONFIG_USERCONFIG` 指向它，发布结束立即删除；token 不得进入仓库、长期 npmrc 或报告。

## 2. 测试线域名映射（入库文档一律写占位域 `*.internal.test`）

| 入库占位 | 本机真实值 |
| --- | --- |
| `test.pc.internal.test` | `<4999 测试线域名>`（Caddy → 127.0.0.1:4999） |
| `dsh.pc.internal.test` | `<dsh 生产域名>` |

## 3. 目标机与生产拓扑

- **`<staging 目标机名>`** = staging 目标机（tarball 实装流程：`<包管理器> add file:` → restart → journalctl 计数 + 探针）。
- 生产 home 与端口：`~/.dsh`、`~/.superd`；`<prod 端口>`。生产重启、关停、live 反代修改必须 owner 明确授权。

## 4. 本机测试参数

- 共用 credential seed：`$(dirname $REPO)/.dsh-test-credentials.yaml`（`DSH_TEST_CREDENTIALS` 可覆盖）。
- 本机浏览器路径、LAN IP、`TRUSTED_HOSTS` 真实值等以环境台账与本机 env 为准。

## 5. 本机敏感词表（与 scripts/leak-patterns.local.txt 同步）

- 域名：`<真实域名>`
- 真实主机 IP：`<真实 IP>`
- 豁免（可入库）：工具/文档中的示例主机名与示例 IP、docker 标准网段。
