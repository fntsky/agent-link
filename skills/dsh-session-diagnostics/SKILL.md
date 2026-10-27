---
name: dsh-session-diagnostics
description: Use when DSH session history, user/assistant text, live output, tool calls, runtime context, or event mapping looks wrong, or before changing DSH session/event code; inspect the real session JSONL instead of inferring shapes from the UI.
---

# DSH session diagnostics

## Read the real log first

DSH persists sessions under:

```text
$DSH_HOME/sessions/<escaped-cwd>/session-*/session.v4.jsonl.zstd
```

Decode and extract one event type at a time. Keep output bounded:

```sh
f=.../session.v4.jsonl.zstd
zstd -dc "$f" | grep -o '"type":"user/message".\{0,900\}' | tail -3
zstd -dc "$f" | grep -o '"type":"assistant/message".\{0,900\}' | tail -2
zstd -dc "$f" | grep -o '"type":"tool/call".\{0,700\}' | tail -2
```

Do not dump a whole session into context. Select the fields needed for the bug.

## Known shapes

- `user/message`: the message is `data` itself. Read `data.id`, `data.content[]`, `data.source` directly.
- `assistant/message`: the message is nested at `data.message.content[]`.
- `tool/call`: read `data.callId`, `data.name`, and `data.arguments`; arguments are a JSON string.
- `tool/result`: inspect the real event before mapping; do not assume the assistant nesting.
- `reasoning` is a content block (`type: "reasoning"`), not always a separate event.
- DSH may append runtime context to a user message as plain text:
  - `Current runtime context. ...`
  - `Time sampled while preparing ...`
  - `Browser time zone for this request: ...`
  - `Elapsed since the preceding model-visible message: ...`
- Plugin extension events look like `dsh/job/*`, `dsh/compaction/*`; they are not user content.

## Invariants

- `session_seq` is ordered; remote projections must not silently drop an event and break cursor continuity.
- `source` distinguishes a real user send from injected context (`kind`, `rpcId`, `clientTimeZone`).
- Live attempts are only meaningful for currently streaming attempts; a baseline can briefly contain an attempt with no chunks.
- Display cleanup and stored history are different layers. Do not mutate the session log just to make one client look right.

## Workflow

1. Identify the event type and the exact `data` path.
2. Verify against the latest real log, including an older/historical message.
3. Reproduce in a unit test with the same shape as the log.
4. For a remote client, prefer mapping the event to an ignored/Extension event over deleting it.
5. Recheck sequence/cursor after any filtering.

## Do not

- Infer DSH event shapes from a test fixture alone.
- Treat `data.message` as universal across event types.
- Strip runtime context without respecting fenced/inline code the user wrote.
