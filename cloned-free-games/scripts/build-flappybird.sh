#!/bin/bash
# Build VadimBoev/FlappyBird (<100KB native Android game) with NDK + aapt
set -e
source ~/cloned-free-games/scripts/android-env.sh
export ANDROID_SDK_ROOT=$ANDROID_HOME
export ANDROID_NDK_ROOT=$ANDROID_HOME/ndk/28.2.13676358
export BUILD_TOOLS_VERSION=36.0.0
export PACKAGE_NAME=com.rdw.judge.flappybird
export KEYSTORE_PASSWORD=judgetest
cd ~/cloned-free-games/games/FlappyBird/FlappyBird
mkdir -p app/build/outputs/apk
~/jdk/jdk-17.0.21+9/bin/keytool -genkeypair -keyalg RSA -keysize 2048 \
  -dname "cn=judge, ou=rdw, o=rdw, c=US" \
  -alias judge -keypass judgetest -keystore judge.jks -storepass judgetest -validity 20000 2>/dev/null || true
sed -i.bak "s/your.app.package.name/$PACKAGE_NAME/g" app/src/main/AndroidManifest.xml
cd app/src/main
$ANDROID_NDK_ROOT/ndk-build APP_ABI="armeabi-v7a arm64-v8a x86_64" 2>&1 | tail -4
cd ../../..
aapt package -f -M app/src/main/AndroidManifest.xml -S app/src/main/res -A app/src/main/assets \
  -I $ANDROID_SDK_ROOT/platforms/android-36/android.jar -F app/build/outputs/apk/unaligned.apk
python3 - <<'PYEOF'
import zipfile, os, glob
apk = "app/build/outputs/apk/unaligned.apk"
with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    for so in glob.glob("app/src/main/libs/*/*.so"):
        arc = "lib/" + os.path.relpath(so, "app/src/main/libs")
        z.write(so, arc)
PYEOF
zipalign -f 4 app/build/outputs/apk/unaligned.apk app/build/outputs/apk/fb.apk
apksigner sign --ks judge.jks --ks-pass pass:judgetest \
  --out app/build/outputs/apk/FlappyBird-signed.apk app/build/outputs/apk/fb.apk
rm -rf libtmp
mv app/src/main/AndroidManifest.xml.bak app/src/main/AndroidManifest.xml
ls -la app/build/outputs/apk/FlappyBird-signed.apk
echo FLAPPY_APK_OK
