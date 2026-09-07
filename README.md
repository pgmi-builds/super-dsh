# Super D (superd)

多 Agent 运行时的统一入口——桥接层 App。不提供运行时：把本机与远端已有的
Agent 运行时映射到 DSH Web UI 可消费的数据面。设计文档见 `docs/`（蓝图 v0.4a +
组件边界 v0.3 + ADR 0001–0007）。

## Dev（P1 骨架）

```bash
npm install --cache .npm-cache
npm run superd -- web --port 4999 --home .superd-test   # dev 实例：4999 + 仓内 home
```

- 默认端口 3090；dev 一律 4999（共用惯例，用完即停）。
- home 默认 `~/.superd`；`--home`/`SUPERD_HOME` 覆盖；用户 `DSH_HOME` 永不被继承。
- `superd web --dump-config` 打印组合后的插件行表。
- 上游参照 checkout：`upstream/deepseek-harness`（pristine `dsh-v0.1.3-alpha.2`，gitignored，勿改）。

## Test

```bash
npm test          # vitest 单测 + 4999 集成冒烟
npm run typecheck
```

## Layout

- `src/` — superd CLI（bin 薄壳 + web 启动器 + home 解析）
- `packages/superd-web-bundle/` — web 面 bundle：载体 + 中性底座 roster patch + 胶水插件
- `docs/` — 蓝图、组件边界、ADR、研究档、实现计划（`docs/superpowers/plans/`）
