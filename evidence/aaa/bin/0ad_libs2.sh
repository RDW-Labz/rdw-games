#!/bin/bash
S=~/freegames/work/0ad/libraries/source
( cd "$S/fcollada" && rm -Rf fcollada-28209 && tar xf fcollada-28209.tar.xz && find fcollada-28209 -name '*.sh' -exec chmod 755 {} + && bash ./build.sh.orig ) > ~/freegames/logs/0ad_fcollada_build.log 2>&1
echo "FC_RC=$?" >> ~/freegames/logs/0ad_fcollada_build.log
( cd "$S/nvtt" && rm -Rf nvtt-28209 && tar xf nvtt-28209.tar.xz && find nvtt-28209 -name '*.sh' -exec chmod 755 {} + && bash ./build.sh ) > ~/freegames/logs/0ad_nvtt_build.log 2>&1
echo "NV_RC=$?" >> ~/freegames/logs/0ad_nvtt_build.log
