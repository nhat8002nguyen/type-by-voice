# Unsigned macOS DMG Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a shareable `TypeByVoice.dmg` (ad-hoc / unsigned Release build) whose API endpoints come from `macos/.env` (not hardcoded), and remain usable when billing/upgrade ships later.

**Architecture:** `package-dmg.sh` sources `macos/.env`, builds Release (existing ad-hoc `CODE_SIGN_IDENTITY = "-"`), writes `TBV_API_URL` / `TBV_DICTATE_URL` into the app `Info.plist`, then wraps the app in a DMG via `hdiutil`. The app resolves endpoints as: process env → Info.plist → Debug localhost fallback. No Developer ID, notarization, Sparkle, or CI upload.

**Tech Stack:** `xcodebuild`, ad-hoc codesign (already configured), `hdiutil`, zsh, `macos/.env` + `.env.example`.

**Spec:** Informal request (free share, no Apple Developer ID). Aligns with deferred items in `docs/superpowers/specs/2026-09-13-macos-client-design.md` — this plan covers **only** an unsigned DMG; signing/notarization/auto-update stay out of scope.

## Global Constraints

- Do **not** add Apple Developer ID, Team ID, notarization, Sparkle, or App Store packaging.
- Keep `CODE_SIGN_IDENTITY = "-"` (ad-hoc) for Release.
- **Do not hardcode** production hostnames in Swift or scripts. Endpoints for shared builds come from `macos/.env` (gitignored); commit `macos/.env.example` only.
- Resolution order in the app: `ProcessInfo` env → `Info.plist` keys `TBV_API_URL` / `TBV_DICTATE_URL` → Debug-only localhost (`http://127.0.0.1:3000`, `ws://127.0.0.1:3000/v1/dictate`). Release without plist keys must fail fast.
- Debug local defaults must keep working for `build-and-run.sh` / runtime `TBV_*` env overrides.
- Billing/upgrade later: keep sending `ClientVersion.fromBundle()` (already done); bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` when cutting a DMG. No billing UI or payment SDK in this plan.
- Recipients will hit Gatekeeper — document right-click → Open (and Accessibility). Do not try to bypass Gatekeeper with hacks.

## File Structure

```
macos/.env.example                 # NEW — TBV_API_URL / TBV_DICTATE_URL placeholders
macos/.env                         # LOCAL ONLY — copy from example; never commit
macos/Scripts/package-dmg.sh       # NEW — source .env, Release build, inject plist, DMG
macos/TypeByVoice/App/AppEndpoints.swift   # NEW — URL resolution helper
macos/TypeByVoice/App/AppModel.swift       # MODIFY — use AppEndpoints
macos/TypeByVoiceTests/AppEndpointsTests.swift  # NEW
macos/README.md                    # MODIFY — .env + DMG + Gatekeeper notes
```

Existing (do not reinvent): `build-and-run.sh`, `run.sh`. If `build-and-run-prod.sh` / `run-prod.sh` exist on the branch, point them at `macos/.env` instead of hardcoded URLs.

---

### Task 1: `.env`-driven endpoint resolution

**Files:**
- Create: `macos/.env.example`
- Create: `macos/TypeByVoice/App/AppEndpoints.swift`
- Modify: `macos/TypeByVoice/App/AppModel.swift` (engineURL / apiBaseURL defaults)
- Create: `macos/TypeByVoiceTests/AppEndpointsTests.swift`
- Ensure new Swift file is in the Xcode app target (and tests in the test target)

**Interfaces:**
- Consumes: `env["TBV_API_URL"]`, `env["TBV_DICTATE_URL"]`; optional `Bundle` Info.plist same keys
- Produces:
  - `AppEndpoints.apiBaseURL(env:bundle:) -> URL`
  - `AppEndpoints.dictateURL(env:bundle:) -> URL`
- Precedence: env → plist → `#if DEBUG` localhost → `#else` `preconditionFailure` with message to run `package-dmg.sh` / set plist

- [ ] **Step 1: Add `macos/.env.example`**

```bash
# Copy to macos/.env (gitignored) and edit for packaging / prod launches.
TBV_API_URL=https://tbv-api.nate-ng.com
TBV_DICTATE_URL=wss://tbv-api.nate-ng.com/v1/dictate
```

- [ ] **Step 2: Write failing tests for `AppEndpoints`**

