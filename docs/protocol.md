# HRP v1 通信契约（候选）

本规范将用户提供的 HRP v1.1 评审草案落实为 wire major 1。
原文“不编写 .proto”是原评审文件的范围，不是本项目的实现限制。
这里没有接入或验证当前上游 DSH API；上游类型只能在 Adapter 兼容层映射。

## 编码、消息关联与边界

- WSS 必须验证服务端证书。公开子协议 `hrp.pb.v1`，每个 Binary Frame
  一个 Envelope；内部子协议 `hrp.relay.pb.v1`，Relay 发 RelayForward，
  Harness 发 HarnessForward。禁止在一个连接混用 JSON 或两种消息根类型。
- Envelope.version 必须为 1；body 与 operation oneof 必须存在。
  request_id 是发送方生成的唯一消息 ID，响应/错误以 reply_to 关联请求 ID。
  请求不能带 reply_to；事件没有 reply_to。成功响应的 operation 必须与请求一致。
  普通请求恰有一个成功响应或 ProtocolError；超时不代表变更未执行。
- oneof 直接确定 kind 与 operation，不再维护可能与载荷矛盾的字符串字段。
  auth.prove 的成功响应即 auth.ok；MembershipSnapshotResponse 即 membership.synced。
  ApprovalRequest 事件即 approval.requested，ApprovalDecideResponse 即 decide.result。
- 未知 operation oneof 或 UnsupportedRequest 返回 UNSUPPORTED_OPERATION；
  未知字段按 Protobuf 兼容规则保留/跳过，不得解释成远程命令。
- 默认最大解码前帧大小 1 MiB、单页最多 200 条、默认 50 条；CapabilitiesGet
  可声明更小限制。超限必须拒绝，不能无限分配内存。所有零枚举非法。
  所有 Timestamp 使用 UTC；uint64 在 JS 端用 bigint/字符串，禁止丢精度。
- RelayForward 只能来自经双方认证且被配置为可信 Relay 的连接。
  Relay 从认证上下文填写 principal、route_id、ACL version，绝不从手机载荷复制。
  Harness 响应必须匹配原路由及 Harness 连接；订阅 ID 由服务端分配且绑定连接。
  公开 Envelope 的额外字段也不能影响内部身份。Harness 不向 Mobile 直接发内部包装。

## 身份与配对

- 公钥是原始 32 字节 Ed25519 公钥，签名为 64 字节。认证挑战 nonce 至少
  32 字节随机数、有效期最多 60 秒、单次使用，绑定请求身份、peer_kind 与连接。
  relay_id 是客户端配置认可的 Relay 身份，不是证书验证的替代。
- AuthProve 签名内容：ASCII `HRP-AUTH-v1`，再按顺序连接 relay_id、identity_id、
  peer_kind（字符串 `mobile` / `harness`）、challenge_id、nonce；每项之前写
  4 字节无符号大端长度。服务端从已存挑战构造内容，验证后原子消费挑战。
- HarnessRegister 只能建立待证明身份；必须完成对登记公钥的挑战证明，才可成为
  在线 Harness 或创建 owner 配对。已存在 ID 的公钥不得被 register 覆盖。
- 配对码至少 128 bit 熵、最多 5 分钟有效、原子单次消费；Relay 限速，不记录码。
  PairRedeem.possession_signature 对 ASCII `HRP-PAIR-v1` 加依次长度前缀的
  pairing_code、device_id、public_key 签名，长度格式同认证。兑换绑定当前连接，
  成功后该连接取得已验证设备身份；后续连接必须重新挑战认证。
- owner 仅限已证明且尚无 owner 的 Harness 发起；device_link 只能由已认证同用户
  设备发起；invite 只能由 owner 发起并创建独立用户。user_id/roles 由 Relay 指定。
- MembershipSnapshot 为 Harness 的完整成员快照，版本单调递增；Harness 原子应用
  后才回 applied_acl_version。旧版本不能回退权限，同版本内容不同必须拒绝。
  未同步最新版本时拒绝业务请求 ACL_NOT_SYNCED；撤权立即关闭相关订阅及审批凭证。
