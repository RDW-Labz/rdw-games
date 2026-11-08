// Scan-a-lot tab.
//
// A bidder walks a warehouse and scans one of three things:
//
//   1. The operator's door "Preview QR" (https://bingoauctions.com/preview/{auction})
//      → a ONE-TIME "preview check-in": we persist that auction's operator
//      (set_bidder_preview_operator, migration 0150) on the device + bidder
//      profile. This is what lets a bidder — who has no operator identity —
//      resolve THAT operator's own physical sticker codes afterward. Set once;
//      re-scanning a different house's QR switches it.
//
//   2. A per-lot BinGo Auctions QR — a bare UUID or https://bingoauctions.com/l/{uuid}
//      → resolve_lot_by_qr_token (0103). No check-in needed; resolves globally.
//
//   3. The operator's OWN physical sticker — a PNK/LPN label, a DataMatrix,
//      or a 1D barcode → resolve_lot_for_bidder(raw, previewOperatorId?)
//      (0313). The check-in is a HINT here, not a prerequisite: pass it and the
//      probe is scoped to that house, omit it and 0313 probes every operator
//      and reports `operator_matches` so we ask for a check-in only when the
//      label is genuinely ambiguous. Until 0313 this called
//      resolve_lot_by_sticker (0150), which REQUIRED the check-in and so
//      dead-ended every bidder who hadn't found the door QR.
//
// After a successful lot resolve (path 2 OR 3) the routing is IDENTICAL:
//   - auction live            → deep-link into the bid screen.
//   - the scanner won it      → "You won this item", point at the pickup pass.
//   - auction not opened yet  → "Add to watchlist?" (notified before it closes)
//   - anything else           → "Not on auction", watchlist offered without
//                               promising an alert we don't send.
//
// Permission gating + the camera-busy flag mirror BinScanner.tsx.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, track, useBidderRole } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

// Bare-UUID regex (per-lot qr_token, identical shape to bin tokens).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Trailing-UUID for the universal-link form https://bingoauctions.com/l/{token}.
const TRAILING_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
// Door "Preview QR": https://bingoauctions.com/preview/{auction_id} (any host).
// Checked BEFORE the lot-token regex because the preview URL also ends in a UUID.
const PREVIEW_RE = /\/preview\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Persisted preview check-in. Stored on-device (mirrors the bidder profile that
// set_bidder_preview_operator writes server-side). v1 payload = { id, name }.
const PREVIEW_OP_KEY = '@clovrbid/preview-operator/v1';

type PreviewOperator = { id: string; name: string | null };

// Mirrors resolve_lot_by_qr_token AND resolve_lot_for_bidder (same column
// allowlist, migrations 0150 / 0313) so both paths share one routing function.
type ResolveResult = {
  lot_id: string;
  lot_code: string;
  operator_id: string;
  operator_code: string;
  status: string;
  auction_id: string | null;
  auction_status: string | null;
  title: string;
  thumbnail_url: string | null;
  // resolve_lot_for_bidder only (0313): how many distinct operators the raw
  // label matched. Absent on the qr_token path, where the token is unique.
  operator_matches?: number;
};

function extractLotToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  const m = trimmed.match(TRAILING_UUID_RE);
  const captured = m?.[1];
  return captured ? captured.toLowerCase() : null;
}

function extractPreviewAuctionId(raw: string): string | null {
  const m = raw.trim().match(PREVIEW_RE);
  return m?.[1] ? m[1].toLowerCase() : null;
}

