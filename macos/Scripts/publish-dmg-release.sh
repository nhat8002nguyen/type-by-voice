#!/bin/zsh
# Upload a packaged DMG to the public releases repo and print the download URL.
# Default host: nhat8002nguyen/type-by-voice-releases (public). Override with TBV_RELEASE_REPO.
#
# Tag handling: the script always asks for the release tag on stdin. Press Enter
# (empty input) to accept the auto-generated next tag, or type an explicit one.
# An explicit tag may be given with or without the "macos-v" prefix.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
DIST_DIR="${TBV_DIST_DIR:-$MACOS_ROOT/dist}"
RELEASE_REPO="${TBV_RELEASE_REPO:-nhat8002nguyen/type-by-voice-releases}"
TAG_PREFIX="macos-v"
ASSET_PREFIX="TypeByVoice"

DMG_PATH="${1:-}"
if [[ -z "$DMG_PATH" ]]; then
  DMG_PATH="$(ls -t "$DIST_DIR"/TypeByVoice-*.dmg(N) 2>/dev/null | head -1 || true)"
fi
if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
  echo "error: no DMG found — run macos/Scripts/package-dmg.sh first (or pass a path)" >&2
  exit 1
fi

BASE="$(basename "$DMG_PATH" .dmg)"
VERSION_BUILD="${BASE#${ASSET_PREFIX}-}"
BASE_VERSION="${VERSION_BUILD%%+*}"
BASE_BUILD="${VERSION_BUILD##*+}"
if [[ "$BASE_VERSION" != <->.<->.<-> ]]; then
  echo "error: cannot parse version from $(basename "$DMG_PATH") (expected ${ASSET_PREFIX}-<major>.<minor>.<patch>+<build>.dmg)" >&2
  exit 1
fi
if [[ "$BASE_BUILD" == "$VERSION_BUILD" || -z "$BASE_BUILD" ]]; then
  BASE_BUILD="1"
fi

# Tags already taken on the release repo — published releases and plain git tags
# (gh release create fails if either collides).
echo "==> Listing existing tags on ${RELEASE_REPO}" >&2
if ! RELEASE_TAGS="$(gh api --paginate "repos/${RELEASE_REPO}/releases?per_page=100" --jq '.[].tag_name' 2>/dev/null)"; then
  echo "error: cannot list releases on ${RELEASE_REPO} — check 'gh auth status' and the repo name" >&2
  exit 1
fi
GIT_TAGS="$(gh api --paginate "repos/${RELEASE_REPO}/tags?per_page=100" --jq '.[].name' 2>/dev/null || true)"
EXISTING_TAGS="$(printf '%s\n%s\n' "$RELEASE_TAGS" "$GIT_TAGS" | sed '/^$/d' | sort -u)"

tag_exists() {
  print -r -- "$EXISTING_TAGS" | grep -qxF -- "$1"
}

# Next free tag for this DMG, kept strictly above every existing tag for the same
# major.minor: the DMG's own tag when it is unused and newest, otherwise the patch
# after the highest one seen. 1.0.0+1 taken → macos-v1.0.1+1, macos-v1.0.2+1, ...
next_tag() {
  local major="${BASE_VERSION%%.*}"
  local minor="${BASE_VERSION#*.}"
  minor="${minor%%.*}"
  local patch="${BASE_VERSION##*.}"
  local build="$BASE_BUILD"

  # Highest existing (patch, build) for this major.minor, or -1 when none.
  local best_patch=-1 best_build=-1
  local line rest p b
  for line in ${(f)EXISTING_TAGS}; do
    [[ -n "$line" ]] || continue
    rest="${line#${TAG_PREFIX}${major}.${minor}.}"
    [[ "$rest" != "$line" ]] || continue
    p="${rest%%+*}"
    [[ "$p" == <-> ]] || continue
    if [[ "$rest" == *+* ]]; then
      b="${rest##*+}"
    else
      b=1
    fi
    [[ "$b" == <-> ]] || b=1
    if (( p > best_patch || (p == best_patch && b > best_build) )); then
      best_patch="$p"
      best_build="$b"
    fi
  done

  if (( !(patch > best_patch || (patch == best_patch && build > best_build)) )); then
    patch=$(( best_patch + 1 ))
  fi

  local candidate_tag
  while true; do
    candidate_tag="${TAG_PREFIX}${major}.${minor}.${patch}+${build}"
    if ! tag_exists "$candidate_tag"; then
      print -r -- "$candidate_tag"
      return 0
    fi
    patch=$(( patch + 1 ))
  done
}

normalize_tag() {
  local raw="$1"
  raw="${raw#${TAG_PREFIX}}"
  raw="${raw#v}"
  raw="${raw//[[:space:]]/}"
  if [[ "$raw" != <->.<->.<-> && "$raw" != <->.<->.<->+<-> ]]; then
    echo "error: invalid tag '${1}' — expected ${TAG_PREFIX}<major>.<minor>.<patch>[+<build>]" >&2
    return 1
  fi
  print -r -- "${TAG_PREFIX}${raw}"
}

AUTO_TAG="$(next_tag)"

printf 'Release tag [%s] (Enter to accept): ' "$AUTO_TAG" >&2
if ! IFS= read -r TAG_INPUT; then
  echo "error: no tag entered (stdin closed) — run this script interactively and press Enter to accept the default" >&2
  exit 1
fi

if [[ -z "${TAG_INPUT//[[:space:]]/}" ]]; then
  TAG="$AUTO_TAG"
else
  TAG="$(normalize_tag "$TAG_INPUT")"
fi

if tag_exists "$TAG"; then
  echo "error: ${RELEASE_REPO} already has a release or tag named ${TAG} — pick a different tag" >&2
  exit 1
fi

TAG_VERSION="${TAG#${TAG_PREFIX}}"
TITLE="${ASSET_PREFIX} macOS ${TAG_VERSION} (unsigned)"

# Upload the asset under the chosen tag so tag, file name, and URL stay consistent.
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
ASSET="${ASSET_PREFIX}-${TAG_VERSION}.dmg"
ASSET_PATH="$STAGE_DIR/$ASSET"
cp "$DMG_PATH" "$ASSET_PATH"

if [[ "$TAG_VERSION" != "$VERSION_BUILD" ]]; then
  echo "warning: app bundle reports ${ASSET_PREFIX}-${VERSION_BUILD}; publishing as ${TAG_VERSION}." >&2
  echo "         Bump MARKETING_VERSION / CURRENT_PROJECT_VERSION and re-run package-dmg.sh for a matching build." >&2
fi

NOTES='Unsigned / ad-hoc-signed macOS build for free sharing (not notarized).

**Install**
1. Download the `.dmg`, open it, drag TypeByVoice to Applications.
2. First launch: right-click TypeByVoice → **Open** (Gatekeeper).
3. Enable Microphone + Accessibility when prompted.

App source stays in the private `type-by-voice` repo. This repo only hosts installers.'

echo "==> Creating GitHub Release ${TAG} on ${RELEASE_REPO} with ${ASSET}"
gh release create "$TAG" "$ASSET_PATH" \
  --repo "$RELEASE_REPO" \
  --title "$TITLE" \
  --notes "$NOTES"

TAG_ENC="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TAG")"
ASSET_ENC="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ASSET")"
URL="https://github.com/${RELEASE_REPO}/releases/download/${TAG_ENC}/${ASSET_ENC}"
echo "==> Public download URL:"
echo "$URL"
echo "    (or releases page: https://github.com/${RELEASE_REPO}/releases/tag/${TAG_ENC})"
