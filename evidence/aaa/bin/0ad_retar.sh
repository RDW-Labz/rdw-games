#!/bin/bash
# Fix exec bits inside bundled tarballs by re-taring the exported trees.
S=~/freegames/work/0ad/libraries/source
( cd $S/fcollada && find fcollada-28209 -name '*.sh' -exec chmod 755 {} + && tar -cJf fcollada-28209.tar.xz fcollada-28209 ) && echo RETAR_FC_OK
( cd $S/nvtt && find nvtt-28209 -name '*.sh' -exec chmod 755 {} + && tar -cJf nvtt-28209.tar.xz nvtt-28209 ) && echo RETAR_NV_OK
