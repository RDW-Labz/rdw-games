// Two-pill toggle for the quick-lot "review before save" setting.
// Mirrors PhotoToggleRow exactly (same chip geometry, same primary-accent
// active state) so the per-session settings band at the top of Quick Lot
// stays visually coherent.
//
// "Auto-save"  → value === false  (rapid-fire; matched lots auto-create
//                                   after the 2s countdown — default)
// "Review"     → value === true   (matched lots open the editable review
//                                   card; staff confirm before saving)
//
// Does NOT affect the no-match path: that already shows an explicit
// 3-button picker (Identify with AI / Create manual / Cancel) with no
// auto-save, regardless of this toggle.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@auction-platform/design-system';

export interface ReviewToggleRowProps {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

export function ReviewToggleRow({ value, onChange, disabled, testID }: ReviewToggleRowProps) {
  return (
    <View testID={testID ?? 'review-toggle-row'} style={s.container}>
      <Text style={s.label}>Save mode</Text>
      <View style={s.row}>
        <ReviewChip
          label="Auto-save"
          sub="< 2 s per lot"
          active={!value}
          disabled={disabled}
          accessibilityRole="radio"
          accessibilityState={{ checked: !value }}
          onPress={() => onChange(false)}
        />
        <ReviewChip
          label="Review"
          sub="confirm before save"
          active={value}
          disabled={disabled}
          accessibilityRole="radio"
          accessibilityState={{ checked: value }}
          onPress={() => onChange(true)}
        />
      </View>
    </View>
  );
}

function ReviewChip({
  label,
  sub,
  active,
  disabled,
  accessibilityRole,
  accessibilityState,
  onPress,
}: {
  label: string;
  sub: string;
  active: boolean;
  disabled?: boolean;
  accessibilityRole?: 'radio';
  accessibilityState?: { checked: boolean };
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      style={[
        s.chip,
        active && s.chipActive,
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={[s.chipLabel, active && s.chipLabelActive]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[s.chipSub, active && s.chipSubActive]} numberOfLines={1}>
        {sub}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  container: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 6,
  },
  label: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  chipLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '900',
  },
  chipLabelActive: {
    color: colors.primary,
  },
  chipSub: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  chipSubActive: {
    color: colors.primary,
    opacity: 0.85,
  },
});
