---
name: hrp-remote-adapter
description: Use when changing the HRP wire contract, Relay forwarding, DSH adapter event mapping, pairing/ACL/member state, live follow, or workspace-scoped session creation across the relay, dsh, and android branches.
---

# HRP remote adapter

Repository layout varies by branch. Check the branch before editing:

- `dsh`: Harness plugin under `plugin/`; wire source `plugin/proto/hrp.proto`.
- `android`: Kotlin client under `android/`; wire source `proto/hrp/v1/hrp.proto`.
- `relay`: Rust Relay; wire source `proto/hrp/v1/hrp.proto`; implementation `src/`.

## Wire changes

- Add optional fields; never reuse a removed field number. Reserve deleted numbers.
- Update every copy of the proto and regenerate the plugin schema:
  `python3 plugin/scripts/generate-schema.py` on `dsh`.
- The Relay decodes and re-encodes protobuf. **prost drops unknown fields**, so a new field is lost until the Relay proto is updated and the binary rebuilt.
- Rebuild `dist/dsh-remote`, update `dist/SHA256SUMS`, and report the new hash. Pushing the branch is not deploying the server.

## Event stream

- Preserve `session_seq` continuity. Do not drop events in the adapter; map hidden events to `Extension` so the remote cursor stays valid.
- `SessionCommitted` must stay contiguous; a gap requires a resync, not silently appending.
- Baseline and live attempts are separate. An active attempt with no chunk must not render a permanent placeholder.
- `user/message` stores the message directly in `data`; `assistant/message` nests it under `data.message`. See `dsh-session-diagnostics`.
- Reasoning and tool calls can be content blocks inside an assistant message as well as separate events; handle both.
- Extension events such as `dsh/job/*` and `dsh/compaction/*` are not chat content; hide them in the client.
- DSH may append runtime context to user text. Strip it for display only; keep it in the log.

## Mutations and identity

- All mutations carry a client operation id and persistent idempotency receipts.
- Create-session operation ids must be unique per user action; do not derive them from title/workspace, or the second blank-titled create returns the first receipt.
- Member revoke closes device connections and bumps ACL once. Removing the last owner must allow a new owner pairing.
- When revoking a device with no remaining memberships, delete the orphan identity so the same phone can re-pair.
- Pairing codes are six Crockford Base32 characters (no I/L/O/U). Normalize case, spaces, dashes, and O/I/L/U → 0/1/1/V consistently on Relay and client. The signature still covers the bytes the client sent.

## Workspace-scoped creation

`SessionCreateRequest.workspace` carries the native workspace path. The adapter calls:

```js
sessionController.create({ cwd: workspace })
```

If the just-created session's inspected metadata has no workspace, set the requested workspace on the returned summary so grouping stays correct.

## Verification

```sh
# dsh plugin
node --test plugin/test/*.test.mjs

# relay
cargo test --release --locked

# android
./gradlew :core:test :app:assembleDebug --offline
```

Also test with a real Relay when the change crosses the wire; unit fixtures cannot catch field-dropping or cursor gaps.
