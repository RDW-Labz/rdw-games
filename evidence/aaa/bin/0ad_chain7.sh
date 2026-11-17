#!/bin/bash
# Stage 7: regenerate workspaces, verify boost flag, build engine.
LOG=~/freegames/logs/0ad_make_engine.log
cd ~/freegames/work/0ad/build/workspaces
PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig JOBS=-j8 ./update-workspaces.sh > /dev/null 2>&1
echo "WS7_RC=$? $(date +%T)" >> $LOG
grep -m1 -o 'boost/include' gcc/graphics.make >> $LOG
cd gcc && PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig make -j8 config=release >> $LOG 2>&1
echo "MK7=$? $(date +%T)" >> $LOG
