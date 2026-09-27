#!/usr/bin/env bash
# scripts/create-dmg.sh
#
# Build a signed, notarizable macOS DMG from an already-signed .app bundle.
#
# Usage:
#   ./scripts/create-dmg.sh \
#     --app   "release/mac-arm64/Jarvis.app" \
#     --out   "release/Jarvis-1.2.3-arm64.dmg" \
#     --bg    "dmg-assets/background.png" \
#     --vol   "Jarvis"
#
# Requires: create-dmg (brew install create-dmg) OR fall back to hdiutil.

set -euo pipefail

# ---- defaults --------------------------------------------------------------
APP_PATH=""
OUT_PATH=""
BG_PATH="dmg-assets/background.png"
VOL_NAME="Jarvis"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
WINDOW_SIZE="600 400"
ICON_SIZE=96

# ---- arg parsing -----------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)       APP_PATH="$2"; shift 2 ;;
    --out)       OUT_PATH="$2"; shift 2 ;;
    --bg)        BG_PATH="$2"; shift 2 ;;
    --vol)       VOL_NAME="$2"; shift 2 ;;
    --identity)  IDENTITY="$2"; shift 2 ;;
    --window)    WINDOW_SIZE="$2"; shift 2 ;;
    --icon-size) ICON_SIZE="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- validate --------------------------------------------------------------
if [[ -z "$APP_PATH" || -z "$OUT_PATH" ]]; then
  echo "ERROR: --app and --out are required" >&2
  exit 2
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: app bundle not found: $APP_PATH" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_PATH" .app)"
mkdir -p "$(dirname "$OUT_PATH")"
rm -f "$OUT_PATH"

echo "==> Building DMG"
echo "    app:      $APP_PATH"
echo "    out:      $OUT_PATH"
echo "    volume:   $VOL_NAME"
echo "    bg:       $BG_PATH"

# ---- prefer create-dmg if available ----------------------------------------
if command -v create-dmg >/dev/null 2>&1; then
  echo "==> Using create-dmg"

  ARGS=(
    --volname "$VOL_NAME"
    --window-pos 200 120
    --window-size ${WINDOW_SIZE// /,}
    --icon-size "$ICON_SIZE"
    --icon "$APP_NAME.app" 150 190
    --hide-extension "$APP_NAME.app"
    --app-drop-link 450 190
    --no-internet-enable
    --overwrite
  )

  if [[ -f "$BG_PATH" ]]; then
    ARGS+=( --background "$BG_PATH" )
  fi

  create-dmg "${ARGS[@]}" "$OUT_PATH" "$APP_PATH"
else
  echo "==> create-dmg not found — falling back to hdiutil"

  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT

  cp -R "$APP_PATH" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"

  hdiutil create \
    -volname "$VOL_NAME" \
    -srcfolder "$STAGE" \
    -ov -format UDZO \
    "$OUT_PATH"
fi

# ---- sign the DMG itself ---------------------------------------------------
if [[ -n "$IDENTITY" ]]; then
  echo "==> Signing DMG with identity: $IDENTITY"
  codesign --force --sign "$IDENTITY" --timestamp "$OUT_PATH"
  codesign --verify --verbose=2 "$OUT_PATH"
else
  echo "==> APPLE_SIGNING_IDENTITY not set — skipping DMG signing"
fi

echo "==> Done: $OUT_PATH"
ls -lh "$OUT_PATH"