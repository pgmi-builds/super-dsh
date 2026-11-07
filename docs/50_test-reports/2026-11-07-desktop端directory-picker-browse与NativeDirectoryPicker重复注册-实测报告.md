# super-dsh 桌面端 directory-picker-browse 与 NativeDirectoryPicker 重复注册 bug 报告

- 日期：2026-11-07（Asia/Hong_Kong 15:24 首次观察）
- 环境：macOS DeepSeek Harness Desktop（app.asar 内置 DSH），desktop profile
- super-dsh 版本：0.3.4-c（better-dsh 亦已装并启用）
- 类型：小 bug / 安装体验（warning 噪音），不影响 super-dsh 功能

## 现象

在 macOS DSH Desktop 桌面应用的 Plugins 页安装或启用 super-dsh 时，弹出警告：

```
Could not enable: dsh: warning: 1 entry did not activate
directory-picker-browse (@deepseek-ai/dsh-host-directory-picker-browse):
Error: service "directoryPicker" has been registered at <NativeDirectoryPicker>
```

`list_plugins` 显示该行 `enabled: true, fiberPhase: "failed"`；super-dsh 其余全部 entry（superd-hub、fusion-transport、a2a、agents/*、join）均正常 active。

## 根因

directory-picker seam（@deepseek-ai/dsh-host-directory-picker）规定**恰好挂载一个 backend**，第二个实现加载时抛标准 duplicate-service 错误：

- 桌面应用宿主自身已 ship 原生 backend（`<NativeDirectoryPicker>`，OS 选择器）；
- super-dsh 的 bundle 又启用了 in-app browse backend（`dsh-host-directory-picker-browse`，供远程浏览器客户端列目录/建目录用）；
- 桌面端两者并存，browse 输掉注册竞争 → 每次安装/启用都弹这条 warning。

## 现场处置（2026-11-07 已做）

1. `plugin_manager set_plugin target=include:directory-picker-browse enabled=false` → applied，warning 消失，super-dsh 全部 active。
2. 另装了一个 workspace 记录性 bundle `@local/desktop-native-picker`（patch：`- id: include:directory-picker-browse / disabled: true`）。

注意：直接在插件 bundle 的 patch 里用 `- id: include:directory-picker-browse / disabled: true` 覆盖**没有生效**（row 仍 enabled/failed），set_plugin 的 profile 层覆盖才生效 —— 优先级层级值得在下一次更新时核实。

客户端侧的 `dsh-client-ui-directory-picker-browse`（surface 行）保留启用无害：无 browse capability 时 UI 自动隐藏该交互。

## 下一次更新建议纳入的 change

在 bundle patch 中按运行环境条件化挂载 directory-picker-browse：

- 方案 A（推荐）：该行 `disabled` 用 `!!js` 表达式在 mount 时检测桌面/宿主原生 picker（或 profile 类型），仅 Web/远端 host 启用；
- 方案 B：文档声明桌面端需手动 disable 该行，README 增加 known-issue 说明；
- 顺带核查 patch 层 `id` 覆盖 disabled 的优先级为何低于 set_plugin 层（本次实测未生效）。

## 影响

- 功能：无损失。桌面端本来就该用原生 OS 选择器（操作者在宿主显示前）；browse backend 仅远程浏览器客户端需要。
- 体验：每次安装/启用 super-dsh 弹一次警告，用户易误认为安装失败。
