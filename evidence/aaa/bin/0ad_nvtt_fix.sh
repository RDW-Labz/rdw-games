#!/bin/bash
# Re-export pristine nvtt, set exec bits, re-tar, rebuild.
S=~/freegames/work/0ad/libraries/source
( cd $S/nvtt && rm -Rf nvtt-28209 && python3 ~/freegames/bin/svn_export.py /public/source-libs/trunk/nvtt nvtt-28209 && find nvtt-28209 -name '*.sh' -exec chmod 755 {} + && tar -cJf nvtt-28209.tar.xz nvtt-28209 && bash ./build.sh ) > ~/freegames/logs/0ad_nvtt_build.log 2>&1
echo "NV_RC=$?" >> ~/freegames/logs/0ad_nvtt_build.log
