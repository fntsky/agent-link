"""Protobuf-only WebSocket peer shared by the simulated phone and Harness."""
import asyncio
import contextlib
import struct
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.client import connect
from hrp.v1 import hrp_pb2 as pb


def uid():
    return str(uuid.uuid4())


def transcript(prefix, *parts):
    parts = [p.encode() if isinstance(p, str) else p for p in parts]
    return prefix + b"".join(struct.pack(">I", len(p)) + p for p in parts)


class RemoteError(Exception):
    def __init__(self, error):
        self.code = error.code
        super().__init__(pb.ErrorCode.Name(error.code))


class Client:
    def __init__(self, base, harness=False, key=None, identity=None):
        self.base, self.harness = base, harness
        self.key = key or Ed25519PrivateKey.generate()
        self.identity = identity or uid()
        self.pending = {}
        self.events = asyncio.Queue()
        self.failure = None

    @property
    def public_key(self):
        return self.key.public_key().public_bytes_raw()

    async def open(self, token=None):
        path, protocol = ("harness", "hrp.relay.pb.v1") if self.harness else ("mobile", "hrp.pb.v1")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self.ws = await connect(f"{self.base}/ws/{path}", subprotocols=[protocol], additional_headers=headers, max_size=1024 * 1024)
        assert self.ws.subprotocol == protocol
        self.reader = asyncio.create_task(self.read())
        return self

    async def send(self, env, route=""):
        frame = pb.HarnessForward(route_id=route, envelope=env) if self.harness else env
        await self.ws.send(frame.SerializeToString())

    async def read(self):
        try:
            async for data in self.ws:
                assert isinstance(data, bytes)
                forward = pb.RelayForward.FromString(data) if self.harness else None
                env = forward.envelope if forward else pb.Envelope.FromString(data)
                if env.HasField("reply_to") and env.reply_to in self.pending:
                    if not self.pending[env.reply_to].done():
                        self.pending[env.reply_to].set_result(env)
                else:
                    await self.incoming(env, forward)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failure = exc
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(exc)

        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("WebSocket closed"))

    async def incoming(self, env, forward):
        await self.events.put(env)

    async def rpc(self, operation, value, harness_id=None, allow_error=False):
        env = pb.Envelope(version=1, request_id=uid())
        getattr(env.request, operation).CopyFrom(value)
        if harness_id:
            env.harness_id = harness_id
        future = asyncio.get_running_loop().create_future()
        self.pending[env.request_id] = future
        try:
            await self.send(env)
            result = await asyncio.wait_for(future, 4)
        finally:
            self.pending.pop(env.request_id, None)
        assert result.reply_to == env.request_id
        if result.WhichOneof("body") == "error":
            if allow_error:
                return result.error
            raise RemoteError(result.error)
        assert result.response.WhichOneof("operation") == operation
        return getattr(result.response, operation)

    async def authenticate(self):
        challenge = await self.rpc("auth_challenge", pb.AuthChallengeRequest(identity_id=self.identity, peer_kind=2 if self.harness else 1))
        message = transcript(b"HRP-AUTH-v1", challenge.relay_id, self.identity, "harness" if self.harness else "mobile", challenge.challenge_id, challenge.nonce)
        return await self.rpc("auth_prove", pb.AuthProveRequest(challenge_id=challenge.challenge_id, signature=self.key.sign(message)))

    async def quiet(self, timeout=0.08):
        try:
            event = await asyncio.wait_for(self.events.get(), timeout)
        except TimeoutError:
            return
        raise AssertionError(f"unexpected event: {event.event.WhichOneof('operation')}")

    async def event(self, name):
        while True:
            result = await asyncio.wait_for(self.events.get(), 4)
            if result.event.WhichOneof("operation") == name:
                return getattr(result.event, name)

    async def close(self):
        await self.ws.close()
        self.reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader
