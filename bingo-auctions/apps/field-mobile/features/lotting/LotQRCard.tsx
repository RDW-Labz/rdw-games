// LotQRCard — renders a printable QR + lot_code card for an item.
//
// The QR encodes the lot's app-wide unique identifier (lot_code). When
// an operator scans it on the picker / intake screens, our parsers
// match it against the LOT_CODE_RE pattern (e.g. CLU-000123).
//
// Usage:
//   <LotQRCard lotCode="CLU-000123" title="DeWalt 20V Drill" />
//
// Sizes:
//   - "compact" (88px QR) — inline in lists / inventory detail
//   - "label"   (220px QR) — printable; operator can screenshot or
//                            photograph for thermal-label workflow
//
// Why no print button: native React Native doesn't have a one-click
// print API; operators screenshot the label view and AirPrint or send
// to a Bluetooth thermal printer via OS share sheet. A future commit
// can add expo-print integration if there's a real printer hooked up.

import { View, Text, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { colors } from '@auction-platform/design-system';

type Variant = 'compact' | 'label';

type Props = {
  lotCode: string;
  /** Optional title to display below the code. Truncated to one line. */
  title?: string;
  /** Optional source/truck label shown as a small caption. */
  source?: string;
  variant?: Variant;
};

const QR_SIZE: Record<Variant, number> = {
  compact: 88,
  label: 220,
};

export function LotQRCard({ lotCode, title, source, variant = 'compact' }: Props) {
  const size = QR_SIZE[variant];
  const isLabel = variant === 'label';
  return (
    <View
      style={[
        s.card,
        isLabel ? s.cardLabel : s.cardCompact,
      ]}
    >
      <View style={[s.qrWrap, { width: size, height: size }]}>
        <QRCode
          value={lotCode}
          size={size}
          backgroundColor="#ffffff"
          color="#000000"
          // ECC level M is the default and balances density vs. error
          // tolerance well — survives crumpled thermal labels.
          ecl="M"
        />
      </View>
      <View style={{ flex: 1, alignItems: isLabel ? 'center' : 'flex-start' }}>
        <Text
          style={[s.lotCode, isLabel && s.lotCodeLabel]}
          numberOfLines={1}
          selectable
        >
          {lotCode}
        </Text>
        {title ? (
          <Text
            style={[s.title, isLabel && s.titleLabel]}
            numberOfLines={isLabel ? 3 : 2}
          >
            {title}
          </Text>
        ) : null}
        {source ? (
          <Text style={s.source} numberOfLines={1}>
            📦 {source}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 12,
    gap: 12,
  },
  cardCompact: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardLabel: {
    flexDirection: 'column',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  qrWrap: {
    backgroundColor: '#ffffff',
    padding: 4,
    borderRadius: 6,
  },
  lotCode: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '900',
    color: '#000000',
    letterSpacing: 0.5,
  },
  lotCodeLabel: {
    fontSize: 22,
    marginTop: 8,
  },
  title: {
    color: '#111111',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  titleLabel: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  source: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
});
