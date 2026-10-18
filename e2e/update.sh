#!/bin/bash
# End-to-end test of Halo's updater, on real builds: an installed 0.0.1 sees a
# 0.0.2 on its feed, refuses it when the archive was tampered with, then
# installs the real one over itself and restarts as 0.0.2, still signed.
#
#   e2e/update.sh        (about 5 minutes: two signed debug builds)
#
# Needs the updater key (~/.tauri/halo-updater.key, its password in the
# Keychain) and a signing identity (APPLE_SIGNING_IDENTITY, or .halo-dev.env). Runs a copy of the app from a
# temporary folder with its own data, on its own bridge port; it stops your
# Halo while it runs (both would listen for the summon key). Debug builds
# accept the plain-HTTP local feed; release builds never do.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(cd "$(mktemp -d)" && pwd -P)/halo-update-test"; APP="$ROOT/crates/halo-app"; B="$ROOT/target/debug/bundle/macos"
LOG=~/Library/Logs/Halo/halo.log
[ -f "$ROOT/.halo-dev.env" ] && . "$ROOT/.halo-dev.env"
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (or put it in .halo-dev.env): an update keeps its signature}"
export APPLE_SIGNING_IDENTITY
fail=0; pass() { echo "PASS $1"; }; nope() { echo "FAIL $1"; fail=1; }
rm -rf "$T"; mkdir -p "$T/feed" "$T/home" "$T/v1"
cd "$APP"
echo "› building 0.0.2 with a signed update archive"
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/halo-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a halo-updater -s 'Halo updater key password' -w)" \
  cargo tauri build --debug --config '{"version":"0.0.2","bundle":{"createUpdaterArtifacts":true}}' 2>&1 | grep -E "errSec|Finished 1 bundle|Error" | head -3
cp "$B/Halo.app.tar.gz" "$B/Halo.app.tar.gz.sig" "$T/feed/" || { echo "no update archive"; exit 1; }
echo "› building 0.0.1"
cargo tauri build --debug 2>&1 | grep -E "errSec|Finished 1 bundle|Error" | head -3
ditto "$B/Halo.app" "$T/v1/Halo.app"
SIGNED="$(codesign -dv "$T/v1/Halo.app" 2>&1)"
[[ "$SIGNED" == *"TeamIdentifier=${HALO_TEAM_ID:-}"* && "$SIGNED" != *"Signature=adhoc"* ]] && pass "0.0.1 is signed" || nope "0.0.1 isn't signed with $APPLE_SIGNING_IDENTITY"
# A tampered archive: the real signature, different bytes.
cp "$T/feed/Halo.app.tar.gz" "$T/feed/tampered.tar.gz"; printf 'x' >> "$T/feed/tampered.tar.gz"
manifest() { python3 - "$1" "$(cat "$T/feed/Halo.app.tar.gz.sig")" "$PORT" > "$T/feed/latest.json" <<'PY'
import json, sys
print(json.dumps({"version": "0.0.2", "notes": "Test update", "pub_date": "2026-10-18T12:00:00Z",
  "platforms": {"darwin-aarch64": {"signature": sys.argv[2], "url": f"http://127.0.0.1:{sys.argv[3]}/{sys.argv[1]}"}}}))
PY
}
# A free port, and our own server on it (never one left over from another run).
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])")
echo "run-$$" > "$T/feed/whoami"
(cd "$T/feed" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) & SERVER=$!
for i in $(seq 1 20); do [ "$(curl -sf -m 1 "http://127.0.0.1:$PORT/whoami")" = "run-$$" ] && break; sleep 0.25; done
[ "$(curl -sf -m 1 "http://127.0.0.1:$PORT/whoami")" = "run-$$" ] || { echo "FAIL the feed server didn't start"; exit 1; }
pkill -f "Halo.app/Contents/MacOS/halo"; sleep 1
start() { HALO_HOME="$T/home" HALO_NO_PROMPT=1 HALO_DEV_BRIDGE=47616 HALO_NO_UPDATE_CHECK=1 HALO_UPDATE_URL=http://127.0.0.1:$PORT/latest.json "$T/v1/Halo.app/Contents/MacOS/halo" >> "$T/app.log" 2>&1 & }
up() { for i in $(seq 1 40); do curl -sf -m 2 http://127.0.0.1:47616/version >/dev/null && return 0; sleep 0.5; done; return 1; }
ver() { curl -sf -m 3 http://127.0.0.1:47616/version | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])"; }
plist() { /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$T/v1/Halo.app/Contents/Info.plist"; }
LOG_FROM=$(wc -l < "$LOG" 2>/dev/null || echo 0)
start; up || nope "0.0.1 came up"
[ "$(ver)" = "0.0.1" ] && pass "running 0.0.1" || nope "not 0.0.1: $(ver)"

manifest tampered.tar.gz
CHECK=$(curl -sf -X POST -d '{}' http://127.0.0.1:47616/update-check)
echo "$CHECK" | grep -q '"version":"0.0.2"' && pass "it sees 0.0.2" || nope "no update seen: $CHECK"
curl -sf -X POST -d '{}' http://127.0.0.1:47616/update-install >/dev/null; sleep 8
[ "$(ver)" = "0.0.1" ] && [ "$(plist)" = "0.0.1" ] && pass "a tampered update is refused; still 0.0.1, untouched" || nope "tampered update went in: $(ver) $(plist)"
tail -n +"$((LOG_FROM + 1))" "$LOG" | grep -q "signature verification failed" && pass "the log says why: signature verification failed" || nope "no signature error in the log"

manifest Halo.app.tar.gz
curl -sf -X POST -d '{}' http://127.0.0.1:47616/update-check >/dev/null
curl -sf -X POST -d '{}' http://127.0.0.1:47616/update-install >/dev/null
sleep 3; up || nope "it came back after the restart"
sleep 1
[ "$(ver)" = "0.0.2" ] && pass "restarted as 0.0.2" || nope "running $(ver)"
[ "$(plist)" = "0.0.2" ] && pass "the bundle on disk is 0.0.2" || nope "bundle says $(plist)"
codesign --verify --deep --strict "$T/v1/Halo.app" && pass "the updated app's signature verifies" || nope "signature broken after update"
CHECK=$(curl -sf -X POST -d '{}' http://127.0.0.1:47616/update-check)
echo "$CHECK" | grep -q '"ok":null' && pass "now it's the newest" || nope "still offered: $CHECK"
pkill -f "$T/v1/Halo.app/Contents/MacOS/halo"; kill $SERVER 2>/dev/null
rm -rf "$(dirname "$T")"
[ $fail = 0 ] && echo "ALL PASSED" || echo "FAILED"
