// Small floating button overlay for CameraView flash / torch control.
//
// Two modes:
//   'photo' — cycles off → on → auto → off. Pair with CameraView's
//             `flash` prop. Flash fires only at shutter time.
//   'torch' — binary on/off toggle. Pair with CameraView's `enableTorch`
//             prop. LED stays on continuously while user aims (right
//             for barcode scanning in dim warehouses).
//
// Designed to sit on top-right of the viewfinder. Parent passes
// position via `style` if a different corner is needed.

import type { ReactElement } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import type { CameraDevice } from 'react-native-vision-camera';
import { colors } from '@auction-platform/design-system';

export type FlashMode = 'off' | 'on' | 'auto';

function nextFlashMode(m: FlashMode): FlashMode {
  return m === 'off' ? 'on' : m === 'on' ? 'auto' : 'off';
}

function labelFor(type: 'photo' | 'torch', state: FlashMode | boolean): string {
  if (type === 'torch') {
    return state ? '⚡ TORCH' : '⚡ OFF';
  }
  const m = state as FlashMode;
  if (m === 'auto') return '⚡ AUTO';
  if (m === 'on') return '⚡ ON';
  return '⚡ OFF';
}

export function CameraFlashButton(props: {
  type: 'photo';
  mode: FlashMode;
  onChange: (m: FlashMode) => void;
  /** Active camera device. When it has no flash unit the photo-mode
   *  toggle is hidden entirely — a flash control that does nothing (or
   *  throws on capture) just confuses staff on flash-less iPads. */
  device?: CameraDevice | null;
  style?: ViewStyle;
} | {
  type: 'torch';
  on: boolean;
  onChange: (on: boolean) => void;
  /** Active camera device. When it has no torch the toggle is hidden —
   *  enableTorch on a torch-less device is a no-op the operator can't act on. */
  device?: CameraDevice | null;
  style?: ViewStyle;
}): ReactElement | null {
  // Hide the control when the hardware can't honor it. Photo flash needs
  // `hasFlash`; the torch toggle needs `hasTorch`. When `device` is
  // undefined (not yet enumerated) we leave the existing behavior intact
  // and render the button — the gate only fires on a known-false flag.
  if (props.type === 'photo' && props.device && !props.device.hasFlash) {
    return null;
  }
  if (props.type === 'torch' && props.device && !props.device.hasTorch) {
    return null;
  }

  const active =
    props.type === 'torch'
      ? props.on
      : props.mode !== 'off';
  const label =
    props.type === 'torch'
      ? labelFor('torch', props.on)
      : labelFor('photo', props.mode);

  function onPress(): void {
    if (props.type === 'torch') props.onChange(!props.on);
    else props.onChange(nextFlashMode(props.mode));
  }

  return (
    <View
      style={[
        {
          position: 'absolute',
          top: 12,
          right: 12,
        },
        props.style,
      ]}
    >
      <Pressable
        onPress={onPress}
        hitSlop={10}
        style={{
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 16,
          backgroundColor: active ? 'rgba(245,158,11,0.92)' : 'rgba(0,0,0,0.55)',
          borderWidth: 1,
          borderColor: active ? '#f59e0b' : colors.border,
        }}
      >
        <Text
          style={{
            color: '#fff',
            fontSize: 11,
            fontWeight: '800',
            letterSpacing: 0.4,
            fontFamily: 'monospace',
          }}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
}
