// Bin lookup — READ-ONLY inventory-location search.
//
// Tester ask ("Inventory Location Search / Bin Lookup"): on the staff iPad,
// scan a bin QR (e.g. the "CLUER Test Bin-01-01" sticker) — OR type a bin
// code — and see every lot currently in that bin: lot code, item title,
// the lot's status, and the current auction (title + status) if it's in one.
//
// This screen NEVER writes. No inserts, no updates, no RPCs. It only reads
// `bins` (resolve the scanned/typed identifier → bin row) and `lots`
// (every lot whose intake_bin_id points at that bin, with the auction
// embedded). Both reads are RLS-scoped to the operator the signed-in user
// is staff for — the same scoping bins/index.tsx and put-away/single.tsx
// rely on — so no manual operator_id filter is needed and a typo can't leak
// another operator's bins.
//
// Conventions mirror (staff)/checkout/pickup-verify.tsx + put-away/single.tsx:
//   - useBackCamera() for lens selection, useTapToFocus() for tap-to-focus
//   - useCodeScanner from react-native-vision-camera v4
//   - QR_ONLY + firstCodeValue from @/lib/vision-camera
//   - extractBinToken(): a bin QR encodes the bin qr_token UUID, possibly
//     wrapped in a URL — pull the first UUID out of the raw scan.
//   - Scanner dedup/lock discipline (scanLockRef + lastScanRef + cooldown)
//     copied from pickup-verify's tokenScanner so a steadily-held QR or a
//     just-resolved bin doesn't re-fire every frame (no re-scan storms).
//   - Manual typed-code path mirrors put-away/single.tsx's submitManualBin:
//     bins.select(...).eq('code', code).maybeSingle().

import { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import * as Haptics from 'expo-haptics';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { QR_ONLY, firstCodeValue, type DecodedCode } from '@/lib/vision-camera';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';
import { useWarehouse } from '@/features/location/WarehouseContext';

// ── UUID / bin-QR helpers ───────────────────────────────────────────────────
// Identical idiom to pickup-verify.tsx's extractBinToken: a bin QR encodes the
// bin's qr_token UUID, possibly wrapped in a URI (e.g. https://bingoauctions.com/...).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractBinToken(raw: string): string | null {
  const trimmed = raw.trim();
  const m = trimmed.match(UUID_RE) ?? trimmed.match(/([0-9a-f-]{36})/i);
  return m && UUID_RE.test(m[0]) ? m[0] : null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ResolvedBin = {
  id: string;
  code: string;
  warehouse_id: string | null;
};

type LotRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  /** Computed column (mig 0315): the label actually printed on the box. */
  display_code: string | null;
  title: string;
  status: string;
  auction_id: string | null;
  auction_title: string | null;
  auction_status: string | null;
};

