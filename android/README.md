# DSH Remote · Android

原生 Kotlin + Jetpack Compose 客户端，最低 Android 8.0（API 26）。
使用 OkHttp WebSocket 和仓库唯一的 HRP Protobuf schema，直接连接 Rust Relay。

## 功能

- 输入 Relay 地址与一次性配对码；以后使用本机 Ed25519 设备身份登录。
- 设置页可切换跟随系统/浅色/深色、四套主题色、四档字体大小，并保存 Relay 远程地址。
- 已配对设备启动/回到前台自动连接，连接后默认读取会话目录；进入会话才订阅，退出即 unfollow。
- 会话按原生工作区聚合、默认折叠；工作区与会话均按最后活动时间倒序，列表显示“上次 今天 HH:mm / 昨天 HH:mm / M月d日”。
- 每个工作区是一个 DSH Remote 边框容器，顶部带新建按钮；会话以紧凑卡片显示，最多四张，更多在容器内横向滑动。
- 新建会话绑定到当前工作区（HRP `SessionCreateRequest.workspace` → DSH `create({ cwd })`），创建后自动展开并进入该会话。
- followup 下一轮消息与 steer 运行中引导；显示 Inbox 接受回执。
- 实时输出按 attempt/revision/chunk_index 合并，持久记录替换暂态展示；进入会话默认滚到底部。
- 发送成功后显示本地回显，直到持久 user/message 到达，避免看不到自己刚发送的正文。
- 用户消息里由 DSH 自动附加的 runtime context 尾部（Time sampled / Browser time zone / Elapsed…）在显示时剥离；用户自己用代码块引用的原文不删。
- 聊天按轮次折叠：执行过程（工具/思考）可逐轮展开，工具/结果先显示一行再点开详情；助手最终输出在折叠区外独立显示且永不折叠；job/compaction 等插件扩展事件不显示。
- 助手最终输出使用 Markwon（Android 原生 Markdown 库）渲染：标题、列表、引用、代码块、GFM 表格、粗体/斜体/删除线、行内代码和可点击链接。
- SessionSeq/实时块出现缺口后提示重新同步；断线清除实时片段与审批凭证。
- 单次允许/拒绝工具审批，显示到期倒计时；允许前要求找到关联工具调用及其参数。
- 读取/选择模型；恢复 Agent；显式请求取消并保留 Inbox。
- 生成 device_link、invite 配对码；无权限操作由 Harness/Relay 拒绝。
- 未确认的发送保留原消息 ID/操作 ID，可重试；其余变更也保留未确认的幂等编号。

没有远端取消与 UI 断线的隐式绑定。连接期间启动前台服务（常驻通知）保持进程和 WebSocket；连接异常会按 1s/2s/4s…最多 30s 退避自动重连。回到前台若已断开会重新读取目录，进入会话会重新获取基线。用户显式断开后不会被自动连接覆盖；退出应用不会取消 Harness 任务。

## 构建与安装

需要 JDK 21、Android SDK 35、Build Tools 35，以及 SDK 的已接受许可证。
Gradle Wrapper 固定为 8.12。`core` 使用 JDK 21 工具链，产物目标为 Java 17。
`local.properties` 可以写 `sdk.dir=/path/to/Android/Sdk`，或配置 `ANDROID_HOME`。

```sh
cd android
export JAVA_HOME=/path/to/jdk-21
./gradlew :core:test :app:assembleDebug :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

用 Android Studio 打开此 `android/` 目录即可开发。Debug APK 路径：
`app/build/outputs/apk/debug/app-debug.apk`。

## 连接本地 Relay

服务端照常独立开发，在仓库根目录启动：

```sh
export HRP_REGISTRATION_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
cargo run --locked
```

在另一个终端复用同一个注册令牌，启动模拟 Harness：

```sh
export HRP_REGISTRATION_TOKEN='<与 Relay 相同的令牌>'
make python-setup
make demo-harness
```

模拟器会在终端显示 owner 配对码。它不是 DeepSeek Adapter，不运行真实模型或工具；
会话保存在模拟器内存中，停止即丢失。测试 Harness 私钥保存在忽略的 `.gen/` 下。
重启后已有 owner 可继续登录，也可由原手机生成第二设备/独立用户配对码。

手机端地址：

- Android Emulator 访问宿主机：`ws://10.0.2.2:53214`。
- USB 真机：先执行 `adb reverse tcp:53214 tcp:53214`，填 `ws://127.0.0.1:53214`。
- Chamber 部署：`wss://<host>/dsh-remote`，客户端自动补 `/ws/mobile`。

输入配对码并连接，点击“读取会话”，再新建会话即可发送。模拟器回复 `hello mobile`；
发送 `approval` 会生成可关联的工具调用和审批请求，可以验证拒绝或本次允许。

## 密钥与传输

设备 Ed25519 签名通过 Bouncy Castle 的轻量 API 完成。32 字节种子与设备 ID、配对恢复
记录、未确认发送记录用 Android Keystore 中不可导出的 AES-GCM 密钥加密，再写入应用
私有 SharedPreferences；这里不声称 Ed25519 本身由硬件 Keystore 执行。
数据备份关闭，不把设备凭证随备份迁移到另一台设备。Keystore 丢失/损坏时不会静默换身份。

Release 仅允许 `wss://` 且保留默认 TLS 证书验证；Debug 可用 `ws://` 本地联调。
首次成功配对后记录 Relay ID，之后挑战认证校验它。允许截图和最近任务预览；会话与
配对码进入系统截图和最近任务缩略图。应用不持久保存会话历史；未确认发送正文为可靠
重试而暂时加密保存，获得回执或手动放弃后删除。

## 结构与测试

- `core/`：独立 JVM Kotlin 模块，包含设备签名、地址处理、Protobuf WebSocket RPC、
  会话 reducer；应用和集成测试复用相同实现。
- `app/`：原生 Compose 界面、ViewModel、Android Keystore 加密存储。
- Protobuf 从 `../proto/hrp/v1/hrp.proto` 生成 Java lite 类，没有第二份 schema。

仓库根目录执行：

```sh
make android-check   # 使用当前 JAVA_HOME；JDK 21
make android-e2e     # Kotlin core -> 真正的 Rust Relay -> Python Harness
```

单元测试覆盖 RFC 8032 签名向量、认证字节编码、Chamber URL、实时输出提交去重、revision
隔离、缺口、断线订阅失效与历史分页。集成测试覆盖配对、认证、订阅、发送/steer、幂等、
审批拒绝、模型切换、取消、退出关注与 Relay 身份校验。

当前已验证 JVM 协议层联调、APK 构建和 Android Lint；尚未在模拟器/真机运行界面，
Keystore 设备实现与界面交互仍需要设备验收。真实 DeepSeek Harness 也尚未接入。
