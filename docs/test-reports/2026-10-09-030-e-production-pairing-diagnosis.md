# 0.3.0-e 生产配对问题诊断

2026-10-09。用户报告：两台生产 DSH 经 Plugin Manager 安装后，PC 无法重新添加 DEV3（token mint 返回200但没有认证 cookie）；Mac Desktop 能添加 PC，但 PC 没有对应灰色 incoming 记录。

## 已确认的事实

生产只做安装文件、日志和 HTTP 接口的只读检查，未重启、改配置、安装、删除或写入 pairing 表。

| 检查 | PC | DEV3 |
| --- | --- | --- |
| profile 磁盘 Super / Better 版本 | 两包均0.3.0-e | 两包均0.3.0-e |
| e 的 gateway / mesh-link 文件哈希 | 与发布构建一致 | 与发布构建一致 |
| 运行中 Hub 自报版本 | **0.3.0-d** | 未取得认证后的 roster，自报版本未核实 |
| 当前进程 launch token 请求根路径 | 303，签发原生认证 cookie | 200，返回密码页，没有 cookie |
| `/superd/pair-auth`（e新增） | 404 | 404 |

PC 的生产机器列表当前为空，与用户已删除 DEV3、Mac incoming 缺失的描述一致。生产服务最近启动时间分别为香港时间12:19:20、12:27:47；e 安装后的 profile manifest 最后落盘时间分别为17:35:56、17:50:39。时间仅作过程线索；PC 自报d和接口行为才是运行代码仍旧的直接证据。

结论：安装包已经是e，生产进程尚未完整切换到e。PC明确仍运行d；DEV3没有e认证入口，运行状态同样与e交付形态不符。不能把磁盘版本、Plugin Manager 安装成功等同于当前运行版本，也不能把DEV3根路径200当作认证成功。

## 两个现象的链路

PC目前的根 token 交换能签发 cookie，所以DEV3和Desktop可以连接PC。DEV3根路径被密码页接管，旧 Super pairing 在200响应里找不到 cookie，直接报用户看到的错误。e会在这种情况下调用独立的原生 token 交换入口，但生产DEV3没有加载该入口。

Mac反向 offer 到PC时，d的接收逻辑尚不支持先按UID保存incoming记录。旧逻辑把 `dsh-app://app` 送进只接受HTTP(S)的普通添加路径，在保存前拒绝。因此Desktop的 outgoing 可成功，mutual toast 会失败，PC却没有灰色行。

## 隔离复现与e行为复核

- 用本仓保留的d/e整包、真实DSH Cordis Loader复现：先导入d，再用e tarball替换同一路径，重新导入仍得到同一个旧模块。报错仍包含用户给出的 `(status 200)`；新进程导入e后，错误文案变为e版本。此诊断用于验证模块缓存机制，不冒充完整Plugin Manager GUI操作或Electron验收。
- 同一d接收模块处理携带UID的 `dsh-app://app` mutual offer，返回400 `origin must be http(s)`，在写入前拒绝。
- 在仍运行的整包PC4999、DEV3隔离4998（本机4996测试载体）上，当前Hub均自报0.3.0-e；两端token mint、认证roster均成功，分别有7个本地agent。
- PC4999真实管理API收到诊断用custom-scheme incoming offer，保留UID `te01`、地址 `dsh-app://app`，状态unreachable；反向失败但记录保留，agent roster中该UID有0个agent，原有其他配对记录保留。这是接收端HTTP行为复核，**不是实际Electron发起验收**。该诊断行保留供查看。
- 实际使用TypeScript LSP检查定义、引用、调用关系，覆盖官方 `installBundle`、本仓 `receivePairing` 和gateway `apply`；官方Loader `import`定义取得，进一步references请求超时，未声称该项完成。TypeScript AST核实安装、reload、import、mint和incoming函数结构。官方包管理路径重组配置并import，并不保证同路径已加载模块换成新字节。

证据目录：`.scratch/030e-production-pairing/`，含 `production-installed-readonly.json`、`production-pc-roster.json`、`production-auth-readonly.json`、`cache-repro.json`、`cold-e-mint.json`、`e-gray-receipt.json`、两份LSP记录及AST结果。证据不输出launch token或cookie值。

## 下一步与授权边界

建议在e安装完成后分别重启PC、DEV3的生产 `dsh.service`，再核实运行Hub版本、独立认证入口及PC到DEV3的配对。此操作尚未执行，按根AGENTS生产重启红线等待用户单次明确授权。

重启不会凭空补写此前已被d拒绝的Mac记录；PC加载e后，需要Desktop再次发送一次pairing offer。生产Mac端的完整复验仍待该请求实际到达。当前不修改业务代码、不发布新版本；先消除已证实的运行版本错位，再评估是否仍存在独立缺陷。

本轮也暴露上一轮验收缺口：此前完整消费者线以新进程启动整包，未验证生产运行进程中的卸载/重装后模块是否确实切换。测试线保留：[PC4999](https://test.pc.internal.test/)。

## 用户复验与收尾

2026-10-09 18:37（香港时间）。用户确认已自行重启PC、DEV3和MacBook Desktop，并重新添加配对，观察到灰色不可达状态，接受本轮结果并明确要求停止测试线。本段记录用户实测与接受结论；不把灰色状态记为双向连接可达的独立验收。此前等待agent生产重启授权的建议不再需要执行。

已停止PC的 `superd-4999-test`、`superd-4997-test`、对应14999/14997测试registry及4996到DEV3的SSH测试转发；已停止DEV3的 `superd-4998-test` 及14998测试registry。用户写的44999在两端均未发现监听，本轮已知主线4999一并关闭。停止后两端 `ss` 核实这些端口均无监听，运行中的 `superd-*` service为0；两端生产 `dsh.service` 仍为active。测试home、会话、配对数据和证据保留，未修改生产配置或Caddy。以上PC4999测试访问地址现已关闭。
