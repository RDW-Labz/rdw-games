#!/bin/bash
# Stage 6: gloox finish, wait boost headers, regenerate workspaces, build engine.
LOG=~/freegames/logs/0ad_chain.log
echo "CHAIN6_START $(date +%T)" >> $LOG
bash ~/freegames/bin/0ad_gloox7.sh >> $LOG 2>&1
for i in $(seq 1 90); do grep -q BOOST_RC ~/freegames/logs/0ad_boost.log 2>/dev/null && break; sleep 20; done
grep BOOST_RC ~/freegames/logs/0ad_boost.log >> $LOG
cd ~/freegames/work/0ad/build/workspaces
PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig JOBS=-j8 ./update-workspaces.sh >> $LOG 2>&1
echo "WS6_RC=$? $(date +%T)" >> $LOG
cd gcc && PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig make -j8 config=release >> $LOG 2>&1
echo "MAKE6_RC=$? $(date +%T)" >> $LOG
echo "CHAIN6_END $(date +%T)" >> $LOG
