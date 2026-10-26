package dev.dshremote.core

import com.google.protobuf.ByteString
import dev.dshremote.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class RelayException(val code: ErrorCode) : IOException(code.name)
data class Link(val connected: Boolean = false, val message: String = "未连接")

/** Native client transport; no history reads or subscriptions occur during authentication. */
class RelayClient(private val identity: DeviceIdentity) {
    private val http = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
    private val generation = AtomicLong()
    private val stateLock = Any()
    private val navigation = Mutex()
    private var socket: WebSocket? = null
    private data class Pending(val expected: Int, val result: CompletableDeferred<Response>, val receive: (Response) -> Unit)
    private val pending = ConcurrentHashMap<String, Pending>()
    private val _link = MutableStateFlow(Link())
    val link: StateFlow<Link> = _link
    private val _conversation = MutableStateFlow<Conversation?>(null)
    val conversation: StateFlow<Conversation?> = _conversation

    suspend fun connect(endpoint: String) {
        disconnect()
        synchronized(stateLock) { _conversation.value = null }
        activeHarness = ""
        val epoch = generation.incrementAndGet()
        val ready = CompletableDeferred<Unit>()
        _link.value = Link(message = "正在连接…")
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                if (generation.get() != epoch) { webSocket.cancel(); return }
                if (response.header("Sec-WebSocket-Protocol") != "hrp.pb.v1") {
                    ready.completeExceptionally(IOException("Relay 未协商 HRP 子协议")); webSocket.cancel(); return
                }
                socket = webSocket
                _link.value = Link(true, "已连接，等待身份验证")
                ready.complete(Unit)
            }
            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                if (generation.get() != epoch) return
                try {
                    require(bytes.size <= 1024 * 1024)
                    val env = Envelope.parseFrom(bytes.toByteArray())
                    require(env.version == 1 && env.requestId.isNotBlank())
                    synchronized(stateLock) {
                        if (env.hasReplyTo()) {
                            val p = pending.remove(env.replyTo) ?: return
                            when (env.bodyCase) {
                                Envelope.BodyCase.ERROR -> p.result.completeExceptionally(RelayException(env.error.code))
                                Envelope.BodyCase.RESPONSE -> {
                                    if (env.response.operationCase.number != p.expected) p.result.completeExceptionally(IOException("响应类型与请求不匹配"))
                                    else {
                                        try { p.receive(env.response); p.result.complete(env.response) }
                                        catch (e: Exception) { p.result.completeExceptionally(e) }
                                    }
                                }
                                else -> p.result.completeExceptionally(IOException("响应格式错误"))
                            }
                        } else if (env.bodyCase == Envelope.BodyCase.EVENT) {
                            val c = _conversation.value ?: return
                            if (env.harnessId == activeHarness && env.subscriptionId == c.subscriptionId) _conversation.value = ConversationReducer.apply(c, env.event)
                        }
                    }
                } catch (_: Exception) {
                    lost(epoch, IOException("Relay 消息无效")); webSocket.cancel()
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                lost(epoch, IOException("Relay 返回了非二进制消息")); webSocket.cancel()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                if (generation.get() == epoch) {
                    ready.completeExceptionally(IOException("连接失败，请检查地址和网络"))
                    lost(epoch, IOException("连接中断，请重新连接"))
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { lost(epoch, IOException("连接已关闭")) }
        }
        val request = okhttp3.Request.Builder().url(endpoint).header("Sec-WebSocket-Protocol", "hrp.pb.v1").build()
        socket = http.newWebSocket(request, listener)
        try { withTimeout(15_000) { ready.await() } }
        catch (e: Exception) { disconnect(); throw e }
    }
    @Volatile var activeHarness: String = ""
        private set

    private fun lost(epoch: Long, error: Exception) {
        if (generation.get() != epoch) return
        _link.value = Link(message = error.message ?: "连接中断")
        pending.values.forEach { it.result.completeExceptionally(error) }
        pending.clear()
        synchronized(stateLock) {
            _conversation.value = _conversation.value?.copy(following = false, live = emptyMap(), approvals = emptyMap(), notice = "连接中断，请重新关注")
        }
    }
    fun disconnect() {
        val epoch = generation.get()
        lost(epoch, IOException("连接已断开"))
        generation.incrementAndGet()
        socket?.cancel(); socket = null
    }
    fun close() { disconnect(); http.dispatcher.executorService.shutdown(); http.connectionPool.evictAll() }

