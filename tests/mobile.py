"""Simulated mobile: identity proof, explicit RPC and explicit subscription."""
from client import Client, pb, transcript, uid


class Mobile(Client):
    async def redeem(self, code, operation_id=None):
        signature = self.key.sign(transcript(b"HRP-PAIR-v1", code, self.identity, self.public_key))
        return await self.rpc("pair_redeem", pb.PairRedeemRequest(
            mutation=pb.Mutation(client_operation_id=operation_id or uid()),
            pairing_code=code, device_id=self.identity, public_key=self.public_key,
            possession_signature=signature))

    async def call(self, op, value):
        return await self.rpc(op, value, "test-harness")

    async def send_message(self, session, text, operation_id=None, message_id=None, mode=1):
        return await self.call("agent_send", pb.AgentSendRequest(
            mutation=pb.Mutation(client_operation_id=operation_id or uid()),
            session_id=session, message_id=message_id or uid(),
            mode=mode, content=[pb.ContentBlock(text=text)]))
