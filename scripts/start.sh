#!/bin/sh
set -eu
export HRP_LISTEN="${HRP_LISTEN:-127.0.0.1:53214}"
export HRP_DATABASE="${HRP_DATABASE:-${CHAMBER_DATA_DIR:-./data}/relay.sqlite3}"
exec ./target/release/dsh-remote
