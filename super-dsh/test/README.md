# super-dsh 测试 rigs（种子侧说明）

> 对应规范：`docs/07-cordis-dsh-dev-test-guides.md` §3.2（种子/运行 home 分离）与 §3.3（compat/clean 配对 + schema 版本记录）。
> 种子 = 本目录脚本（入库，幂等再生 profile）；运行 home = `.tests/*`（gitignored）。

| Rig | 启动 | home（gitignored） | 角色 |
|---|---|---|---|
| **compat**（默认） | `bash super-dsh/test/start-4999.sh` | `.tests/superd/` | **长寿命**：跨版本验证旧 session log 可读、restart-survival、真实模型回复；credentials/sessions/world homes 跨重置保留 |
| **clean** | `SUPERD_PORT=4997 SUPERD_HOME_DIR=$PWD/.tests/superd-clean bash super-dsh/test/start-4999.sh` | `.tests/superd-clean/` | **每次可弃**：全新 home 的干净启动（首次 boot / world provision / 首会话）；跑完即 `rm -rf` |

- **session schema 版本**：两 rig 当前承载 **v4**（dsh 0.1.7 会话格式；写入侧三铁律见 `docs/test-reports/2026-09-24-dsh-0.1.7-rc.1-alignment.md` §九；`superd-hub/test/system-head*` 有 v4-reader 镜像校验器兜底）。
- **最近兼容验证**：2026-09-24（compat rig：restart-survival + 真实模型回复；dev3 目标机同轮实装）。下次对齐轮后更新此行。
- **端口纪律**：4999 = 共用测试口（整机共享；脚本 `ss` 预检，占用即拒，他人/其他 agent 在用时不碰）；clean rig 自选空闲端口（非 4999 无 Caddy 映射，LAN 暴露走 socat，脚本输出有提示）。
- **重置**：compat rig 只动 `profiles/superd-pub`（脚本每次 `rm -rf` 重建），user data 不动；clean rig 整个 home 可弃。
- 脚本旋钮：`SUPERD_PORT` / `SUPERD_HOME_DIR` / `SUPERD_PROFILE`（默认 `4999` / `.tests/superd` / `superd-pub`；unit、日志、profile patch 端口、trusted-hosts 端口形 entry 全部派生）。
- **场景退役（2026-09-24 user 裁决）**：per-agent 场景 rig（standalone app 线、world-plugin 集成测试、live/spike/verify/smoke/probe、真 sidecar spawn）已全部删除——**场景级验证只走本 README 的整包 rigs + dev3 实装**；adapter 侧只留单元测试（fakes / 映射 / 事件转译 / lazy 不变量）。