    private suspend fun rpc(request: dev.dshremote.protocol.Request, harness: String? = activeHarness.takeIf { it.isNotBlank() }, receive: (Response) -> Unit = {}): Response {
        check(link.value.connected) { "请先连接 Relay" }
        val requestId = DeviceIdentity.newId()
        val env = Envelope.newBuilder().setVersion(1).setRequestId(requestId).setRequest(request).apply { harness?.let(::setHarnessId) }.build()
        val deferred = CompletableDeferred<Response>()
        pending[requestId] = Pending(request.operationCase.number, deferred, receive)
        try {
            require(env.serializedSize <= 1024 * 1024) { "消息过大" }
            check(socket?.send(env.toByteArray().toByteString()) == true) { "无法发送消息" }
            return withTimeout(30_000) { deferred.await() }
        } finally { pending.remove(requestId) }
    }
    suspend fun authenticate(expectedRelay: String?): String {
        val challenge = rpc(dev.dshremote.protocol.Request.newBuilder().setAuthChallenge(AuthChallengeRequest.newBuilder().setIdentityId(identity.deviceId).setPeerKind(PeerKind.PEER_KIND_MOBILE)).build(), harness = null).authChallenge
        require(expectedRelay == null || challenge.relayId == expectedRelay) { "Relay 身份发生变化，请重新配对" }
        require(challenge.nonce.size() == 32 && challenge.expiresAt.seconds > System.currentTimeMillis() / 1000) { "认证挑战无效" }
        val message = DeviceIdentity.transcript("HRP-AUTH-v1", challenge.relayId.toByteArray(), identity.deviceId.toByteArray(), "mobile".toByteArray(), challenge.challengeId.toByteArray(), challenge.nonce.toByteArray())
        rpc(dev.dshremote.protocol.Request.newBuilder().setAuthProve(AuthProveRequest.newBuilder().setChallengeId(challenge.challengeId).setSignature(ByteString.copyFrom(identity.sign(message)))).build(), harness = null)
        _link.value = Link(true, "身份已验证")
        return challenge.relayId
    }
    suspend fun redeem(code: String, operationId: String): PairRedeemResponse {
        val message = DeviceIdentity.transcript("HRP-PAIR-v1", code.toByteArray(), identity.deviceId.toByteArray(), identity.publicKey)
        val result = rpc(dev.dshremote.protocol.Request.newBuilder().setPairRedeem(PairRedeemRequest.newBuilder().setMutation(mutation(operationId)).setPairingCode(code).setDeviceId(identity.deviceId).setPublicKey(ByteString.copyFrom(identity.publicKey)).setPossessionSignature(ByteString.copyFrom(identity.sign(message)))).build(), harness = null).pairRedeem
        activeHarness = result.harnessId
        _link.value = Link(true, "配对成功")
        return result
    }
    fun selectHarness(harness: String) { activeHarness = harness }
    suspend fun capabilities(): CapabilitiesGetResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setCapabilitiesGet(CapabilitiesGetRequest.getDefaultInstance()).build()).capabilitiesGet
    suspend fun sessions(pageToken: String? = null): SessionListResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setSessionList(SessionListRequest.newBuilder().setPageSize(50).apply { pageToken?.let(::setPageToken) }).build()).sessionList
    suspend fun createSession(title: String, operationId: String): SessionCreateResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setSessionCreate(SessionCreateRequest.newBuilder().setTitle(title).setMutation(mutation(operationId))).build()).sessionCreate
    suspend fun follow(session: String) = navigation.withLock {
        leaveInternal()
        try {
            rpc(dev.dshremote.protocol.Request.newBuilder().setSessionFollow(SessionFollowRequest.newBuilder().setSessionId(session).setTailLimit(100)).build()) { response ->
                require(response.sessionFollow.baseline.session.sessionId == session)
                _conversation.value = ConversationReducer.baseline(response.sessionFollow)
            }
        } catch (e: Exception) { disconnect(); throw e }
    }
    suspend fun leave() = navigation.withLock { leaveInternal() }
    private suspend fun leaveInternal() {
        val previous = synchronized(stateLock) { _conversation.value.also { _conversation.value = null } }
        if (previous?.following == true && link.value.connected) {
            try { rpc(dev.dshremote.protocol.Request.newBuilder().setSessionUnfollow(SessionUnfollowRequest.newBuilder().setSubscriptionId(previous.subscriptionId)).build()) }
            catch (e: Exception) { disconnect(); throw e }
        }
    }
    suspend fun older(): Boolean {
        val c = conversation.value ?: return false
        require(c.events.size < 1000) { "当前最多显示 1000 条历史记录" }
        val first = c.events.firstOrNull()?.sessionSeq ?: c.cursor + 1
        val page = rpc(dev.dshremote.protocol.Request.newBuilder().setSessionPage(SessionPageRequest.newBuilder().setSessionId(c.session.sessionId).setBeforeSeq(first).setPageSize(50)).build()).sessionPage
        synchronized(stateLock) {
            _conversation.value?.takeIf { it.subscriptionId == c.subscriptionId }?.let { _conversation.value = ConversationReducer.older(it, page) }
        }
        return page.hasMore
    }
    suspend fun send(session: String, text: String, mode: SendMode, operationId: String, messageId: String): AgentSendResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setAgentSend(AgentSendRequest.newBuilder().setSessionId(session).setMessageId(messageId).setMutation(mutation(operationId)).setMode(mode).addContent(ContentBlock.newBuilder().setText(text))).build()).agentSend
    suspend fun resume(session: String, operationId: String): AgentCreateOrResumeResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setAgentCreateOrResume(AgentCreateOrResumeRequest.newBuilder().setSessionId(session).setMutation(mutation(operationId))).build()).agentCreateOrResume
    suspend fun cancel(session: String, keepInbox: Boolean, operationId: String): AgentCancelResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setAgentCancel(AgentCancelRequest.newBuilder().setSessionId(session).setKeepInbox(keepInbox).setMutation(mutation(operationId))).build()).agentCancel
    suspend fun pendingApprovals(session: String) {
        val c = conversation.value ?: return
        val response = rpc(dev.dshremote.protocol.Request.newBuilder().setApprovalPending(ApprovalPendingRequest.newBuilder().setSessionId(session)).build()).approvalPending
        synchronized(stateLock) { _conversation.value?.takeIf { it.subscriptionId == c.subscriptionId }?.let { _conversation.value = it.copy(approvals = response.requestsList.associateBy { a -> a.approvalId }) } }
    }
    suspend fun decide(approval: ApprovalRequest, decision: ApprovalDecision, operationId: String): ApprovalDecisionStatus {
        require(approval.expiresAt.seconds > System.currentTimeMillis() / 1000) { "审批已过期" }
        val c = conversation.value
        require(c?.following == true && c.session.sessionId == approval.sessionId && !c.needsResync) { "请重新关注会话后再审批" }
        val response = rpc(dev.dshremote.protocol.Request.newBuilder().setApprovalDecide(ApprovalDecideRequest.newBuilder().setSessionId(approval.sessionId).setApprovalId(approval.approvalId).setDecisionToken(approval.decisionToken).setDecision(decision).setMutation(mutation(operationId))).build()).approvalDecide
        synchronized(stateLock) { _conversation.value?.let { _conversation.value = it.copy(approvals = it.approvals - approval.approvalId) } }
        return response.status
    }
    suspend fun models(session: String): ModelListResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setModelList(ModelListRequest.newBuilder().setSessionId(session)).build()).modelList
    suspend fun currentModel(session: String): ModelSelection = rpc(dev.dshremote.protocol.Request.newBuilder().setModelCurrent(ModelCurrentRequest.newBuilder().setSessionId(session)).build()).modelCurrent.selection
    suspend fun selectModel(session: String, model: ModelSelection, operationId: String): ModelSelection = rpc(dev.dshremote.protocol.Request.newBuilder().setModelSelect(ModelSelectRequest.newBuilder().setSessionId(session).setSelection(model).setMutation(mutation(operationId))).build()).modelSelect.selection
    suspend fun createPair(mode: PairMode, operationId: String): PairCreateResponse = rpc(dev.dshremote.protocol.Request.newBuilder().setPairCreate(PairCreateRequest.newBuilder().setHarnessId(activeHarness).setMode(mode).setMutation(mutation(operationId))).build()).pairCreate
    companion object { fun mutation(id: String): Mutation = Mutation.newBuilder().setClientOperationId(id).build() }
}
