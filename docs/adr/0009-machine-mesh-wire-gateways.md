# Machine Mesh：wire 形态 GatewayFace 与全权 consumer 配对模型

2026-09-27 accepted（brainstorming 收敛，spec `docs/specs/machine-mesh-a2a/spec.md`）

## 决策

1. **远端 agent 以 wire 形态 GatewayFace 接入，不派生任何本地容器**：
   `RemoteGatewayFace`（HTTP envelope POST + WS mux client，指向远端 `/hub` 家族）
   注册进现有 gateway 注册表（`targets.ts` 既定预言的实现），与本地 world 网关
   同型同权。浏览器永远只面对本机 ctx0 的单一 origin 与单一认证域。
2. **配对 = 一次 token→cookie mint，配对方即全权 consumer**：不建新凭证体系、
   不做权限分级（v1）；per-machine `execEnabled` 旋钮与审计为唯一附加闸。
   单向添加先行。
3. **寻址 = owner 铸造的短 ID 传播**：machine 4 位 / agent 6 位随机字符，
   由被标识物的归属方铸造并经 roster 探测传播，peer 原样采纳；本地 label 保留
   为显示与兼容别名。

## 理由

- 0.1.5+ 的 native-ui-only 地基（`/hub` 单一路由家族 + `?agent=` demux +
  fusion transport）使"远端接入"退化为注册表多一个条目：UI、switch、
  session 数据面零改动即消费远端 agent——任何 per-agent UI 容器方案
  （含曾经的 CTX7+ 设想）都被此地基取代。
- ADR 0007 已源码级取证认证链（launch token 一次性 mint HMAC cookie，
   签名密钥持久 ⇒ cookie 跨上游重启 30 天）；"远端 hub 的又一个 consumer"
   是该模型的最小扩展，零新面。
- wire 上跑的就是本机浏览器同款流量（envelope + mux 帧，dsh pin 窗
   `>=0.1.5-0 <0.3.0-0` 背书兼容性），无需独立协议版本工程。

## Consequences

- **S4 例外条款**："零 HTTP、零字节代理"约束的适用范围收窄为**浏览器面**
  （浏览器 ↔ 本机 ctx0 仍是唯一 origin）；hub-to-hub 出站 wire 为认可形态。
  `targets.ts` 头注（"out-of-process target … over the wire (ADR 0007
  loopback relay) — the caller cannot tell the difference"）自本 ADR 起兑现。
- A2A / exec / roster 联邦全部消费同一 GatewayFace 与同一 cookie，不另开
  信任通道；A2A 回投依赖"发起方持 cookie 订阅目标会话流"，双向配对非刚需。
- 本机成为远端 agent 数据面的必经之路（proxy 一跳延迟）；换得跨域零配置、
  认证零新面、UI 零改动。
- ID 碰撞在 HomeLab 规模可忽略（4 位机器 ID @10 台 ≈ 0.003%），采纳时
  fail-loud；不接受 silently rename。
- 取代蓝图 §6 遗留的 standalone Machine Manager 设想与 teleport §5.1 中
  "Remote superD 委托"档的容器化想象——形态更薄。
