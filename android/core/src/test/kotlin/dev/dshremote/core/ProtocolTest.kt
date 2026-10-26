package dev.dshremote.core

import com.google.protobuf.ByteString
import dev.dshremote.protocol.*
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun baseline(cursor: Long = 0): Conversation = ConversationReducer.baseline(SessionFollowResponse.newBuilder().setSubscriptionId("sub").setBaseline(Baseline.newBuilder().setCursor(cursor).setSession(SessionSummary.newBuilder().setSessionId("s"))).build())
    private fun start(revision: Long = 1) = Event.newBuilder().setAssistantLiveStart(AssistantLiveStart.newBuilder().setSessionId("s").setAttempt(LiveAttempt.newBuilder().setAttemptId("a").setRevision(revision))).build()
    private fun chunk(index: Long = 0, revision: Long = 1, session: String = "s") = Event.newBuilder().setAssistantLiveChunk(AssistantLiveChunk.newBuilder().setSessionId(session).setAttemptId("a").setRevision(revision).addChunks(LiveChunk.newBuilder().setChunkIndex(index).setContent(ContentBlock.newBuilder().setText("hello")))).build()
    @Test fun ed25519MatchesRfc8032Vector() {
        val identity = DeviceIdentity("test", hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
        assertArrayEquals(hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), identity.publicKey)
        assertArrayEquals(hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"), identity.sign(byteArrayOf()))
    }
    @Test fun transcriptUsesByteLengthsAndBigEndian() {
        assertArrayEquals(hex("485250000000016100000003e4b8ad"), DeviceIdentity.transcript("HRP", "a".toByteArray(), "中".toByteArray()))
    }
    @Test fun endpointsKeepChamberPrefixAndRejectCredentialUrls() {
        assertEquals("wss://host/dsh-remote/ws/mobile", mobileEndpoint("wss://host/dsh-remote/"))
        assertEquals("wss://host/ws/mobile", mobileEndpoint("wss://host/ws/mobile"))
        assertEquals("ws://10.0.2.2:53214/ws/mobile", mobileEndpoint("ws://10.0.2.2:53214", true))
        for (invalid in listOf("http://host", "ws://host", "wss://user:password@host", "wss://host?secret=1", "wss://host#secret")) {
            assertThrows(IllegalArgumentException::class.java) { mobileEndpoint(invalid) }
        }
    }
    @Test fun committedOutputReplacesLiveWithoutDuplicateAnswer() {
        var state = ConversationReducer.apply(baseline(), start())
        state = ConversationReducer.apply(state, chunk())
        assertEquals("hello", state.live["a"]!!.blocks.single().text)
        val record = SessionEvent.newBuilder().setSessionSeq(1).setAssistantMessage(AssistantRecord.newBuilder().setAttemptId("a").setRevision(1).addContent(ContentBlock.newBuilder().setText("hello"))).build()
        state = ConversationReducer.apply(state, Event.newBuilder().setSessionCommitted(SessionCommitted.newBuilder().setSessionId("s").setCursor(1).addEvents(record)).build())
        assertTrue(state.live.isEmpty())
        assertEquals(1L, state.cursor)
        assertEquals(1, state.events.size)
        val duplicate = ConversationReducer.apply(state, Event.newBuilder().setSessionCommitted(SessionCommitted.newBuilder().setSessionId("s").setCursor(1).addEvents(record)).build())
        assertEquals(state, duplicate)
    }
    @Test fun duplicateChunksAndOlderRevisionsCannotOverwriteCurrentAttempt() {
        var state = ConversationReducer.apply(baseline(), start(2))
        state = ConversationReducer.apply(state, chunk(revision = 2))
        val original = state
        assertEquals(original, ConversationReducer.apply(state, chunk(revision = 2)))
        assertEquals(original, ConversationReducer.apply(state, chunk(revision = 1)))
        assertEquals(original, ConversationReducer.apply(state, start(1)))
        val old = SessionEvent.newBuilder().setSessionSeq(1).setAssistantAttempt(AssistantRecord.newBuilder().setAttemptId("a").setRevision(1)).build()
        state = ConversationReducer.apply(state, Event.newBuilder().setSessionCommitted(SessionCommitted.newBuilder().setSessionId("s").setCursor(1).addEvents(old)).build())
        assertEquals(2L, state.live["a"]!!.revision)
    }
    @Test fun gapInvalidatesLiveAndApprovalCredentials() {
        var state = ConversationReducer.apply(baseline(), start())
        state = state.copy(approvals = mapOf("approval" to ApprovalRequest.newBuilder().setDecisionToken(ByteString.copyFrom(ByteArray(32))).build()))
        val broken = ConversationReducer.apply(state, chunk(2))
        assertTrue(broken.needsResync)
        assertTrue(broken.approvals.isEmpty())
        assertTrue(broken.live.isEmpty())
        val record = SessionEvent.newBuilder().setSessionSeq(2).build()
        val durableGap = ConversationReducer.apply(state, Event.newBuilder().setSessionCommitted(SessionCommitted.newBuilder().setSessionId("s").setCursor(2).addEvents(record)).build())
        assertTrue(durableGap.needsResync)
        assertEquals(0L, durableGap.cursor)
    }
    @Test fun unrelatedSessionsAndInactiveSubscriptionsAreIgnored() {
        val state = ConversationReducer.apply(baseline(), start())
        assertEquals(state, ConversationReducer.apply(state, chunk(session = "other")))
        val inactive = state.copy(following = false)
        assertEquals(inactive, ConversationReducer.apply(inactive, chunk()))
    }
    @Test fun resetDropsLiveAndApprovalsButPreservesCommittedHistory() {
        val baseline = baseline(8)
        val state = ConversationReducer.apply(baseline, start()).copy(approvals = mapOf("a" to ApprovalRequest.getDefaultInstance()))
        val reset = ConversationReducer.apply(state, Event.newBuilder().setSubscriptionReset(SubscriptionReset.newBuilder().setSubscriptionId("sub")).build())
        assertFalse(reset.following)
        assertTrue(reset.live.isEmpty())
        assertTrue(reset.approvals.isEmpty())
        assertEquals(8L, reset.cursor)
    }
    @Test fun historyPagingDoesNotMoveCurrentDurableCursor() {
        val original = baseline(10)
        val records = listOf(SessionEvent.newBuilder().setSessionSeq(4).build(), SessionEvent.newBuilder().setSessionSeq(5).build())
        val state = ConversationReducer.older(original, SessionPageResponse.newBuilder().addAllEvents(records).build())
        val duplicate = ConversationReducer.older(state, SessionPageResponse.newBuilder().addAllEvents(records).build())
        assertEquals(10L, duplicate.cursor)
        assertEquals(listOf(4L, 5L), duplicate.events.map { it.sessionSeq })
    }
}
