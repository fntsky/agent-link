#!/usr/bin/env python3
"""Starts a real Rust Relay and exercises it with Python WebSocket endpoints.

Run through `make e2e`; generated Python messages come from the same .proto.
All state, keys and database are temporary. No real model or tool is invoked.
"""
import asyncio
import contextlib
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import urllib.request

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus
from client import Client, RemoteError, pb, transcript, uid
from harness import Harness
from mobile import Mobile

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "e2e-registration-secret-" + "x" * 32
CHECKS = 0


def passed(name):
    global CHECKS
    CHECKS += 1
    print(f"PASS {CHECKS:02d} {name}", flush=True)


async def expect_error(code, awaitable):
    try:
        await awaitable
    except RemoteError as error:
        assert error.code == code, (pb.ErrorCode.Name(code), str(error))
        return
    raise AssertionError(f"expected {pb.ErrorCode.Name(code)}")


class Server:
    def __init__(self, directory):
        self.directory = directory
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.base = f"ws://127.0.0.1:{self.port}"
        self.database = str(Path(directory) / "relay.sqlite3")
        self.log = open(Path(directory) / "server.log", "a+")
        self.process = None

    async def start(self):
        self.process = subprocess.Popen([str(ROOT / "target/debug/dsh-remote")], cwd=ROOT, env={**os.environ, "HRP_LISTEN": f"127.0.0.1:{self.port}", "HRP_DATABASE": self.database, "HRP_REGISTRATION_TOKEN": TOKEN}, stdout=self.log, stderr=self.log)
        for _ in range(100):
            if self.process.poll() is not None:
                self.log.seek(0)
                raise AssertionError(self.log.read())
            try:
                def health():
                    with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/healthz", timeout=0.2) as response:
                        return response.read()
                assert await asyncio.to_thread(health) == b"ok"
                return
            except OSError:
                await asyncio.sleep(0.05)
        raise AssertionError("Relay did not become healthy")

    async def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(self.process.wait), 5)
            except TimeoutError:
                self.process.kill()
                await asyncio.to_thread(self.process.wait)
                raise AssertionError("graceful shutdown timed out")
            assert self.process.returncode == 0
        self.process = None


async def ready(mobile):
    for _ in range(100):
        try:
            return await mobile.call("session_list", pb.SessionListRequest())
        except RemoteError as e:
            if e.code != pb.ERROR_CODE_ACL_NOT_SYNCED:
                raise
            await asyncio.sleep(0.02)
    raise AssertionError("ACL not synchronized")


