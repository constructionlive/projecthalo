#!/usr/bin/env bash
# Stages the theme kit that ships inside Halo.app (Resources/kit): what a
# custom theme is built from, and what the theme agent reads to learn.
#
#   kit/ui/src/        Halo's own UI source, read-only: the built-in themes to
#                      fork or learn from; lib/api.ts is the sandbox's (calls
#                      become messages to Halo's window)
#   kit/node_modules/  React, three.js, xterm, the fonts
#   kit/bin/esbuild    the compiler (pinned, from npm, integrity-checked by npm)
#   kit/KIT.md         how a theme works, for people and agents
#
# Run by the app build (tauri.conf.json's beforeBuildCommand); safe to rerun.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/crates/halo-app/kit"
UI="$ROOT/ui"
ESBUILD_VERSION=0.28.2
[ "$(uname -m)" = "arm64" ] && PKG="@esbuild/darwin-arm64" || PKG="@esbuild/darwin-x64"

mkdir -p "$OUT/ui" "$OUT/node_modules" "$OUT/bin"
rsync -a --delete --exclude '.DS_Store' "$UI/src/" "$OUT/ui/src/"
# In a theme, the app's api is the sandbox's.
cat > "$OUT/ui/src/lib/api.ts" <<'TS'
// In a custom theme the app's api is the sandbox's: every call is a message to
// Halo's window, which checks the theme's permissions and answers.
export { api, inApp, themeReady } from '../kit/api';
export type { TermReplay } from '../kit/api';
TS
# The app's public images (the starfield, the grain) beside the stylesheet that uses them.
cp "$UI"/public/*.png "$OUT/ui/src/styles/"
sed -i '' "s|url('/\([a-z-]*\.png\)')|url('./\1')|g" "$OUT/ui/src/styles/halo.css"
cp "$UI/src/kit/KIT.md" "$OUT/KIT.md"
cp "$UI/tsconfig.json" "$OUT/ui/tsconfig.json"

for m in react react-dom scheduler @xterm @fontsource; do
	mkdir -p "$OUT/node_modules/$(dirname "$m")"
	rsync -a --delete "$UI/node_modules/$m/" "$OUT/node_modules/$m/"
done
# three.js: the library and its add-ons, not its docs, editor or sources.
mkdir -p "$OUT/node_modules/three/examples"
rsync -a --delete "$UI/node_modules/three/build/" "$OUT/node_modules/three/build/"
rsync -a --delete "$UI/node_modules/three/examples/jsm/" "$OUT/node_modules/three/examples/jsm/"
cp "$UI/node_modules/three/package.json" "$OUT/node_modules/three/package.json"

if [ "$("$OUT/bin/esbuild" --version 2>/dev/null || true)" != "$ESBUILD_VERSION" ]; then
	TMP="$(mktemp -d)"
	(cd "$TMP" && npm pack "$PKG@$ESBUILD_VERSION" --silent >/dev/null)
	tar -xzf "$TMP"/*.tgz -C "$TMP"
	cp "$TMP/package/bin/esbuild" "$OUT/bin/esbuild"
	chmod +x "$OUT/bin/esbuild"
	rm -rf "$TMP"
fi
# Apple notarizes an app only if every executable in it carries the app's signature.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ "$APPLE_SIGNING_IDENTITY" != "-" ]; then
	codesign --force --options runtime --timestamp=none -s "$APPLE_SIGNING_IDENTITY" "$OUT/bin/esbuild" 2>/dev/null \
		|| codesign --force --options runtime -s "$APPLE_SIGNING_IDENTITY" "$OUT/bin/esbuild"
	[ "${NOTARIZE:-0}" = "1" ] && codesign --force --options runtime --timestamp -s "$APPLE_SIGNING_IDENTITY" "$OUT/bin/esbuild"
fi
echo "kit staged: $(du -sh "$OUT" | cut -f1), esbuild $("$OUT/bin/esbuild" --version)"