- 本地 Session 完全开放：SessionList 与本地工作区使用同一份目录，已认证成员可以看到
  并读取工作区中的全部 Session，也可执行协议支持的发送、取消、模型选择等操作。
  不设 Adapter 专属 Session、创建者绑定或导入/认领步骤；远程创建的 Session 就是普通
  本地 Session，也会立即出现在工作区。
- 成员 ACL 仍是唯一边界：未认证连接、已撤销成员和 ACL 未同步的连接不能读 Session。
  审批仍要求当前连接正在订阅该 Session，并使用绑定该连接与审批的 decision token；
  这与 Session 可见性无关，不能借“完全开放”绕过。
- 已认证 Harness 可用 `member_revoke`（携带 Mutation、harness_id、device_id）移除本
  Harness 的成员，包括 owner。Relay 在同一事务中删除成员、提升 ACL 版本，并返回
  `MemberRevokeResponse{acl_version, removed}`；随后关闭该设备的 Relay 连接、通知
  Harness 清理 connection 作用域，并推送新的 MembershipSnapshot。相同操作 ID 重试
  返回原回执，不重复提升版本。移除最后一个 owner 后，允许重新创建 owner 配对码；
  若被撤销设备已不属于任何 Harness，Relay 同时删除其设备身份，因此同一台手机可以
  用新的配对码重新加入。

## 幂等、Session 与 Inbox

- 所有 Mutation.client_operation_id 必填；SessionOpen 仅 resume_agent=true 时必填。
  Harness 将用户、操作 ID、operation 与规范化请求摘要持久保存，副作用和幂等记录须
  具备崩溃一致性。同用户同 ID 同内容返回原结果；不同内容返回 IDEMPOTENCY_CONFLICT。
  配对类 Mutation 由 Relay 持久处理。审批的幂等回执不能再次触发审批副作用。
- SessionCreate 建立普通原生 Session 与 Agent，并立即进入本地工作区目录；
  AgentCreateOrResume 仅恢复已有 Session，不以任意 session_id 创建新会话。SessionOpen 默认不恢复 Agent。
  AgentSend 遇 unloaded 返回 AGENT_NOT_LOADED，由调用方明确请求恢复。
- AgentSend 的 message_id 标识 Inbox 消息，来源由可信 principal 派生。
  followup 下一 turn；steer 最近可用 step，空闲时可唤醒；inject 不唤醒且默认仅可信 owner。
  成功结果只确认 Inbox 接受，不能预先分配/承诺未来 turn_id。
  InboxChanged 在订阅内报告 queued/claimed/committed/discarded/rejected 等变化。
- AgentCancel.keep_inbox 缺省为 false。cancel_requested 仅确认提出协作式取消，
  最终结果由持久 turn/end 确认。断线、unfollow、Relay 重启都不得取消或 dispose Agent。
- SessionSummary.committed_seq、Baseline.cursor 和 SessionCommitted.cursor 指向
  DSH 同一 Session 的持久进度；0 为尚无事件。Session seq 为原生日志序号，不重编。
  页面事件按 seq 升序返回；before_seq 为排他上界，返回最接近上界的更早页；
  after_seq 为排他下界，返回紧邻下界的后续页。未传范围读取最新页。
  SessionList 的分页 token 由 Harness 产生且与查询用户绑定，Relay 不持久保存。
- Projection.schema_version=1，data 是 Adapter 的版本化显示投影，不是独立历史数据库。
  v1 至少包含 messages 数组（message_id/role/content）、可空 active_turn_id；
  content 使用 ContentBlock 的标准 ProtoJSON 形状。扩展字段客户端可以忽略。
  任何投影和 tail 均从同一 Session 日志派生；不能以缓存投影替代持久日志真相。
- SessionEvent.event_type 为原生事件名，例如 user/message、assistant/message、
  assistant/attempt、tool/call、tool/result、turn/start、step/start、step/end、turn/end、
  approval/asked、approval/decided、model/selected。已知类型必须与对应 oneof 一致。
  lifecycle 的 outcome/reason 保留上游兼容层映射；未知插件事件必须走 Extension，
  namespace/type/schema_version/media_type 必填，不支持的内容明示未知，禁止静默丢失 seq。

## 订阅与实时流

