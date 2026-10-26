#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
binary="$project_root/dist/dsh-remote"
if [ ! -x "$binary" ]; then
    printf '%s\n' "Relay binary not found at $binary; run 'make build' first." >&2
    exit 1
fi

cd "$project_root"
export HRP_LISTEN="${HRP_LISTEN:-127.0.0.1:53214}"
export HRP_DATABASE="${HRP_DATABASE:-${CHAMBER_DATA_DIR:-$project_root/data}/relay.sqlite3}"
exec "$binary"
