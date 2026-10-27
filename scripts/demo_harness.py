#!/usr/bin/env python3
"""Interactive test Harness for the Android app. No real model/tool execution."""
import argparse
import asyncio
import os
from pathlib import Path
import signal

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from client import RemoteError, pb, uid
from harness import Harness


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--relay", default="ws://127.0.0.1:53214", help="Relay base URL, including Chamber prefix if present")
    parser.add_argument("--identity", default="demo-harness")
    parser.add_argument("--key-file", default=".gen/demo-harness.key")
    args = parser.parse_args()
    token = os.environ.get("HRP_REGISTRATION_TOKEN")
    if not token:
        parser.error("set HRP_REGISTRATION_TOKEN to match the Relay")
    path = Path(args.key_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(Ed25519PrivateKey.generate().private_bytes_raw())
    harness = Harness(args.relay.rstrip("/"), key=Ed25519PrivateKey.from_private_bytes(path.read_bytes()), identity=args.identity)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, stop.set)
    try:
        await harness.start(token)
        print("模拟 Harness 已上线；Session 只保留在此进程中，不执行真实模型或工具。", flush=True)
        try:
            pair = await harness.rpc("pair_create", pb.PairCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), harness_id=harness.identity, mode=1))
            code = pair.pairing_code
            print(f"首次 owner 配对码（六位，单次有效，最多 5 分钟）：\n{code[:3]}-{code[3:]}", flush=True)
        except RemoteError as error:
            if error.code != pb.ERROR_CODE_FORBIDDEN:
                raise
            print("此 Harness 已有 owner：请用原手机登录，或在原手机中生成 device_link / invite 配对码。", flush=True)
        print("手机中填 Relay 地址；消息返回 hello mobile，发送 approval 可测试工具审批。Ctrl+C 停止。", flush=True)
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), 1)
            except TimeoutError:
                if harness.failure is not None:
                    raise harness.failure
    finally:
        await harness.close()


if __name__ == "__main__":
    asyncio.run(main())
