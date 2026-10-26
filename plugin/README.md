# DSH Remote 插件

`@local/dsh-remote` 是 Harness 侧的 HRP v1 Adapter。它把当前 DeepSeek Harness
连接到一个 HRP Relay，并在「设置 → 插件 → 远程配对」里提供远程地址、注册令牌、
连接状态和手机配对功能。

插件使用 `proto/hrp.proto`（来自仓库 `proto/hrp/v1/hrp.proto`）的 wire 契约，
通过 `plugin/lib/schema.json` 驱动一个无依赖的 protobuf 编解码器；Harness ↔ Relay
使用 `hrp.relay.pb.v1` 子协议和 `HarnessForward` / `RelayForward` 包装。

## 已实现

| 能力 | 说明 |
| --- | --- |
| 连接与身份 | Ed25519 密钥、`harness.register`、`auth.challenge/prove`、断线重连 |
| ACL | 处理 Relay 的 `membership.snapshot`，校验 principal、成员和 ACL 版本 |
| 配对 | Harness 发起 owner 配对，设置页显示一次性配对码、有效期和复制按钮 |
| 设置页 | `settings.plugins.tab`：远程地址、显示名称、注册令牌、连接状态、设备列表 |
| 状态查询 | `harness.status` 由 Relay 处理；插件状态 RPC 只对已认证浏览器开放 |
| Session | `session.list/create/open/snapshot/page/follow/unfollow`；目录与本地工作区一致，不做插件专属过滤 |
| Agent | `agent.send/cancel/status/inbox_get/create_or_resume` |
| 实时流 | `session_committed`、`assistant_live_start/chunk/end` |
| 模型 | `model.current/list/select` |

### 安全边界

- Session 目录完全开放：`session.list` 直接投影 DSH 工作区的原生 Session 目录，
  已认证成员看到的本机 Session 与工作区一致。不存在插件专属 Session、创建者绑定
  或单独的远程目录；`session.create` 创建的就是普通本机 Session。
- 成员 ACL 是唯一边界：每个业务请求校验 Relay 注入的 `RelayForward.principal`、
  成员关系和 `acl_version`；不信任手机构造的 principal。未认证/已撤销成员不可读。
- 每个订阅绑定手机 `connection_id`；手机断线或 Relay 断线时清理订阅，
  但不取消 Agent、不删除 Session。
- 设置 RPC 走 DSH Connection 的浏览器认证和 Host/Origin 检查；未认证请求返回
  401/403。设置页不会把注册令牌或私钥回传给浏览器。

Session 标题直接取 DSH 的 `title` 投影；没有标题时依次使用工作目录名和 Session ID，
因此手机与工作区的显示名一致。`session.create` 带标题时会通过 `sessionController.rename`
写入原生 `session/title` 事件，之后在工作区也能看到。

### 当前限制

- 远程审批（`approval.*`）只返回空/不可用，没有注册 DSH 的 approval answerer；
  `approval_policy_set` 明确返回不支持。
- Inbox 查询返回空，队列编辑不在本版范围。
- 只处理文本 `ContentBlock`；图片、文件、工作区传输未实现。
- 尚未实现成员撤销入口；Relay 当前也没有该 API。
- 真实 Android 端联调仍需在手机端完成配对后验证。

## 安装

插件是普通 DSH bundle（`dsh.bundle.patch` + `dsh.client`），Host 侧只使用 Node
内置模块，不安装任何 npm 依赖。

从仓库根目录安装：

```sh
# 在 DSH 会话里通过 plugin_manager 安装本地目录
# target: /path/to/dsh-remote/plugin
```

或在当前 profile 里用 Plugin Manager 的本地目录安装功能选择 `plugin/`。

安装后打开 **设置 → 插件**，会出现「远程配对 / Remote Relay」页签。

## 配置

设置页字段：

- **远程地址**：Relay 的基地址，例如 `ws://127.0.0.1:53214` 或
  `wss://relay.example.com/dsh-remote`。插件会自动补 `/ws/harness`；
  也可以直接填写完整端点。
- **显示名称**：Harness 在 Relay 上的显示名。
- **注册令牌**：首次注册需要 Relay 的 `HRP_REGISTRATION_TOKEN`（至少 32 字符）。
  已登记的 Harness 重连时可以使用私钥证明，不再需要令牌。留空表示不修改。
- **生成配对码**：Harness 调用 `pair.create`（owner 模式）。手机在配对页输入此码。

状态页会显示 ACL 版本、已配对设备、在线时长和最近错误。

## 状态文件

默认路径：`$DSH_HOME/dsh-remote/state.json`，权限 `0600`。包含：

- Ed25519 私钥（PKCS#8）和公钥（原始 32 字节，base64）
- `harness_id`、Relay 地址、注册令牌
- 幂等回执（按用户与 `client_operation_id` 保存，24 小时或 500 条后清理）

可用 `DSH_REMOTE_STATE` 覆盖路径，或用 `DSH_REMOTE_URL` /
`DSH_REMOTE_REGISTRATION_TOKEN` 提供首次默认值。令牌和私钥不会通过状态 RPC
返回给浏览器。

## 协议映射

- 请求/响应使用 Envelope 的 oneof；`reply_to` 关联请求；Relay 侧的路由 ID
  原样带回。
- 认证 transcript：`HRP-AUTH-v1` + 4 字节大端长度前缀的
  `relay_id/harness_id/"harness"/challenge_id/nonce`。
- `membership.snapshot` 必须在 Harness 应用后才回 `applied_acl_version`；
  Relay 只在该版本匹配时打开业务闸门。
- DSH `sessionController.follow` 的 `snapshot` 转成 HRP `Baseline`，后续
  `event` 转成 `session_committed`，`assistant-stream` 转成 live 事件。
- DSH 原生事件映射到 `SessionEvent.body`；未知事件以
  `Extension(namespace: "dsh")` 保留 seq。

## 测试

```sh
node --test plugin/test/codec.test.mjs
node --test plugin/test/sessions.test.mjs
```

手工联调：

```sh
# 1. 启动 Relay（临时数据库）
HRP_LISTEN=127.0.0.1:53215 \
HRP_DATABASE=/tmp/hrp-test/relay.sqlite3 \
HRP_REGISTRATION_TOKEN=<32+ chars> \
cargo run --locked

# 2. 启动 Adapter 测试进程，读取输出中的 PAIR 码
HRP_TEST_URL=ws://127.0.0.1:53215 \
HRP_TEST_TOKEN=<same token> \
DSH_REMOTE_STATE=/tmp/hrp-test/state.json \
node plugin/test/adapter.integration.mjs

# 3. 用 tests/mobile.py 的 Mobile 兑换配对码并调用 session_list
```

`plugin/test/adapter.integration.mjs` 使用临时状态文件，不会读写真实
`$DSH_HOME` 状态。

## 目录

- `index.js` — Host 半：Relay 连接、设置 RPC、生命周期
- `client.js` — Client 半：设置页
- `lib/proto.js` / `lib/schema.json` — protobuf 运行时和生成 schema
- `lib/ws.js` — 带 Authorization 的 RFC 6455 客户端
- `lib/adapter.js` — HRP 握手、ACL、配对、请求分发
- `lib/sessions.js` — DSH Session/Agent/Model 到 HRP 的桥接
- `proto/hrp.proto` — wire 契约副本
- `scripts/generate-schema.py` — 从 proto 重新生成 schema
