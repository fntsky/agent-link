package dev.dshremote.core

import dev.dshremote.protocol.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Uses exactly the same Kotlin transport/reducer as the Android application. */
class RelayIntegrationTest {
    @Test fun realRustRelayAndPythonHarnessRoundTrip() = runBlocking {
        val base = System.getenv("HRP_TEST_URL")
        assumeTrue("Run with make android-e2e", !base.isNullOrBlank())
        val client = RelayClient(DeviceIdentity(DeviceIdentity.newId(), DeviceIdentity.newSeed()))
        val endpoint = mobileEndpoint(base!!, true)
        try {
            client.connect(endpoint)
            val paired = client.redeem(requireNotNull(System.getenv("HRP_TEST_PAIRING_CODE")), DeviceIdentity.newId())
            assertEquals("test-harness", paired.harnessId)
            assertNull(client.conversation.value)
            client.connect(endpoint)
            client.authenticate(requireNotNull(System.getenv("HRP_TEST_RELAY_ID")))
            client.selectHarness(paired.harnessId)
            var listed: SessionListResponse? = null
            for (attempt in 0..10) {
                try { listed = client.sessions(); break }
                catch (e: RelayException) { if (e.code != ErrorCode.ERROR_CODE_ACL_NOT_SYNCED) throw e; delay(100) }
            }
            assertNotNull(listed)
            assertTrue(listed!!.sessionsList.isEmpty())
            val created = client.createSession("Kotlin round trip", "", DeviceIdentity.newId())
            val session = created.baseline.session.sessionId
            // The native directory is shared immediately; no plugin-specific session list.
            assertTrue(client.sessions().sessionsList.any { it.sessionId == session })
            client.follow(session)
            assertTrue(client.conversation.value!!.following)
            assertEquals(0L, client.conversation.value!!.cursor)
            val operation = DeviceIdentity.newId()
            val message = DeviceIdentity.newId()
            assertEquals(DeliveryState.DELIVERY_STATE_ACCEPTED, client.send(session, "from Kotlin", SendMode.SEND_MODE_FOLLOWUP, operation, message).state)
            val committed = withTimeout(5000) { client.conversation.first { it?.cursor == 2L && it.live.isEmpty() } }!!
            assertFalse(committed.needsResync)
            assertEquals("hello mobile", committed.events.last().assistantMessage.contentList.single().text)
            client.send(session, "from Kotlin", SendMode.SEND_MODE_FOLLOWUP, operation, message)
            delay(100)
            assertEquals(2L, client.conversation.value!!.cursor)
            try {
                client.send(session, "changed", SendMode.SEND_MODE_FOLLOWUP, operation, message)
                fail("same operation cannot change payload")
            } catch (e: RelayException) { assertEquals(ErrorCode.ERROR_CODE_IDEMPOTENCY_CONFLICT, e.code) }
            client.send(session, "steer", SendMode.SEND_MODE_STEER, DeviceIdentity.newId(), DeviceIdentity.newId())
            withTimeout(5000) { client.conversation.first { it?.cursor == 4L && it.live.isEmpty() } }
            client.send(session, "approval", SendMode.SEND_MODE_FOLLOWUP, DeviceIdentity.newId(), DeviceIdentity.newId())
            val approvals = withTimeout(5000) { client.conversation.first { !it?.approvals.isNullOrEmpty() } }!!
            assertFalse(approvals.needsResync)
            val approval = approvals.approvals.values.single()
            assertTrue(approvals.events.any { it.hasToolCall() && it.toolCall.callId == approval.callId })
            assertEquals(ApprovalDecisionStatus.APPROVAL_DECISION_STATUS_ACCEPTED, client.decide(approval, ApprovalDecision.APPROVAL_DECISION_REJECT, DeviceIdentity.newId()))
            assertTrue(client.conversation.value!!.approvals.isEmpty())
            assertTrue(client.models(session).modelsList.isNotEmpty())
            val chosen = ModelSelection.newBuilder().setProvider("test").setModel("kotlin-selected").build()
            assertEquals(chosen, client.selectModel(session, chosen, DeviceIdentity.newId()))
            assertEquals(chosen, client.currentModel(session))
            val link = client.createPair(PairMode.PAIR_MODE_DEVICE_LINK, DeviceIdentity.newId())
            assertTrue(link.pairingCode.isNotEmpty())
            val cursor = client.conversation.value!!.cursor
            client.cancel(session, true, DeviceIdentity.newId())
            val cancelled = withTimeout(5000) { client.conversation.first { (it?.cursor ?: 0) > cursor } }!!
            assertEquals("turn/end", cancelled.events.last().eventType)
            client.leave()
            assertNull(client.conversation.value)
            client.follow(session)
            assertEquals(cancelled.cursor, client.conversation.value!!.cursor)
            client.disconnect()
            assertFalse(client.conversation.value!!.following)
            assertTrue(client.conversation.value!!.approvals.isEmpty())
            client.connect(endpoint)
            try { client.authenticate("wrong-relay-id"); fail("Relay pin must be enforced") }
            catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("Relay")) }
        } finally { client.close() }
    }
}
