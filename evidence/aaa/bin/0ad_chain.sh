#!/bin/bash
# Fetch bundled lib sources (svn via WebDAV), wait for mozjs, build libs+workspaces+engine.
R=~/freegames/work/0ad; L=$R/libraries/source; LOG=~/freegames/logs/0ad_chain.log
echo "CHAIN_START $(date +%T)" >> $LOG
python3 ~/freegames/bin/svn_export.py /public/source-libs/trunk/fcollada $L/fcollada/fcollada-28209 >> $LOG 2>&1; echo "SVN_FCOLLADA=$?" >> $LOG
python3 ~/freegames/bin/svn_export.py /public/source-libs/trunk/nvtt $L/nvtt/nvtt-28209 >> $LOG 2>&1; echo "SVN_NVTT=$?" >> $LOG
# wait for mozjs download to finish (MOZJS_DL marker appears), max ~75 min
for i in $(seq 1 225); do grep -q MOZJS_DL ~/freegames/logs/0ad_mozjs_dl.log && break; sleep 20; done
echo "MOZJS_WAIT_DONE $(date +%T)" >> $LOG
cd $R/libraries
for i in 1 2; do JOBS=-j8 ./build-source-libs.sh >> $LOG 2>&1; rc=$?; [ $rc = 0 ] && break; echo "LIBS_ATTEMPT_${i}_rc=$rc" >> $LOG; done
echo "LIBS_DONE rc=$rc $(date +%T)" >> $LOG
cd $R/build/workspaces && JOBS=-j8 ./update-workspaces.sh >> $LOG 2>&1; echo "WORKSPACES_RC=$? $(date +%T)" >> $LOG
cd gcc && make -j8 config=release >> $LOG 2>&1; echo "MAKE_RC=$? $(date +%T)" >> $LOG
echo "CHAIN_END $(date +%T)" >> $LOG
