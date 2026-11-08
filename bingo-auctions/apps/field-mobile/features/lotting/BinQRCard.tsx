// BinQRCard — printable QR + code card for a warehouse bin.
//
// The QR encodes the bin's qr_token UUID (per migration 0001's
// bins.qr_token UNIQUE column). intake_lot_to_bin RPC + the picker
// flows match the scanned UUID against bins.qr_token to identify
// which bin a lot is being put away to.
//
// Usage:
//   <BinQRCard binCode="A-01" qrToken="38dcddba-7c5a-4fb5-..." />
//
// Same compact/label sizing as LotQRCard for visual parity. The big
// "label" variant prints to ~3" thermal label form factor (220px QR
// + label text ≈ standard Brother / Munbyn 62mm × 100mm shipping
// label).

import { View, Text, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

type Variant = 'compact' | 'label';

type Props = {
  binCode: string;
  qrToken: string;
  /** Optional warehouse label for context. */
  warehouseName?: string;
  variant?: Variant;
};

const QR_SIZE: Record<Variant, number> = {
  compact: 88,
  label: 220,
};

export function BinQRCard({ binCode, qrToken, warehouseName, variant = 'compact' }: Props) {
  const size = QR_SIZE[variant];
  const isLabel = variant === 'label';
  return (
    <View style={[s.card, isLabel ? s.cardLabel : s.cardCompact]}>
      <View style={[s.qrWrap, { width: size, height: size }]}>
        <QRCode
          value={qrToken}
          size={size}
          backgroundColor="#ffffff"
          color="#000000"
          ecl="M"
        />
      </View>
      <View style={{ flex: 1, alignItems: isLabel ? 'center' : 'flex-start' }}>
        <Text style={[s.binCode, isLabel && s.binCodeLabel]} numberOfLines={1} selectable>
          BIN {binCode}
        </Text>
        {warehouseName ? (
          <Text style={s.warehouseName} numberOfLines={1}>
            {warehouseName}
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
  binCode: {
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '900',
    color: '#000000',
    letterSpacing: 1,
  },
  binCodeLabel: {
    fontSize: 28,
    marginTop: 10,
    letterSpacing: 2,
  },
  warehouseName: {
    color: '#666666',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
});
