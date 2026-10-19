#!/usr/bin/env bash
# Builds a Halo release and publishes it to the update feed every installed
# copy checks: https://pub-061018a047d54079b309fb16a26a1ce0.r2.dev/halo/latest.json
#
#   NOTES="- Arenas for every workspace\n- Terminal cars" scripts/release-macos.sh
#   CRITICAL=1 …    # can't be skipped or put off
#   DRY_RUN=1 …     # build and print the manifest, upload nothing
#   SKIP_BUILD=1 …  # publish what's already built
#
# Signs the app with your Developer ID (RELEASE_SIGNING_IDENTITY) and notarizes it (NOTARIZE=0 skips that,
# for a local try only): needs APPLE_ID, APPLE_PASSWORD (an app-specific
# password) and APPLE_TEAM_ID. Signs the update with ~/.tauri/halo-updater.key,
# whose password is in the Keychain ("Halo updater key password"). Uploads with
# an R2 token: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, as Takeoff Desk does.
#
# The version is tauri.conf.json's (bump it, and the workspace's, first).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# This machine's signing setup and release secrets (both gitignored).
set -a
[ -f "$ROOT/.halo-dev.env" ] && . "$ROOT/.halo-dev.env"
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
CONF=crates/halo-app/tauri.conf.json
VERSION="$(python3 -c "import json; print(json.load(open('$CONF'))['version'])")"
ENDPOINT="${R2_ENDPOINT:-https://136b5efccdb1fd7296a5546ab0a6b41f.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-construction-live-desktop}"
PUBLIC="${R2_PUBLIC:-https://pub-061018a047d54079b309fb16a26a1ce0.r2.dev}"
PREFIX="halo"
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] && PLATFORM="darwin-aarch64" || PLATFORM="darwin-x86_64"
[ "$ARCH" = "arm64" ] && LABEL="arm64" || LABEL="x64"
BUNDLE=target/release/bundle

if [ "${SKIP_BUILD:-0}" != "1" ]; then
	echo "› building Halo $VERSION ($LABEL)"
	export APPLE_SIGNING_IDENTITY="${RELEASE_SIGNING_IDENTITY:?set RELEASE_SIGNING_IDENTITY (a Developer ID Application identity), e.g. in .halo-dev.env}"
	export NOTARIZE="${NOTARIZE:-1}"
	if [ "${NOTARIZE:-1}" = "1" ]; then
		: "${APPLE_ID:?set APPLE_ID (or NOTARIZE=0 for a local try)}" "${APPLE_PASSWORD:?set APPLE_PASSWORD, an app-specific password}" "${APPLE_TEAM_ID:=${HALO_TEAM_ID:?set APPLE_TEAM_ID}}"
		export APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
	else
		unset APPLE_ID APPLE_PASSWORD
		echo "  (not notarized: other Macs will refuse it; for a local try only)"
	fi
	TAURI_SIGNING_PRIVATE_KEY="$(cat "${HALO_UPDATER_KEY:-$HOME/.tauri/halo-updater.key}")"
	TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a halo-updater -s "Halo updater key password" -w)"
	export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
	(cd crates/halo-app && cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":true,"targets":["app","dmg"]}}')
	unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
	# Tauri notarizes the app; the disk image it comes in is downloaded too, so it's notarized as well.
	if [ "${NOTARIZE:-1}" = "1" ]; then
		for dmg in "$BUNDLE"/dmg/Halo_"$VERSION"_*.dmg; do
			xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
			xcrun stapler staple "$dmg"
		done
	fi
fi

ARCHIVE="$BUNDLE/macos/Halo.app.tar.gz"
DMG="$(ls "$BUNDLE"/dmg/Halo_"$VERSION"_*.dmg 2>/dev/null | head -1 || true)"
[ -f "$ARCHIVE" ] && [ -f "$ARCHIVE.sig" ] || { echo "no signed update archive in $BUNDLE/macos: build first" >&2; exit 1; }
codesign --verify --deep --strict "$BUNDLE/macos/Halo.app" || { echo "Halo.app's signature doesn't verify" >&2; exit 1; }

upload() { # file key content-type [cache-control]
	if [ "${DRY_RUN:-0}" = "1" ]; then echo "  (dry run) $1 → $2"; return; fi
	: "${AWS_ACCESS_KEY_ID:?set the R2 token (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)}"
	curl -sSf --aws-sigv4 "aws:amz:auto:s3" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
		-H "Content-Type: $3" -H "Cache-Control: ${4:-public, max-age=31536000}" \
		-T "$1" "$ENDPOINT/$BUCKET/$2" >/dev/null
	echo "  ✓ $PUBLIC/$2"
}

echo "› publishing Halo $VERSION"
KEY_ARCHIVE="$PREFIX/$VERSION/Halo-$VERSION-$LABEL.app.tar.gz"
upload "$ARCHIVE" "$KEY_ARCHIVE" "application/gzip"
if [ -n "$DMG" ]; then
	upload "$DMG" "$PREFIX/$VERSION/Halo-$VERSION-$LABEL.dmg" "application/x-apple-diskimage"
	# A stable link for the website and emails.
	upload "$DMG" "$PREFIX/latest/Halo-$LABEL.dmg" "application/x-apple-diskimage" "public, max-age=300"
fi

MANIFEST="$(mktemp)"
NOTES="${NOTES:-}" VERSION="$VERSION" CRITICAL="${CRITICAL:-0}" PLATFORM="$PLATFORM" URL="$PUBLIC/$KEY_ARCHIVE" SIG="$(cat "$ARCHIVE.sig")" python3 - > "$MANIFEST" <<'PY'
import json, os, datetime
print(json.dumps({
	"version": os.environ["VERSION"],
	"notes": os.environ["NOTES"].replace("\\n", "\n"),
	"pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
	"critical": os.environ["CRITICAL"] == "1",
	"platforms": {os.environ["PLATFORM"]: {"signature": os.environ["SIG"], "url": os.environ["URL"]}},
}, indent=2))
PY
cat "$MANIFEST"
# The manifest must not be cached long, or copies won't see the update.
upload "$MANIFEST" "$PREFIX/latest.json" "application/json" "public, max-age=300"
echo "✓ every copy of Halo older than $VERSION offers this update within 6 hours (or at its next start)"
