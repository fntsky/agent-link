"""Real Kotlin client core -> Rust Relay -> Python Harness integration."""
import asyncio
import contextlib
import os
from pathlib import Path
import sqlite3
import tempfile

from client import pb, uid
from e2e import Server, TOKEN
from harness import Harness

ROOT = Path(__file__).resolve().parents[1]


async def main():
    with tempfile.TemporaryDirectory(prefix="hrp-kotlin-e2e-") as directory:
        server = Server(directory)
        harness = Harness(server.base)
        try:
            await server.start()
            await harness.start(TOKEN)
            pair = await harness.rpc("pair_create", pb.PairCreateRequest(mutation=pb.Mutation(client_operation_id=uid()), harness_id=harness.identity, mode=1))
            with sqlite3.connect(server.database) as database:
                relay = database.execute("SELECT value FROM settings WHERE key='relay_id'").fetchone()[0]
            env = {**os.environ, "HRP_TEST_URL": server.base, "HRP_TEST_PAIRING_CODE": pair.pairing_code, "HRP_TEST_RELAY_ID": relay}
            process = await asyncio.create_subprocess_exec(str(ROOT / "android/gradlew"), "-p", str(ROOT / "android"), ":core:test", "--tests", "*RelayIntegrationTest", "--rerun-tasks", "--console=plain", cwd=ROOT, env=env)
            try:
                code = await asyncio.wait_for(process.wait(), 180)
            except BaseException:
                process.terminate()
                await process.wait()
                raise
            assert code == 0, f"Kotlin integration failed ({code})"
            assert harness.failure is None, harness.failure
            assert harness.cancel_count == 1
            assert harness.executions == 0, "reject must not execute the simulated tool"
            assert any(s["title"] == "Kotlin round trip" for s in harness.sessions.values())
            print("PASS Kotlin pair/auth/follow/send/steer/idempotency/approval/model/cancel/reconnect against Rust Relay")
        finally:
            with contextlib.suppress(Exception):
                await harness.close()
            await server.stop()
            server.log.close()


if __name__ == "__main__":
    asyncio.run(main())
