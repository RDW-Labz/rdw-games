#!/bin/bash
# Stage 4: wait for mozjs+gloox, regenerate workspaces, build engine, smoke test.
LOG=~/freegames/logs/0ad_chain.log
echo "CHAIN4_START $(date +%T)" >> $LOG
for i in $(seq 1 180); do
  m=$(grep -c 'MZ=' ~/freegames/logs/0ad_mozjs_build.log 2>/dev/null || true)
  g=$(grep -c 'GLOOX_RC' ~/freegames/logs/0ad_gloox.log 2>/dev/null || true)
  [ "$m" -ge 1 ] && [ "$g" -ge 1 ] && break
  sleep 20
done
echo "WAIT_LIBS_DONE $(date +%T)" >> $LOG
grep 'MZ=' ~/freegames/logs/0ad_mozjs_build.log | tail -1 >> $LOG
grep 'GLOOX_RC' ~/freegames/logs/0ad_gloox.log >> $LOG
cd ~/freegames/work/0ad/build/workspaces
PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig:$HOME/tools/mozjs/lib/pkgconfig:$PKG_CONFIG_PATH JOBS=-j8 ./update-workspaces.sh >> $LOG 2>&1
echo "WS4_RC=$? $(date +%T)" >> $LOG
cd gcc && PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig make -j8 config=release >> $LOG 2>&1
echo "MAKE4_RC=$? $(date +%T)" >> $LOG
echo "CHAIN4_END $(date +%T)" >> $LOG
