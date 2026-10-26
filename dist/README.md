# Relay 预编译版本

`dsh-remote` 是 Agent Link 的 HRP WebSocket Relay，保留现有程序名以兼容部署。
从仓库根目录运行 `./start.sh`；必须设置 `HRP_REGISTRATION_TOKEN`。
本目录只包含程序和校验值，不包含运行时数据、令牌或私钥。

使用 `make build` 重新生成 Linux 本机 release 版本并更新 SHA256SUMS。
当前预编译目标为 Linux x86_64 GNU（动态链接 glibc），不适用于 Android、Windows 或 ARM。
部署环境应与构建环境兼容；不兼容时在目标机器执行 `make build`。
