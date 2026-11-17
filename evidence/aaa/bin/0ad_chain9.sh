#!/bin/bash
# Rebuild lobby against Arch gloox 1.0.28 and relink all.
cd ~/freegames/work/0ad/build/workspaces/gcc
rm -f obj/lobby_Release/*.o
PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig make -j8 config=release >> ~/freegames/logs/0ad_make_engine.log 2>&1
echo "MK9=$? $(date +%T)" >> ~/freegames/logs/0ad_make_engine.log
