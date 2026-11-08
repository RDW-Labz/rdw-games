// BrandedButton — the canonical CTA primitive for the bidder app.
//
// Replaces bare `Pressable` + `Text` usage which the user flagged as
// "doesn't read as tappable." A button must look like a button:
//   - solid fill (`primary`) or visible border (`secondary`)
//   - obvious pressed state (opacity + scale)
//   - 44pt minimum tap target (Apple HIG / Google a11y)
//   - typography that signals action (uppercase label)
//
// The component is intentionally low-API: variant + size + icons +
// loading/disabled. No theming knobs, no slot props — those would
// re-introduce the inconsistency this primitive exists to fix.
//
// Variants follow the v3 brand:
//   primary   — solid BinGo-orange fill (colors.primary), near-black label.
//   secondary — dark surface + 1.5px brand-green border, brand-green label.
//   ghost     — transparent, brand-green label, no border (low-emphasis).
//
// Loading state renders an ActivityIndicator (brand-green on dark
// variants, black on `primary`) and locks press. Disabled drops opacity
// to 0.4 and locks press. Both states preserve the layout footprint so
// surrounding content doesn't reflow when the button toggles.

import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, type } from '../theme';

export type BrandedButtonVariant = 'primary' | 'secondary' | 'ghost';
export type BrandedButtonSize = 'sm' | 'md' | 'lg';

export interface BrandedButtonProps {
  variant: BrandedButtonVariant;
  size?: BrandedButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

// BinGo brand CTA color. The historical GREEN constant name is kept so
// call sites do not churn. It retained the old hot pink (#ff3d9a) after
// the navy/orange rebrand —
// which is why the sign-in/sign-up buttons stayed pink until 2026-07-07
// (owner report). It now simply mirrors colors.primary, BinGo ORANGE.
export const BRANDED_BUTTON_GREEN = colors.primary;

// 44pt min height is Apple HIG; Google's Material baseline is 48dp,
// which our `md` size meets. `sm` is reserved for inline / row actions
// and still clears 44pt vertically via internal padding.
const SIZE_TOKENS: Record<
  BrandedButtonSize,
  { minHeight: number; paddingVertical: number; paddingHorizontal: number; fontSize: number; gap: number }
> = {
  sm: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 14, fontSize: 13, gap: 6 },
  md: { minHeight: 48, paddingVertical: 14, paddingHorizontal: 18, fontSize: 15, gap: 8 },
  lg: { minHeight: 56, paddingVertical: 18, paddingHorizontal: 22, fontSize: 16, gap: 10 },
};

interface VariantStyle {
  background: string;
  border: string;
  borderWidth: number;
  label: string;
  spinner: string;
}

const VARIANT_STYLES: Record<BrandedButtonVariant, VariantStyle> = {
  primary: {
    background: BRANDED_BUTTON_GREEN,
    border: 'transparent',
    borderWidth: 0,
    // Near-black on bright green has the best contrast ratio (>10:1)
    // and matches the existing v3 callouts (HomeHero CTA, SectionBanner
    // chip) so the button reads as part of the same visual family.
    label: '#0a0c11',
    spinner: '#0a0c11',
  },
  secondary: {
    background: colors.surface,
    border: BRANDED_BUTTON_GREEN,
    borderWidth: 1.5,
    label: BRANDED_BUTTON_GREEN,
    spinner: BRANDED_BUTTON_GREEN,
  },
  ghost: {
    background: 'transparent',
    border: 'transparent',
    borderWidth: 0,
    label: BRANDED_BUTTON_GREEN,
    spinner: BRANDED_BUTTON_GREEN,
  },
};

export function BrandedButton(props: BrandedButtonProps) {
  const {
    variant,
    size = 'md',
    leftIcon,
    rightIcon,
    loading = false,
    disabled = false,
    onPress,
    children,
    testID,
    style,
  } = props;

  const sizeTokens = SIZE_TOKENS[size];
  const variantStyles = VARIANT_STYLES[variant];
  const isInactive = loading || disabled;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isInactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: isInactive, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: variantStyles.background,
          borderColor: variantStyles.border,
          borderWidth: variantStyles.borderWidth,
          minHeight: sizeTokens.minHeight,
          paddingVertical: sizeTokens.paddingVertical,
          paddingHorizontal: sizeTokens.paddingHorizontal,
          // Disabled wins over pressed; loading wins over neither (we
          // keep the visual present so the user knows what they're
          // waiting on). 0.85 + scale(0.98) is the standard iOS press
          // affordance — gentle enough not to feel like a button drop.
          opacity: disabled ? 0.4 : pressed && !loading ? 0.85 : 1,
          transform: [{ scale: pressed && !isInactive ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variantStyles.spinner} size="small" />
      ) : (
        <View style={[styles.inner, { gap: sizeTokens.gap }]}>
          {leftIcon != null && <View style={styles.icon}>{leftIcon}</View>}
          <Text
            style={[
              styles.label,
              type.label,
              { color: variantStyles.label, fontSize: sizeTokens.fontSize },
            ]}
            numberOfLines={1}
          >
            {children}
          </Text>
          {rightIcon != null && <View style={styles.icon}>{rightIcon}</View>}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    textAlign: 'center',
  },
});
