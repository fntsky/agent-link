"""Smoke the actual chamber.toml start command with temporary shared data.

This validates the upstream process contract, not Formicary's own proxy code.
"""
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
assert "prepare" not in config["chamber"], "prebuilt deployment must not compile at startup"
assert (ROOT / "dist/dsh-remote").is_file()
proxy = config["proxyhttp"]
upstream = urlparse(proxy["upstream"])
assert upstream.scheme == "http" and upstream.hostname == "127.0.0.1"
assert proxy["route"] == "/dsh-remote"
with tempfile.TemporaryDirectory(prefix="hrp-chamber-") as directory:
    with socket.socket() as check:
        check.bind((upstream.hostname, 0))
        port = check.getsockname()[1]
    with open(Path(directory) / "server.log", "w+") as log:
        env = {k: v for k, v in os.environ.items() if k not in ("HRP_LISTEN", "HRP_DATABASE")}
        env.update(HRP_LISTEN=f"127.0.0.1:{port}", CHAMBER_DATA_DIR=directory, HRP_REGISTRATION_TOKEN="chamber-smoke-" + "x" * 32)
        process = subprocess.Popen(["sh", "-c", "exec " + proxy["script"]], cwd=ROOT / proxy["working_directory"], env=env, stdout=log, stderr=log)
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
            assert database.is_file(), "database must use CHAMBER_DATA_DIR"
            with sqlite3.connect(database) as db:
                assert db.execute("SELECT value FROM settings WHERE key='relay_id'").fetchone()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError("SIGTERM did not stop foreground process")
        assert process.returncode == 0
        print("PASS chamber.toml foreground script, /healthz, shared database path, SIGTERM")
