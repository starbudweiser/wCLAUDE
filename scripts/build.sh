#!/bin/bash
# Compile wCLAUDE, le signe (sign_app.sh, certificat stable) et l'installe dans ~/Applications/Applications Personnelles.
# NO_INSTALL=1 : s'arrête après la signature (dist/…/wCLAUDE.app).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="/Volumes/SKYRIM/TOOLS/MAC/_tools"
DEST="$HOME/Applications/Applications Personnelles"
cd "$ROOT"

echo "▸ Outil Trousseau (Swift)"
swiftc -O -target arm64-apple-macos13 helper/keychain.swift -o app/bin/wCLAUDE

echo "▸ Dépendances"
[ -d node_modules/electron/dist/Electron.app ] || { npm ci; node node_modules/electron/install.js; }

echo "▸ Paquet"
APP="$(node scripts/package.mjs | tail -1)"

echo "▸ Signature de l'outil Trousseau, puis de l'appli"
HELPER="$APP/Contents/Resources/app/bin/wCLAUDE"
KC="$HOME/Library/Keychains/skyrim-signing.keychain-db"; PASS_FILE="$HOME/.skyrim-signing/keychain.pw"
if [ -f "$KC" ] && [ -f "$PASS_FILE" ]; then
  security unlock-keychain -p "$(cat "$PASS_FILE")" "$KC"
  HASH="$(security find-identity -v -p codesigning "$KC" | { grep 'Developer ID Application' || true; } | awk '{print $2}' | head -1)"
  codesign --force --options runtime --timestamp --keychain "$KC" --sign "$HASH" --identifier fr.stephan.wclaude.keychain "$HELPER"
else
  codesign --force --sign "sKYCRASH Local Signing" --identifier fr.stephan.wclaude.keychain "$HELPER" 2>/dev/null || codesign --force --sign - "$HELPER"
fi
"$TOOLS/sign_app.sh" "$APP"

[ "${NO_INSTALL:-0}" = 1 ] && { echo "$APP"; exit 0; }

echo "▸ Installation dans $DEST"
osascript -e 'tell application id "fr.stephan.wclaude" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do pgrep -f "$DEST/wCLAUDE.app/Contents/MacOS/wCLAUDE" >/dev/null || break; sleep 0.25; done
mkdir -p "$DEST"
rm -rf "$DEST/wCLAUDE.app"
ditto "$APP" "$DEST/wCLAUDE.app"
echo "✓ $DEST/wCLAUDE.app"
