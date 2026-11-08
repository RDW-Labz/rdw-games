#!/bin/bash
# Screenshot OpenTTD desktop run under Xvfb as test evidence.
set -x
pkill Xvfb 2>/dev/null
rm -f /tmp/.X99-lock
sleep 1
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
XV=$!
sleep 2
cd ~/cloned-free-games/OpenTTD
DISPLAY=:99 ./build/openttd -m "no music" -D "$HOME/.local/share/openttd" > ~/cloned-free-games/logs/openttd-run.log 2>&1 &
OP=$!
sleep 45
DISPLAY=:99 import -window root "$1"
kill $OP 2>/dev/null
kill $XV 2>/dev/null
ls -la "$1"
tail -8 ~/cloned-free-games/logs/openttd-run.log
