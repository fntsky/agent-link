package dev.dshremote.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.dshremote.core.*
import dev.dshremote.protocol.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RemoteUi(
    val address: String = "",
    val connected: Boolean = false,
    val busy: Boolean = false,
    val status: String = "未连接",
    val error: String? = null,
    val notice: String? = null,
    val sessions: List<SessionSummary> = emptyList(),
    val directoryLoaded: Boolean = false,
    val nextPage: String? = null,
    val conversation: Conversation? = null,
    val capabilities: Set<String> = emptySet(),
    val models: List<ModelOption>? = null,
    val model: ModelSelection? = null,
    val pairing: PairCreateResponse? = null,
    val pendingSend: PendingSend? = null,
)
class RemoteViewModel(application: Application) : AndroidViewModel(application) {
    private val vault = CredentialVault(application)
    private val client = RelayClient(vault.identity)
    private var action: Job? = null
    private val _ui = MutableStateFlow(RemoteUi(address = vault.profile?.endpoint?.removeSuffix("/ws/mobile") ?: "", pendingSend = vault.pendingSend))
    val ui = _ui.asStateFlow()
    init {
        viewModelScope.launch { client.link.collect { link -> _ui.update { it.copy(connected = link.connected, status = link.message) } } }
        viewModelScope.launch { client.conversation.collect { c -> _ui.update { it.copy(conversation = c) } } }
    }
    private fun launchWork(block: suspend () -> Unit) {
        if (ui.value.busy) return
        _ui.update { it.copy(busy = true, error = null, notice = null) }
        action = viewModelScope.launch {
            try { block() }
            catch (e: CancellationException) { if (e is kotlinx.coroutines.TimeoutCancellationException) _ui.update { it.copy(error = readable(e)) } else throw e }
            catch (e: Exception) { _ui.update { it.copy(error = readable(e)) } }
            finally { _ui.update { it.copy(busy = false) } }
        }
    }
    fun connect(address: String, pairingCode: String) = launchWork {
        val endpoint = mobileEndpoint(address, BuildConfig.DEBUG)
        var profile = vault.profile?.takeIf { it.endpoint == endpoint }
        val code = pairingCode.trim().ifEmpty { profile?.pairingCode.orEmpty() }
        require(code.isNotBlank() || !profile?.harness.isNullOrBlank()) { "首次连接需要输入 Harness 提供的配对码" }
        _ui.update { it.copy(address = address.trim(), sessions = emptyList(), directoryLoaded = false, nextPage = null, capabilities = emptySet()) }
        try {
            client.connect(endpoint)
            if (code.isNotBlank()) {
                profile = if (profile?.pairingCode == code) profile else Profile(endpoint, pairingCode = code, pairingOperation = DeviceIdentity.newId())
                vault.profile = profile
                val paired = client.redeem(code, profile!!.pairingOperation)
                // Persist receipt before reconnect: a crash cannot orphan the already paired identity.
                profile = Profile(endpoint, paired.harnessId, paired.userId)
                vault.profile = profile
                client.connect(endpoint)
            }
            require(profile != null && profile.harness.isNotBlank())
            val relay = client.authenticate(profile.relayId.takeIf { it.isNotEmpty() })
            vault.profile = profile.copy(relayId = relay, pairingCode = "", pairingOperation = "")
            client.selectHarness(profile.harness)
            _ui.update { it.copy(notice = "身份已验证。点击读取会话，按需获取历史。") }
        } catch (e: Exception) { client.disconnect(); throw e }
    }
    fun disconnect() { action?.cancel(); client.disconnect() }
    // Backgrounding closes transport and credentials bound to it, never the remote Agent.
    fun background() { action?.cancel(); client.disconnect() }
    fun refresh(next: Boolean = false) = launchWork {
        var result: SessionListResponse? = null
        for (attempt in 0..5) {
            try { result = client.sessions(if (next) ui.value.nextPage else null); break }
            catch (e: RelayException) { if (e.code != ErrorCode.ERROR_CODE_ACL_NOT_SYNCED || attempt == 5) throw e; delay(250L * (attempt + 1)) }
        }
        val page = requireNotNull(result)
        _ui.update { it.copy(sessions = ((if (next) it.sessions else emptyList()) + page.sessionsList).distinctBy { s -> s.sessionId }, directoryLoaded = true, nextPage = page.nextPageToken.takeIf { token -> page.hasNextPageToken() && token.isNotBlank() }) }
        try { val capabilities = client.capabilities().operationsList.toSet(); _ui.update { it.copy(capabilities = capabilities) } }
        catch (e: RelayException) { if (e.code != ErrorCode.ERROR_CODE_UNSUPPORTED_OPERATION) throw e }
    }
    private suspend fun <T> mutate(key: String, action: suspend (String) -> T): T {
        val scope = "${vault.profile?.endpoint}|${client.activeHarness}|$key"
        val result = action(vault.operation(scope))
        vault.finishOperation(scope)
        return result
    }
    fun create(title: String) = launchWork {
        val created = mutate("create:$title") { client.createSession(title.ifBlank { "新会话" }, it) }
        val session = created.baseline.session
        _ui.update { it.copy(sessions = listOf(session) + it.sessions.filterNot { old -> old.sessionId == session.sessionId }, directoryLoaded = true) }
        client.follow(session.sessionId)
    }
    fun follow(session: String) = launchWork { client.follow(session); _ui.update { it.copy(model = null, models = null) } }
    fun resync() { ui.value.conversation?.session?.sessionId?.let(::follow) }
    fun leave() = launchWork { client.leave(); _ui.update { it.copy(models = null, model = null) } }
    fun older() = launchWork { if (!client.older()) _ui.update { it.copy(notice = "已读取到最早的可用历史") } }
    fun send(text: String, mode: SendMode) = launchWork {
        val c = requireNotNull(ui.value.conversation)
        require(c.following && !c.needsResync) { "请先重新关注会话" }
        require(text.isNotBlank()) { "请输入消息" }
        val old = vault.pendingSend
        require(old == null) { "有一条消息结果未确认，请先重试或放弃本地重试" }
        val send = PendingSend(requireNotNull(vault.profile).endpoint, client.activeHarness, c.session.sessionId, text, mode.number, DeviceIdentity.newId(), DeviceIdentity.newId())
        vault.pendingSend = send
        _ui.update { it.copy(pendingSend = send) }
        sendPending(send)
    }
    fun retrySend() = launchWork { sendPending(requireNotNull(vault.pendingSend)) }
    private suspend fun sendPending(send: PendingSend) {
        require(send.endpoint == vault.profile?.endpoint && send.harness == client.activeHarness) { "请连接原 Relay 和 Harness 再重试" }
        val result = client.send(send.session, send.text, SendMode.forNumber(send.mode), send.operation, send.message)
        vault.pendingSend = null
        _ui.update { it.copy(pendingSend = null, notice = "消息回执：${result.state.name.removePrefix("DELIVERY_STATE_")}；执行结果由会话事件确认") }
    }
    fun abandonSend() { vault.pendingSend = null; _ui.update { it.copy(pendingSend = null, notice = "已放弃本地重试；远端可能已经接受这条消息") } }
    fun resume() = launchWork {
        val session = requireNotNull(ui.value.conversation).session.sessionId
        mutate("resume:$session") { client.resume(session, it) }
        _ui.update { it.copy(notice = "Agent 已加载，可重试待确认消息") }
    }
    fun cancel() = launchWork {
        val session = requireNotNull(ui.value.conversation).session.sessionId
        mutate("cancel:$session") { client.cancel(session, true, it) }
        _ui.update { it.copy(notice = "已请求停止，保留 Inbox；等待持久结束事件确认") }
    }
    fun approvals() = launchWork { client.pendingApprovals(requireNotNull(ui.value.conversation).session.sessionId) }
    fun decide(approval: ApprovalRequest, allow: Boolean) = launchWork {
        val result = mutate("approval:${approval.approvalId}:$allow") { client.decide(approval, if (allow) ApprovalDecision.APPROVAL_DECISION_ALLOW_ONCE else ApprovalDecision.APPROVAL_DECISION_REJECT, it) }
        _ui.update { it.copy(notice = when (result) {
            ApprovalDecisionStatus.APPROVAL_DECISION_STATUS_ACCEPTED -> "审批答复已接受"
            ApprovalDecisionStatus.APPROVAL_DECISION_STATUS_STALE -> "审批已过期或凭证已失效"
            ApprovalDecisionStatus.APPROVAL_DECISION_STATUS_ALREADY_RESOLVED -> "审批已经解决"
            else -> "当前身份不能决定这项审批"
        }) }
    }
    fun loadModels() = launchWork {
        val session = requireNotNull(ui.value.conversation).session.sessionId
        val models = client.models(session).modelsList
        val current = client.currentModel(session)
        _ui.update { it.copy(models = models, model = current) }
    }
    fun chooseModel(model: ModelSelection) = launchWork {
        val session = requireNotNull(ui.value.conversation).session.sessionId
        val chosen = mutate("model:$session:${model.provider}:${model.model}:${model.reasoningEffort}") { client.selectModel(session, model, it) }
        _ui.update { it.copy(model = chosen, models = null, notice = "模型选择已提交，将在后续步骤生效") }
    }
    fun closeModels() { _ui.update { it.copy(models = null) } }
    fun pair(mode: PairMode) = launchWork { val result = mutate("pair:${mode.number}") { client.createPair(mode, it) }; _ui.update { it.copy(pairing = result) } }
    fun closePairing() { _ui.update { it.copy(pairing = null) } }
    override fun onCleared() { client.close() }
    private fun readable(error: Exception): String = when (error) {
        is RelayException -> when (error.code) {
            ErrorCode.ERROR_CODE_HARNESS_OFFLINE -> "Harness 离线，请稍后重试"
            ErrorCode.ERROR_CODE_UNAUTHENTICATED -> "身份验证失败，请检查设备是否已配对"
            ErrorCode.ERROR_CODE_FORBIDDEN -> "当前身份没有此操作权限"
            ErrorCode.ERROR_CODE_AGENT_NOT_LOADED -> "Agent 未加载，请先恢复 Agent，再重试消息"
            ErrorCode.ERROR_CODE_UNSUPPORTED_OPERATION -> "Harness 暂不支持这项操作"
            ErrorCode.ERROR_CODE_ACL_NOT_SYNCED -> "成员权限正在同步，请稍后重试"
            else -> "操作失败：${error.code.name.removePrefix("ERROR_CODE_")}"
        }
        is kotlinx.coroutines.TimeoutCancellationException -> "请求超时，结果尚未确认；重试将沿用原操作编号"
        else -> error.message ?: "操作失败，请重试"
    }
}
