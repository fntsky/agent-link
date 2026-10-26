# Agent Link

面向移动端和 Agent Harness 的远程连接项目：共享 HRP 协议、Rust WebSocket Relay、原生 Android 客户端，以及可扩展的 Harness 适配器。

GitHub：[fntsky/agent-link](https://github.com/fntsky/agent-link)。三个分支分别为 `delay`（Relay，默认）、`android`（Kotlin 客户端）、`dsh`（DeepSeek Harness 插件）。
本分支提供 Relay，可独立启动或作为 Formicary Chamber 运行。
HRP v1.1 是设计文档修订号，wire major 仍为 1。

Relay 负责 Ed25519 挑战认证、owner/device_link/invite 配对、成员 ACL 同步、
RPC 路由和连接级订阅隔离。SQLite 只保存身份、公钥、成员、短期配对与配对幂等记录。
会话历史、Session ACL、Inbox、工具审批执行及业务幂等由 Harness 负责。

## 直接运行已编译版本

仓库像 rs_blog 一样提交 `dist/dsh-remote`，当前为 Linux x86_64 可执行文件。
首次启动自动生成 Harness 注册令牌，数据默认保存到 `data/`：

```sh
HRP_LISTEN=0.0.0.0:53323 ./start.sh
# 查看 Harness 要填写的注册令牌：
cat data/relay-registration-token
```

启动脚本默认监听 `127.0.0.1:53323`；独立局域网访问时如上覆盖为 `0.0.0.0`。
`dist/SHA256SUMS` 可用于校验二进制：`cd dist && sha256sum -c SHA256SUMS`。
无需在部署端安装 Rust/protoc。其他系统或架构请重新编译。

## 本地开发

需要 Rust stable（edition 2024）、C 编译器及支持 proto3 optional 的 `protoc`。
Python 测试需要 Python 3.11 或更高版本。
Rust 类型在构建时通过 prost 从 schema 生成，SQLite 随二进制构建。
`make build` 编译 release 并更新 `dist/`；`cargo run --locked` 仍用于日常开发。

```sh
export HRP_REGISTRATION_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
cargo run --locked
```

默认监听 `127.0.0.1:53214`，默认数据库为 `./data/relay.sqlite3`。
`HRP_LISTEN` 和 `HRP_DATABASE` 可覆盖。注册令牌至少 32 字节，只给受信 Harness 使用；
不要把令牌放进 URL、Git 或手机端。服务端不输出令牌、配对码或业务正文。

| 地址 | 用途 | WebSocket 子协议 |
| --- | --- | --- |
| `GET /healthz` | 健康检查，返回 `ok` | — |
| `/ws/mobile` | 手机连接，每条 Binary Message 为 Envelope | `hrp.pb.v1` |
| `/ws/harness` | Harness 连接，上行为 HarnessForward，下行为 RelayForward | `hrp.relay.pb.v1` |

Harness 首次 register 时必须在握手中带 `Authorization: Bearer <HRP_REGISTRATION_TOKEN>`。
注册只是登记待证明公钥；随后必须 auth.challenge / auth.prove 才能上线。
已登记 Harness 重连仅需私钥证明，无须再提供注册令牌。连接认证前也使用相同包装格式。
手机首次通过 pair.redeem 取得身份，以后使用设备私钥挑战认证。

公开部署由入口反向代理终止 TLS，客户端使用 `wss://` 并验证证书；默认仅本机明文 HTTP/WS。
Relay 本身不依赖 Formicary 登录会话，不把 `X-Formicary-*` 当作 HRP principal。

## Chamber

[chamber.toml](chamber.toml) 定义代理、健康检查；[启动脚本](start.sh)
以前台进程运行 release 二进制。默认由 TOML 的启动命令指定令牌文件；首次自动生成，重启复用。
部署使用已提交的二进制，无需构建工具。

- 无 prepare 构建步骤，直接运行 `dist/dsh-remote`。
- 默认令牌文件：`${CHAMBER_DATA_DIR}/relay-registration-token`，权限为 0600。
  可在服务器读取这个文件，将其值填给 Harness；手机只填写一次性配对码。
- 在本机 `chamber.toml` 的 `script` 中写 `HRP_REGISTRATION_TOKEN="自定义长令牌" ./start.sh`
  可以显式指定，优先于文件。实际令牌不能提交到公开仓库。
  修改配置后重启 Chamber；令牌文件和数据库都位于共享数据目录，升级不会清空。
- upstream：`http://127.0.0.1:53323`，健康路径 `/healthz`。
- 外部路由：`/dsh-remote`，例如 `wss://<host>/dsh-remote/ws/mobile`。
- 数据库：`${CHAMBER_DATA_DIR}/relay.sqlite3`；未设时退回 `./data/relay.sqlite3`。
  `HRP_DATABASE` 可以显式覆盖，升级版本目录不会承载持久数据。

无需改变正常开发工作流。Chamber 负责启动及反向代理。
仓库更名为 Agent Link；已有 Chamber 名称、路由 `/dsh-remote` 和二进制名保留兼容。
从 Formicary 导入公开仓库时选择 `fntsky/agent-link` 的 `delay` 分支。

## 测试

```sh
make check           # proto 编译、fmt、Clippy、Rust 回归测试
make python-setup    # 一次性创建 .venv 并安装测试依赖
make e2e             # 构建 Rust，生成 Python protobuf，启动临时 Relay 和模拟两端
make chamber-smoke   # release 构建后，按 chamber.toml 的脚本、健康路径和共享数据规则启动测试
```

Python [Harness 模拟器](tests/harness.py) 与 [手机模拟器](tests/mobile.py) 使用真实
WebSocket 和 protobuf 通信；[端到端测试](tests/e2e.py) 覆盖配对、认证重放、ACL 屏障、
发送、分页、订阅、实时流、审批、模型控制、取消、断线及 Relay 重启。
测试使用临时数据库和随机测试身份，退出后回收进程与数据。

Rust 回归额外检查错误 Harness/响应类型不能抢路由、旧 ACL ack、基线先行、
背压、follow 超时清理及 SQLite 事务回滚。Chamber smoke 只检查本项目配置和启动脚本，
不启动完整 Formicary 反向代理。

## 契约与当前范围

- [Protobuf schema](proto/hrp/v1/hrp.proto)
- [传输、授权及一致性规范](docs/protocol.md)
- [Relay 实现细节与边界](docs/relay.md)

当前是可联调的 Relay 实现，Python Harness 是测试替身，尚未接入真实 DeepSeek Harness。
Session、Inbox、Approval 等请求透传给 Harness；模拟器的模型/工具响应不代表真实执行。
成员撤销管理 API、真实 Adapter 和移动 UI 尚未实现。发布前仍需真实上游联调。
字段号与枚举值属于 wire 契约；删除字段必须 reserved，不得复用。

## Android 客户端

原生 Kotlin + Jetpack Compose 工程位于 [android/](android/README.md)，包括设备配对与认证、
会话列表、实时聊天、审批和模型选择。使用同一份 Protobuf，服务端开发与 Chamber 启动方式保持不变。

```sh
# 需要 JDK 21 和 Android SDK 35
make android-check
make android-e2e
```
