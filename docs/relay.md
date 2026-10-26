# Relay 实现说明

## 内部连接格式

Harness 从握手开始就使用 `hrp.relay.pb.v1`。上行始终 HarnessForward，下行始终
RelayForward。认证、注册、配对等 Relay 本地 RPC 的 route_id 为空；此时不注入 principal。
业务请求 route_id 非空且由 Relay 分配。Harness 必须保留请求的 harness_id 和 request_id，
响应 reply_to 等于请求 request_id，包装 route_id 原样返回。

新增 RelayForward.connection_id 是 Relay 生成的手机连接身份。它与 device_id 不同，
同一设备重连也会改变；Harness 应用它绑定审批 token、订阅与临时资源。
RelayForward.principal 是已验证用户/设备/角色/ACL 版本。客户端不能自报这些字段。

Harness 认证成功后，Relay 先发 auth.prove 响应，再发内部 membership.snapshot 请求。
该内部请求 route_id 非空，无用户 principal；Harness 原子应用完整 ACL 并响应
MembershipSnapshotResponse。只有响应版本与当前版本一致时才开放手机业务转发。
新成员加入、Harness 重连都会重新同步；旧版本 ack 不能打开闸门。
Relay 启动不自动推送会话目录或任何历史。

手机断线时，Relay 对该设备有成员关系的在线 Harness 发送内部 Event：
`relay_connection_closed`。事件携带 connection_id，包装也携带相同 connection_id 和
可信 principal；route_id 为空。它不需要响应。Harness 必须清除该连接的订阅、审批
凭证和待处理临时路由，但不能取消 Agent 或删除 Session。Harness 的 Relay 连接丢失时，
应直接清理该 Relay 连接上的全部临时状态，不能等待此事件。

业务事件上行 route_id 为空，Envelope 必须带 harness_id 与 subscription_id。
Relay 只向这个订阅所绑定的手机连接发送，校验来源 Harness 连接和事件内 session_id。
不能用一次 RPC 的 route_id 广播事件。手机尚未 follow 时事件直接丢弃。

## 资源与失败处理

- 每消息最多 1 MiB；二进制之外的业务消息、无效 Protobuf、超限帧关闭连接。
- 每连接最多 64 条待发帧、128 条未完成业务请求、64 条活动加待完成订阅。
  慢客户端的有界队列满即关闭连接，Harness 的 AgentLoop 不应等待转发。
  单帧写入最多等待 5 秒。Relay 总连接上限 4096。
- 每 IP 未认证握手/消息合计最多 120 次/分钟，认证后消息最多 2400 次/分钟。
  两者使用独立计数桶，超过限制关闭连接。同一 NAT 下设备共享 IP 配额。
- 未认证连接和挑战最多 30 秒。认证有效期 24 小时，届满重建连接并重新证明。
- 每 15 秒发 Ping；45 秒没有对端帧则清理连接。
- RPC 路由最多保留 30 秒，超时返回 SUBSCRIPTION_RESET_REQUIRED；变更可能已被 Harness
  接受，客户端必须用原 client_operation_id 重试，不能创建新的操作 ID。
  follow 超时还会关闭手机连接，以通知 Harness 清理可能已安装的观察者。
- membership.snapshot 30 秒内未有效确认即关闭 Harness 连接。
- Harness 断线向待响应请求返回 HARNESS_OFFLINE，并向有效订阅发送 SubscriptionReset。
  手机断线删除 pending routes 和订阅；没有跨重连回放。两种断线都不触发 agent.cancel。
- SIGINT/SIGTERM 停止接收并关闭所有 WebSocket，随后退出。

Relay 仅检查成员层授权；Session ACL、审批 token 和时间校验、Inbox 调度、durable seq、
业务幂等、模型选择时机是 Harness 的职责。Relay 会检查基本字段、模式和操作 ID，
但不替代 Harness 对收到的每次请求进行独立验证。Relay 不缓存 Session 正文或审批 token。
身份存储目前使用单个 SQLite 连接，由 Relay 状态锁串行化短事务；当前面向单实例部署。

## 当前实现边界

没有成员撤销管理接口，因此不宣称已验证在线撤权闭环。完整 ACL snapshot 已有版本
屏障；以后加入撤权入口时，还须同时关闭该成员订阅、失效审批及应用 Harness ACL。
不得在运行中手动修改数据库作为撤权方式。

HarnessStatus.adapter_version 暂为空；实际 Adapter 能力通过 capabilities.get 透传查询。
未绑定用户不能查询 HarnessStatus。现有 Harness 重复上线返回 AGENT_BUSY，避免隐式
替换连接造成路由混用。register 不允许覆盖已有 ID 的公钥。

配对幂等回执持久化。PairCreate 的同 ID 重试返回原配对码，即使它已经用过或到期；
需要新码时显式提供新的操作 ID。PairRedeem 仅在未认证连接上执行，同设备私钥证明、
同请求 ID 重试可恢复原回执，不能重复加入成员或重复提高 ACL 版本。
