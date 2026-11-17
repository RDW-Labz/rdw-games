#!/bin/bash
# Stage 3: unpack+chmod+build each bundled lib, then premake/workspaces/make.
S=~/freegames/work/0ad/libraries/source; LOG=~/freegames/logs/0ad_chain.log
export PATH=$HOME/tools/autoconf-2.13:$HOME/tools/autoconf-2.13/bin:$PATH
runlib() { # dir tarball nested
  local d=$1 t=$2 n=$3
  if [ -e "$S/$d/.already-built" ]; then echo "lib $d already-built marker"; return 0; fi
  ( cd "$S/$d" && rm -Rf "$n" && tar xf "$t" && find "$n" -name '*.sh' -exec chmod 755 {} + && ./"build.sh.orig" )
  echo "RUNLIB_$d_RC=$?" >> $LOG
}
echo "CHAIN3_START $(date +%T)" >> $LOG
runlib fcollada fcollada-28209.tar.xz fcollada-28209
# nvtt original has no exec-bit problem in outer script itself; wrapper only for fcollada
( cd "$S/nvtt" && rm -Rf nvtt-28209 && tar xf nvtt-28209.tar.xz && find nvtt-28209 \( -name '*.sh' -o -name 'configure' \) -exec chmod 755 {} + && ./build.sh ) ; echo "RUNLIB_NVTT_RC=$?" >> $LOG
( cd "$S/premake-core" && ./build.sh ) ; echo "RUNLIB_PREMAKE_RC=$?" >> $LOG
( cd "$S/spidermonkey" && JOBS=-j8 ./build.sh ) ; echo "RUNLIB_MOZJS_RC=$?" >> $LOG
cd ~/freegames/work/0ad/build/workspaces && JOBS=-j8 ./update-workspaces.sh >> $LOG 2>&1; echo "WS3_RC=$? $(date +%T)" >> $LOG
cd gcc && make -j8 config=release >> $LOG 2>&1; echo "MAKE3_RC=$? $(date +%T)" >> $LOG
echo "CHAIN3_END $(date +%T)" >> $LOG
