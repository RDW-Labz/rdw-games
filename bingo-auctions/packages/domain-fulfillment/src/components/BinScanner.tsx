// QR scanner for bin pickup confirmation. Uses expo-camera barcode scanning.
//
// *** BACK-UP PATH — staff-mediated pickup is now the primary flow. ***
//
// Normally: the bidder shows their pickup QR (rendered above this component
// in the pickup detail screen) to a warehouse staff member, who scans it on
// the staff "Verify Pickup" screen in the field-mobile picker app. That path
// does the ID check, lot-by-lot verification, and signature capture, and is
// the default for all operators.
//
// This self-scan component remains as a fallback for operators who run
// unstaffed pickup windows (e.g. 24-hour lockers, drop-box style). To
// enable it for a given operator, no code change is needed — just instruct
// the bidder to use it. However, self-scan has no identity verification:
// anyone who obtains the bin QR can confirm pickup. Operators should weigh
// that risk.
//
// Flow: open camera → scan a QR encoding a bin's qr_token UUID → call
// confirm_pickup RPC → on success, the screen refreshes to show those lots
// as picked up.
//
// Permission gating: if the user hasn't granted camera permission yet, we
// show a prompt before mounting the camera.

import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { supabase } from '@auction-platform/supabase-client';
import { track } from '@auction-platform/supabase-client';

type ConfirmResult = {
  ok: boolean;
  reason: string;
  picked_up_count: number;
  bin_id: string | null;
  bin_code: string | null;
  lot_ids: string[];
};

const REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Please sign in.',
  not_a_bidder: 'You need a bidder account.',
  bin_not_found: 'This QR code doesn\'t match any bin.',
  no_staged_lots: 'No items of yours are staged at this bin.',
  ok: '',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function BinScanner({ onConfirmed }: { onConfirmed: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  async function handleScan(scan: BarcodeScanningResult) {
    if (busy) return;

    // Pull the UUID out of the QR. Accept either a bare UUID or a URI like
    // `auction-platform://bin/<uuid>`.
    const raw = scan.data.trim();
    const m = raw.match(UUID_RE) ?? raw.match(/([0-9a-f-]{36})$/i);
    const token = m?.[0];

    if (!token || !UUID_RE.test(token)) {
      Alert.alert(
        'Not a BinGo Auctions bin QR',
        'This QR doesn\'t contain a BinGo Auctions bin token. Make sure you\'re scanning a sticker printed from the warehouse setup page in the operator console — manually-made QRs (with just the bin code) won\'t work.',
      );
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('confirm_pickup', { p_bin_qr_token: token });
      if (error) throw error;
      const result = data as unknown as ConfirmResult;
      if (!result.ok) {
        Alert.alert(
          'Couldn\'t confirm pickup',
          REASON_MESSAGES[result.reason] ?? `Server said: ${result.reason}`,
        );
        return;
      }
      track('pickup_confirmed', {
        bin_id: result.bin_id,
        bin_code: result.bin_code,
        lot_count: result.picked_up_count,
      });
      Alert.alert(
        'Picked up',
        `Bin ${result.bin_code} — ${result.picked_up_count} lot${result.picked_up_count === 1 ? '' : 's'} marked picked up.`,
      );
      setScanning(false);
      onConfirmed();
    } catch (err) {
      Alert.alert('Confirm failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!permission) return null;

  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.permissionText}>
          Camera access is needed to scan bin QR codes for pickup confirmation.
        </Text>
        <Pressable onPress={requestPermission} style={styles.button}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  if (!scanning) {
    return (
      <Pressable onPress={() => setScanning(true)} style={[styles.button, { backgroundColor: '#232839' }]}>
        <Text style={[styles.buttonText, { color: '#8a93a6', fontSize: 13 }]}>
          No staff available? Scan the bin QR yourself (back-up only)
        </Text>
      </Pressable>
    );
  }

  return (
    <View>
      <CameraView
        style={{ height: 360, borderRadius: 8, overflow: 'hidden' }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : handleScan}
      />
      <Pressable
        onPress={() => setScanning(false)}
        style={[styles.button, { marginTop: 8, backgroundColor: '#232839' }]}
      >
        <Text style={styles.buttonText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  permission: {
    padding: 16,
    backgroundColor: '#14171f',
    borderRadius: 8,
    borderColor: '#232839',
    borderWidth: 1,
    alignItems: 'center',
  },
  permissionText: { color: '#8a93a6', textAlign: 'center', lineHeight: 20, marginBottom: 12 },
  button: {
    padding: 14,
    backgroundColor: '#4f8cff',
    borderRadius: 8,
  },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: '600' },
});
