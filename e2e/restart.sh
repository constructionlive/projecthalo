#!/bin/sh
# Restarts the isolated test instance (its own data in e2e/home, the dev bridge
# on :47615). `restart.sh fresh` wipes its data first.
E2E="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$E2E")"
APP="$ROOT/target/debug/bundle/macos/Halo.app"
# This machine's signing setup, if it has one (see CONTRIBUTING.md).
[ -f "$ROOT/.halo-dev.env" ] && . "$ROOT/.halo-dev.env"
# With a team set, never run a build signed otherwise: macOS ties Halo's Input
# Monitoring and microphone permissions to the signature.
if [ -n "${HALO_TEAM_ID:-}" ] && ! codesign -dv "$APP" 2>&1 | grep -q "TeamIdentifier=$HALO_TEAM_ID"; then
  echo "Halo.app isn't signed by team $HALO_TEAM_ID: rebuild it signed first."; exit 1
fi
pkill -f "Halo.app/Contents/MacOS/halo"; sleep 1
[ "$1" = "fresh" ] && rm -rf "$E2E/home" && mkdir -p "$E2E/home"
HALO_HOME="$E2E/home" HALO_NO_PROMPT=1 HALO_DEV_BRIDGE=47615 HALO_MODEL=haiku HALO_STALL_SECS=25 \
  nohup "$APP/Contents/MacOS/halo" >> "$E2E/app.log" 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:47615/state >/dev/null && exit 0; sleep 1; done
echo "app did not come up"; exit 1