export default function ScanScreen() {
  const router = useRouter();
  const role = useBidderRole();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [previewOperator, setPreviewOperator] = useState<PreviewOperator | null>(null);
  // "Tap to start" gate. The live camera (and the expo-camera native preview)
  // only mounts once the user opts in — opening the tab no longer fires up the
  // camera / drains battery / feels jarring. Mirrors BinScanner.tsx's
  // `scanning` flag. Reset to false whenever the tab loses focus (below) so the
  // camera is torn down when the bidder navigates away.
  const [scanning, setScanning] = useState(false);

  // Don't auto-request permission on mount anymore — wait until the user taps
  // "Start scanning" so the OS prompt is tied to an explicit intent (and the
  // camera isn't eagerly initialised on tab focus). Requested in startScanning().

  // Load the persisted preview check-in once on mount.
  useEffect(() => {
    AsyncStorage.getItem(PREVIEW_OP_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as PreviewOperator;
          if (parsed && typeof parsed.id === 'string') setPreviewOperator(parsed);
        } catch {
          // Malformed — ignore; a fresh check-in will overwrite it.
        }
      })
      .catch(() => {
        // Storage unavailable — the user can still check in this session.
      });
  }, []);

  // Reset busy whenever the tab regains focus so a prior scan doesn't keep the
  // scanner disabled after navigating back. On blur, also drop out of the
  // active-scanning state so the camera preview is unmounted while the tab is
  // backgrounded — the bidder taps "Start scanning" again to resume.
  useFocusEffect(
    useCallback(() => {
      setBusy(false);
      return () => setScanning(false);
    }, []),
  );

  // Enter active-scanning mode. Requests camera permission first if it hasn't
  // been granted yet (and can still be asked); the CameraView only mounts once
  // `scanning` is true AND permission is granted (see render below).
  const startScanning = useCallback(async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return; // denied — the not-granted UI handles messaging
    }
    setScanning(true);
  }, [permission?.granted, requestPermission]);

  async function persistPreviewOperator(op: PreviewOperator) {
    setPreviewOperator(op);
    try {
      await AsyncStorage.setItem(PREVIEW_OP_KEY, JSON.stringify(op));
    } catch {
      // Best-effort; in-memory state still works for this session.
    }
  }

  async function addToWatchlist(lotId: string): Promise<{ ok: boolean; message: string }> {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      return { ok: false, message: 'Please sign in to save lots to your watchlist.' };
    }
    // Upsert so re-scanning a watched lot isn't an error. PK is
    // (bidder_id, lot_id); ignoreDuplicates makes it idempotent.
    const { error } = await supabase
      .from('watchlist')
      .upsert(
        { bidder_id: u.user.id, lot_id: lotId },
        { onConflict: 'bidder_id,lot_id', ignoreDuplicates: true },
      );
    if (error) return { ok: false, message: error.message };
    track('watchlist_added', { lot_id: lotId });
    return { ok: true, message: 'Added to watchlist.' };
  }

  // Shared post-resolve routing — IDENTICAL for the qr_token and sticker paths.
  //
  // Used to be two outcomes: live → bid screen, everything else → "bidding
  // hasn't opened on this lot yet". That second message was wrong for most of
  // what it covered. An unsold, ended, or already-won item is not waiting to
  // open — it is not on auction at all, which is what the 2026-08-07 report
  // asked us to say. And a bidder scanning the box of something they already
  // WON was being invited to watchlist their own property.
  //
  // What the watchlist actually does bounds what we may promise: closing-soon
  // (lib/cron/closing-soon.ts) fires 10 minutes before THAT lot's close_at.
  // Nothing watches for a relist — and a relist mints a new lot id anyway, so
  // the watchlist row would point at the dead one. So the off-auction branch
  // offers the watchlist without claiming we'll announce a return.
  function routeResolvedLot(row: ResolveResult) {
    if (row.auction_status === 'live') {
      track('lot_qr_scanned', { lot_id: row.lot_id, action: 'navigated' });
      router.push({ pathname: '/lot/[id]', params: { id: row.lot_id, source: 'scan' } });
      return;
    }

    const openToLot = () =>
      router.push({ pathname: '/lot/[id]', params: { id: row.lot_id, source: 'scan' } });

    // The bidder already owns it — 0313 resolves a scanned label to the
    // scanner's own lot in that lineage, so this is their item, in their hands.
    if (row.status === 'won') {
      track('lot_qr_scanned', { lot_id: row.lot_id, action: 'won_item' });
      Alert.alert(
        row.title || `Lot ${row.lot_code}`,
        'You won this item — it’s on your pickup pass.',
        [{ text: 'View item', onPress: openToLot }],
      );
      return;
    }

    const notYetOpen = row.auction_status === 'scheduled' || row.auction_status === 'draft';
    const watchPrompt = notYetOpen
      ? {
          title: row.title || `Lot ${row.lot_code}`,
          body: 'Bidding hasn’t opened on this lot yet. Add it to your watchlist? We’ll notify you before it closes.',
        }
      : {
          title: 'Not on auction',
          body: `${row.title || `Lot ${row.lot_code}`} isn’t up for auction right now. You can add it to your watchlist to keep track of it.`,
        };

    Alert.alert(watchPrompt.title, watchPrompt.body, [
      { text: 'Cancel', style: 'cancel', onPress: () => setBusy(false) },
      {
        text: 'Add to watchlist',
        onPress: async () => {
          const result = await addToWatchlist(row.lot_id);
          if (!result.ok) {
            Alert.alert('Could not add', result.message, [
              { text: 'OK', onPress: () => setBusy(false) },
            ]);
            return;
          }
          track('lot_qr_scanned', { lot_id: row.lot_id, action: 'watchlisted' });
          openToLot();
        },
      },
    ]);
  }

  // Path 1: door "Preview QR" → persist the auction's operator as the check-in.
  async function handlePreviewCheckIn(auctionId: string) {
    try {
      const { data, error } = await supabase.rpc('set_bidder_preview_operator', {
        p_auction_id: auctionId,
      });
      if (error) throw error;
      const res = data as {
        ok?: boolean;
        operator_id?: string;
        operator_name?: string | null;
      } | null;
      if (!res?.ok || !res.operator_id) {
        Alert.alert(
          "Couldn't check in",
          "That Preview QR didn't match an auction. Ask the staff for the current one.",
          [{ text: 'OK', onPress: () => setBusy(false) }],
        );
        return;
      }
      await persistPreviewOperator({ id: res.operator_id, name: res.operator_name ?? null });
      track('preview_checkin', { operator_id: res.operator_id });
      Alert.alert(
        res.operator_name ? `Previewing ${res.operator_name}` : 'Checked in',
        'You can now scan the stickers on this auction house’s items to open or watchlist them.',
        [{ text: 'Got it', onPress: () => setBusy(false) }],
      );
    } catch (err) {
      Alert.alert('Check-in failed', err instanceof Error ? err.message : 'Unknown error', [
        { text: 'OK', onPress: () => setBusy(false) },
      ]);
    }
  }

  // Path 3: the operator's own sticker → resolve_lot_for_bidder (mig 0313).
  //
  // The check-in is now a HINT, not a prerequisite. It used to be required
  // because the old RPC needed an operator code to build its '{op}:{raw}'
  // probe, so a bidder who hadn't found the door QR was told to go find it and
  // got nothing — the 2026-08-07 report. 0313 makes the operator optional and
  // reports how many distinct operators the raw label matched, so we only ask
  // for a check-in when the label is genuinely ambiguous.
  async function resolveByStickerAndRoute(rawCode: string) {
    let opId = previewOperator?.id ?? null;
    if (!opId) {
      // State may not have hydrated yet — fall back to storage.
      const stored = await AsyncStorage.getItem(PREVIEW_OP_KEY).catch(() => null);
      if (stored) {
        try {
          opId = (JSON.parse(stored) as PreviewOperator).id ?? null;
        } catch {
          opId = null;
        }
      }
    }
    try {
      const { data, error } = await supabase.rpc('resolve_lot_for_bidder', {
        p_raw_code: rawCode,
        p_operator_id: opId,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as ResolveResult | undefined;
      if (!row || !row.lot_id) {
        Alert.alert(
          'Lot not found',
          opId
            ? "That sticker doesn't match a lot at the auction house you checked in to. If you're at a different house, scan its Preview QR."
            : "That sticker doesn't match any lot we have.",
          [{ text: 'OK', onPress: () => setBusy(false) }],
        );
        return;
      }
      // Ambiguous across houses and we have no check-in to break the tie. Show
      // the ranked winner but let the bidder pin it down properly.
      if (!opId && (row.operator_matches ?? 1) > 1) {
        Alert.alert(
          'That label is used by more than one auction house',
          `Showing the ${row.operator_code} item. If you're somewhere else, scan that house's "Preview QR" (posted at the pickup door) and scan this label again.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => setBusy(false) },
            { text: 'Show it', onPress: () => routeResolvedLot(row) },
          ],
        );
        return;
      }
      routeResolvedLot(row);
    } catch (err) {
      Alert.alert('Scan failed', err instanceof Error ? err.message : 'Unknown error', [
        { text: 'OK', onPress: () => setBusy(false) },
      ]);
    }
  }

  async function handleScan(scan: BarcodeScanningResult) {
    if (busy) return;
    const raw = scan.data ?? '';

    // 1. Door "Preview QR" → one-time check-in. MUST be tried before the
    //    lot-token path (the preview URL also ends in a UUID).
    const previewAuctionId = extractPreviewAuctionId(raw);
    if (previewAuctionId) {
      setBusy(true);
      await handlePreviewCheckIn(previewAuctionId);
      return;
    }

    // 2. BinGo Auctions lot QR (bare UUID or /l/{uuid}) → resolve_lot_by_qr_token.
    const token = extractLotToken(raw);
    if (token) {
      setBusy(true);
      try {
        const { data, error } = await supabase.rpc('resolve_lot_by_qr_token', {
          p_token: token,
        });
        if (error) throw error;
        const row = (Array.isArray(data) ? data[0] : data) as ResolveResult | undefined;
        if (!row || !row.lot_id) {
          Alert.alert(
            'Lot not found',
            "This sticker doesn't match any lot. The QR may have been rotated by the operator.",
            [{ text: 'Try again', onPress: () => setBusy(false) }],
          );
          return;
        }
        routeResolvedLot(row);
      } catch (err) {
        Alert.alert('Scan failed', err instanceof Error ? err.message : 'Unknown error', [
          { text: 'OK', onPress: () => setBusy(false) },
        ]);
      }
      return;
    }

    // 3. Any other code (the operator's own PNK/LPN/UPC/DataMatrix sticker) →
    //    operator-scoped resolve via the persisted preview check-in.
    const trimmed = raw.trim();
    if (!trimmed) {
      setBusy(true);
      Alert.alert('Nothing scanned', 'Point the camera at the QR or sticker and try again.', [
        { text: 'OK', onPress: () => setBusy(false) },
      ]);
      return;
    }
    setBusy(true);
    await resolveByStickerAndRoute(trimmed);
  }

  // Role gates. The (tabs)/_layout.tsx already routes non-bidders away, but
  // render a friendly fallback during the brief mount window.
  if (role.kind === 'loading') {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }
  if (
    role.kind === 'unauthenticated' ||
    role.kind === 'staff_in_bidder_app' ||
    role.kind === 'pending_provision'
  ) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Sign in as a bidder</Text>
        <Text style={styles.muted}>Scanning lots is only available for bidder accounts.</Text>
        <Pressable onPress={() => router.replace('/login')} style={styles.button}>
          <Text style={styles.buttonText}>Go to sign in</Text>
        </Pressable>
      </View>
    );
  }

  if (!permission) {
    return <View style={styles.center} />;
  }

  // "Search instead" cross-link → routes to Browse/search. Shared between the
  // idle gate and the active-scan overlay so the bidder always has a one-tap
  // escape hatch back to text search.
  const searchInsteadLink = (
    <Pressable
      onPress={() => router.push('/(tabs)' as never)}
      hitSlop={8}
      accessibilityRole="link"
      style={styles.crossLink}
    >
      <Text style={styles.crossLinkIcon}>🔎</Text>
      <Text style={styles.crossLinkText}>Search lots instead</Text>
    </Pressable>
  );

  // Permission was explicitly denied and can't be re-prompted from the app —
  // point the bidder at Settings. (When permission can still be asked, the
  // idle gate below requests it on the "Start scanning" tap.)
  if (!permission.granted && !permission.canAskAgain) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.muted}>
          Enable camera access for BinGo Auctions in Settings to scan lot stickers.
        </Text>
        {searchInsteadLink}
      </View>
    );
  }

  // Idle "tap to start" gate. Default landing for the Scan tab — the camera is
  // NOT mounted here, so opening the tab is cheap and doesn't flash a live
  // preview. Tapping "Start scanning" requests permission (if needed) then
  // flips `scanning` true, which mounts the CameraView below.
  if (!scanning) {
    return (
      <View style={styles.center}>
        <View style={styles.idleReticle}>
          <Text style={styles.idleReticleGlyph}>⛶</Text>
        </View>
        <Text style={styles.title}>Scan a lot</Text>
        <Text style={styles.muted}>
          {previewOperator
            ? `Previewing ${previewOperator.name ?? 'this auction house'}. Point your camera at a lot sticker or BinGo Auctions QR to open or watchlist it.`
            : "Scan the auction house's door Preview QR once, then scan item stickers to open or watchlist them. BinGo Auctions QR stickers work anytime."}
        </Text>
        <Pressable
          testID="scan-start"
          onPress={startScanning}
          style={styles.button}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Start scanning</Text>
        </Pressable>
        {searchInsteadLink}
      </View>
    );
  }

  return (
    <View style={styles.cameraWrap}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{
          // QR + DataMatrix cover BinGo Auctions QRs and 2D vendor stickers (PNK
          // labels); the 1D set covers UPC/EAN/Code128/LPN labels. Choosing
          // types is a JS-only expo-camera config (OTA-safe) — the native
          // module already bundles every decoder.
          barcodeTypes: [
            'qr',
            'datamatrix',
            'pdf417',
            'aztec',
            'code128',
            'code39',
            'code93',
            'codabar',
            'itf14',
            'ean13',
            'ean8',
            'upc_a',
            'upc_e',
          ],
        }}
        onBarcodeScanned={busy ? undefined : handleScan}
      />
      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.reticle} />
        {busy ? (
          <Text style={styles.overlayText}>Resolving…</Text>
        ) : (
          <>
            <Text style={styles.overlayText}>
              {previewOperator
                ? 'Scan a lot sticker or BinGo Auctions QR'
                : 'Scan the door Preview QR to start'}
            </Text>
            <Text style={styles.overlaySubText}>
              {previewOperator
                ? `Previewing ${previewOperator.name ?? 'this auction house'}. Live lots open to bid; others get added to your watchlist.`
                : "Scan the auction house's Preview QR once, then scan the stickers on items to open or watchlist them. BinGo Auctions QR stickers work anytime."}
            </Text>
          </>
        )}
      </View>
      {/* "Search instead" cross-link, pinned at the bottom over the live
          preview. Sits OUTSIDE the pointerEvents="none" overlay so it stays
          tappable. */}
      <View style={styles.cameraFooter} pointerEvents="box-none">
        <Pressable
          testID="scan-search-instead"
          onPress={() => router.push('/(tabs)' as never)}
          hitSlop={8}
          accessibilityRole="link"
          style={styles.crossLinkOnCamera}
        >
          <Text style={styles.crossLinkIcon}>🔎</Text>
          <Text style={styles.crossLinkText}>Search lots instead</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  muted: {
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    backgroundColor: colors.primary,
    borderRadius: 8,
  },
  buttonText: {
    color: '#0a0c11',
    fontWeight: '700',
  },
  // Idle-gate reticle — a static framed glyph that previews the scan target
  // shape without mounting the live camera.
  idleReticle: {
    width: 96,
    height: 96,
    borderColor: colors.primary,
    borderWidth: 2,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  idleReticleGlyph: {
    color: colors.primary,
    fontSize: 40,
  },
  // "Search instead" cross-link on the idle / permission screens (dark bg).
  crossLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  // Same link pinned over the live camera preview — pill backing for legibility.
  crossLinkOnCamera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: 'rgba(10,12,17,0.72)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  crossLinkIcon: {
    fontSize: 13,
  },
  crossLinkText: {
    color: colors.primary,
    fontSize: 13,
    ...type.label,
  },
  cameraFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 28,
    alignItems: 'center',
  },
  cameraWrap: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: 240,
    height: 240,
    borderColor: colors.primary,
    borderWidth: 2,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  overlayText: {
    marginTop: 16,
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
  overlaySubText: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    fontWeight: '400',
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 16,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
});
