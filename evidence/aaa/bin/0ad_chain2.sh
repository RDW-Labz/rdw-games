#!/bin/bash
# Stage 2: build bundled libs, generate workspaces, compile engine.
R=~/freegames/work/0ad; LOG=~/freegames/logs/0ad_chain.log
echo "CHAIN2_START $(date +%T)" >> $LOG
cd $R/libraries
for i in 1 2; do JOBS=-j8 ./build-source-libs.sh >> $LOG 2>&1; rc=$?; [ $rc = 0 ] && break; echo "LIBS2_ATTEMPT_${i}_rc=$rc" >> $LOG; done
echo "LIBS2_DONE rc=$rc $(date +%T)" >> $LOG
cd $R/build/workspaces && JOBS=-j8 ./update-workspaces.sh >> $LOG 2>&1; echo "WS2_RC=$? $(date +%T)" >> $LOG
cd gcc && make -j8 config=release >> $LOG 2>&1; echo "MAKE2_RC=$? $(date +%T)" >> $LOG
echo "CHAIN2_END $(date +%T)" >> $LOG