- 仅显式 SessionFollow 才允许推送 Session 内容。认证、查询、发送消息不会隐式订阅。
  先安装观察者并缓冲竞态事件，再生成一致 baseline；follow 响应必须先于任何事件。
  baseline.tail 是 cursor 之前的有限尾部，不保证包含所有历史。
- follow 后 durable 更新必须严格按原生日志顺序，且 seq > baseline.cursor。
  每批 cursor 等于该批最后事件 seq，projection 若存在必须对应这一 cursor。
  检测缺口应 SessionPage(after_seq) 修复或重新 follow，不能把 live chunk 当历史游标。
- baseline.active_attempts 给出当时活动 attempt 与 next_chunk_index，后续 live 从此
  index 开始；baseline 不保证恢复之前未持久化的实时片段。实时块 index 从 0 开始，
  在 session/attempt/revision 内递增，允许批量但保留每块类型、顺序和 index。
  重试或替换由 revision 区分；旧 revision 不得覆盖新 revision。
- 文本可约 50ms/256B 合批，首片尽早；工具和 attempt 边界先 flush。
  end 的 COMMITTED 必须带 committed_seq，指向 assistant/message 或 assistant/attempt；
  其他 outcome 不允许伪造提交。客户端以持久内容替换 live 展示，避免重复。
- 每连接转发缓冲必须有界；溢出发 SubscriptionReset 后关闭订阅，无法发送通知时
  关闭连接。不能阻塞 AgentLoop。重连后所有旧订阅、路由、审批 token 与 live 缓冲失效。
  SessionUnfollow 对当前连接已经移除的订阅可幂等成功，不能删除他人的订阅。

## 审批与模型

- ApprovalRequest 只给有权限且已订阅该 Session 的连接；ApprovalPending 是显式查询，
  只返回当前仍有效的问题，不建立订阅。远程决策仍要求当前连接正在订阅。
  token 是至少 256 bit 随机不透明凭证，绑定 Session/审批/用户/设备/连接/到期时间。
  Pending 可以为新连接发新 token，但不得复活已解决/失效的远程审批认领。
- 审批不复制原始参数；call_id 与已授权的 tool/call 展示关联。用户仅可 allow_once
  或 reject；重复/迟到/撤权/错会话/token 无效都不得执行允许操作。
  ACCEPTED 表示原生 approval seam 接受决策，具体结果看原生审计。
- ask 交给组合 Answerer；never 拒绝所有需要审批的动作。没有订阅者、超时、断线、
  Answerer 不可用时，远程 Answerer 返回 unavailable 或不认领，绝不默认允许。
  本地 Answerer 可按原生策略独立工作；Remote 不抢答它不拥有的问题。
- model.list 是当前部署可用目录；model.select 成功只表示选择已持久提交，
  对后续尚未 prepare 的 step 生效，不承诺修改在途调用。
- fork/子 Agent 创建、终端、文件、音频、工作区传输不在本版操作集合。
  parent/fork 元信息用于展示，不赋予 dispose/控制其他 Agent 的权利。

## 实现验收边界

Relay 仅持久身份、公钥、绑定、成员、撤销版本、短期配对及配对幂等数据；
禁止持久 Session 目录、正文、历史游标、转发 payload。日志不得含 prompt、工具参数、
令牌或配对码。持久 Session、ACL 与业务幂等属于 Harness。

发布前必须用真实 Adapter 验证：三种配对、挑战重放、跨用户 ACL、撤权同步、幂等崩溃恢复、
follow 基线竞态和分页缺口、attempt 重试/提交去重、Inbox 两种调度边界、取消最终事实、
断线重连、慢消费者、审批超时/重放/竞争 Answerer，以及插件卸载后的资源清理。
当前 protoc 检查仅证明 schema 可编译，不证明上述运行时行为。

## Relay 连接生命周期补充

RelayForward.connection_id 由可信 Relay 注入，仅在当前手机连接有效；审批凭证绑定它。
手机断线的内部 RelayConnectionClosed 事件使 Harness 清理该连接的临时状态，
不取消 Agent。事件和包装的 connection_id 必须相同。Relay 链路本身断开时，Harness
直接清理链路上的全部临时状态。具体内部认证包装与握手时序见 [Relay 实现](relay.md)。