async def run(server):
    clients = []
    async def phone(**kwargs):
        client = await Mobile(server.base, **kwargs).open()
        clients.append(client)
        return client
    harness = Harness(server.base)
    try:
        await server.start()
        try:
            async with connect(f"{server.base}/ws/mobile"):
                raise AssertionError("subprotocol should be mandatory")
        except InvalidStatus as e:
            assert e.response.status_code == 400
        passed("healthz and strict WebSocket subprotocol negotiation")

        anonymous = await phone()
        await expect_error(pb.ERROR_CODE_UNAUTHENTICATED, anonymous.call("session_list", pb.SessionListRequest()))
        untrusted = await Client(server.base, harness=True).open()
        clients.append(untrusted)
        await expect_error(pb.ERROR_CODE_FORBIDDEN, untrusted.rpc("harness_register", pb.HarnessRegisterRequest(harness_id="forged", public_key=untrusted.public_key)))
        passed("unauthenticated business RPC and untrusted registration rejected")

        await harness.start(TOKEN)
        owner_pair_request = pb.PairCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), harness_id=harness.identity, mode=1)
        pair = await harness.rpc("pair_create", owner_pair_request)
        replay = await harness.rpc("pair_create", owner_pair_request)
        assert replay == pair
        conflict = pb.PairCreateRequest()
        conflict.CopyFrom(owner_pair_request)
        conflict.mode = 2
        await expect_error(pb.ERROR_CODE_IDEMPOTENCY_CONFLICT, harness.rpc("pair_create", conflict))
        passed("Ed25519 Harness proof, persistent pairing idempotency and conflict")

        owner = await phone()
        # Hold acknowledgement to demonstrate the ACL barrier.
        harness.sync_gate.clear()
        paired = await owner.redeem(pair.pairing_code)
        await expect_error(pb.ERROR_CODE_ACL_NOT_SYNCED, owner.call("session_list", pb.SessionListRequest()))
        harness.sync_gate.set()
        assert not (await ready(owner)).sessions
        await owner.quiet()
        intruder = await phone()
        await expect_error(pb.ERROR_CODE_FORBIDDEN, intruder.redeem(pair.pairing_code))
        passed("owner pairing is one-use; business waits for matching ACL acknowledgement")

        bad_proof = await phone(identity=owner.identity, key=owner.key)
        challenge = await bad_proof.rpc("auth_challenge", pb.AuthChallengeRequest(identity_id=owner.identity, peer_kind=1))
        await expect_error(pb.ERROR_CODE_UNAUTHENTICATED, bad_proof.rpc("auth_prove", pb.AuthProveRequest(challenge_id=challenge.challenge_id, signature=b"\0" * 64)))
        signature = owner.key.sign(transcript(b"HRP-AUTH-v1", challenge.relay_id, owner.identity, "mobile", challenge.challenge_id, challenge.nonce))
        await expect_error(pb.ERROR_CODE_UNAUTHENTICATED, bad_proof.rpc("auth_prove", pb.AuthProveRequest(challenge_id=challenge.challenge_id, signature=signature)))
        await bad_proof.authenticate()
        await bad_proof.quiet()
        passed("invalid signature consumes challenge; reconnect proof sends no history")

        created = await owner.call("session_create", pb.SessionCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), title="Python round trip"))
        session = created.baseline.session.session_id
        assert created.baseline.cursor == 0
        await owner.send_message(session, "without subscription")
        snapshot = await owner.call("session_snapshot", pb.SessionSnapshotRequest(session_id=session))
        assert snapshot.baseline.cursor == 2 and harness.live_sent == 0
        await owner.quiet()
        assert harness.seen_principals[-1].user_id == paired.user_id
        assert harness.seen_principals[-1].device_id == owner.identity
        passed("Session/create/send/snapshot and trusted principal; no unsubscribed tokens")

        follow = await owner.call("session_follow", pb.SessionFollowRequest(session_id=session))
        assert follow.baseline.cursor == 2
        operation, message = uid(), uid()
        accepted = await owner.send_message(session, "followup", operation, message)
        assert accepted.state == pb.DELIVERY_STATE_ACCEPTED
        start = await owner.event("assistant_live_start")
        chunks = await owner.event("assistant_live_chunk")
        committed = await owner.event("session_committed")
        end = await owner.event("assistant_live_end")
        assert start.attempt.attempt_id == chunks.attempt_id == end.attempt_id
        assert [c.chunk_index for c in chunks.chunks] == [0, 1]
        assert "".join(c.content.text for c in chunks.chunks) == "hello mobile"
        assert committed.cursor == end.committed_seq == 4
        assert committed.events[-1].assistant_message.content[0].text == "hello mobile"
        passed("follow baseline before live stream; chunk order and durable settlement")

        assert await owner.send_message(session, "followup", operation, message) == accepted
        await owner.quiet()
        await expect_error(pb.ERROR_CODE_IDEMPOTENCY_CONFLICT, owner.send_message(session, "different", operation, message))
        await expect_error(pb.ERROR_CODE_INVALID_ARGUMENT, owner.send_message(session, "bad mode", mode=0))
        await owner.send_message(session, "steer", mode=2)
        await owner.event("assistant_live_end")
        page = await owner.call("session_page", pb.SessionPageRequest(session_id=session, after_seq=2, page_size=2))
        assert [e.session_seq for e in page.events] == [3, 4] and page.has_more
        earlier = await owner.call("session_page", pb.SessionPageRequest(session_id=session, before_seq=3, page_size=2))
        assert [e.session_seq for e in earlier.events] == [1, 2]
        passed("mutation replay, payload conflict, Inbox modes and SessionSeq pagination")

        # Forged event has a valid subscription but the wrong Session identity.
        await harness.emit_to(follow.subscription_id, "assistant_live_chunk", pb.AssistantLiveChunk(session_id="another-session", attempt_id="forged"))
        await owner.quiet()
        passed("Relay rejects cross-Session events on a valid subscription")

        link = await owner.call("pair_create", pb.PairCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), harness_id=harness.identity, mode=2))
        second = await phone()
        linked = await second.redeem(link.pairing_code)
        assert linked.user_id == paired.user_id
        await ready(second)
        await second.quiet()
        await expect_error(pb.ERROR_CODE_FORBIDDEN, second.call("session_unfollow", pb.SessionUnfollowRequest(subscription_id=follow.subscription_id)))
        await owner.send_message(session, "still watching")
        await owner.event("assistant_live_end")
        await second.quiet()
        passed("device_link preserves user; subscriptions are connection-owned")

        invite = await owner.call("pair_create", pb.PairCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), harness_id=harness.identity, mode=3))
        guest = await phone()
        invited = await guest.redeem(invite.pairing_code)
        assert invited.user_id != paired.user_id
        guest_directory = await ready(guest)
        assert [s.session_id for s in guest_directory.sessions] == [session]
        guest_snapshot = await guest.call("session_snapshot", pb.SessionSnapshotRequest(session_id=session))
        assert guest_snapshot.baseline.cursor == len(harness.sessions[session]["events"])
        await expect_error(pb.ERROR_CODE_FORBIDDEN, guest.call("pair_create", pb.PairCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), harness_id=harness.identity, mode=3)))
        passed("workspace Session directory is shared with every member; owner-only invitation enforced")

        await owner.send_message(session, "approval")
        approval = await owner.event("approval_request")
        assert len(approval.decision_token) == 32 and approval.call_id
        pending = await owner.call("approval_pending", pb.ApprovalPendingRequest(session_id=session))
        assert pending.requests[0].approval_id == approval.approval_id
        decision = pb.ApprovalDecideRequest(mutation=pb.Mutation(client_operation_id=uid()), session_id=session, approval_id=approval.approval_id, decision_token=approval.decision_token, decision=1)
        await expect_error(pb.ERROR_CODE_FORBIDDEN, second.call("approval_decide", decision))
        result = await owner.call("approval_decide", decision)
        assert result.status == pb.APPROVAL_DECISION_STATUS_ACCEPTED and harness.executions == 1
        assert await owner.call("approval_decide", decision) == result
        decision.mutation.client_operation_id = uid()
        result = await owner.call("approval_decide", decision)
        assert result.status == pb.APPROVAL_DECISION_STATUS_ALREADY_RESOLVED and harness.executions == 1
        passed("approval correlation, follow requirement and exactly-once decision side effect")

        await owner.send_message(session, "approval")
        reject = await owner.event("approval_request")
        result = await owner.call("approval_decide", pb.ApprovalDecideRequest(mutation=pb.Mutation(client_operation_id=uid()), session_id=session, approval_id=reject.approval_id, decision_token=reject.decision_token, decision=2))
        assert result.status == pb.APPROVAL_DECISION_STATUS_ACCEPTED and harness.executions == 1
        await owner.send_message(session, "approval")
        expired = await owner.event("approval_request")
        harness.approvals[expired.approval_id]["request"].expires_at.seconds = 1
        result = await owner.call("approval_decide", pb.ApprovalDecideRequest(mutation=pb.Mutation(client_operation_id=uid()), session_id=session, approval_id=expired.approval_id, decision_token=expired.decision_token, decision=1))
        assert result.status == pb.APPROVAL_DECISION_STATUS_STALE and harness.executions == 1
        passed("rejection and expired approval fail closed")

        assert (await owner.call("model_current", pb.ModelCurrentRequest(session_id=session))).selection.model == "mock-1"
        assert (await owner.call("model_list", pb.ModelListRequest(session_id=session))).models
        selection = pb.ModelSelection(provider="test", model="mock-2")
        assert (await owner.call("model_select", pb.ModelSelectRequest(session_id=session, mutation=pb.Mutation(client_operation_id=uid()), selection=selection))).selection == selection
        await owner.call("approval_policy_set", pb.ApprovalPolicySetRequest(session_id=session, mutation=pb.Mutation(client_operation_id=uid()), policy=2))
        assert (await owner.call("approval_policy_get", pb.ApprovalPolicyGetRequest(session_id=session))).policy == 2
        await expect_error(pb.ERROR_CODE_UNSUPPORTED_OPERATION, owner.call("unsupported", pb.UnsupportedRequest(operation="session.fork")))
        passed("model/policy control and unsupported operations")

        await owner.call("session_unfollow", pb.SessionUnfollowRequest(subscription_id=follow.subscription_id))
        await owner.send_message(session, "continue offline")
        await owner.quiet()
        assert harness.cancel_count == 0
        refollow = await owner.call("session_follow", pb.SessionFollowRequest(session_id=session))
        await owner.send_message(session, "approval")
        stale = await owner.event("approval_request")
        old_connection = harness.subscriptions[refollow.subscription_id][0]
        await owner.close()
        await second.call("session_list", pb.SessionListRequest())
        for _ in range(100):
            if old_connection in harness.closed_connections:
                break
            await asyncio.sleep(0.01)
        assert old_connection in harness.closed_connections
        assert not harness.approvals[stale.approval_id]["tokens"]
        assert harness.cancel_count == 0
        replacement = await phone(identity=owner.identity, key=owner.key)
        await replacement.authenticate()
        await replacement.call("session_follow", pb.SessionFollowRequest(session_id=session))
        result = await replacement.call("approval_decide", pb.ApprovalDecideRequest(mutation=pb.Mutation(client_operation_id=uid()), session_id=session, approval_id=stale.approval_id, decision_token=stale.decision_token, decision=1))
        assert result.status == pb.APPROVAL_DECISION_STATUS_STALE
        passed("unfollow/disconnect preserve Agent; old connection approval credentials invalidated")

        await replacement.call("agent_cancel", pb.AgentCancelRequest(session_id=session, mutation=pb.Mutation(client_operation_id=uid()), keep_inbox=True))
        end = await replacement.event("session_committed")
        assert end.events[-1].event_type == "turn/end" and harness.cancel_count == 1
        passed("cancel receipt is distinct from committed turn/end")

        await harness.close()
        await replacement.event("subscription_reset")
        await expect_error(pb.ERROR_CODE_HARNESS_OFFLINE, second.call("session_list", pb.SessionListRequest()))
        await harness.start(TOKEN, register=False)
        assert len((await ready(second)).sessions) == 1
        await second.quiet()
        passed("Harness disconnect resets subscriptions; reconnect resynchronizes ACL")

        # Relay restart keeps only identities; simulator retains Session truth.
        await harness.close()
        for c in clients:
            await c.close()
        clients.clear()
        await server.stop()
        with sqlite3.connect(server.database) as db:
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert tables == {"settings", "harnesses", "devices", "members", "pairs", "mutations"}
            assert db.execute("SELECT COUNT(*) FROM members").fetchone()[0] == 3
        await server.start()
        await harness.start(TOKEN, register=False)
        restored = await phone(identity=owner.identity, key=owner.key)
        await restored.authenticate()
        assert len((await ready(restored)).sessions) == 1
        await restored.quiet()
        assert (await restored.call("session_snapshot", pb.SessionSnapshotRequest(session_id=session))).baseline.cursor > 4
        passed("Relay restart preserves identity, stores no Session history and restores explicit reads")

        # Transport hardening uses raw sockets so malformed traffic cannot desync clients.
        for frame in ("not-binary", b"\xff\xff", b"x" * (1024 * 1024 + 1)):
            async with connect(f"{server.base}/ws/mobile", subprotocols=["hrp.pb.v1"]) as raw:
                await raw.send(frame)
                try:
                    await asyncio.wait_for(raw.recv(), 2)
                    raise AssertionError("malformed frame should close connection")
                except ConnectionClosed:
                    pass
        passed("text, malformed Protobuf and oversized frames close safely")
        assert harness.failure is None, harness.failure
    finally:
        with contextlib.suppress(Exception):
            await harness.close()
        for c in clients:
            with contextlib.suppress(Exception):
                await c.close()
        await server.stop()
        server.log.close()


async def main():
    with tempfile.TemporaryDirectory(prefix="hrp-e2e-") as directory:
        await run(Server(directory))
    print(f"\n{CHECKS} end-to-end scenarios passed")


if __name__ == "__main__":
    asyncio.run(main())
