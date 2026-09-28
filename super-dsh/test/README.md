# super-dsh 测试 rigs（种子侧）

唯一种子 = 本目录 [`start-4999.sh`](./start-4999.sh)（入库、幂等；运行 home 在 `.tests/`，gitignored）。
规范、rig 语义与验收层级一律见 **[`docs/07-cordis-dsh-dev-test-guides.md`](../../docs/07-cordis-dsh-dev-test-guides.md)**（本仓唯一通用测试指引）——本文件只留速查，不另立规范。

- **启动**：`bash super-dsh/test/start-4999.sh`（默认 4999 + `.tests/superd` 长寿命 home）
- **旋钮**：`SUPERD_PORT` / `SUPERD_HOME_DIR` / `SUPERD_PROFILE`（+ `SUPERD_TRACE`）；全新 home 临时指 `SUPERD_HOME_DIR=` 即得（用完即删，见 docs/07 §3.2）
- **速记**：端口无主化（测试 unit 占口自动接管）· seed 持久 ⇒ cookie 30 天免重注入 · 重置只动 profile，user data 保留 · session schema **v4**（v4-reader 兜底校验器：`superd-hub/test/system-head*`）
