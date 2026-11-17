#!/bin/bash
# Stage 5: finish gloox, regenerate workspaces, build engine.
G=~/freegames/work/gloox-git-trunk; LOG=~/freegames/logs/0ad_chain.log
cd $G
for f in $(grep -rl "std::time\|[^_:a-z]time(" src/tests --include='*.cpp' 2>/dev/null); do grep -q ctime $f || sed -i '0,/#include/s//#include <ctime>\n#include/' $f; done
make -j8 >> ~/freegames/logs/0ad_gloox_make.log 2>&1 && make install > /dev/null 2>&1
echo "GLOOX5_RC=$?" >> $LOG
cd ~/freegames/work/0ad/build/workspaces
PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig JOBS=-j8 ./update-workspaces.sh >> $LOG 2>&1
echo "WS5_RC=$? $(date +%T)" >> $LOG
cd gcc && PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig make -j8 config=release >> $LOG 2>&1
echo "MAKE5_RC=$? $(date +%T)" >> $LOG
echo "CHAIN5_END $(date +%T)" >> $LOG
