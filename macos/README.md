# TypeByVoice macOS client

Menu-bar dictation client for macOS 13+. Speaks the shared dictation v1 protocol
over WebSocket, encodes mic audio as Ogg Opus, and inserts the final transcript
via clipboard paste.

## Build & test

```bash
cd macos
xcodebuild test -scheme TypeByVoice -destination 'platform=macOS'
```

Unit tests live in `TypeByVoiceTests`. Integration tests in
`TypeByVoiceIntegrationTests` start the Node `cli-mock` from
`contracts/dictation-v1` and run the real coordinator + encoder + remote engine
pipeline against it.

## Manual insertion matrix

Do not automate. After a successful dictate, confirm the transcript lands at the
caret in each target, both with and without a clipboard manager running
(e.g. Paste, Maccy, CopyClip).

| Target | Without clipboard manager | With clipboard manager |
|---|---|---|
| TextEdit | | |
| Notes | | |
| VS Code | | |
| Terminal | | |
| Safari text field | | |

For each cell: focus an editable field, dictate a short phrase, verify insert,
then verify the previous clipboard contents are restored after
`clipboardRestoreDelayMs` (default 150 ms). Note any app that only keeps the
transcript on the clipboard (fallback path) instead of pasting.
