#!/bin/bash
# Preview the Skyglass shell on your desktop in a phone-sized window (600x1024).
cd "$(dirname "$0")/rootfs/usr/lib/skyglass/shell"
python3 server.py & SRV=$!
trap 'kill $SRV' EXIT
sleep 0.7
B=$(command -v chromium || command -v google-chrome || command -v chromium-browser)
"$B" --app=http://127.0.0.1:7777/ --window-size=600,1060 --user-data-dir="${XDG_CACHE_HOME:-$HOME/.cache}/skyglass-preview" --no-first-run
