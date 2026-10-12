# Better Dash Python REPL：移植 OMP 执行链与快照边界

状态：两阶段已实现并完成 `0.3.0-s` 整包消费者验收；整体验审发现的检查点目录失败边界已修复，37 项相关回归与两条类型检查通过；`0.3.0-t` 在 PC 与 dev3 的实装增量复验也已完成。尚未获得发布放行。2026-10-12 user 明确批准第一、第二阶段一起实施。原调研日期：2026-10-11。见 [执行计划](../../superpowers/plans/2026-10-12-omp-python-repl-port.md) 与 [验收报告](../../test-reports/2026-10-12-omp-python-repl-port.md)。

## 1. 方向

“抄 OMP”指将所需源码复制到 Better Dash 自有源码中，完成本地 Node、DSH、Cordis 接口适配并随 `better-dsh` 交付；不 import OMP 包，也不要求消费者安装 Bun。现有 AST device 已有同类剥离先例：`better-dsh/src/devices/ast/ast-device.ts`。

第一阶段以 OMP Python REPL 的运行语义为基线，**`runner.py` 逐字节复制，保持原文件不改**。复制的 Python runner 本身不依赖 IPython、ipykernel、Jupyter 或 ZeroMQ，只使用 Python 标准库。根据实际采用的便利函数，将 OMP `prelude.py` 一同纳入并注明来源；它和 OMP 专有的 Agent 桥接需要在 Better 的工具面上作取舍。宿主侧从 OMP 的 TypeScript kernel、共享 IPC 与会话管理中抽取所需逻辑，接上 Better 的 `ReplRuntime`、工具绑定、输出、取消、reset 和生命周期接口。`Bun.spawn` 换成 Node `child_process.spawn`；Bun 的脚本文本导入换成包内 `.py` 资源路径。Better 的 TS 在构建时编译为 JS，运行时不执行 TS。

新路径是 `Better/Node → stdin/stdout JSON 行 → Python runner → Python 解释器`。因此可移除这条路径上的 IPython、ipykernel、Jupyter client 和 ZeroMQ 需求；**Python 解释器仍是运行前提**。是否随包交付解释器是另一项决策，不由移植 OMP 自动解决。第一阶段按 OMP 策略保留进程内会话状态，不承诺进程重启后的变量恢复。

复制时固定一个 OMP commit，保存原始文件、许可证和来源记录；若 `runner.py` 原样复制，校验其字节哈希。本文调研时的 OMP HEAD 为 `fa5ff4a3a977a28b93d025f4cf50f046e019f18c`，实施时应以实际复制的 commit 为准。MIT 许可声明随交付物保留。

资料：[OMP Python REPL 说明](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/python-repl.md)、[runner.py](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/eval/py/runner.py)、[TS kernel](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/eval/py/kernel.ts)、[共享 IPC](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/eval/kernel-base.ts)、[MIT 许可](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/LICENSE)。

## 2. “快照恢复”恢复什么

快照是**会话运行时 Python 用户命名空间的一份持久检查点**，用于 Python 子进程死亡、插件重启或同一会话恢复时，让新进程尽量接续旧 REPL 中由模型创建的值。例如 `x = 3`、列表、字典、对象实例、可序列化的函数或类，以及 Better 经 `setVar` 放入命名空间的值。它不是模型聊天记录或 compaction 摘要；那些属于 DSH 会话数据。也不是“把整个 Python 进程冻住”。

| 状态 | 是否属于快照目标 | 说明 |
| --- | --- | --- |
| 每会话的用户变量及其可序列化对象图 | 是，best effort | 核心恢复对象；按会话键隔离 |
| 检查点序号、格式、解释器及环境标识、跳过项 | 是 | 判断能否加载、丢失了多少轮、向模型准确报告 |
| Better 的宿主工具绑定、prelude、IPC、事件循环 | 否 | 新 runner 启动时重新建立；不得把旧进程句柄反序列化 |
| DSH 对话、工具日志、compaction、文件内容 | 否 | 各有独立持久化和真实来源；快照不复制它们 |
| 打开的文件/套接字、子进程、线程、数据库连接、锁 | 否 | 与旧 OS 进程绑定；恢复后需重新打开 |
| `cwd`、环境变量、`sys.path`、模块缓存和库内部全局状态 | 默认不保证 | 启动配置可重新应用；用户代码造成的任意进程副作用不能由变量快照完整重建 |
| 对外副作用，如文件修改、网络请求、工具调用 | 否 | 已发生的副作用不可通过恢复变量撤销，也不可盲目重放代码 |

特别要区分：会话**活着时**，OMP runner 中的变量自然跨 cell 保留；需要快照的是**旧 runner 退出、新 runner 启动**这个边界。OMP 自身的 compaction 只提供有限的运行时提示，不恢复新进程中的历史变量值。[OMP eval 文档](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/tools/eval.md)

## 3. 若第二阶段加快照：技术边界

