#!/usr/bin/env bash
# scripts/notarization/build-sign-notarize.sh
#
# End-to-end macOS release: build → sign → notarize → staple → DMG → sign DMG → notarize DMG → staple DMG
#
# Required env vars:
#   APPLE_ID                your Apple ID email
#   APPLE_APP_SPECIFIC_PASSWORD   app-specific password from appleid.apple.com
#   APPLE_TEAM_ID           10-char Team ID
#   APPLE_SIGNING_IDENTITY  "Developer ID Application: Your Name (TEAMID)"
#
# Optional:
#   APPLE_KEYCHAIN_PROFILE  if set, uses keychain profile instead of APPLE_ID/password
#   SKIP_BUILD=1            skip npm run build + electron-builder (reuse existing artifacts)
#   ARCH=arm64|x64          default: current host arch
#
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

# ---- config ---------------------------------------------------------------
ARCH="${ARCH:-$(uname -m)}"
[[ "$ARCH" == "aarch64" ]] && ARCH="arm64"
PRODUCT_NAME="Jarvis"
VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="release"
APP_DIR="release/mac-${ARCH}"
APP_PATH="${APP_DIR}/${PRODUCT_NAME}.app"
DMG_PATH="${OUT_DIR}/${PRODUCT_NAME}-${VERSION}-${ARCH}.dmg"

# ---- sanity ---------------------------------------------------------------
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}"

if [[ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  : "${APPLE_ID:?APPLE_ID is required (or set APPLE_KEYCHAIN_PROFILE)}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required (or set APPLE_KEYCHAIN_PROFILE)}"
fi

echo "=============================================="
echo " macOS build + sign + notarize"
echo "=============================================="
echo " product:   $PRODUCT_NAME"
echo " version:   $VERSION"
echo " arch:      $ARCH"
echo " identity:  $APPLE_SIGNING_IDENTITY"
echo " team:      $APPLE_TEAM_ID"
echo "=============================================="

# ---- 1. clean --------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Cleaning previous build"
  rm -rf "$OUT_DIR" dist
fi

# ---- 2. build --------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> npm ci"
  npm ci

  echo "==> Rebuilding native modules"
  npx electron-rebuild -f

  echo "==> webpack build"
  NODE_ENV=production npm run build

  echo "==> electron-builder (mac, dir target only — we'll DMG ourselves)"
  npx electron-builder \
    --mac dir \
    --"$ARCH" \
    --publish never \
    --config electron-builder.yml
fi

[[ -d "$APP_PATH" ]] || { echo "ERROR: app bundle missing: $APP_PATH"; exit 1; }

# ---- 3. codesign the .app (electron-builder already does this, re-verify) --
echo "==> Verifying .app signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -d --entitlements :- "$APP_PATH" 2>&1 | head -50 || true

# ---- 4. notarize the .app --------------------------------------------------
echo "==> Notarizing .app (this can take 2-10 minutes)"
APP_ZIP="${OUT_DIR}/${PRODUCT_NAME}-${VERSION}-${ARCH}-app.zip"
ditto -c -k --keepParent "$APP_PATH" "$APP_ZIP"

notarize() {
  local file="$1"
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    xcrun notarytool submit "$file" \
      --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
      --wait
  else
    xcrun notarytool submit "$file" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  fi
}

notarize "$APP_ZIP"

# ---- 5. staple the .app ----------------------------------------------------
echo "==> Stapling .app"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl -a -vvv -t exec "$APP_PATH"

rm -f "$APP_ZIP"

# ---- 6. build the DMG ------------------------------------------------------
echo "==> Building DMG"
./scripts/create-dmg.sh \
  --app "$APP_PATH" \
  --out "$DMG_PATH" \
  --bg  "dmg-assets/background.png" \
  --vol "$PRODUCT_NAME" \
  --identity "$APPLE_SIGNING_IDENTITY"

# ---- 7. notarize the DMG ---------------------------------------------------
echo "==> Notarizing DMG"
notarize "$DMG_PATH"

# ---- 8. staple the DMG -----------------------------------------------------
echo "==> Stapling DMG"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl -a -vvv -t install "$DMG_PATH" || true

# ---- 9. summarize ----------------------------------------------------------
echo ""
echo "=============================================="
echo " DONE"
echo "=============================================="
echo " app: $APP_PATH"
echo " dmg: $DMG_PATH"
ls -lh "$DMG_PATH"
echo "=============================================="