```swift
import XCTest
@testable import TypeByVoice

final class AppEndpointsTests: XCTestCase {
    func testEnvOverridesWin() {
        let env = [
            "TBV_API_URL": "https://example.test",
            "TBV_DICTATE_URL": "wss://example.test/v1/dictate",
        ]
        XCTAssertEqual(AppEndpoints.apiBaseURL(env: env, bundle: .main).absoluteString, "https://example.test")
        XCTAssertEqual(AppEndpoints.dictateURL(env: env, bundle: .main).absoluteString, "wss://example.test/v1/dictate")
    }

    func testMissingEnvUsesDebugLocalhost() {
        let url = AppEndpoints.apiBaseURL(env: [:], plist: [:])
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:3000")
        XCTAssertEqual(
            AppEndpoints.dictateURL(env: [:], plist: [:]).absoluteString,
            "ws://127.0.0.1:3000/v1/dictate"
        )
    }

    func testPlistUsedWhenEnvMissing() {
        let plist = [
            "TBV_API_URL": "https://from-plist.test",
            "TBV_DICTATE_URL": "wss://from-plist.test/v1/dictate",
        ]
        XCTAssertEqual(AppEndpoints.apiBaseURL(env: [:], plist: plist).absoluteString, "https://from-plist.test")
        XCTAssertEqual(
            AppEndpoints.dictateURL(env: [:], plist: plist).absoluteString,
            "wss://from-plist.test/v1/dictate"
        )
    }
}
```

Prefer injectable `plist: [String: String]` over live Bundle in tests so XCTest does not depend on the host app’s Info.plist.

- [ ] **Step 3: Run tests — expect FAIL (type missing)**

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' -only-testing:TypeByVoiceTests/AppEndpointsTests
```

Expected: compile/link failure for `AppEndpoints`

- [ ] **Step 4: Implement `AppEndpoints` and wire `AppModel`**

```swift
import Foundation

enum AppEndpoints {
    static func apiBaseURL(
        env: [String: String] = ProcessInfo.processInfo.environment,
        plist: [String: String]? = nil,
        bundle: Bundle = .main
    ) -> URL {
        resolve(
            key: "TBV_API_URL",
            env: env,
            plist: plist ?? stringDictionary(from: bundle),
            debugFallback: "http://127.0.0.1:3000"
        )
    }

    static func dictateURL(
        env: [String: String] = ProcessInfo.processInfo.environment,
        plist: [String: String]? = nil,
        bundle: Bundle = .main
    ) -> URL {
        resolve(
            key: "TBV_DICTATE_URL",
            env: env,
            plist: plist ?? stringDictionary(from: bundle),
            debugFallback: "ws://127.0.0.1:3000/v1/dictate"
        )
    }

    private static func stringDictionary(from bundle: Bundle) -> [String: String] {
        (bundle.infoDictionary ?? [:]).compactMapValues { $0 as? String }
    }

    private static func resolve(
        key: String,
        env: [String: String],
        plist: [String: String],
        debugFallback: String
    ) -> URL {
        if let raw = env[key], let url = URL(string: raw), !raw.isEmpty {
            return url
        }
        if let raw = plist[key], let url = URL(string: raw), !raw.isEmpty {
            return url
        }
        #if DEBUG
        return URL(string: debugFallback)!
        #else
        preconditionFailure("Missing \(key). Bake it via macos/Scripts/package-dmg.sh (macos/.env) or set the env var.")
        #endif
    }
}
```

In `AppModel` init defaults:

```swift
engineURL: URL = AppEndpoints.dictateURL(),
apiBaseURL: URL = AppEndpoints.apiBaseURL(),
```

Add `AppEndpoints.swift` to the TypeByVoice target (and tests already `@testable`).

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd macos && xcodebuild test -scheme TypeByVoice -destination 'platform=macOS' -only-testing:TypeByVoiceTests/AppEndpointsTests
```

- [ ] **Step 6: Commit**

```bash
git add macos/.env.example macos/TypeByVoice/App/AppEndpoints.swift macos/TypeByVoice/App/AppModel.swift macos/TypeByVoiceTests/AppEndpointsTests.swift macos/TypeByVoice.xcodeproj/project.pbxproj
git commit -m "feat(macos): resolve API endpoints from env and Info.plist"
```

---

### Task 2: `package-dmg.sh` + share instructions

**Files:**
- Create: `macos/Scripts/package-dmg.sh`
- Modify: `macos/README.md`
- Optionally modify: `macos/Scripts/build-and-run-prod.sh` / `run-prod.sh` if present — `set -a; source "$MACOS_ROOT/.env"; set +a` instead of hardcoded exports

**Interfaces:**
- Consumes: `macos/.env` with required `TBV_API_URL` and `TBV_DICTATE_URL`
- Produces: `macos/dist/TypeByVoice-<version>+<build>.dmg` whose app Info.plist contains those keys

- [ ] **Step 1: Write `macos/Scripts/package-dmg.sh`**