// Friendly labels for the lot_status enum (mig — lot_status). Falls back to a
// title-cased raw value for any future enum member.
function lotStatusLabel(status: string): string {
  switch (status) {
    case 'pending_intake':
      return 'Pending intake';
    case 'in_inventory':
      return 'In inventory';
    case 'draft':
      return 'Draft';
    case 'scheduled':
      return 'Scheduled';
    case 'live':
      return 'Live';
    case 'won':
      return 'Won';
    case 'unsold':
      return 'Unsold';
    case 'canceled':
      return 'Canceled';
    case 'relisted':
      return 'Relisted';
    case 'disposed':
      return 'Disposed';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export default function BinContentsScreen() {
  // 0293: scope bin-CODE lookups to the active building. Verified on prod
  // 2026-07-28: ALL 30 of Dodge City's bin codes collide with Harrison's
  // (1-01-01, 1-02-01, …), so an operator-wide `.eq('code', …).maybeSingle()`
  // matched two rows and errored out — manual code entry was broken for every
  // Dodge City bin. The QR path is unaffected (qr_token is globally unique).
  const { warehouse: activeWarehouse } = useWarehouse();
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const role = useOperatorRole();
  const device = useBackCamera();
  const cameraRef = useRef<Camera | null>(null);
  const focus = useTapToFocus(cameraRef);

  const [bin, setBin] = useState<ResolvedBin | null>(null);
  const [lots, setLots] = useState<LotRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  // SCANNER-LOOP discipline (copied from pickup-verify's tokenScanner): the
  // scanner fires ~10 frames/sec. Two refs break re-scan storms —
  //   scanLockRef  — held true while a lookup is in flight / results are shown;
  //                  cleared on "Scan another bin".
  //   lastScanRef  — suppresses the SAME decoded value within a cooldown.
  const scanLockRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const SCAN_DEDUP_MS = 2500;

  const binScanner = useCodeScanner({
    codeTypes: QR_ONLY,
    onCodeScanned: (codes) => {
      if (busy || scanLockRef.current || bin) return;
      const c = firstCodeValue(codes);
      if (!c) return;
      const prev = lastScanRef.current;
      const nowMs = Date.now();
      if (prev && prev.value === c.data && nowMs - prev.at < SCAN_DEDUP_MS) return;
      lastScanRef.current = { value: c.data, at: nowMs };
      void onBinScan(c);
    },
  });

  async function onBinScan(scan: DecodedCode) {
    const token = extractBinToken(scan.data);
    if (!token) {
      // Lock briefly so per-frame scans of an unreadable code don't restack;
      // the dedup ref also suppresses the same raw value for SCAN_DEDUP_MS.
      scanLockRef.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setError({
        title: 'Not a bin QR',
        detail: 'Could not read a bin code from this QR. Aim at a bin label and try again.',
      });
      scanLockRef.current = false;
      return;
    }
    await resolveAndLoad({ qrToken: token });
  }

  // Manual typed-code path — mirrors put-away/single.tsx's submitManualBin:
  // resolve the TYPED code against bins.code (RLS scopes bins to the caller's
  // operator, so a typo can't leak another operator's bins).
  async function submitManualCode() {
    if (busy) return;
    const code = manualCode.trim().toUpperCase();
    if (!code) return;
    await resolveAndLoad({ code });
  }

  // Resolve a bin (by qr_token OR typed code) then load every lot in it.
  // READ-ONLY: two SELECTs, no writes.
  const resolveAndLoad = useCallback(
    async (key: { qrToken: string } | { code: string }) => {
      setBusy(true);
      setError(null);
      // Lock the scanner while we resolve + show results so it doesn't re-fire.
      scanLockRef.current = true;
      try {
        // 1) Resolve the bin. RLS scopes `bins` to the operator's warehouses.
        let query = supabase.from('bins').select('id, code, warehouse_id');
        // Codes are only unique WITHIN a warehouse, so a code lookup must be
        // scoped. A QR token is globally unique, so leave that path alone —
        // scanning a bin in the other building should still resolve (and the
        // mismatch warning below tells the worker what happened).
        if (activeWarehouse && 'code' in key) {
          query = query.eq('warehouse_id', activeWarehouse.id);
        }
        const { data: binRow, error: binErr } =
          'qrToken' in key
            ? await query.eq('qr_token', key.qrToken).maybeSingle()
            : await query.eq('code', key.code).maybeSingle();

        if (binErr) throw binErr;
        if (!binRow) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setError({
            title: 'Bin not found',
            detail:
              'code' in key
                ? activeWarehouse
                  ? `No bin "${key.code}" at ${activeWarehouse.name}. Check the label, or switch location if you're at a different building.`
                  : `No bin "${key.code}" exists for your operator. Check the bin label and try again.`
                : 'This QR does not match any known bin for your operator.',
          });
          // Allow an immediate re-scan of a different bin.
          scanLockRef.current = false;
          return;
        }

        const resolvedBin = binRow as ResolvedBin;

        // 2) Load the lots still PHYSICALLY in this bin (mig 0334).
        //    intake_bin_id is the FK lots → bins, set at put-away and never
        //    cleared — a relist even copies it onto the new lot. So an
        //    unfiltered read accumulates every lot ever intaked here, including
        //    ones long gone ("38 shown, ~10 on the shelf", 2026-07-08).
        //
        //    Filtering by status alone was the first fix and it is necessary but
        //    NOT sufficient, because a lineage shares ONE box across several
        //    rows. So the list comes from bin_present_lots() rather than a raw
        //    select. RLS still scopes `lots` to the operator — the function is
        //    SECURITY INVOKER. READ-ONLY.
        //
        // A relist never moves the box: the child inherits intake_bin_id and the
        // printed label, so parent and child both matched PRESENT_STATUSES and
        // the same box listed twice under one display_code. And when the child
        // later sold and was collected, the parent kept status='relisted' and
        // its bin forever — nothing clears it. A physical audit of Cage-01-01
        // (2026-08-26) put numbers on it: this screen said 19, the shelf held
        // 16, and the three extras were parents whose children were collected
        // by buyers in July and early August. Warehouse-wide that was 1,742
        // phantom rows across 264 bins. The RPC keeps one row per box and drops
        // a parent only when a descendant already represents it or it has left.
        const { data: lotData, error: lotErr } = await supabase.rpc('bin_present_lots', {
          p_bin_id: resolvedBin.id,
        });

        if (lotErr) throw lotErr;

        const rows = (lotData ?? []) as unknown as Array<{
          id: string;
          lot_code: string;
          sticker_code: string | null;
          display_code: string | null;
          title: string;
          status: string;
          auction_id: string | null;
        }>;

        // The RPC returns lot columns only; fetch the auction labels for the
        // handful of ids it came back with rather than embedding (a set-returning
        // function has no PostgREST relationships to embed through).
        const auctionIds = Array.from(
          new Set(rows.map((r) => r.auction_id).filter((x): x is string => !!x)),
        );
        const auctionById = new Map<string, { title: string; status: string }>();
        if (auctionIds.length > 0) {
          const { data: auctionRows } = await supabase
            .from('auctions')
            .select('id, title, status')
            .in('id', auctionIds);
          for (const a of (auctionRows ?? []) as Array<{
            id: string;
            title: string;
            status: string;
          }>) {
            auctionById.set(a.id, { title: a.title, status: a.status });
          }
        }

        const mapped: LotRow[] = rows.map((r) => {
          const a = r.auction_id ? auctionById.get(r.auction_id) ?? null : null;
          return {
            id: r.id,
            lot_code: r.lot_code,
            sticker_code: r.sticker_code,
            display_code: r.display_code,
            title: r.title,
            status: r.status,
            auction_id: r.auction_id,
            auction_title: a?.title ?? null,
            auction_status: a?.status ?? null,
          };
        });

        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setBin(resolvedBin);
        setLots(mapped);
        setManualCode('');
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError({ title: 'Lookup failed', detail: (err as Error).message });
        scanLockRef.current = false;
      } finally {
        setBusy(false);
      }
    },
    // activeWarehouse scopes the code lookup, and WarehouseContext hydrates from
    // AsyncStorage asynchronously — without it in the deps this callback would
    // capture a null warehouse on first render and keep resolving codes
    // operator-wide for the rest of the session.
    [activeWarehouse],
  );

  function reset() {
    setBin(null);
    setLots(null);
    setManualCode('');
    setError(null);
    // Clear scan guards so the next bin scans immediately.
    scanLockRef.current = false;
    lastScanRef.current = null;
  }

  if (role.kind !== 'staff') return null;

  if (!hasPermission) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 12 }}>
          Camera access is required to scan a bin QR. You can also type a bin
          code instead.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 14, backgroundColor: colors.primary, borderRadius: 8 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900' }}>
            Allow camera
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
      <ScrollView
        testID="bin-lookup-screen"
        contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
          {bin ? 'bin contents' : 'scan or type a bin code'}
        </Text>
        <Text
          style={{
            color: colors.text,
            fontSize: 26,
            ...type.displayHero,
            marginTop: 4,
            marginBottom: 8,
          }}
        >
          Bin lookup
        </Text>

        {!bin && (
          <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
            Scan a bin&apos;s QR — or type its code — to see every lot currently
            stored in it. Read-only; nothing is moved or changed.
          </Text>
        )}

        {/* Persistent error banner (mirrors put-away/single.tsx). */}
        {error && (
          <View
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.danger,
              backgroundColor: colors.dangerDim,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '900' }}>
              {error.title}
            </Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 }}>
              {error.detail}
            </Text>
            <Pressable onPress={() => setError(null)} hitSlop={10} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>
                Dismiss
              </Text>
            </Pressable>
          </View>
        )}

        {/* ── Lookup mode: camera + manual entry ── */}
        {!bin && (
          <>
            {device && (
              <View style={s.cameraBox}>
                <Camera
                  ref={cameraRef}
                  style={{ flex: 1 }}
                  device={device}
                  isActive={cameraGate && (!bin && !busy)}
                  codeScanner={binScanner}
                />
                <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
                {focus.indicator}
                {busy && (
                  <View style={s.cameraBusy}>
                    <ActivityIndicator color={colors.primary} />
                  </View>
                )}
              </View>
            )}

            <Text
              style={{
                color: colors.textMuted,
                fontSize: 12,
                marginTop: 12,
                marginBottom: 6,
              }}
            >
              Or type a bin code:
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={manualCode}
                onChangeText={setManualCode}
                placeholder="BIN-000047"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
                style={{
                  flex: 1,
                  padding: 12,
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 10,
                  color: colors.text,
                  fontSize: 16,
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                }}
                returnKeyType="search"
                onSubmitEditing={() => manualCode.trim() && submitManualCode()}
              />
              <Pressable
                onPress={() => manualCode.trim() && submitManualCode()}
                disabled={!manualCode.trim() || busy}
                style={{
                  paddingHorizontal: 18,
                  justifyContent: 'center',
                  backgroundColor: colors.primary,
                  borderRadius: 10,
                  opacity: !manualCode.trim() || busy ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#000', fontWeight: '900' }}>Look up</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ── Results mode: bin header + lot list ── */}
        {bin && lots && (
          <>
            <View style={s.binHeader}>
              <View style={{ flex: 1 }}>
                <Text style={s.binCode}>{bin.code}</Text>
                <Text style={s.binCount}>
                  {lots.length === 0
                    ? 'No inventory'
                    : `${lots.length} ${lots.length === 1 ? 'lot' : 'lots'}`}
                </Text>
              </View>
              <Pressable onPress={reset} style={s.scanAgainBtn} hitSlop={10}>
                <Text style={s.scanAgainText}>Scan another bin</Text>
              </Pressable>
            </View>

            {lots.length === 0 ? (
              <View style={s.emptyBox}>
                <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 14 }}>
                  No inventory in this bin.
                </Text>
              </View>
            ) : (
              <View style={{ gap: 10, marginTop: 14 }}>
                {lots.map((l) => (
                  <View key={l.id} style={s.lotCard}>
                    <Text style={s.lotCode}>
                      {lotDisplayCode({ sticker_code: l.sticker_code, lot_code: l.lot_code, display_code: l.display_code }) ??
                        l.lot_code}
                    </Text>
                    <Text style={s.lotTitle} numberOfLines={2}>
                      {l.title}
                    </Text>
                    <View style={s.badgeRow}>
                      {/* Lot status badge */}
                      <View style={s.badge}>
                        <Text style={s.badgeText}>{lotStatusLabel(l.status)}</Text>
                      </View>
                      {/* Auction badge — title + status, or "not in an auction" */}
                      {l.auction_id && l.auction_title ? (
                        <View style={[s.badge, s.auctionBadge]}>
                          <Text style={[s.badgeText, { color: colors.primary }]} numberOfLines={1}>
                            {l.auction_title}
                            {l.auction_status ? ` · ${l.auction_status}` : ''}
                          </Text>
                        </View>
                      ) : (
                        <Text style={s.noAuction}>— not in an auction</Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  cameraBox: {
    height: 320,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 12,
  },
  cameraBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  binHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  binCode: {
    color: colors.primary,
    fontSize: 20,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  binCount: { color: colors.textMuted, fontSize: 13, marginTop: 2, fontWeight: '700' },
  scanAgainBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  scanAgainText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  emptyBox: {
    marginTop: 24,
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  lotCard: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lotCode: {
    color: colors.primary,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '900',
  },
  lotTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.border,
  },
  auctionBadge: {
    backgroundColor: colors.primaryDim,
    maxWidth: '70%',
  },
  badgeText: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
  noAuction: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
});