快照功能放在 Better 自有扩展层，仍保持复制的 `runner.py` 字节不变：在没有用户 cell 并发执行的时点，由宿主发送内部 cell，在同一用户 namespace 中读取 `globals()`、过滤 runner/prelude/Better 内部绑定，并调用随包交付的快照辅助逻辑。恢复时先启动 runner、完成初始化与 prelude，再运行内部恢复 cell，最后允许用户 cell 进入。内部 cell 必须不污染可见结果和用户变量清单。若这一方式经实测无法满足隔离要求，再单独裁决是否改 runner；不能暗中把“原样复制”改成 fork。

触发点：完成的用户 cell 后尝试保存最新检查点；正常关闭时可再尝试一次。`reset` 清除内存与磁盘检查点。异常终止时只使用**已经完整提交**的最近检查点，不重放死亡时的 cell，也不假装它执行成功。检查点写入临时文件、验证大小与格式后再原子替换；失败或超限保留上一份可用检查点。每个会话单独存放，首次启动或故障重启只尝试恢复一次。

### 3.1 `dill` 随包源码交付的裁决

以 Better 当前锁定的 `dill==0.4.1` 为基线，将其 Python 包源码复制到 Better 的交付资源中，让子进程直接从包内路径 `import dill`，不在消费者机器上执行 `pip install dill`。保留上游 BSD-3-Clause 许可、版本和来源记录。优先保持 vendored 源码原样；Better 特有的 namespace 过滤、检查点格式和错误报告放在自有快照辅助层，避免改动 dill 内部。`dill` 自身不是解释器，Python 解释器仍需由宿主或另行交付。

包体积实测（PyPI 的 0.4.1 `py3-none-any` wheel）：压缩 wheel **120,019 bytes**；其中 `dill/` 目录的 46 个 `.py` 文件展开为 **350,717 bytes**，排除自带测试后 14 个 `.py` 文件为 **245,541 bytes**。这些是 Python 源文件体积，不含打包后的 npm 压缩率或解释器体积。wheel 元数据没有默认 `Requires-Dist`；`objgraph`、`gprof2dot` 是可选诊断功能的 extra。PyPI 页面列出的 `setuptools` 是构建/安装要求，不是把已复制的 `dill/` 源码导入并运行时须安装的包。上游声明支持 Python/PyPy ≥3.9。资料：[PyPI dill 0.4.1](https://pypi.org/project/dill/0.4.1/)、[dill 源码](https://github.com/uqfoundation/dill)、[BSD 许可](https://github.com/uqfoundation/dill/blob/master/LICENSE)。

衔接点是 OMP runner 的用户 namespace，与 IPython 或 Jupyter 协议无关。在 2026-10-11 的历史隔离探针中，未修改的 OMP `runner.py` 使用随进程路径提供的 dill 0.4.1：第一个 Python 子进程创建 `x = [1, 2]` 与引用 `x` 的 lambda，内部 cell 用 `dill.dump` 保存变量字典；第二个全新子进程用 `dill.load` 和 `globals().update` 恢复，随后 `f(4)` 得到 `5`。这项历史探针只证明基本衔接可行，不能证明任意对象都可恢复。当时尚未经过 Better 真实交付测试；2026-10-12 的 `0.3.0-s` 整包已在 PC4999 与 dev3 独立实装完成原生模型验收，具体结果与限制见上方验收报告。

Best effort 不应退回普通标准库 `pickle`，否则对 REPL 函数、闭包等的覆盖可能明显缩小。仍会有 dill 无法序列化或恢复的对象，以及依赖缺失或环境不一致的对象；这些值允许跳过并报告。要注意：把整个变量字典一次 `dill.dump` 时，一个坏值可使整份失败；若要“丢弃坏值并保住其他变量”，须由 Better 自有层实现筛选与部分恢复记录，并验证对象间引用关系。不能只捕获一次异常就声称做到了按变量 best effort。也不能重放任意历史 cell 来假装恢复，因为副作用可能重复发生。

`dill.load` 会执行反序列化逻辑，因此只加载本会话受控目录中的检查点，目录权限和会话键隔离属于恢复边界；不要把外来 `.dill` 文件当作数据导入。

## 4. Best effort 的具体承诺

可以沿用现有 best effort 标准，但必须**如实暴露恢复结果**，不能把“找到快照文件”等同于“状态完整恢复”——当前 `dill` 实现也会因不可序列化对象、超限、超时或环境变化而退化。

1. 保存与恢复都允许失败，失败不阻止 REPL 从空命名空间继续运行；失败原因写入日志和模型可见结果。
2. Manifest 记录检查点轮次、格式、Python/环境标识、大小和保存覆盖情况。恢复前校验；不兼容或损坏时明确报告空状态。
3. 若只恢复部分变量，应报告“部分恢复”及跳过的名称或数量；**不能报告“已恢复整个 namespace”**。对象间共享引用和依赖关系无法保持时也应视作部分恢复，或整份拒绝。
4. 模型须知道最新成功检查点的轮次，以及检查点之后哪些 cell 可能丢失；故障时观察到的那次调用不自动重试。
5. 资源句柄、网络连接和其他进程副作用始终超出承诺；用户代码应能检测和重建这些资源。

因此，第二阶段的目标是“尽可能恢复模型的 Python scratchpad 变量，并准确报告缺口”，不是恢复整个 Python 进程。是否加这一阶段，不影响先完成 OMP 执行链移植与去除 Jupyter/ZMQ 依赖。
