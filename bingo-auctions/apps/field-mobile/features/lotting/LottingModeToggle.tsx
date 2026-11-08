// Segmented control rendered at the top of each lotting entry screen
// (quick, photo, scan, web). Lets the operator pick whether the next
// successful save will rotate the lot's qr_token onto a scanned sticker.
//
// Visual style matches the existing CONDITION chip pattern in
// SessionContext so it doesn't introduce a third "kind of toggle" into
// the field-mobile UI. Two pills, side by side, the active one tinted
// in the primary accent.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@auction-platform/design-system';
import { useLottingMode } from './LottingModeContext';

interface LottingModeToggleProps {
  /** When disabled (e.g. a lot save is in flight), prevents accidental
   *  switching mid-action. Affects appearance only — the read-side keeps
   *  working. */
  disabled?: boolean;
}

export function LottingModeToggle({ disabled }: LottingModeToggleProps) {
  const { mode, setMode } = useLottingMode();
  return (
    <View testID="lotting-mode-toggle" style={s.container}>
      <Text style={s.label}>Sticker source</Text>
      <View style={s.row}>
        <ModeChip
          label="Generate QR"
          sub="auto-print later"
          active={mode === 'generate'}
          disabled={disabled}
          onPress={() => setMode('generate')}
        />
        {/* One "Pre-stickered" mode now covers BOTH BinGo Auctions pre-printed QR
            rolls AND the operator's own labels (LPN, vendor sticker,
            DataMatrix). PreStickeredScanner routes by the scanned value
            (UUID → claim_prestickered_qr; else → claim_sticker_code), so the
            old separate "LPN sticker" chip is redundant and was removed. */}
        <ModeChip
          label="Pre-stickered"
          sub="scan any sticker"
          active={mode === 'prestickered'}
          disabled={disabled}
          onPress={() => setMode('prestickered')}
        />
      </View>
    </View>
  );
}

function ModeChip({
  label,
  sub,
  active,
  disabled,
  onPress,
}: {
  label: string;
  sub: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
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
    paddingTop: 10,
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
