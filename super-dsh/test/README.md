# super-dsh 测试 rigs（种子侧说明）

> 对应规范：`docs/07-cordis-dsh-dev-test-guides.md` §3.2（种子/运行 home 分离）与 §3.3（compat/clean 配对 + schema 版本记录）。
> 种子 = 本目录脚本（入库，幂等再生 profile）；运行 home = `.tests/*`（gitignored）。

| Rig | 启动 | home（gitignored） | 角色 |
|---|---|---|---|
| **compat**（默认） | `bash super-dsh/test/start-4999.sh` | `.tests/superd/` | **长寿命**：跨版本验证旧 session log 可读、restart-survival、真实模型回复；credentials/sessions/world homes 跨重置保留 |
| **clean** | `SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/superd-clean bash super-dsh/test/start-4999.sh` | `.tests/superd-clean/` | **每次可弃**：全新 home 的干净启动（首次 boot / world provision / 首会话）；跑完即 `rm -rf` |

- **session schema 版本**：两 rig 当前承载 **v4**（dsh 0.1.7 会话格式；写入侧三铁律见 `docs/test-reports/2026-09-24-dsh-0.1.7-rc.1-alignment.md` §九；`superd-hub/test/system-head*` 有 v4-reader 镜像校验器兜底）。
- **最近兼容验证**：2026-09-24（compat rig：restart-survival + 真实模型回复；dev3 目标机同轮实装）。下次对齐轮后更新此行。
- **端口纪律（2026-09-26 user 裁决）**：用户主要经 LAN 访问。**4999 = 共用测试口**，有 Caddy 代理（`test.pc.internal.test`），脚本直出 wan URL；**非 4999 端口一律由脚本自动拉起 socat LAN 中继**（unit `superd-lan-<port>-relay`，只绑 LAN IP、绝不 0.0.0.0；fence 的 trusted-hosts 已含 LAN IP 的 bare 与 `ip:port` 两形 entry）。4999 被占时脚本拒绝并列出占用者——处置二选一：① `SUPERD_PORT=<空闲口>` 换口起线（relay 自动跟随）；② **user 明确下令放倒占用者**才放倒，绝不静默 kill。脚本幂等重启**自身同名 unit**（`systemctl stop` 后再起）不在此限。
- **重置**：compat rig 只动 `profiles/superd-pub`（脚本每次 `rm -rf` 重建），user data 不动；clean rig 整个 home 可弃。
- 脚本旋钮：`SUPERD_PORT` / `SUPERD_HOME_DIR` / `SUPERD_PROFILE`（默认 `4999` / `.tests/superd` / `superd-pub`；unit、relay unit、日志、profile patch 端口、trusted-hosts 端口形 entry 全部派生）。
- **场景退役（2026-09-24 user 裁决）**：per-agent 场景 rig（standalone app 线、world-plugin 集成测试、live/spike/verify/smoke/probe、真 sidecar spawn）已全部删除——**场景级验证只走本 README 的整包 rigs + dev3 实装**；adapter 侧只留单元测试（fakes / 映射 / 事件转译 / lazy 不变量）。
