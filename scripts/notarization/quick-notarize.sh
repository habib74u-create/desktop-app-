#!/usr/bin/env bash
# scripts/notarization/quick-notarize.sh
#
# Notarize + staple an already-signed artifact.
#
# Usage:
#   ./scripts/notarization/quick-notarize.sh path/to/Jarvis.dmg
#   ./scripts/notarization/quick-notarize.sh path/to/Jarvis.app
#
# Env:
#   APPLE_KEYCHAIN_PROFILE  preferred (see: xcrun notarytool store-credentials)
# OR:
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <path-to-.dmg-or-.app>" >&2
  exit 2
fi

if [[ ! -e "$TARGET" ]]; then
  echo "ERROR: not found: $TARGET" >&2
  exit 1
fi

# ---- submit ---------------------------------------------------------------
echo "==> Notarizing: $TARGET"

submit() {
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    xcrun notarytool submit "$1" \
      --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
      --wait
  else
    : "${APPLE_ID:?APPLE_ID required}"
    : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD required}"
    : "${APPLE_TEAM_ID:?APPLE_TEAM_ID required}"
    xcrun notarytool submit "$1" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  fi
}

# If it's an .app, zip it first (notarytool needs an archive for .app)
TMP_ZIP=""
if [[ -d "$TARGET" && "$TARGET" == *.app ]]; then
  TMP_ZIP="$(mktemp -d)/$(basename "$TARGET").zip"
  echo "==> Zipping .app → $TMP_ZIP"
  ditto -c -k --keepParent "$TARGET" "$TMP_ZIP"
  submit "$TMP_ZIP"
  rm -f "$TMP_ZIP"
else
  submit "$TARGET"
fi

# ---- staple ---------------------------------------------------------------
echo "==> Stapling"
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"

# ---- verify ---------------------------------------------------------------
echo "==> Gatekeeper check"
if [[ "$TARGET" == *.dmg ]]; then
  spctl -a -vvv -t install "$TARGET" || true
else
  spctl -a -vvv -t exec "$TARGET"
fi

echo "==> Done: $TARGET"