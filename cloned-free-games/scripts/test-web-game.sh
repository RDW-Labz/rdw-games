#!/bin/bash
# Smoke-test a web game in the emulator's Chrome: load URL, screenshot, tap center, screenshot again.
# Usage: test-web-game.sh <name> <path> [swipe]
source ~/cloned-free-games/scripts/android-env.sh
NAME=$1; PATHPART=$2; MODE=${3:-tap}
EV=~/cloned-free-games/evidence
adb shell am force-stop com.android.chrome
sleep 1
adb shell am start -a android.intent.action.VIEW -d "http://10.0.2.2:8100/$PATHPART/" -n com.android.chrome/com.google.android.apps.chrome.Main > /dev/null
sleep 12
adb exec-out screencap -p > $EV/web-$NAME-before.png
case $MODE in
  tap)   adb shell input tap 540 1400 ;;
  swipe) adb shell input swipe 540 1500 540 900 300 ;;
esac
sleep 2
adb exec-out screencap -p > $EV/web-$NAME-after.png
adb shell dumpsys activity activities | grep -m1 topResumedActivity
python3 - <<PYEOF
from PIL import Image, ImageChops
import math
a = Image.open("$EV/web-$NAME-before.png").convert("RGB")
b = Image.open("$EV/web-$NAME-after.png").convert("RGB")
diff = ImageChops.difference(a, b).getbbox()
hist = a.convert("L").histogram()
total = sum(hist)
dark = sum(hist[:25]) / total
print(f"NAME=$NAME screen_dark_frac={dark:.2f} changed_after_input={'YES' if diff else 'NO'} bbox={diff}")
PYEOF
