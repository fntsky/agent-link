---
name: dsh-android-client
description: Use when changing the Android DSH Remote client: Compose chat rendering, Markdown, WebSocket lifecycle, background keepalive, pairing UI, workspace/session directory, settings, themes, or font scaling.
---

# DSH Android client

Path: `android/` in the `android` branch. The wire contract is `proto/hrp/v1/hrp.proto`; core networking is `android/core/`.

## Chat rendering conventions

- Group the durable stream into **rounds** anchored on user messages.
- The execution process (tools, results, reasoning) is collapsible and **collapsed by default**, including the last round.
- The final assistant answer is rendered **outside** the process fold and is never collapsed. Collapsing execution must not hide the answer.
- After opening a round, each tool call is still one line; tap it again for arguments/output. Match tool results by `callId`.
- Show reasoning as its own `思考 · …` row, separate from the answer.
- Hide extension events (`dsh/job/*`, `dsh/compaction/*`) and empty user/live rows.
- Strip DSH runtime-context suffixes only when they are outside code fences; keep user-quoted text intact.

## Markdown

- Use **Markwon** (Android View) inside `AndroidView`. Do not use a Compose Multiplatform Markdown artifact without checking its Compose runtime version; an incompatible version crashed on opening a conversation.
- Keep the final answer selectable and links clickable.

## Directory

- Workspace groups default collapsed.
- Each group is a bordered DSH Remote container with a per-workspace `+`.
- New sessions are created with the workspace path; expand the group and enter the new session.
- Compact session cards: at most four per viewport, horizontal scroll inside the group for more.
- Show last activity time and sort workspaces/sessions newest first.

## Connection lifecycle

- Do not disconnect in `onStop`.
- Start a foreground service with a low-importance notification while a connection is desired; request `POST_NOTIFICATIONS` on Android 13+.
- Auto-reconnect with bounded backoff (1s/2s/4s…30s). Mark manual disconnect so `onStart` does not reconnect against the user's intent.
- Foreground service is a keepalive, not a guarantee: OEM battery policies can still kill the process.

## Settings

- Persist theme mode, accent palette, font scale, and remote address in SharedPreferences.
- Apply font scale with `LocalDensity`/`Density(fontScale)` at the theme root.
- Changing the Relay address invalidates the old profile; it needs a fresh pairing code. Do not silently auto-connect to the old endpoint.

## Build and diagnosis

```sh
JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew :core:test :app:assembleDebug --offline
sha256sum app/build/outputs/apk/debug/app-debug.apk
```

Bump `versionCode`/`versionName`, report the APK path and SHA-256, and state whether Relay changed. For a crash, ask for:

```sh
adb logcat -d -s AndroidRuntime:E
```

Do not assume a desktop DSH layout equals the Android UI; verify on the phone.
