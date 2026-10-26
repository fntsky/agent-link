package dev.dshremote.core

import dev.dshremote.protocol.*

// Durable records and live attempts are kept separate, and never persisted by the app.
data class LiveOutput(val attempt: String, val revision: Long, val nextIndex: Long, val blocks: List<ContentBlock> = emptyList(), val ended: Boolean = false)
data class Conversation(
    val session: SessionSummary,
    val subscriptionId: String,
    val cursor: Long,
    val events: List<SessionEvent>,
    val projection: Projection,
    val live: Map<String, LiveOutput> = emptyMap(),
    val approvals: Map<String, ApprovalRequest> = emptyMap(),
    val inbox: Inbox = Inbox.getDefaultInstance(),
    val needsResync: Boolean = false,
    val following: Boolean = true,
    val notice: String? = null,
)

/** Called under RelayClient's state lock so baseline and events are applied in wire order. */
object ConversationReducer {
    fun baseline(response: SessionFollowResponse): Conversation {
        require(response.hasBaseline() && response.baseline.hasSession()) { "缺少订阅基线" }
        val b = response.baseline
        require(b.tailList.all { it.sessionSeq <= b.cursor }) { "基线游标无效" }
        return Conversation(b.session, response.subscriptionId, b.cursor,
            b.tailList.sortedBy { it.sessionSeq }, b.projection,
            b.activeAttemptsList.associate { it.attemptId to LiveOutput(it.attemptId, it.revision, it.nextChunkIndex) })
    }
    fun apply(current: Conversation, event: Event): Conversation {
        if (!current.following) return current
        return when (event.operationCase) {
            Event.OperationCase.SESSION_COMMITTED -> {
                val update = event.sessionCommitted
                if (update.sessionId != current.session.sessionId) return current
                val records = update.eventsList.filter { it.sessionSeq > current.cursor }
                if (records.isEmpty()) return current
                val ordered = records.zipWithNext().all { (a, b) -> b.sessionSeq == a.sessionSeq + 1 }
                if (records.first().sessionSeq != current.cursor + 1 || !ordered || records.last().sessionSeq != update.cursor) {
                    return current.copy(needsResync = true, live = emptyMap(), approvals = emptyMap(), notice = "历史存在缺口，请重新同步")
                }
                val settled = records.mapNotNull {
                    when (it.bodyCase) {
                        SessionEvent.BodyCase.ASSISTANT_MESSAGE -> it.assistantMessage.attemptId to it.assistantMessage.revision
                        SessionEvent.BodyCase.ASSISTANT_ATTEMPT -> it.assistantAttempt.attemptId to it.assistantAttempt.revision
                        else -> null
                    }
                }.toSet()
                current.copy(cursor = update.cursor, events = (current.events + records).takeLast(1000),
                    projection = if (update.hasProjection()) update.projection else current.projection,
                    live = current.live.filterValues { (it.attempt to it.revision) !in settled })
            }
            Event.OperationCase.ASSISTANT_LIVE_START -> {
                val v = event.assistantLiveStart
                if (v.sessionId != current.session.sessionId) return current
                val a = v.attempt
                val previous = current.live[a.attemptId]
                if (previous != null && previous.revision >= a.revision) current else current.copy(live = current.live + (a.attemptId to LiveOutput(a.attemptId, a.revision, a.nextChunkIndex)))
            }
            Event.OperationCase.ASSISTANT_LIVE_CHUNK -> {
                val v = event.assistantLiveChunk
                if (v.sessionId != current.session.sessionId) return current
                val a = current.live[v.attemptId] ?: return current
                if (a.revision != v.revision) return current
                var next = a.nextIndex
                val blocks = a.blocks.toMutableList()
                for (chunk in v.chunksList) {
                    if (chunk.chunkIndex < next) continue
                    if (chunk.chunkIndex != next) return current.copy(needsResync = true, live = emptyMap(), approvals = emptyMap(), notice = "实时流出现缺口，请重新同步")
                    blocks += chunk.content
                    next++
                }
                // A malformed or unbounded live stream must not exhaust the phone.
                if (blocks.sumOf { it.serializedSize.toLong() } > 2 * 1024 * 1024) return current.copy(needsResync = true, live = emptyMap(), notice = "实时输出过大，请读取已提交历史")
                current.copy(live = current.live + (a.attempt to a.copy(nextIndex = next, blocks = blocks)))
            }
            Event.OperationCase.ASSISTANT_LIVE_END -> {
                val v = event.assistantLiveEnd
                if (v.sessionId != current.session.sessionId) return current
                val a = current.live[v.attemptId] ?: return current
                if (a.revision != v.revision) return current
                // Keep successful live output until the authoritative record arrives.
                if (v.outcome == AttemptOutcome.ATTEMPT_OUTCOME_COMMITTED && v.hasCommittedSeq() && v.committedSeq > current.cursor) current.copy(live = current.live + (a.attempt to a.copy(ended = true)))
                else current.copy(live = current.live - v.attemptId)
            }
            Event.OperationCase.APPROVAL_REQUEST -> {
                val v = event.approvalRequest
                if (v.sessionId != current.session.sessionId) current else current.copy(approvals = current.approvals + (v.approvalId to v))
            }
            Event.OperationCase.APPROVAL_RESOLVED -> current.copy(approvals = current.approvals - event.approvalResolved.approvalId)
            Event.OperationCase.INBOX_CHANGED -> if (event.inboxChanged.sessionId == current.session.sessionId) current.copy(inbox = event.inboxChanged.inbox) else current
            Event.OperationCase.AGENT_STATUS_CHANGED -> {
                val a = event.agentStatusChanged.agent
                if (a.sessionId == current.session.sessionId) current.copy(session = current.session.toBuilder().setAgentState(a.state).build()) else current
            }
            Event.OperationCase.SUBSCRIPTION_RESET -> current.copy(following = false, live = emptyMap(), approvals = emptyMap(), notice = "订阅失效，请重新关注")
            else -> current
        }
    }
    fun older(current: Conversation, page: SessionPageResponse): Conversation {
        val merged = (page.eventsList + current.events).associateBy { it.sessionSeq }.values.sortedBy { it.sessionSeq }
        return current.copy(events = merged.takeLast(1000))
    }
}

fun ContentBlock.displayText(): String = when (valueCase) {
    ContentBlock.ValueCase.TEXT -> text
    ContentBlock.ValueCase.REASONING -> "思考 · $reasoning"
    ContentBlock.ValueCase.TOOL_CALL -> "工具 ${toolCall.toolName}\n调用 ${toolCall.callId}\n${toolCall.arguments}"
    ContentBlock.ValueCase.TOOL_RESULT -> "工具结果 ${toolResult.callId}\n" + toolResult.contentList.joinToString("\n") { it.displayText() }
    ContentBlock.ValueCase.EXTENSION -> "扩展内容 ${extension.namespace}/${extension.eventType}（暂不支持显示）"
    else -> "暂不支持的内容"
}
