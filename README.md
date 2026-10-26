# DSH Remote · DeepSeek Harness 插件

本分支只包含 DeepSeek Harness 侧的 HRP v1 插件 `@local/dsh-remote`，不包含 Relay、
Android 客户端或 Rust 工程。Relay 在 [`relay`](https://github.com/fntsky/agent-link/tree/relay)
分支，Android 客户端在 [`android`](https://github.com/fntsky/agent-link/tree/android) 分支。

插件把本机 Harness 连接到 HRP Relay，让已配对手机通过 Relay 读取和操作本机 DSH
工作区中的原生 Session，并在「设置 → 插件 → 远程配对」中提供连接、配对和设备管理。

## 功能

- **连接与身份**：Ed25519 密钥、`harness.register`、`auth.challenge/prove`、
  自动重连；首次连接只保存 Relay 地址和注册令牌。
- **成员 AC**L：处理 Relay 的 `membership.snapshot`，校验 principal、成员关系和
  `acl_version`；每个业务请求都不信任手机自报的身份。
- **配对**：生成一次性 owner 配对码；显示有效期、复制和失效状态。
- **成员管理**：列出已配对设备，可移除任意成员（包括 owner）。移除会提升 ACL
  版本、关闭该设备连接；最后一个 owner 被移除后可以重新生成 owner 码。没有其他
  成员关系的设备身份会一并删除，同一台手机可以用新码重新加入。
- **原生 Session 目录**：`session.list` 直接投影 DSH 工作区目录，不创建插件专属
  Session；`SessionSummary.workspace` 提供工作区路径，手机端据此聚合和折叠。
- **读取与实时**：`session.open/snapshot/page/follow/unfollow`，映射自然消息、
  工具调用/结果、生命周期、模型选择、审批事件；未知事件走 Extension 保留 seq。
- **发送与模型**：`agent.send/cancel/status/inbox_get/create_or_resume`、
  `model.current/list/select`。
- **设置页**：`settings.plugins.tab`，包含 Relay 地址、显示名称、注册令牌、连接
  状态、ACL 版本、在线时长、已配对设备与移除操作。

## 安装

插件是普通 DSH bundle（`dsh.bundle.patch` + `dsh.client`），Host 侧只使用 Node
内置模块，不需要 npm 依赖。

在 DSH 会话里通过 `plugin_manager` 安装本地目录：

```text
target: /path/to/agent-link/plugin
```

安装后打开 **设置 → 插件 → 远程配对 / Remote Relay**。

插件管理器的本地目录安装会链接 `plugin/`；修改代码后需要重新安装，Host 侧深层
模块或 schema 变更时还需要重启 DSH 桌面应用，以确保 Node 模块缓存被刷新。

## 配置

- **远程地址**：`ws://127.0.0.1:53215` 或 `wss://host/dsh-remote`；插件会自动补
  `/ws/harness`，也可以填写完整端点。
- **显示名称**：Harness 在 Relay 上的名称。
- **注册令牌**：首次注册需要 Relay 的 `HRP_REGISTRATION_TOKEN`（至少 32 字符）。
  已登记 Harness 重连时使用私钥证明，不再需要令牌；留空表示不修改。

已配对设备列表中的“移除”是用户操作，不暴露给 Agent 工具。

## 状态与安全

默认状态文件：`$DSH_HOME/dsh-remote/state.json`，权限 `0600`。包含：

- Ed25519 私钥（PKCS#8，base64）和公钥（原始 32 字节）
- `harness_id`、Relay 地址、注册令牌
- 幂等回执（按用户与 `client_operation_id`，24 小时或 500 条后清理）

注册令牌和私钥不会通过设置 RPC 回传给浏览器。设置 RPC 走 DSH Connection 的浏览器
认证和 Host/Origin 检查；未认证请求返回 401/403。

已认证 Relay 成员可以读取和操作 DSH 工作区中的全部原生 Session。Session 可见性
与本地工作区一致，不存在插件专属目录；成员 ACL 是唯一边界。审批仍要求当前连接
正在订阅该 Session，并使用绑定该连接与审批的 decision token。

## 目录

- `plugin/index.js` — Host 半：Relay 连接、设置 RPC、生命周期
- `plugin/client.js` — Client 半：设置页
- `plugin/lib/adapter.js` — HRP 握手、ACL、配对、成员撤销、请求分发
- `plugin/lib/sessions.js` — DSH Session/Agent/Model 到 HRP 的桥接
- `plugin/lib/ws.js` — 带 Authorization 的 RFC 6455 客户端
- `plugin/lib/proto.js` / `lib/schema.json` — protobuf 运行时与生成 schema
- `plugin/proto/hrp.proto` — wire 契约副本（从 `relay` 分支同步）
- `plugin/scripts/generate-schema.py` — 从本地 proto 重新生成 schema
- `plugin/test/` — 编解码、Host RPC、Session 桥接、成员撤销测试

详细说明见 [plugin/README.md](plugin/README.md)。

## 测试

```sh
node --test plugin/test/*.test.mjs
```

手工联调需要一个 Relay，从 `relay` 分支检出目录启动；具体命令和 Python 手机模拟器
见 [plugin/README.md](plugin/README.md)。

## 当前限制

- 远程审批 answerer 未接入：`approval.*` 返回空/不可用，`approval_policy_set`
  返回不支持。
- Inbox 查询返回空，队列编辑不在本版范围。
- 只处理文本 `ContentBlock`；图片、文件、工作区传输未实现。
- 尚未实现远程终端、文件系统和工作区管理。
- 真实 Android 端到端仍需要手机完成配对后验证。

## 分支

| 分支 | 内容 |
| --- | --- |
| [`relay`](https://github.com/fntsky/agent-link/tree/relay) | HRP 协议、Rust WebSocket Relay、Python 测试替身 |
| [`android`](https://github.com/fntsky/agent-link/tree/android) | Kotlin/Jetpack Compose Android 客户端 |
| [`dsh`](https://github.com/fntsky/agent-link/tree/dsh) | 本分支：DeepSeek Harness 插件 |

字段号与枚举值属于 wire 契约；删除字段必须 reserved，不得复用。
