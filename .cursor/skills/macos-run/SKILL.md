---
name: macos-run
description: >-
  Launch the existing Debug TypeByVoice.app without rebuilding. Use when the
  user asks to run, relaunch, or restart the current macOS client build.
---

# macOS run (current build)

## When to use

- User asks to run / relaunch / restart the macOS app
- Binary already exists; no code rebuild needed

## Do this

```bash
chmod +x macos/Scripts/run.sh
./macos/Scripts/run.sh
```

If the script exits with "no Debug build", switch to the `macos-build-and-run` skill.

## Defaults

| Variable | Default |
|---|---|
| `TBV_API_URL` | `http://127.0.0.1:3000` |
| `TBV_DICTATE_URL` | `ws://127.0.0.1:3000/v1/dictate` |
| `TBV_DERIVED_DATA` | `macos/DerivedData` |

## Notes

- Does **not** reset Accessibility (signature unchanged).
- For a fresh build + Accessibility reset, use `macos-build-and-run`.
