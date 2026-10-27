# Project skills

Compact, repository-local references for the DSH Remote branches. They are documentation; copy one into a Harness skill directory only if you want it discovered automatically.

- `dsh-session-diagnostics` — read real DSH session JSONL; event shapes and runtime context.
- `hrp-remote-adapter` — HRP wire/Relay/adapter invariants, pairing, ACL, workspaces.
- `dsh-android-client` — Compose UI, Markdown, background connection, settings.

All three are copied into each branch so any checkout is self-contained. The table shows where each is most relevant:

| Branch | Most relevant skill(s) |
| --- | --- |
| `dsh` | `dsh-session-diagnostics`, `hrp-remote-adapter` |
| `android` | `dsh-android-client`, `hrp-remote-adapter` |
| `relay` | `hrp-remote-adapter` |
