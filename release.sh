#!/bin/bash
# Publie wCLAUDE sur GitHub : build, notarisation (_tools/notarize_app.sh), zip + .sha256, release avec notes.
# Notes : changelogs/<version>.md, une section par langue (<!-- notes:fr --> …), lues par la mise à jour de l'appli.
# DRY=1 : montre les étapes sans notariser ni publier.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
REPO="$(node -p "require('./package.json').wclaude.updateRepo")"
V="$(node -p "require('./package.json').version")"
NOTES="changelogs/$V.md"
run() { if [ "${DRY:-0}" = 1 ]; then echo "[DRY] $*"; else "$@"; fi; }

[ -f "$NOTES" ] || { echo "release : notes absentes ($NOTES)" >&2; exit 1; }
for l in fr en es it; do grep -q "<!-- notes:$l -->" "$NOTES" || { echo "release : langue $l absente de $NOTES" >&2; exit 1; }; done
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "release : modifications non commitées" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release : main n'est pas poussé" >&2; exit 1; }

NO_INSTALL=1 scripts/build.sh
APP="$ROOT/dist/wCLAUDE-darwin-arm64/wCLAUDE.app"
ZIP="$ROOT/dist/wCLAUDE-$V-macOS-arm64.zip"
run env DIST="$ROOT/dist/notarized" /Volumes/SKYRIM/TOOLS/MAC/_tools/notarize_app.sh "$APP"
run mv "$ROOT/dist/notarized/wCLAUDE.zip" "$ZIP"
if [ "${DRY:-0}" != 1 ]; then (cd "$ROOT/dist" && shasum -a 256 "$(basename "$ZIP")" > "$(basename "$ZIP").sha256"); fi
run gh release create "v$V" "$ZIP" "$ZIP.sha256" --repo "$REPO" --title "wCLAUDE $V" --notes-file "$NOTES"
