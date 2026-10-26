package dev.dshremote.core

import java.net.URI

/** User supplies a Relay base URL, including an optional Chamber route prefix. */
fun mobileEndpoint(value: String, allowCleartext: Boolean = false): String {
    val uri = URI(value.trim())
    require(uri.scheme == "wss" || (allowCleartext && uri.scheme == "ws")) { "请输入 wss:// Relay 地址（调试版也支持 ws://）" }
    require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "地址不能包含密码、查询参数或片段" }
    require(uri.port == -1 || uri.port in 1..65535) { "端口无效" }
    val base = uri.toString().trimEnd('/')
    return if (uri.path.trimEnd('/').endsWith("/ws/mobile")) base else "$base/ws/mobile"
}
