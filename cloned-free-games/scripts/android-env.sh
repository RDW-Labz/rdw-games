# Source this before any Android gradle build on this host
export JAVA_HOME="$HOME/jdk/jdk-17.0.21+9"
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/build-tools/36.0.0:$PATH"
