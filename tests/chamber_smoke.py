"""Smoke prebuilt startup and TOML-managed credentials without starting Formicary."""
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import tomllib
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
config = tomllib.loads((ROOT / "chamber.toml").read_text())
assert config["chamber"]["name"] == "dsh-remote"
assert config["chamber"]["schema_version"] == 1
assert "prepare" not in config["chamber"], "prebuilt deployment must not compile"
assert (ROOT / "dist/dsh-remote").is_file()
proxy = config["proxyhttp"]
upstream = urlparse(proxy["upstream"])
assert upstream.scheme == "http" and upstream.hostname == "127.0.0.1"
assert proxy["route"] == "/dsh-remote"
with tempfile.TemporaryDirectory(prefix="hrp-chamber-") as directory:
    original_token = None
    for run in range(3):
        with socket.socket() as check:
            check.bind((upstream.hostname, 0))
            port = check.getsockname()[1]
        with open(Path(directory) / "server.log", "a+") as log:
            env = {k: v for k, v in os.environ.items() if k not in ("HRP_LISTEN", "HRP_DATABASE", "HRP_REGISTRATION_TOKEN", "HRP_REGISTRATION_TOKEN_FILE")}
            env.update(HRP_LISTEN=f"127.0.0.1:{port}", CHAMBER_DATA_DIR=directory)
            if run == 2:
                env["HRP_REGISTRATION_TOKEN"] = "explicit-override-" + "x" * 32
            # script is trusted TOML shell text, matching Formicary's execution model.
            process = subprocess.Popen(["sh", "-c", proxy["script"]], cwd=ROOT / proxy["working_directory"], env=env, stdout=log, stderr=log, start_new_session=True)
            try:
                for _ in range(100):
                    assert process.poll() is None, "start script exited before healthy"
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}" + proxy["health_path"], timeout=0.2) as response:
                            assert response.status == 200 and response.read() == b"ok"
                        break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise AssertionError("health check timed out")
                database = Path(directory) / "relay.sqlite3"
                assert database.is_file()
                with sqlite3.connect(database) as db:
                    assert db.execute("SELECT value FROM settings WHERE key='relay_id'").fetchone()
                token_file = Path(directory) / "relay-registration-token"
                token = token_file.read_text().strip()
                assert len(token) == 64
                assert token_file.stat().st_mode & 0o777 == 0o600
                if original_token is None:
                    original_token = token
                assert token == original_token, "restart or override must preserve the token file"
            finally:
                # Formicary also stops the whole shell process group.
                import signal
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            assert process.returncode in (0, -signal.SIGTERM)
    print("PASS prebuilt Chamber startup, health, shared data, private token generation/reuse/override, shutdown")
