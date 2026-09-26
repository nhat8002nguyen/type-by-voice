---
name: macos-build-and-run
description: >-
  Build the Debug TypeByVoice macOS app, reset Accessibility TCC for the
  ad-hoc-signed binary, and launch it against the local backend. Use when the
  user asks to build and run the macOS client, rebuild TypeByVoice, or refresh
  a Debug build after code changes.
---

# macOS build and run

## When to use

- User asks to build and run / rebuild the macOS app
- After macOS client code changes that need a fresh binary

## Do this

1. From the repo root (or any worktree that contains `macos/`), run:

```bash
chmod +x macos/Scripts/build-and-run.sh macos/Scripts/reset-accessibility.sh
./macos/Scripts/build-and-run.sh
```

2. Tell the user to re-enable **TypeByVoice** in  
   System Settings → Privacy & Security → Accessibility  
   (Debug builds re-sign every compile; the reset clears the stale grant).

## Defaults

| Variable | Default |
|---|---|
| `TBV_API_URL` | `http://127.0.0.1:3000` |
| `TBV_DICTATE_URL` | `ws://127.0.0.1:3000/v1/dictate` |
| `TBV_DERIVED_DATA` | `macos/DerivedData` |

Override by exporting env vars before running the script.

## Notes

- The Xcode Debug target also runs `reset-accessibility.sh` as a build phase; the script calls it again explicitly after `xcodebuild` so the reset is visible in the terminal.
- For launch-only (no rebuild), use the `macos-run` skill / `macos/Scripts/run.sh`.
