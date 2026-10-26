package dev.dshremote.app

import android.Manifest
import android.text.method.LinkMovementMethod
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.ViewModelProvider
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import com.google.protobuf.Struct
import com.google.protobuf.Value
import dev.dshremote.core.*
import dev.dshremote.protocol.*
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private lateinit var remote: RemoteViewModel
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Screenshots and the recents preview are intentionally allowed.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
        try {
            remote = ViewModelProvider(this)[RemoteViewModel::class.java]
        } catch (_: Exception) {
            setContent {
                MaterialTheme {
                    Surface(Modifier.fillMaxSize()) {
                        Column(Modifier.safeDrawingPadding().padding(28.dp), verticalArrangement = Arrangement.Center) {
                            Text("设备凭证无法读取", style = MaterialTheme.typography.headlineMedium)
                            Spacer(Modifier.height(16.dp))
                            Text("本机密钥可能已失效，应用已停止连接，且不会自动替换设备身份。请保留现有数据并检查设备 Keystore。")
                        }
                    }
                }
            }
            return
        }
        setContent {
            val state by remote.ui.collectAsStateWithLifecycle()
            val settings by remote.settings.collectAsStateWithLifecycle()
            val systemDark = isSystemInDarkTheme()
            val dark = when (settings.themeMode) {
                ThemeMode.SYSTEM -> systemDark
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
            }
            val colors = appColorScheme(settings.palette, dark)
            val baseDensity = LocalDensity.current
            MaterialTheme(colorScheme = colors) {
                CompositionLocalProvider(LocalDensity provides Density(baseDensity.density, settings.fontScale)) {
                    RemoteApp(state, settings, remote)
                }
            }
        }
    }
    override fun onStart() {
        super.onStart()
        if (::remote.isInitialized) remote.autoConnect()
    }
}

