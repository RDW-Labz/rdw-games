#!/bin/bash
# Replace hand-built gloox with Arch gloox 1.0.28 pkg, rebuild lobby+.
set -e
cd ~/freegames/work
curl -fL --retry 6 -o gloox.pkg.tar.zst https://geo.mirror.pkgbuild.com/extra/os/x86_64/gloox-1.0.28-1-x86_64.pkg.tar.zst
rm -rf glooxpkg && mkdir glooxpkg
bsdtar -xf gloox.pkg.tar.zst -C glooxpkg
rm -rf ~/tools/gloox
mkdir -p ~/tools/gloox
cp -a glooxpkg/usr/include glooxpkg/usr/lib ~/tools/gloox/
sed -i 's|^prefix=/usr|prefix=/home/cluer/tools/gloox|' ~/tools/gloox/lib/pkgconfig/gloox.pc 2>/dev/null || true
ls ~/tools/gloox/lib/pkgconfig/ >> ~/freegames/logs/0ad_make_engine.log
echo GLOOXARCH_OK >> ~/freegames/logs/0ad_make_engine.log
cd ~/freegames/work/0ad/build/workspaces
PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig JOBS=-j8 ./update-workspaces.sh > /dev/null 2>&1
echo "WS8_RC=$? $(date +%T)" >> ~/freegames/logs/0ad_make_engine.log
cd gcc && PKG_CONFIG_PATH=$HOME/tools/gloox/lib/pkgconfig make -j8 config=release >> ~/freegames/logs/0ad_make_engine.log 2>&1
echo "MK8=$? $(date +%T)" >> ~/freegames/logs/0ad_make_engine.log
