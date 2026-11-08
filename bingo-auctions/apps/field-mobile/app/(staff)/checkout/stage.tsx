// Stage flow:
//   1. Scan lot QR (encodes the lot UUID).
//   2. Confirm lot details + capture a staging photo (skippable).
//   3. Scan bin QR (encodes the bin's qr_token UUID).
//   4. Upload photo to staging-photos bucket if captured.
//   5. Server: assign_lot_to_bin RPC creates the bin_assignments row + emits
//      pickup_ready notification if all lots in any matching invoice are now
//      staged.
//
// The staging photo is the killer feature for cutting wasted pickup
// trips: bidders see the actual item before driving to the warehouse.

import { useRef, useState } from 'react';
import { WarehouseFilterChip } from '@/features/location/WarehouseFilterChip';
import { View, Text, Pressable, Alert, ActivityIndicator, ScrollView, Image, StyleSheet } from 'react-native';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { useBackCamera } from '@/features/camera/useBackCamera';
import {
  TAKE_PHOTO_OPTIONS,
  QR_ONLY,
  firstCodeValue,
  safeFlash,
  translateCaptureError,
  type DecodedCode,
} from '@/lib/vision-camera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { uploadImageFromUri } from '../../../lib/upload-image';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Step = 'scan_lot' | 'confirm_lot' | 'capture_photo' | 'scan_bin' | 'submitting' | 'done';

type Lot = {
  id: string;
  lot_code: string | null;
  sticker_code: string | null;
  title: string;
  photo_urls: string[];
  operator_id: string;
  // FIX #7: where the item currently sits (intake/put-away shelf) so staff
  // know where to retrieve it before assigning a staging bin. PostgREST
  // returns the to-one embed as an object (or null); the bins!fkey hint
  // disambiguates the lots→bins relationship.
  intake_bin_id: string | null;
  intake_bin: { code: string | null } | null;
};

const REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Sign in again — your session expired.',
  not_operator_staff: 'You\'re not on staff for any operator.',
  lot_not_found: 'No lot matched that QR.',
  lot_other_operator: 'That lot belongs to a different operator.',
  bin_not_found: 'No bin matched that QR.',
  bin_other_operator: 'That bin belongs to a different operator.',
};

