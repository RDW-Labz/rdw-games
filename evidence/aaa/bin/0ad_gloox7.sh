#!/bin/bash
cd ~/freegames/work/gloox-git-trunk
grep -rl 'ctime(' src examples 2>/dev/null | while read f; do grep -q '#include <ctime>' $f || sed -i '0,/#include/s//#include <ctime>\n#include/' $f; done
make -j8 >> ~/freegames/logs/0ad_gloox_make.log 2>&1 && make install > /dev/null 2>&1
echo "GLOOX7_RC=$? MARKER"