```zsh
#!/bin/zsh
# Build Release TypeByVoice (ad-hoc signed), bake endpoints from macos/.env into Info.plist, wrap in DMG.
# Not notarized — recipients must right-click → Open the first time.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
ENV_FILE="${TBV_ENV_FILE:-$MACOS_ROOT/.env}"
DERIVED_DATA="${TBV_DERIVED_DATA:-$MACOS_ROOT/DerivedData-Release}"
DIST_DIR="${TBV_DIST_DIR:-$MACOS_ROOT/dist}"
STAGE="$DIST_DIR/stage"
APP_SRC="$DERIVED_DATA/Build/Products/Release/TypeByVoice.app"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing $ENV_FILE — copy macos/.env.example to macos/.env and edit" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${TBV_API_URL:-}" || -z "${TBV_DICTATE_URL:-}" ]]; then
  echo "error: TBV_API_URL and TBV_DICTATE_URL must be set in $ENV_FILE" >&2
  exit 1
fi

cd "$MACOS_ROOT"
echo "==> Building Release → $DERIVED_DATA"
xcodebuild \
  -scheme TypeByVoice \
  -destination 'platform=macOS' \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  build

if [[ ! -d "$APP_SRC" ]]; then
  echo "error: Release app missing at $APP_SRC" >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_SRC/Contents/Info.plist")"
DMG_NAME="TypeByVoice-${VERSION}+${BUILD}.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST_DIR"
ditto "$APP_SRC" "$STAGE/TypeByVoice.app"
PLIST="$STAGE/TypeByVoice.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :TBV_API_URL" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :TBV_DICTATE_URL" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :TBV_API_URL string ${TBV_API_URL}" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :TBV_DICTATE_URL string ${TBV_DICTATE_URL}" "$PLIST"
# Re-sign ad-hoc after plist edit so the seal matches.
codesign --force --deep --sign - "$STAGE/TypeByVoice.app"
ln -sf /Applications "$STAGE/Applications"

rm -f "$DMG_PATH"
echo "==> Creating $DMG_PATH (API=${TBV_API_URL})"
hdiutil create \
  -volname "TypeByVoice" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG_PATH"

rm -rf "$STAGE"
echo "==> Done: $DMG_PATH"
echo "note: unsigned — tell recipients: right-click TypeByVoice → Open (Gatekeeper)"
```

`chmod +x macos/Scripts/package-dmg.sh`

- [ ] **Step 2: Ensure local `macos/.env` exists (do not commit)**

```bash
cp macos/.env.example macos/.env
# edit if needed
```

- [ ] **Step 3: Run packaging**

```bash
./macos/Scripts/package-dmg.sh
```

Expected: DMG under `macos/dist/`; mounted app Info.plist contains `TBV_API_URL` / `TBV_DICTATE_URL` from `.env`.

- [ ] **Step 4: Smoke-check**

```bash
# Mount DMG, then:
open -n "/Volumes/TypeByVoice/TypeByVoice.app"
```

Expected: launches against the `.env` endpoints (not localhost).

- [ ] **Step 5: Document in `macos/README.md`**

```markdown
## Share (unsigned DMG)

1. `cp macos/.env.example macos/.env` and set `TBV_API_URL` / `TBV_DICTATE_URL`.
2. `./macos/Scripts/package-dmg.sh` → `macos/dist/TypeByVoice-<version>+<build>.dmg`

Endpoints are baked from `.env` into the app Info.plist at package time (not hardcoded in source).

**For recipients**

1. Open the DMG, drag TypeByVoice to Applications.
2. First launch: right-click → **Open** (Gatekeeper blocks unsigned apps).
3. Enable Accessibility + Microphone when prompted.

Bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` before each share build.
```

- [ ] **Step 6: Commit** (do **not** add `macos/.env` or `macos/dist/`)

```bash
git add macos/Scripts/package-dmg.sh macos/README.md
git commit -m "feat(macos): add unsigned DMG packaging from macos/.env"
```

Add `macos/dist/` to `.gitignore` if not already covered by root `dist/`.

---

## Out of scope (do not add)

- Apple Developer Program / Developer ID / notarization / Stapling
- Sparkle or any auto-updater
- GitHub Actions that upload DMGs
- Billing UI, StoreKit, Stripe checkout in the macOS app
- Changing bundle ID or installer `.pkg`
- Hardcoded production URLs in Swift or shell

## Self-review

1. **Spec coverage:** Free share without Developer ID → Task 2. Endpoints from `.env` → Tasks 1–2. Billing-ready later → `ClientVersion` + version bump note. Gatekeeper → README.
2. **Placeholders:** None.
3. **Consistency:** Example values in `.env.example` may show the current prod host as documentation only; runtime/source must not hardcode them as the only path.

---