export default function StageScreen() {
  const [warehouseFilterId, setWarehouseFilterId] = useState<string | null>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const [step, setStep] = useState<Step>('scan_lot');
  const [lot, setLot] = useState<Lot | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ binCode: string; lotTitle: string } | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const scanCameraRef = useRef<Camera | null>(null);
  const device = useBackCamera();
  const photoFocus = useTapToFocus(cameraRef);
  const scanFocus = useTapToFocus(scanCameraRef);
  // Both scan steps (lot QR + bin QR) reuse a single useCodeScanner —
  // the routing decision (lot vs bin) lives in `step`, not the scanner.
  const qrScanner = useCodeScanner({
    codeTypes: QR_ONLY,
    onCodeScanned: (codes) => {
      const c = firstCodeValue(codes);
      if (!c || busy) return;
      if (step === 'scan_lot') void onLotScan(c);
      else if (step === 'scan_bin') void onBinScan(c);
    },
  });

  function extractUuid(s: string): string | null {
    const m = s.trim().match(UUID_RE) ?? s.match(/([0-9a-f-]{36})/i);
    return m && UUID_RE.test(m[0]) ? m[0] : null;
  }

  async function onLotScan(scan: DecodedCode) {
    if (busy) return;
    const lotId = extractUuid(scan.data);
    if (!lotId) {
      Alert.alert('Not a lot QR', 'Couldn\'t read a lot ID from this code.');
      return;
    }
    setBusy(true);
    const { data, error } = await supabase
      .from('lots')
      .select(
        'id, title, photo_urls, operator_id, lot_code, sticker_code, display_code, ' +
          'intake_bin_id, intake_bin:bins!lots_intake_bin_id_fkey(code)',
      )
      .eq('id', lotId)
      .single();
    setBusy(false);
    if (error || !data) {
      Alert.alert('Lot not found', error?.message ?? 'Try again.');
      return;
    }
    setLot(data as unknown as Lot);
    setStep('confirm_lot');
  }

  async function takePhoto() {
    if (!cameraRef.current) return;
    setBusy(true);
    try {
      if (!cameraRef.current) return;
      const photo = await cameraRef.current.takePhoto({
        flash: safeFlash(device, 'auto'),
        ...TAKE_PHOTO_OPTIONS,
      });
      setPhotoUri(`file://${photo.path}`);
    } catch (err) {
      Alert.alert('Capture failed', translateCaptureError(err));
    } finally {
      setBusy(false);
    }
  }

  // W6-P2 (2026-05-26): exponential-backoff retry. Pre-W6-P2 a single
  // network blip would silently drop the staging photo (returned null,
  // bin_assignment row stayed without photo_url). Now we retry up to 3
  // times with 0ms / 500ms / 2000ms backoff before giving up.
  async function uploadStagingPhoto(operatorId: string, assignmentId: string): Promise<string | null> {
    if (!photoUri) return null;
    const path = `${operatorId}/${assignmentId}.jpg`;
    const BACKOFF_MS = [0, 500, 2000];
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt]! > 0) {
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]!));
      }
      const result = await uploadImageFromUri('staging-photos', path, photoUri, {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (result.ok) {
        return result.url;
      }
      // eslint-disable-next-line no-console
      console.warn(`staging photo upload failed (attempt ${attempt + 1}/${BACKOFF_MS.length}):`, result.reason);
    }
    return null;
  }

  async function onBinScan(scan: DecodedCode) {
    if (busy || !lot) return;
    const token = extractUuid(scan.data);
    if (!token) {
      Alert.alert('Not a bin QR', 'Couldn\'t read a bin token.');
      return;
    }
    setBusy(true);
    setStep('submitting');
    try {
      // Stage 1: assign the lot. The RPC inserts the bin_assignments row
      // (with photo_url=null) and emits the pickup_ready check.
      const { data, error } = await supabase.rpc('assign_lot_to_bin', {
        p_lot_id: lot.id,
        p_bin_qr_token: token,
        p_photo_url: null,
        p_notes: null,
      });
      if (error) throw error;
      const result = data as {
        ok: boolean;
        reason: string;
        bin_code: string | null;
        assignment_id: string | null;
      };
      if (!result.ok) {
        Alert.alert(
          'Couldn\'t stage',
          REASON_MESSAGES[result.reason] ?? `Server said: ${result.reason}`,
        );
        setStep('scan_bin');
        return;
      }

      // Stage 2: upload the staging photo (if we captured one) and update
      // the row with the URL. We do this AFTER the assignment so the
      // bidder's pickup_ready notification doesn't fire before there's
      // a visible photo.
      if (photoUri && result.assignment_id) {
        const url = await uploadStagingPhoto(lot.operator_id, result.assignment_id);
        if (url) {
          await supabase
            .from('bin_assignments')
            .update({ staging_photo_url: url })
            .eq('id', result.assignment_id);
        }
      }

      setLastResult({ binCode: result.bin_code ?? '', lotTitle: lot.title });
      setStep('done');
    } catch (err) {
      Alert.alert('Stage failed', (err as Error).message);
      setStep('scan_bin');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setLot(null);
    setLastResult(null);
    setPhotoUri(null);
    setStep('scan_lot');
  }

  if (!hasPermission) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: '#0b0d12' }}>
        <Text style={{ color: '#e8eaf0', fontSize: 16, marginBottom: 12 }}>
          Camera access is required to scan QR codes and capture staging photos.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
        >
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const stepLabel =
    step === 'scan_lot'
      ? '1 of 4 · scan lot'
      : step === 'confirm_lot'
        ? '2 of 4 · confirm'
        : step === 'capture_photo'
          ? '3 of 4 · staging photo'
          : step === 'scan_bin'
            ? '4 of 4 · scan bin'
            : step === 'submitting'
              ? 'submitting…'
              : 'done';

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#0b0d12' }} contentContainerStyle={{ padding: 16 }}>
      <WarehouseFilterChip value={warehouseFilterId} onChange={setWarehouseFilterId} />
      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>{stepLabel}</Text>

      {(step === 'scan_lot' || step === 'scan_bin') && device && (
        <View style={{ height: 360, borderRadius: 8, overflow: 'hidden', marginTop: 12 }}>
          <Camera
            ref={scanCameraRef}
            style={{ flex: 1 }}
            device={device}
            isActive={cameraGate && ((step === 'scan_lot' || step === 'scan_bin') && !busy)}
            codeScanner={qrScanner}
          />
          <Pressable style={StyleSheet.absoluteFillObject} onPress={scanFocus.onTap} />
          {scanFocus.indicator}
        </View>
      )}

      {step === 'confirm_lot' && lot && (
        <View style={{ marginTop: 16 }}>
          <Text style={{ color: '#e8eaf0', fontSize: 18, fontWeight: '600' }}>{lot.title}</Text>
          <Text style={{ color: '#8a93a6', marginTop: 4, fontSize: 13 }}>Lot {lotDisplayCode(lot) ?? lot.lot_code ?? lot.id.slice(0, 8)}</Text>
          {/* FIX #7: show where the item currently lives so staff can retrieve
              it before scanning a staging bin. */}
          <Text style={{ color: '#4f8cff', marginTop: 8, fontSize: 13, fontWeight: '600' }}>
            {lot.intake_bin?.code
              ? `Retrieve from: ${lot.intake_bin.code}`
              : 'Location pending'}
          </Text>
          <Pressable
            onPress={() => setStep('capture_photo')}
            style={{ marginTop: 16, padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>
              Continue to staging photo
            </Text>
          </Pressable>
          <Pressable
            onPress={reset}
            style={{ marginTop: 8, padding: 14, backgroundColor: '#232839', borderRadius: 6 }}
          >
            <Text style={{ color: '#8a93a6', textAlign: 'center' }}>Wrong lot — rescan</Text>
          </Pressable>
        </View>
      )}

      {step === 'capture_photo' && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: '#8a93a6', fontSize: 13, marginBottom: 8 }}>
            Capture a quick photo of the actual item. Bidders see this before driving in — it cuts
            wasted trips on misrepresented items.
          </Text>
          {photoUri ? (
            <View>
              <Image
                source={{ uri: photoUri }}
                style={{ width: '100%', height: 360, borderRadius: 8 }}
                resizeMode="cover"
              />
              <Pressable
                onPress={() => setPhotoUri(null)}
                style={{ marginTop: 8, padding: 14, backgroundColor: '#232839', borderRadius: 6 }}
              >
                <Text style={{ color: '#8a93a6', textAlign: 'center' }}>Retake</Text>
              </Pressable>
            </View>
          ) : (
            <View>
              {device && (
                <View style={{ height: 360, borderRadius: 8, overflow: 'hidden' }}>
                  <Camera
                    ref={cameraRef}
                    style={{ flex: 1 }}
                    device={device}
                    isActive={cameraGate && (step === 'capture_photo' && !photoUri)}
                    photo={true}
                  />
                  <Pressable style={StyleSheet.absoluteFillObject} onPress={photoFocus.onTap} />
                  {photoFocus.indicator}
                </View>
              )}
              <Pressable
                onPress={takePhoto}
                disabled={busy}
                style={{ marginTop: 8, padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
              >
                <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>
                  {busy ? 'Capturing…' : 'Take photo'}
                </Text>
              </Pressable>
            </View>
          )}
          <Pressable
            onPress={() => setStep('scan_bin')}
            style={{ marginTop: 8, padding: 14, backgroundColor: '#1c2e49', borderRadius: 6 }}
          >
            <Text style={{ color: '#e8eaf0', textAlign: 'center' }}>
              {photoUri ? 'Continue with this photo' : 'Skip — no photo'}
            </Text>
          </Pressable>
        </View>
      )}

      {step === 'submitting' && (
        <View style={{ alignItems: 'center', marginTop: 32 }}>
          <ActivityIndicator color="#4f8cff" />
        </View>
      )}

      {step === 'done' && lastResult && (
        <View style={{ marginTop: 16 }}>
          <View
            style={{
              padding: 16,
              backgroundColor: 'rgba(52, 211, 154, 0.1)',
              borderColor: '#34d39a',
              borderWidth: 1,
              borderRadius: 8,
            }}
          >
            <Text style={{ color: '#34d39a', fontWeight: '600' }}>Staged</Text>
            <Text style={{ color: '#e8eaf0', marginTop: 4 }}>
              {lastResult.lotTitle} → bin {lastResult.binCode}
            </Text>
          </View>
          <Pressable
            onPress={reset}
            style={{ marginTop: 16, padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>
              Stage another
            </Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}
