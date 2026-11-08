// Tap-to-focus hook for vision-camera v4 Camera component.
//
// expo-camera 17 had no public focus API and relied on continuous AF
// converging on its own — that's why labels close to the lens often
// shipped slightly soft pre-vision-camera. v4 exposes `camera.focus({x,y})`
// which moves the AE/AF/AWB metering point to a specific spot in the
// preview's view coordinate space. We wire it up here as a reusable hook
// every camera screen drops into the same way.
//
// Usage:
//
//     const cameraRef = useRef<Camera>(null);
//     const { onTap, indicator } = useTapToFocus(cameraRef);
//
//     <View style={containerStyle}>
//       <Camera ref={cameraRef} ... />
//       {/* Absolute-positioned overlay that catches taps on the camera
//           area. Rendered BEFORE any UI buttons so those buttons hit-
//           test first (later JSX siblings paint on top). */}
//       <Pressable style={StyleSheet.absoluteFillObject} onPress={onTap} />
//       <CameraFlashButton ... />   {/* button on top of focus overlay */}
//       {indicator}                  {/* yellow focus square, fades out */}
//     </View>
//
// The indicator is a yellow square positioned at the tap point that
// fades over ~900ms. Visual feedback that the camera received the tap.
// Apple's Camera.app uses the same pattern; users recognize it.

import { useRef, useState, type ReactNode } from 'react';
import { Animated, type GestureResponderEvent } from 'react-native';
import type { Camera } from 'react-native-vision-camera';

export function useTapToFocus(cameraRef: React.RefObject<Camera | null>): {
  onTap: (e: GestureResponderEvent) => void;
  indicator: ReactNode;
} {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  const onTap = (e: GestureResponderEvent) => {
    if (!cameraRef.current) return;
    const { locationX: x, locationY: y } = e.nativeEvent;
    setPoint({ x, y });
    opacity.setValue(1);
    Animated.timing(opacity, {
      toValue: 0,
      duration: 900,
      useNativeDriver: true,
    }).start();
    // Focus can throw if the camera isn't fully started or the device
    // doesn't support point focus (rare on iOS, common on cheap Android
    // hardware). Swallow it — worst case the user taps again. We don't
    // want to surface this to the operator since it's not actionable.
    cameraRef.current.focus({ x, y }).catch(() => {});
  };

  const indicator = point ? (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: point.x - 32,
        top: point.y - 32,
        width: 64,
        height: 64,
        borderWidth: 2,
        borderColor: '#ffeb3b',
        borderRadius: 6,
        opacity,
      }}
    />
  ) : null;

  return { onTap, indicator };
}
