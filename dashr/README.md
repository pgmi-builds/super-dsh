# dashr — dsh distro（筹界定，尚无代码）

> **定位**：dashr = **dsh 发行版（distro）**——把上游 dsh 与全部 better-dsh 组件
> （repl / url-schemes / failover / compaction-tuning / web-trust / mobile，及其后续新包）
> 预组态成一个开箱即用的发行面：一份 bundles 组合 + patch 底座 + kernel 供给 + 移动端/
> 信任栅栏默认值，用户一次安装即得完整体验，无需逐个插件拼装。
>
> **与 `../better-dsh/` 的关系**：better-dsh 是 **dsh 插件包**（npm `@pgmi-builds/better-dsh`，
> 组件化、可独立发布、装进任何 dsh）；dashr 是 **组合与交付层**（消费 better-dsh 各包，
> 不重复实现它们）。类比：better-dsh = 组件集，dashr = 用这套组件装好的整机。
>
> **状态（2026-09-23 更新）**：bun 单文件二进制发行线已落地——构建体系在 **`port/`
> 移植仓库**（见下 §构建），首个可用产物 = **dashr-linux-x64 单二进制**（含 dsh-base ∪
> dsh-web-app 闭包与全部 agent presets，`bun build --compile` 产物）。better-dsh 各组件
> 的随包组合随 stage-2（post-built 插件动态装载线）并回。版本与 tag 命名、与上游对齐
> 节奏的绑定方式——见根 AGENTS.md 与仓库编排讨论结论后再立。
>
> **红线继承**：本仓 Development Operation Contract（根 AGENTS.md §〇）对 dashr 同样生效；
> 发布前三闸（第一人称实测 → 报告 → user 放行）不豁免。

## 构建体系（port/，2026-09-23）

旧的 `src/` patch-系列构建机制已退役（fresh-start 账本裁决，spec §9）。distro 构建的
唯一正源 = **`dashr/port/` 移植仓库**（自包含 git 仓）：构建入口
`dashr/port/scripts/dashr/build.sh`，规格书 `dashr/docs/specs/dashr-bun-port/spec.md`；
port 仓对上游（deepseek-harness）的一切合并经 git tag 走 pristine tag 快照，永不就地
开发 upstream 工作树。

## 发行渠道（设计，未发布）

npm 通道（目标形态，esbuild/turborepo 同款）：`dashr` umbrella 包（bin shim +
`optionalDependencies` 平台组）+ `@dashr/dashr-<os>-<arch>` 平台包（纯二进制载荷，
os/cpu 门）。用户侧 `npm i -g dashr` / `bun i -g dashr` 即装即用（bun 与 npm 同读 npm
registry，无需新生态）。备选/并行：GitHub Releases 附安装脚本。**任何实际 publish
走根 AGENTS.md §〇 三闸。**
