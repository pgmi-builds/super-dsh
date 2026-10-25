# remote surface：action 派发 + transfer 拆分（2026-10-25）

- 状态：已实现；上游 rc.3 对齐同轮完成。报告：`docs/test-reports/2026-10-25-dsh-021-rc3-and-remote-surface.md`。
- 上游裁决来源：2026-10-24 会话（user 两阶段方案），2026-10-25 user 三条指令合并执行。

## 决策

1. **action 必填、无默认**：不保留「省略 action 再按字段推断」的第二套派发；schema `required` 生效，execute 内同义守卫。
2. **字段只属于一个动词**：`ACTION_PARAMS` 白名单，跨腿字段一律 `E_PARAMS`；不再有静默透传的多余参数。
3. **add 管池，不管会话**：`ssh` 注册身份（不拨号）、`spawn` 建 BYO PTY（warm）；`cmd` 恒为空串。warm creation 从 surface 移除（`exec` 必须执行，预热用 `cmd:"true"`）。
4. **PTY 创建隐式留在 exec**：`<transport>:pty[:label]` 即建即跑，不新增第五个动词。
5. **status 保留浅在场语义**：无 target = roster，有 target = probe/card；不拆成两个动词。
6. **transfer 用 mode 而非 action**：copy/rsync 是搬运方式；字段集与 fail-loud 语义原样迁移。
7. **简介重写**：PTY = stateful oneshot（同回执 + 状态），鼓励默认使用；保留 oneshot 适用场景与 stderr 合并的诚实边界。

## 落地

- 新增 `better-dsh/src/remote/transfer-tool.ts`；重写 `tool.ts` surface 层；`agent-registration.ts` 注册两工具且 all-or-nothing。
- driver/pty-session/copy/rsync/jobs 零改动。
- 测试：8 个 spec 迁移调用形；BYO 用例改两步；新增 action/mode 必填、跨腿字段、transfer 工具独立性断言。
- 文档：`docs/remote-tools.md`、`docs/remote-copy.md`、spec 顶部修订条目、环境备注。

## 未决

- BYO 一步式（注册+执行）已取消；若 user 要保留，需要把 ssh/spawn 并入 exec，等价于部分回退第 1/2 条。
- 4999 浏览器线待沙箱外重启后做真实模型 surface 验收；npm 发布与 git 提交等 user 放行。
