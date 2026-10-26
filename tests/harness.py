"""Test double, NOT a DeepSeek adapter. Session/ACL/approval truth lives here.

The Relay is deliberately unable to implement these operations by itself.
"""
import asyncio
import copy
import secrets
import time

from client import Client, pb, uid


class Harness(Client):
    def __init__(self, base, **kwargs):
        super().__init__(base, harness=True, identity="test-harness", **kwargs)
        self.members = {}
        self.acl_version = 0
        self.sessions = {}
        self.subscriptions = {}
        self.receipts = {}
        self.approvals = {}
        self.live_sent = 0
        self.executions = 0
        self.cancel_count = 0
        self.seen_principals = []
        self.closed_connections = []
        self.sync_gate = asyncio.Event()
        self.sync_gate.set()
        self.synced = asyncio.Event()
        self.model = pb.ModelSelection(provider="test", model="mock-1")
        self.policy = 1

    async def start(self, token, register=True):
        await self.open(token)
        if register:
            await self.rpc("harness_register", pb.HarnessRegisterRequest(harness_id=self.identity, public_key=self.public_key, display_name="Python Harness"))
        self.synced.clear()
        await self.authenticate()
        await asyncio.wait_for(self.synced.wait(), 4)
        return self

    async def incoming(self, env, forward):
        if env.WhichOneof("body") == "event":
            assert env.event.WhichOneof("operation") == "relay_connection_closed"
            connection = env.event.relay_connection_closed.connection_id
            assert connection == forward.connection_id
            self.closed_connections.append(connection)
            self.subscriptions = {k: v for k, v in self.subscriptions.items() if v[0] != connection}
            for approval in self.approvals.values():
                approval["tokens"].pop(connection, None)
            return
        assert env.WhichOneof("body") == "request"
        op = env.request.WhichOneof("operation")
        value = getattr(env.request, op)
        if op == "membership_snapshot":
            await self.sync_gate.wait()
            assert value.acl_version >= self.acl_version
            self.acl_version = value.acl_version
            self.members = {m.device_id: m for m in value.members}
            await self.reply(forward, op, pb.MembershipSnapshotResponse(applied_acl_version=self.acl_version))
            self.synced.set()
            return
        p = forward.principal
        assert forward.connection_id and forward.route_id
        assert p.device_id in self.members and self.members[p.device_id].user_id == p.user_id
        assert p.acl_version == self.acl_version
        self.seen_principals.append(copy.deepcopy(p))
        session = getattr(value, "session_id", None)
        if session and (session not in self.sessions or self.sessions[session]["user"] != p.user_id):
            await self.reply(forward, error=pb.ERROR_CODE_SESSION_NOT_FOUND)
            return
        mutation = getattr(value, "mutation", None)
        mutation_id = mutation.client_operation_id if mutation else None
        receipt_key = (p.user_id, mutation_id)
        digest = (op, value.SerializeToString())
        if mutation_id and receipt_key in self.receipts:
            old_digest, result = self.receipts[receipt_key]
            if old_digest != digest:
                await self.reply(forward, error=pb.ERROR_CODE_IDEMPOTENCY_CONFLICT)
            else:
                await self.reply(forward, op, result)
            return
        result = None
        if op == "capabilities_get":
            result = pb.CapabilitiesGetResponse(operations=["session.list", "session.follow", "agent.send", "approval.decide"], max_frame_bytes=1024 * 1024, max_page_size=200, content_types=["text"])
        elif op == "session_list":
            result = pb.SessionListResponse(sessions=[self.summary(k) for k, s in self.sessions.items() if s["user"] == p.user_id])
        elif op == "session_create":
            session = uid()
            self.sessions[session] = {"user": p.user_id, "events": [], "title": value.title}
            result = pb.SessionCreateResponse(baseline=self.baseline(session), agent=pb.AgentRef(session_id=session, agent_id=session, state=1))
        elif op in ("session_open", "session_snapshot"):
            cls = pb.SessionOpenResponse if op == "session_open" else pb.SessionSnapshotResponse
            result = cls(baseline=self.baseline(session))
        elif op == "session_page":
            events = self.sessions[session]["events"]
            if value.WhichOneof("range") == "after_seq":
                events = [e for e in events if e.session_seq > value.after_seq]
                page = events[:value.page_size or 50]
            else:
                events = [e for e in events if not value.HasField("before_seq") or e.session_seq < value.before_seq]
                page = events[-(value.page_size or 50):]
            result = pb.SessionPageResponse(events=page, has_more=len(events) > len(page), committed_seq=len(self.sessions[session]["events"]))
        elif op == "session_follow":
            sub = uid()
            self.subscriptions[sub] = (forward.connection_id, session, copy.deepcopy(p))
            result = pb.SessionFollowResponse(subscription_id=sub, baseline=self.baseline(session))
        elif op == "session_unfollow":
            self.subscriptions.pop(value.subscription_id, None)
            result = pb.SessionUnfollowResponse()
        elif op == "agent_send":
            if value.mode == 3 and 1 not in p.roles:
                await self.reply(forward, error=pb.ERROR_CODE_FORBIDDEN)
                return
            result = pb.AgentSendResponse(state=pb.DELIVERY_STATE_ACCEPTED)
        elif op == "agent_cancel":
            self.cancel_count += 1
            result = pb.AgentCancelResponse(cancel_requested=True)
        elif op == "agent_status":
            result = pb.AgentStatusResponse(agent=pb.AgentRef(session_id=session, state=1), committed_seq=len(self.sessions[session]["events"]))
        elif op == "agent_inbox_get":
            result = pb.AgentInboxGetResponse()
        elif op == "agent_create_or_resume":
            result = pb.AgentCreateOrResumeResponse(agent=pb.AgentRef(session_id=session, state=1))
        elif op == "approval_pending":
            result = pb.ApprovalPendingResponse(requests=[a["request"] for a in self.approvals.values() if a["request"].session_id == session and not a["resolved"] and a["request"].expires_at.seconds > time.time()])
        elif op == "approval_decide":
            a = self.approvals.get(value.approval_id)
            status = pb.APPROVAL_DECISION_STATUS_STALE
            if a:
                if a["resolved"]:
                    status = pb.APPROVAL_DECISION_STATUS_ALREADY_RESOLVED
                elif a["tokens"].get(forward.connection_id) == value.decision_token and a["request"].expires_at.seconds > time.time():
                    status = pb.APPROVAL_DECISION_STATUS_ACCEPTED
                    a["resolved"] = True
                    if value.decision == 1:
                        self.executions += 1
            result = pb.ApprovalDecideResponse(status=status)
        elif op == "approval_policy_get":
            result = pb.ApprovalPolicyGetResponse(policy=self.policy)
        elif op == "approval_policy_set":
            self.policy = value.policy
            result = pb.ApprovalPolicySetResponse(policy=self.policy)
        elif op == "model_current":
            result = pb.ModelCurrentResponse(selection=self.model)
        elif op == "model_list":
            result = pb.ModelListResponse(models=[pb.ModelOption(selection=self.model, capabilities=["text"])])
        elif op == "model_select":
            self.model.CopyFrom(value.selection)
            result = pb.ModelSelectResponse(selection=self.model)
        if result is None:
            await self.reply(forward, error=pb.ERROR_CODE_UNSUPPORTED_OPERATION)
            return
        if mutation_id:
            self.receipts[receipt_key] = (digest, copy.deepcopy(result))
        await self.reply(forward, op, result)
        if op == "agent_send":
            await self.generate(session, value, p)
        if op == "agent_cancel":
            event = pb.SessionEvent(event_type="turn/end", lifecycle=pb.LifecycleRecord(outcome="cancelled"))
            self.append(session, event)
            await self.emit(session, "session_committed", pb.SessionCommitted(session_id=session, events=[event], cursor=event.session_seq))

    def summary(self, session):
        s = self.sessions[session]
        return pb.SessionSummary(session_id=session, title=s["title"], agent_id=session, committed_seq=len(s["events"]), agent_state=1)

    def baseline(self, session):
        return pb.Baseline(session=self.summary(session), cursor=len(self.sessions[session]["events"]), tail=self.sessions[session]["events"][-50:])

    def append(self, session, event):
        event.session_seq = len(self.sessions[session]["events"]) + 1
        self.sessions[session]["events"].append(event)

    async def reply(self, forward, op=None, result=None, error=None):
        env = pb.Envelope(version=1, request_id=uid(), reply_to=forward.envelope.request_id, harness_id=self.identity)
        if error:
            env.error.code = error
        else:
            getattr(env.response, op).CopyFrom(result)
        await self.send(env, forward.route_id)

    async def emit(self, session, name, value):
        for sub, (_, sid, _) in list(self.subscriptions.items()):
            if sid == session:
                await self.emit_to(sub, name, value)

    async def emit_to(self, sub, name, value):
        env = pb.Envelope(version=1, request_id=uid(), harness_id=self.identity, subscription_id=sub)
        getattr(env.event, name).CopyFrom(value)
        await self.send(env)
        if name.startswith("assistant_live"):
            self.live_sent += 1

    async def generate(self, session, value, principal):
        user = pb.SessionEvent(event_type="user/message", user_message=pb.MessageRecord(message_id=value.message_id, content=value.content, source=pb.MessageSource(user_id=principal.user_id, device_id=principal.device_id, channel="hrp")))
        self.append(session, user)
        if value.content[0].text == "approval":
            request = pb.ApprovalRequest(session_id=session, approval_id=uid(), call_id=uid(), tool_name="test-tool", reason="test only")
            request.expires_at.seconds = int(time.time()) + 60
            approval = {"request": request, "tokens": {}, "resolved": False}
            self.approvals[request.approval_id] = approval
            for sub, (connection, sid, _) in list(self.subscriptions.items()):
                if sid == session:
                    token = secrets.token_bytes(32)
                    approval["tokens"][connection] = token
                    request.decision_token = token
                    await self.emit_to(sub, "approval_request", request)
            return
        attempt = uid()
        await self.emit(session, "assistant_live_start", pb.AssistantLiveStart(session_id=session, attempt=pb.LiveAttempt(attempt_id=attempt, revision=1, turn_id=uid(), step_id=uid())))
        await self.emit(session, "assistant_live_chunk", pb.AssistantLiveChunk(session_id=session, attempt_id=attempt, revision=1, chunks=[pb.LiveChunk(chunk_index=0, content=pb.ContentBlock(text="hello ")), pb.LiveChunk(chunk_index=1, content=pb.ContentBlock(text="mobile"))]))
        assistant = pb.SessionEvent(event_type="assistant/message", assistant_message=pb.AssistantRecord(attempt_id=attempt, revision=1, content=[pb.ContentBlock(text="hello mobile")], outcome="completed"))
        self.append(session, assistant)
        await self.emit(session, "session_committed", pb.SessionCommitted(session_id=session, events=[user, assistant], cursor=assistant.session_seq))
        await self.emit(session, "assistant_live_end", pb.AssistantLiveEnd(session_id=session, attempt_id=attempt, revision=1, outcome=1, committed_seq=assistant.session_seq))

    async def close(self):
        await super().close()
        self.subscriptions.clear()
        for a in self.approvals.values():
            a["tokens"].clear()