@Composable
private fun RemoteApp(state: RemoteUi, settings: AppSettings, vm: RemoteViewModel) {
    var createDialog by remember { mutableStateOf(false) }
    var cancelDialog by remember { mutableStateOf(false) }
    var abandonDialog by remember { mutableStateOf(false) }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    BackHandler(showSettings || (state.conversation != null && state.connected)) {
        if (showSettings) showSettings = false
        else if (!state.busy) vm.leave()
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (showSettings) IconButton(onClick = { showSettings = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                else if (state.conversation != null && state.connected) IconButton(onClick = vm::leave, enabled = !state.busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回会话列表") }
                else Icon(Icons.Default.Terminal, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Text(
                        if (showSettings) "设置" else state.conversation?.session?.title?.ifBlank { "会话" }?.takeIf { state.connected } ?: "DSH Remote",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(if (showSettings) "主题、字体与远程地址" else state.status, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!showSettings && state.connected) IconButton(onClick = vm::disconnect, enabled = !state.busy) { Icon(Icons.Default.LinkOff, "断开连接") }
                if (!showSettings) IconButton(onClick = { showSettings = true }) { Icon(Icons.Default.Settings, "设置") }
            }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.error?.let { Banner(it, true) }
            state.notice?.let { Banner(it) }
            when {
                showSettings -> SettingsScreen(state, settings, vm, Modifier.weight(1f))
                !state.connected -> ConnectPanel(state, vm, Modifier.weight(1f))
                state.conversation == null -> Directory(state, vm, { createDialog = true }, Modifier.weight(1f))
                else -> Chat(state, vm, { cancelDialog = true }, { abandonDialog = true }, Modifier.weight(1f))
            }
        }
    }
    if (createDialog) {
        var title by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { createDialog = false }, title = { Text("新建会话") }, text = {
            OutlinedTextField(title, { title = it }, label = { Text("会话名称") }, singleLine = true)
        }, confirmButton = { TextButton(onClick = { createDialog = false; vm.create(title) }) { Text("创建") } }, dismissButton = { TextButton(onClick = { createDialog = false }) { Text("取消") } })
    }
    if (cancelDialog) Confirm("请求停止 Agent？", "已生成的内容会保留，Inbox 队列会保留。实际停止由会话结束事件确认。", "请求停止", { cancelDialog = false; vm.cancel() }, { cancelDialog = false })
    if (abandonDialog) Confirm("放弃本地重试？", "远端可能已经接受这条消息。此操作只移除本机重试记录。", "放弃重试", { abandonDialog = false; vm.abandonSend() }, { abandonDialog = false })
    state.models?.let { models ->
        AlertDialog(onDismissRequest = vm::closeModels, title = { Text("选择模型") }, text = {
            LazyColumn { items(models) { option ->
                ListItem(headlineContent = { Text(option.selection.model) }, supportingContent = { Text(listOf(option.selection.provider, option.selection.reasoningEffort).filter { it.isNotBlank() }.joinToString(" · ")) }, leadingContent = { RadioButton(option.selection == state.model, onClick = null) }, modifier = Modifier.clickable(enabled = !state.busy) { vm.chooseModel(option.selection) })
            } }
        }, confirmButton = { TextButton(onClick = vm::closeModels) { Text("关闭") } })
    }
    state.pairing?.let { pairing ->
        AlertDialog(onDismissRequest = vm::closePairing, title = { Text("一次性配对码") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("仅交给要绑定的设备使用。到期：${time(pairing.expiresAt.seconds)}")
                SelectionContainer { Text(pairing.pairingCode, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium) }
            }
        }, confirmButton = { TextButton(onClick = vm::closePairing) { Text("完成") } })
    }
}

@Composable
private fun Banner(text: String, error: Boolean = false) {
    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), shape = RoundedCornerShape(12.dp), color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer) {
        Text(text, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun SettingsScreen(state: RemoteUi, settings: AppSettings, vm: RemoteViewModel, modifier: Modifier) {
    var address by remember(settings.remoteAddress, state.address) {
        mutableStateOf(settings.remoteAddress.ifBlank { state.address })
    }
    Column(
        modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        SettingsSection("外观")
        Text("主题模式", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                ThemeMode.SYSTEM to "跟随系统",
                ThemeMode.LIGHT to "浅色",
                ThemeMode.DARK to "深色",
            ).forEach { (mode, label) ->
                FilterChip(selected = settings.themeMode == mode, onClick = { vm.setThemeMode(mode) }, label = { Text(label) })
            }
        }
        Text("主题色", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                AccentPalette.TEAL to "青绿",
                AccentPalette.BLUE to "蓝色",
                AccentPalette.PURPLE to "紫色",
                AccentPalette.ORANGE to "橙色",
            ).forEach { (palette, label) ->
                FilterChip(selected = settings.palette == palette, onClick = { vm.setPalette(palette) }, label = { Text(label) })
            }
        }
        Text("字体大小", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                0.9f to "小",
                1f to "标准",
                1.15f to "大",
                1.3f to "特大",
            ).forEach { (scale, label) ->
                FilterChip(selected = kotlin.math.abs(settings.fontScale - scale) < 0.01f, onClick = { vm.setFontScale(scale) }, label = { Text(label) })
            }
        }
        HorizontalDivider()
        SettingsSection("远程连接")
        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Relay 地址") },
            placeholder = { Text("wss://example.com/dsh-remote") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { vm.saveRemoteAddress(address) }, enabled = address.isNotBlank()) { Text("保存地址") }
            if (state.connected) OutlinedButton(onClick = vm::disconnect) { Text("断开连接") }
            Text(state.status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("更换 Relay 地址后，原配对关系不再适用；需要重新输入新的配对码。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider()
        SettingsSection("关于")
        Text("DSH Remote v${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium)
        Text("Markdown: Markwon · 前台服务保活 · 自动重连", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SettingsSection(title: String) {
    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
}

private fun appColorScheme(palette: AccentPalette, dark: Boolean): ColorScheme {
    return if (dark) {
        when (palette) {
            AccentPalette.TEAL -> darkColorScheme(primary = Color(0xFF9AD9C6), secondary = Color(0xFFEDBB8B), background = Color(0xFF101917), surface = Color(0xFF16211E), surfaceVariant = Color(0xFF22302B))
            AccentPalette.BLUE -> darkColorScheme(primary = Color(0xFF9CC7FF), secondary = Color(0xFFC4B5FD), background = Color(0xFF0C1420), surface = Color(0xFF131D2B), surfaceVariant = Color(0xFF1D2A3A))
            AccentPalette.PURPLE -> darkColorScheme(primary = Color(0xFFC9B8FF), secondary = Color(0xFFFF9CCF), background = Color(0xFF140F24), surface = Color(0xFF1D1730), surfaceVariant = Color(0xFF2A2140))
            AccentPalette.ORANGE -> darkColorScheme(primary = Color(0xFFFFB86B), secondary = Color(0xFF7DD3FC), background = Color(0xFF1A1008), surface = Color(0xFF24180D), surfaceVariant = Color(0xFF332315))
        }
    } else {
        when (palette) {
            AccentPalette.TEAL -> lightColorScheme(primary = Color(0xFF186C58), secondary = Color(0xFF9A5425), background = Color(0xFFF6F7F2), surface = Color(0xFFFCFDF8), surfaceVariant = Color(0xFFE9EDE5))
            AccentPalette.BLUE -> lightColorScheme(primary = Color(0xFF1F6FEB), secondary = Color(0xFF7C5CFF), background = Color(0xFFF4F7FB), surface = Color(0xFFFFFFFF), surfaceVariant = Color(0xFFE6EDF7))
            AccentPalette.PURPLE -> lightColorScheme(primary = Color(0xFF6D4AFF), secondary = Color(0xFFC2418A), background = Color(0xFFF8F5FF), surface = Color(0xFFFFFFFF), surfaceVariant = Color(0xFFEDE8FA))
            AccentPalette.ORANGE -> lightColorScheme(primary = Color(0xFFB45309), secondary = Color(0xFF0F766E), background = Color(0xFFFFF9F3), surface = Color(0xFFFFFFFF), surfaceVariant = Color(0xFFF7E8DA))
        }
    }
}

@Composable
private fun ConnectPanel(state: RemoteUi, vm: RemoteViewModel, modifier: Modifier) {
    var address by rememberSaveable(state.address) { mutableStateOf(state.address) }
    // Pair codes are intentionally not put in saved-instance-state or the clipboard.
    var code by remember { mutableStateOf("") }
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item { Spacer(Modifier.height(24.dp)); Icon(Icons.Default.Devices, null, Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary) }
        item { Text("把工作现场\n带在身边", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold); Spacer(Modifier.height(10.dp)); Text("连接你的 Harness，按需查看会话、跟进任务，并处理工具审批。", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item { OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth(), label = { Text("Relay 地址") }, placeholder = { Text("wss://example.com/dsh-remote") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true, enabled = !state.busy) }
        item { OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("首次连接的配对码") }, supportingText = { Text("已配对设备留空即可；配对码由 Harness 或已有设备提供。") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !state.busy) }
        item { Button(onClick = { vm.connect(address, code); code = "" }, Modifier.fillMaxWidth().height(52.dp), enabled = address.isNotBlank() && !state.busy) { Icon(Icons.Default.Link, null); Spacer(Modifier.width(8.dp)); Text("连接 Harness") } }
        item { Text("设备私钥在本机加密保存。仅连接和认证不会读取会话历史。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item { Text("DSH Remote v${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun Directory(state: RemoteUi, vm: RemoteViewModel, create: () -> Unit, modifier: Modifier) {
    var menu by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(setOf<String>()) }
    val groups = state.sessions
        .groupBy { if (it.hasWorkspace()) it.workspace else "" }
        .toList()
        .sortedBy { (workspace, _) -> workspaceLabel(workspace) }
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("会话", Modifier.weight(1f), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            IconButton(onClick = { vm.refresh() }, enabled = !state.busy) { Icon(Icons.Default.Refresh, "刷新会话") }
            Box {
                IconButton(onClick = { menu = true }, enabled = !state.busy) { Icon(Icons.Default.MoreVert, "设备与分享") }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("绑定我的另一台设备") }, onClick = { menu = false; vm.pair(PairMode.PAIR_MODE_DEVICE_LINK) })
                    DropdownMenuItem(text = { Text("邀请独立用户") }, onClick = { menu = false; vm.pair(PairMode.PAIR_MODE_INVITE) })
                    DropdownMenuItem(text = { Text("断开连接") }, onClick = { menu = false; vm.disconnect() })
                }
            }
            FilledTonalIconButton(onClick = create, enabled = !state.busy) { Icon(Icons.Default.Add, "新建会话") }
        }
        Text("与 Harness 工作区共用同一份会话目录", Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!state.directoryLoaded || state.sessions.isEmpty()) {
            Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(Icons.Default.Forum, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(16.dp))
                Text(if (!state.directoryLoaded) "正在读取会话…" else "工作区还没有会话", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(8.dp))
                Text(if (!state.directoryLoaded) "连接后会自动读取，无需手动刷新。" else "在工作区或这里创建会话开始工作。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(20.dp))
                Button(onClick = { if (!state.directoryLoaded) vm.refresh() else create() }, enabled = !state.busy) { Text(if (!state.directoryLoaded) "重新读取" else "新建会话") }
            }
        } else LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            groups.forEach { (workspace, sessions) ->
                val key = workspace.ifBlank { "" }
                val open = key in expanded
                item(key = "workspace:$key") {
                    WorkspaceHeader(workspaceLabel(key), sessions.size, open) {
                        expanded = if (open) expanded - key else expanded + key
                    }
                }
                if (open) {
                    items(sessions, key = { it.sessionId }) { session -> SessionCard(session, state.busy, vm) }
                }
            }
            state.nextPage?.let { item { TextButton(onClick = { vm.refresh(true) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("加载更多会话") } } }
        }
    }
}

@Composable
private fun WorkspaceHeader(label: String, count: Int, expanded: Boolean, toggle: () -> Unit) {
    Surface(Modifier.fillMaxWidth().clickable(onClick = toggle), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.FolderOpen, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(10.dp))
            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
            Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (expanded) "折叠工作空间" else "展开工作空间")
        }
    }
}

@Composable
private fun SessionCard(session: SessionSummary, busy: Boolean, vm: RemoteViewModel) {
    Card(onClick = { vm.follow(session.sessionId) }, enabled = !busy, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.ChatBubbleOutline, null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                Text(session.title.ifBlank { "未命名会话" }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(4.dp))
                Text("${agentState(session.agentState)} · 已提交 ${session.committedSeq}" + if (session.hasParentSessionId()) " · 分支会话" else "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.Default.ChevronRight, "进入会话")
        }
    }
}

private fun workspaceLabel(workspace: String): String {
    if (workspace.isBlank()) return "其他会话"
    val normalized = workspace.replace('\\', '/').trimEnd('/')
    return normalized.substringAfterLast('/').ifBlank { workspace }
}

@Composable
private fun Chat(state: RemoteUi, vm: RemoteViewModel, cancel: () -> Unit, abandon: () -> Unit, modifier: Modifier) {
    val c = requireNotNull(state.conversation)
    var draft by rememberSaveable(c.session.sessionId) { mutableStateOf("") }
    var steer by rememberSaveable(c.session.sessionId) { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val active = state.connected && c.following && !c.needsResync && !state.busy
    LaunchedEffect(c.session.sessionId) {
        withFrameNanos { }
        withFrameNanos { }
        if (listState.layoutInfo.totalItemsCount > 0) listState.scrollToItem(listState.layoutInfo.totalItemsCount - 1)
    }
    LaunchedEffect(state.localEcho?.id) {
        if (state.localEcho != null) {
            withFrameNanos { }
            if (listState.layoutInfo.totalItemsCount > 0) listState.animateScrollToItem(listState.layoutInfo.totalItemsCount - 1)
        }
    }
    Column(modifier.fillMaxWidth().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (c.following) "正在关注 · 已提交 ${c.cursor}" else "已停止关注", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            TextButton(onClick = vm::loadModels, enabled = active) { Text(state.model?.model ?: "模型") }
            Box {
                IconButton(onClick = { more = true }) { Icon(Icons.Default.MoreVert, "会话操作") }
                DropdownMenu(more, { more = false }) {
                    DropdownMenuItem(text = { Text("重新同步") }, onClick = { more = false; vm.resync() }, enabled = state.connected && !state.busy)
                    DropdownMenuItem(text = { Text("恢复 Agent") }, onClick = { more = false; vm.resume() }, enabled = active)
                    DropdownMenuItem(text = { Text("读取待审批") }, onClick = { more = false; vm.approvals() }, enabled = active)
                    DropdownMenuItem(text = { Text("请求停止 Agent") }, onClick = { more = false; cancel() }, enabled = active)
                }
            }
        }
        c.notice?.let { Banner(it) }
        val rounds = remember(c.events) { buildRounds(c.events) }
        val liveOutputs = c.live.values.filter { it.blocks.isNotEmpty() }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { TextButton(onClick = vm::older, enabled = active, modifier = Modifier.fillMaxWidth()) { Text("读取更早历史") } }
            items(rounds, key = { "round:${it.key}" }) { round ->
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    round.user?.let { event ->
                        val text = stripRuntimeContext(event.userMessage.contentList.joinToString("\n") { it.displayText() })
                        if (text.isNotBlank()) MessageCard("你", text, true, foldable = true)
                    }
                    if (roundHasProcess(round)) RoundSection(round)
                    finalAssistantText(round)?.let { text -> MarkdownMessage(text) }
                }
            }
            items(liveOutputs, key = { "live:${it.attempt}" }) { output ->
                MessageCard("正在生成 · 暂未提交", output.blocks.joinToString("") { it.displayText() }, false, transient = true)
            }
            if (c.events.isEmpty() && liveOutputs.isEmpty() && state.localEcho == null) item {
                Text("会话已打开。发送消息开始工作。", Modifier.fillMaxWidth().padding(24.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            state.localEcho?.let { echo -> item(key = "echo:${echo.id}") { MessageCard("你 · 发送中", echo.text, true, transient = true) } }
            items(c.approvals.values.toList(), key = { "approval:${it.approvalId}" }) { approval -> ApprovalCard(approval, c, active, vm) }
        }
        state.pendingSend?.let { pending ->
            Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("消息回执尚未确认", fontWeight = FontWeight.SemiBold)
                    Text(pending.text, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                    Row { TextButton(onClick = vm::retrySend, enabled = active) { Text("沿用原编号重试") }; TextButton(onClick = abandon, enabled = !state.busy) { Text("放弃本地重试") } }
                }
            }
        }
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = steer, onClick = { steer = !steer }, label = { Text(if (steer) "引导最近步骤" else "下一轮消息") }, enabled = active && state.pendingSend == null)
            Spacer(Modifier.width(12.dp))
            Text(if (steer) "运行中也可追加方向" else "进入下一轮 Inbox", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(draft, { draft = it }, Modifier.weight(1f), placeholder = { Text("给 Harness 发消息…") }, maxLines = 5, enabled = active && state.pendingSend == null, shape = RoundedCornerShape(20.dp))
            Spacer(Modifier.width(8.dp))
            FilledIconButton(onClick = { vm.send(draft, if (steer) SendMode.SEND_MODE_STEER else SendMode.SEND_MODE_FOLLOWUP); draft = "" }, enabled = active && draft.isNotBlank() && state.pendingSend == null, modifier = Modifier.size(54.dp)) { Icon(Icons.AutoMirrored.Filled.Send, "发送消息") }
        }
    }
}

private data class ChatRound(
    val key: String,
    val user: SessionEvent?,
    val events: List<SessionEvent>,
    val isLast: Boolean = false,
)

/** Split the durable event stream into user-anchored rounds. Everything after
 *  the last user message stays in the last round and is expanded by default. */
private fun buildRounds(events: List<SessionEvent>): List<ChatRound> {
    val rounds = mutableListOf<ChatRound>()
    var user: SessionEvent? = null
    val bucket = mutableListOf<SessionEvent>()
    fun flush() {
        if (user == null && bucket.isEmpty()) return
        val meaningful = bucket.any {
            it.hasToolCall() || it.hasToolResult() || it.hasAssistantMessage()
        }
        if (user != null || meaningful) {
            val first = user?.sessionSeq ?: bucket.firstOrNull()?.sessionSeq ?: 0
            rounds += ChatRound("$first:${bucket.firstOrNull()?.sessionSeq ?: 0}", user, bucket.toList())
        }
        user = null
        bucket.clear()
    }
    for (event in events) {
        if (event.hasUserMessage()) {
            flush()
            user = event
        } else {
            bucket += event
        }
    }
    flush()
    return rounds.mapIndexed { index, round -> round.copy(key = "$index:${round.key}", isLast = index == rounds.lastIndex) }
}

private fun reasoningBlocks(event: SessionEvent): List<ContentBlock> = if (event.hasAssistantMessage()) {
    event.assistantMessage.contentList.filter { it.valueCase == ContentBlock.ValueCase.REASONING }
} else emptyList()

private fun embeddedToolBlocks(event: SessionEvent): List<ContentBlock> = if (event.hasAssistantMessage()) {
    event.assistantMessage.contentList.filter { it.valueCase == ContentBlock.ValueCase.TOOL_CALL }
} else emptyList()

private fun roundHasProcess(round: ChatRound): Boolean = round.events.any { event ->
    event.hasToolCall() || event.hasToolResult() || reasoningBlocks(event).isNotEmpty() || embeddedToolBlocks(event).isNotEmpty()
}

/** The final assistant answer is deliberately rendered outside the foldable
 *  process section: collapsing a round must never hide the answer itself. */
private fun finalAssistantText(round: ChatRound): String? {
    val message = round.events.lastOrNull { it.hasAssistantMessage() } ?: return null
    val text = message.assistantMessage.contentList
        .filter { it.valueCase != ContentBlock.ValueCase.REASONING && it.valueCase != ContentBlock.ValueCase.TOOL_CALL }
        .joinToString("\n") { it.displayText() }
    return text.ifBlank { null }
}

@Composable
private fun RoundSection(round: ChatRound) {
    var open by remember(round.key) { mutableStateOf(round.isLast) }
    LaunchedEffect(round.isLast) { if (!round.isLast) open = false }
    val tools = round.events.count { it.hasToolCall() } + round.events.sumOf { embeddedToolBlocks(it).size }
    val completed = round.events.any { it.eventType == "turn/end" } || round.events.any { it.hasAssistantMessage() }
    val times = round.events.mapNotNull { event ->
        if (!event.hasCommittedAt()) null else event.committedAt.seconds * 1000 + event.committedAt.nanos / 1_000_000
    }
    val duration = if (times.size > 1) ((times.maxOrNull() ?: 0) - (times.minOrNull() ?: 0)) / 1000 else 0
    val label = when {
        completed && duration > 0 -> "已完成 · 用时 ${formatDuration(duration)}"
        completed -> "已完成"
        round.isLast -> "执行中"
        else -> "执行过程"
    }
    val results = round.events.filter { it.hasToolResult() }.associateBy { it.toolResult.callId }
    Column(Modifier.fillMaxWidth()) {
        Surface(
            Modifier.fillMaxWidth().clickable { open = !open },
            shape = RoundedCornerShape(9.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (completed) Icons.Default.CheckCircle else Icons.Default.HourglassEmpty, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(7.dp))
                Text(label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
                if (tools > 0) Text("$tools 步", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(4.dp))
                Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (open) "收起本轮" else "展开本轮", modifier = Modifier.size(16.dp))
            }
        }
        if (open) {
            Column(Modifier.padding(start = 10.dp, top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (event in round.events) {
                    when {
                        event.hasToolCall() -> ToolRow(
                            event.toolCall.callId,
                            event.toolCall.toolName,
                            event.toolCall.arguments,
                            results[event.toolCall.callId],
                        )
                        event.hasAssistantMessage() -> {
                            reasoningBlocks(event).forEach { block -> ReasoningRow(block.reasoning) }
                            embeddedToolBlocks(event).forEach { block ->
                                val tool = block.toolCall
                                ToolRow(tool.callId, tool.toolName, tool.arguments, results[tool.callId])
                            }
                        }
                        // Lifecycle and plugin extension events (job/*,
                        // compaction/*, ...) stay out of the UI.
                    }
                }
            }
        }
    }
}

@Composable
private fun ReasoningRow(text: String) {
    var open by remember(text) { mutableStateOf(false) }
    val preview = text.lineSequence().firstOrNull()?.trim().orEmpty().ifBlank { "思考内容" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Lightbulb, null, tint = MaterialTheme.colorScheme.secondary, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text("思考", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary)
            Spacer(Modifier.width(8.dp))
            Text(preview, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (open) "收起思考" else "展开思考")
        }
        if (open) SelectionContainer { Text(text, Modifier.padding(start = 24.dp, top = 2.dp, bottom = 6.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun ToolRow(callId: String, toolName: String, arguments: Struct, result: SessionEvent?) {
    var open by remember(callId) { mutableStateOf(false) }
    val summary = toolSummary(arguments)
    val title = toolTitle(toolName)
    val output = result?.toolResult?.contentList?.joinToString("\n") { it.displayText() }?.ifBlank { "（无输出）" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Terminal, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
            Spacer(Modifier.width(8.dp))
            Text(summary, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (open) "收起工具详情" else "展开工具详情")
        }
        if (open) {
            Surface(Modifier.fillMaxWidth().padding(start = 24.dp, top = 2.dp, bottom = 6.dp), shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("调用 $callId", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    SelectionContainer { Text(structText(arguments), style = MaterialTheme.typography.bodySmall) }
                    if (output != null) {
                        Text(if (result?.toolResult?.isError == true) "错误输出" else "输出", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        SelectionContainer { Text(output, style = MaterialTheme.typography.bodySmall) }
                    } else {
                        Text("运行中…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

private fun toolTitle(name: String): String = when (name) {
    "bash", "terminal" -> "运行命令"
    "grep" -> "搜索文件内容"
    "glob" -> "查找文件"
    "read" -> "读取文件"
    "write" -> "写入文件"
    "edit" -> "编辑文件"
    "web_search" -> "网页搜索"
    "web_fetch" -> "网页获取"
    "apply_patch" -> "修改文件"
    else -> name.ifBlank { "工具" }
}

private fun toolSummary(args: Struct): String {
    val fields = args.fieldsMap
    for (key in listOf("cmd", "command", "query", "pattern", "path", "file_path", "url")) {
        val value = fields[key] ?: continue
        val text = valueText(value)
        if (text.isNotBlank()) return text.replace('\n', ' ').take(120)
    }
    return fields.entries.firstOrNull()?.let { "${it.key}: ${valueText(it.value)}" }?.take(120).orEmpty()
}

private fun structText(args: Struct): String {
    if (args.fieldsMap.isEmpty()) return "（无参数）"
    return args.fieldsMap.entries.joinToString("\n") { "${it.key}: ${valueText(it.value)}" }
}

private fun valueText(value: Value): String = when (value.kindCase) {
    Value.KindCase.STRING_VALUE -> value.stringValue
    Value.KindCase.NUMBER_VALUE -> value.numberValue.toString()
    Value.KindCase.BOOL_VALUE -> value.boolValue.toString()
    Value.KindCase.NULL_VALUE -> "null"
    Value.KindCase.STRUCT_VALUE -> structText(value.structValue)
    Value.KindCase.LIST_VALUE -> value.listValue.valuesList.joinToString(", ") { valueText(it) }
    else -> ""
}

private fun formatDuration(seconds: Long): String = if (seconds >= 60) "${seconds / 60} 分 ${seconds % 60} 秒" else "${seconds} 秒"

@Composable
private fun MarkdownMessage(text: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val onSurface = MaterialTheme.colorScheme.onSurface.toArgb()
    val primary = MaterialTheme.colorScheme.primary.toArgb()
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(TablePlugin.create(context))
            .usePlugin(StrikethroughPlugin.create())
            .build()
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
        Text("Harness", Modifier.padding(horizontal = 4.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface) {
            AndroidView(
                factory = { ctx ->
                    TextView(ctx).apply {
                        setTextIsSelectable(true)
                        movementMethod = LinkMovementMethod.getInstance()
                        setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
                        setLineSpacing(0f, 1.18f)
                        val pad = (16 * resources.displayMetrics.density).toInt()
                        setPadding(pad, pad, pad, pad)
                    }
                },
                update = { view ->
                    view.setTextColor(onSurface)
                    view.setLinkTextColor(primary)
                    markwon.setMarkdown(view, text)
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun MessageCard(label: String, content: String, user: Boolean, transient: Boolean = false, foldable: Boolean = false, collapseByDefault: Boolean = false) {
    var expanded by remember(label, content) { mutableStateOf(!collapseByDefault) }
    val lineCount = content.count { it == '\n' } + 1
    val overflows = content.length > 520 || lineCount > 8
    val canFold = foldable && (overflows || collapseByDefault)
    val shown = when {
        content.isEmpty() -> "（无可显示内容）"
        !canFold || expanded -> content
        collapseByDefault -> content.lineSequence().firstOrNull()?.take(180).orEmpty().ifBlank { "（无摘要）" }
        else -> content.take(520).trimEnd() + "…"
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        Text(label, Modifier.padding(horizontal = 4.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(Modifier.fillMaxWidth(if (user) 0.9f else 1f), shape = RoundedCornerShape(18.dp), color = if (user) MaterialTheme.colorScheme.primaryContainer else if (transient) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface) {
            SelectionContainer { Text(shown, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, lineHeight = 23.sp) }
        }
        if (canFold) {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起" else if (collapseByDefault) "展开详情" else "展开全文") }
        }
    }
}

@Composable
private fun ApprovalCard(approval: ApprovalRequest, conversation: Conversation, enabled: Boolean, vm: RemoteViewModel) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(approval.approvalId) { while (true) { now = System.currentTimeMillis() / 1000; delay(1000) } }
    val valid = enabled && approval.expiresAt.seconds > now
    val call = conversation.events.lastOrNull { it.hasToolCall() && it.toolCall.callId == approval.callId }?.toolCall
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Default.GppMaybe, null); Spacer(Modifier.width(8.dp)); Text("需要工具审批", fontWeight = FontWeight.Bold) }
            Text(approval.toolName, style = MaterialTheme.typography.titleMedium)
            Text(approval.reason)
            Text("调用 ${approval.callId.ifBlank { "未提供" }}", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
            if (call != null) SelectionContainer { Text(call.arguments.toString(), style = MaterialTheme.typography.bodySmall) }
            else Text("当前已加载历史中未找到关联工具参数。确认前可先读取更早历史。", style = MaterialTheme.typography.bodySmall)
            Text(if (approval.expiresAt.seconds > now) "${approval.expiresAt.seconds - now} 秒后到期" else "审批已过期", style = MaterialTheme.typography.labelSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { vm.decide(approval, false) }, enabled = valid) { Text("拒绝") }
                Button(onClick = { vm.decide(approval, true) }, enabled = valid && call != null && call.toolName == approval.toolName) { Text("仅允许本次") }
            }
        }
    }
}

@Composable
private fun Confirm(title: String, text: String, action: String, confirm: () -> Unit, dismiss: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { Text(text) }, confirmButton = { TextButton(onClick = confirm) { Text(action) } }, dismissButton = { TextButton(onClick = dismiss) { Text("取消") } })
}
private fun agentState(state: AgentState): String = when (state) {
    AgentState.AGENT_STATE_RUNNING -> "运行中"
    AgentState.AGENT_STATE_IDLE -> "空闲"
    AgentState.AGENT_STATE_UNLOADED -> "未加载"
    else -> "状态未知"
}
private fun time(seconds: Long): String = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(seconds * 1000))
