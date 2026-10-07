# Agent runtime 图标资产包（superd-hub/assets/icons）

Super D 的 runtime 图标正本目录（spec `docs/specs/hub-roster-identity/spec.md` §2）。渲染层不直接引用本目录——`scripts/build-icon-assets.mjs` 按 `manifest.json` 把**被映射到的资产**内联进 `src/client/icon-assets.gen.ts`（base64 data URI），`src/client/runtime-icons.tsx` 按 `runtimeId` 查表。未映射的资产不进 bundle，只作为采集库存放在此。

## runtimeId（匹配键）

统一标识 = adapter 包名的 unscoped 形态（`agent-omp`、`agent-omp-sdk`、…）；native DSH 恒为 `native`。约定 codified 在 `superd-hub/src/roster.ts` 的 `runtimeIdOf(key)`，随 roster/probe 全链路传递。remote 传来本地没有映射的 runtimeId 时渲染 fallback（subagent artwork）。

## 来源

- **PNG（38 枚）**：ORCA（`stablyai/orca`）`src/shared/agent-icons/`，取自 commit `c8dcffce46d92ddbb1f511baf88df60d322f4ac1`，文件名保持 ORCA 原名（`antigravity.png`、`hermes.png`、`dsh.png`…），便于整目录再同步。本线此前 inline 的 hermes/agy 两枚与该集合 byte-identical（已验证）。
- **SVG（4 枚）**：本线 bundle 早期 inline 的 mark 落盘——`omp.svg` / `pi.svg` 与 ORCA `agent-icon-glyphs.tsx` 的内联手稿同源；`claude.svg` / `codex.svg` 为早期采集，精确上游出处未记录（已知形态与 simple-icons 系一致）。
- **`dsh-fish.svg`**：Super D 自绘的 FishLogo 几何（官方站点蓝 `#4D6BFE`），非 ORCA 资产。

## 规则

1. **加一个 runtime 图标**：资产文件放进本目录 → `manifest.json` 的 `map` 加一行 `runtimeId → 文件` → 跑 `node scripts/build-icon-assets.mjs`（`npm run build-client` 会自动前置）→ 提交生成物。
2. **多对一是常态**：SDK 半线与主线路是同一个 agent 的不同 transport，映射到同一资产（`agent-omp` + `agent-omp-sdk` → `omp.svg`）。
3. **tile**：自身墨色会在深色画框上消失的资产（codex 黑线白底、pi 白线黑底）在 `tiles` 里声明不透明衬底色，渲染层据此加圆角衬底。
4. **新资产落盘前**确认许可与品牌使用范围；README 的来源段同步更新。
