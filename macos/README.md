# TypeByVoice macOS client

Menu-bar dictation client for macOS 13+. Speaks the shared dictation v1 protocol
over WebSocket, encodes mic audio as Ogg Opus, and inserts the final transcript
via clipboard paste.

## Build & test

```bash
cd macos
xcodebuild test -scheme TypeByVoice -destination 'platform=macOS'
```

### Build and run (Debug)

Builds, resets Accessibility TCC for the ad-hoc-signed binary, and launches
against the local backend (`:3000` by default):

```bash
./macos/Scripts/build-and-run.sh
```

After each Debug build, re-enable **TypeByVoice** in  
System Settings → Privacy & Security → Accessibility.

### Run current build

Launch the existing Debug app without rebuilding:

```bash
./macos/Scripts/run.sh
```

Override API endpoints with `TBV_API_URL` / `TBV_DICTATE_URL` if needed.

### Prod / shared endpoints (`.env`)

```bash
cp macos/.env.example macos/.env   # gitignored — edit URLs there
./macos/Scripts/build-and-run-prod.sh   # or run-prod.sh
```

`build-and-run-prod.sh` / `run-prod.sh` load `macos/.env` (no hardcoded hosts).

## Share (unsigned DMG)

1. Ensure `macos/.env` has `TBV_API_URL` / `TBV_DICTATE_URL`.
2. Package:

```bash
./macos/Scripts/package-dmg.sh
# → macos/dist/TypeByVoice-<version>+<build>.dmg
```

Endpoints are baked from `.env` into the app Info.plist at package time (not hardcoded in source).

### Publish public download link

```bash
./macos/Scripts/publish-dmg-release.sh
# prints https://github.com/<owner>/type-by-voice/releases/download/macos-v…/TypeByVoice-….dmg
```

Share that URL with other Mac users. The GitHub repo (or Releases) must be **public** for anonymous downloads.

**For recipients**

1. Download the `.dmg`, open it, drag TypeByVoice to Applications.
2. First launch: right-click TypeByVoice → **Open** (Gatekeeper blocks unsigned apps).
3. Enable **Microphone** and **Accessibility** when prompted.

Bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in the Xcode target before each share build.

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
