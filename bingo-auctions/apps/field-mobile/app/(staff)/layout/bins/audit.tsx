// Bin Audit — reconcile a bin's PHYSICAL contents against what the system says.
//
// Pickup-day recap 2026-07-08 (owner clarification): won items are turning up
// in the wrong bin (recorded 13-4-1, physically 13-10-1, etc.). When a customer
// can't find an item, staff need to verify in minutes whether it is truly
// missing, in the wrong bin, never put away, mis-recorded, or the bin just has
// extra/misplaced stock. Bin lookup shows what SHOULD be here; this screen adds
// the reconcile: scan the items actually in the bin and get a live
// present / missing / misplaced breakdown.
//
// "Expected" = union of (a) lots staged for pickup in this bin
// (bin_assignments status='staged') and (b) lots stored here
// (lots.intake_bin_id) that can still be on a shelf. As each physical item is
// scanned it checks off; a scan that isn't expected here is flagged "misplaced"
// with where the system thinks it belongs.
//
// READ-ONLY: no inserts/updates. Staff physically move items and re-audit, or
// use put-away to correct a location. (One-tap correction is a planned follow-up.)

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
import { Camera, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import * as Haptics from 'expo-haptics';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { ALL_RETAIL_CODE_TYPES, firstCodeValue } from '@/lib/vision-camera';
import { resolveLotScan, type ScanRow } from '@/lib/resolve-lot-scan';
import { resolveTypedBin } from '@/lib/typed-bin-lookup';
import { useWarehouse } from '@/features/location/WarehouseContext';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function extractToken(raw: string): string | null {
  const t = raw.trim();
  const m = t.match(UUID_RE) ?? t.match(/([0-9a-f-]{36})/i);
  return m && UUID_RE.test(m[0]) ? m[0] : null;
}

type BinRef = { code: string | null; aisle: string | null; bay: string | null };
type ResolvedBin = { id: string; code: string };

type ExpectedLot = {
  id: string;
  qr_token: string | null;
  lot_code: string;
  sticker_code: string | null;
  /** Computed column (mig 0315): the label actually printed on the box. */
  display_code: string | null;
  title: string;
  status: string;
  source: 'staged' | 'intake';
};

type ExtraLot = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  /** Computed column (mig 0315): the label actually printed on the box. */
  display_code: string | null;
  title: string;
  belongs: string; // where the system says it should be
};

function toBinRef(rel: unknown): BinRef | null {
  const n = Array.isArray(rel) ? rel[0] : rel;
  if (n && typeof n === 'object') {
    const b = n as { code?: string | null; aisle?: string | null; bay?: string | null };
    return { code: b.code ?? null, aisle: b.aisle ?? null, bay: b.bay ?? null };
  }
  return null;
}

function formatLocation(b: BinRef | null): string {
  if (!b) return 'no location on file';
  const parts: string[] = [];
  if (b.aisle) parts.push(`Aisle ${b.aisle}`);
  if (b.bay) parts.push(`Bay ${b.bay}`);
  if (parts.length === 0 && b.code) return b.code;
  return b.code ? `${parts.join(', ')} (${b.code})` : parts.join(', ');
}

export default function BinAuditScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const role = useOperatorRole();
  const device = useBackCamera();
  const cameraRef = useRef<Camera | null>(null);
  const focus = useTapToFocus(cameraRef);

  const [bin, setBin] = useState<ResolvedBin | null>(null);
  const [expected, setExpected] = useState<ExpectedLot[]>([]);
  const [foundIds, setFoundIds] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<ExtraLot[]>([]);
  const [corrected, setCorrected] = useState<ExtraLot[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ExpectedLot[]>([]);
  const [relocatingId, setRelocatingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualCode, setManualCode] = useState('');
  // Manual lot-code entry during the audit (barcode damaged / unreadable).
  const [manualLotCode, setManualLotCode] = useState('');
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  // Typed bin codes are scoped to the active location (codes repeat across locations).
  const { warehouse: activeWarehouse, available: warehouses } = useWarehouse();

  // Bin scan is locked once resolved; item scans stay open (many per bin) with
  // per-value dedup so a held QR doesn't re-fire every frame.
  const binLockRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const processedRef = useRef<Set<string>>(new Set()); // raw values already handled
  const SCAN_DEDUP_MS = 1500;

  const loadBin = useCallback(async (key: { qrToken: string } | { code: string }) => {
    setBusy(true);
    setError(null);
    binLockRef.current = true;
    try {
      let binRow: unknown = null;
      if ('qrToken' in key) {
        const { data, error: binErr } = await supabase.from('bins').select('id, code').eq('qr_token', key.qrToken).maybeSingle();
        if (binErr) throw binErr;
        binRow = data;
      } else {
        // Codes repeat across warehouses (every location uses 1-01-01, ...):
        // scope a typed code to the active location and to active, unretired
        // bins. maybeSingle() on an unscoped code failed for shared codes.
        let q = supabase
          .from('bins')
          .select('id, code, warehouse_id')
          .eq('code', key.code)
          .eq('is_active', true)
          .is('retired_at', null);
        if (activeWarehouse) q = q.eq('warehouse_id', activeWarehouse.id);
        const { data, error: binErr } = await q.limit(10);
        if (binErr) throw binErr;
        const resolved = resolveTypedBin(
          (data ?? []) as Array<{ id: string; code: string; warehouse_id: string | null }>,
          key.code,
          activeWarehouse?.name ?? null,
          new Map(warehouses.map((w) => [w.id, w.name])),
        );
        if (resolved.kind !== 'one') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setError({ title: resolved.title, detail: resolved.detail });
          binLockRef.current = false;
          return;
        }
        binRow = resolved.bin;
      }
      if (!binRow) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setError({ title: 'Bin not found', detail: 'No bin matched that QR/code for your operator.' });
        binLockRef.current = false;
        return;
      }
      const rb = binRow as ResolvedBin;

      const [{ data: stagedRows }, { data: intakeRows }] = await Promise.all([
        supabase
          .from('bin_assignments')
          .select('lots(id, qr_token, lot_code, sticker_code, display_code, title, status)')
          .eq('bin_id', rb.id)
          .eq('status', 'staged'),
        // 0334: same source as Bin Lookup, so the two screens cannot disagree
        // about what should be on a shelf. This used to be a status-filtered
        // select that excluded 'relisted' outright — which hid 1,551 boxes whose
        // only shelf record is a relist parent, so scanning one read as
        // "unexpected". Bin Lookup meanwhile INCLUDED every relisted parent,
        // phantoms and all. Cage-01-01 (2026-08-26) showed both errors at once:
        // lookup said 19, audit expected 16, the shelf held 16.
        supabase.rpc('bin_present_lots', { p_bin_id: rb.id }),
      ]);

      const byId = new Map<string, ExpectedLot>();
      for (const r of (stagedRows ?? []) as Array<{ lots: unknown }>) {
        const l = (Array.isArray(r.lots) ? r.lots[0] : r.lots) as ExpectedLot | null;
        if (l?.id) byId.set(l.id, { ...l, source: 'staged' });
      }
      for (const l of (intakeRows ?? []) as ExpectedLot[]) {
        if (l.id && !byId.has(l.id)) byId.set(l.id, { ...l, source: 'intake' });
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setBin(rb);
      setExpected(Array.from(byId.values()));
      setFoundIds(new Set());
      setExtras([]);
      setRemoved([]);
      processedRef.current = new Set();
      setManualCode('');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError({ title: 'Lookup failed', detail: (err as Error).message });
      binLockRef.current = false;
    } finally {
      setBusy(false);
    }
  }, [activeWarehouse, warehouses]);

  // Resolve a scanned item against the expected set; if unknown, look it up and
  // record it as misplaced with where it actually belongs.
  const scanItem = useCallback(
    async (raw: string): Promise<'found' | 'misplaced' | 'not_found' | 'error'> => {
      const token = extractToken(raw);
      const code = raw.trim();

      // Match locally against expected (qr_token, lot_code, or sticker_code).
      // sticker_code is stored operator-prefixed ("OP:BRN123" — mig 0185); a
      // scanned sticker barcode reads just "BRN123", so match the suffix too.
      const hit = expected.find(
        (e) =>
          (token && e.qr_token === token) ||
          e.lot_code === code ||
          (e.sticker_code !== null &&
            (e.sticker_code === code || e.sticker_code.endsWith(`:${code}`))),
      );
      if (hit) {
        setFoundIds((prev) => {
          if (prev.has(hit.id)) return prev;
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          const next = new Set(prev);
          next.add(hit.id);
          return next;
        });
        return 'found';
      }

      // Unknown here → resolve the lot + where it belongs (misplaced/extra).
      try {
        // Was a first-hit ladder (qr_token → lot_code → sticker_code →
        // suffix), each probe `.maybeSingle()`. For a relisted item the box's
        // label is the retired parent's lot_code AND the live child's sticker,
        // so `lot_code` at step 2 won and the audit reported the tombstone's
        // stale bin as where the item belongs — marking a correctly-shelved box
        // misplaced. `resolveLotScan` gathers every match and prefers the live
        // incarnation.
        const SEL =
          'qr_token, title, intake_bin:bins!lots_intake_bin_id_fkey(code, aisle, bay)';
        const resolved = await resolveLotScan<ScanRow & Record<string, unknown>>(
          token ?? code,
          SEL,
        );
        const row = resolved?.lot ?? null;
        if (!row) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return 'not_found'; // no lot with this code/QR exists
        }
        const lotId = row.id as string;
        // Where the system thinks it is: staged bin first, else intake shelf.
        const { data: asg } = await supabase
          .from('bin_assignments')
          .select('bins(code, aisle, bay)')
          .eq('lot_id', lotId)
          .eq('status', 'staged')
          .order('assigned_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const belongsBin = asg ? toBinRef((asg as { bins?: unknown }).bins) : toBinRef(row.intake_bin);

        // NOT misplaced if the system already says it belongs in the bin we're
        // auditing. The expected set (bin_present_lots, 0334) excludes lots past
        // inventory state (won / unsold / disposed), but such an item can still
        // be physically on THIS shelf — location is independent of auction/sold
        // status (same principle as put-away mig 0273). Without this, those
        // items were flagged "misplaced → Move to <the same bin>" (bug 2026-07-17).
        // Fold it into the expected/found sets so it reads as accounted-for.
        if (bin && belongsBin?.code && belongsBin.code === bin.code) {
          const lot: ExpectedLot = {
            id: lotId,
            qr_token: (row.qr_token as string | null) ?? null,
            lot_code: row.lot_code as string,
            sticker_code: (row.sticker_code as string | null) ?? null,
            display_code: (row.display_code as string | null) ?? null,
            title: row.title as string,
            status: (row.status as string | null) ?? '',
            source: 'intake',
          };
          setExpected((prev) => (prev.some((e) => e.id === lotId) ? prev : [...prev, lot]));
          setFoundIds((prev) => {
            if (prev.has(lotId)) return prev;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            const next = new Set(prev);
            next.add(lotId);
            return next;
          });
          return 'found';
        }

        setExtras((prev) => {
          if (prev.some((x) => x.id === lotId)) return prev;
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return [
            ...prev,
            {
              id: lotId,
              lot_code: row!.lot_code as string,
              display_code: (row!.display_code as string | null) ?? null,
              sticker_code: (row!.sticker_code as string | null) ?? null,
              title: row!.title as string,
              belongs: formatLocation(belongsBin),
            },
          ];
        });
        return 'misplaced';
      } catch {
        return 'error'; // transient lookup failure
      }
    },
    [expected, bin],
  );

  // Tester recap 2026-07-09 §1: "camera would not scan any items". The BRN/
  // PNK/TEA pre-sticker rolls print 1D barcodes (Code-128/39), not QR — the
  // audit was QR-only, so pointing at a sticker decoded nothing. Scan the
  // same full set lotting uses; non-lot codes (product UPCs) resolve to no
  // lot and are ignored.
  const scanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      if (busy) return;
      const c = firstCodeValue(codes);
      if (!c) return;
      const nowMs = Date.now();
      const prev = lastScanRef.current;
      if (prev && prev.value === c.data && nowMs - prev.at < SCAN_DEDUP_MS) return;
      lastScanRef.current = { value: c.data, at: nowMs };

      if (!bin) {
        if (binLockRef.current) return;
        const token = extractToken(c.data);
        if (token) void loadBin({ qrToken: token });
        return;
      }
      // Audit mode: process each distinct raw value once.
      if (processedRef.current.has(c.data)) return;
      processedRef.current.add(c.data);
      void scanItem(c.data);
    },
  });

  function onBinManual() {
    const code = manualCode.trim();
    if (code) void loadBin({ code });
  }

  // Manual lot-code entry during the audit — for when a lot's barcode is
  // damaged/unreadable (owner request 2026-07-15). Resolves the typed code the
  // same way a scan would (found here / misplaced / doesn't exist) and shows a
  // clear "Lot does not exist" error when nothing matches so staff know the
  // item needs relabeling, re-lotting, or removal.
  async function onLotManual() {
    const code = manualLotCode.trim();
    if (!code || busy) return;
    setError(null);
    const result = await scanItem(code);
    if (result === 'not_found') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError({
        title: 'Lot does not exist',
        detail: `No lot matches "${code}". Investigate the item — it may need to be relabeled, re-lotted, or removed from the bin.`,
      });
    } else {
      // found / misplaced / (transient) error — the list updated; clear input.
      setManualLotCode('');
    }
  }

  // One-tap correction: record the misplaced lot as belonging to THIS bin.
  // Location-only (audit_relocate_lot) — never touches the auction or invoice.
  const moveHere = useCallback(
    async (x: ExtraLot) => {
      if (!bin) return;
      setRelocatingId(x.id);
      try {
        const { error: rpcErr } = await supabase.rpc('audit_relocate_lot', {
          p_lot_id: x.id,
          p_bin_id: bin.id,
        });
        if (rpcErr) throw rpcErr;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setExtras((prev) => prev.filter((e) => e.id !== x.id));
        setCorrected((prev) => (prev.some((c) => c.id === x.id) ? prev : [...prev, x]));
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError({ title: 'Move failed', detail: (err as Error).message });
      } finally {
        setRelocatingId(null);
      }
    },
    [bin],
  );

  // #8 (2026-07-21): "not here". The audit shows this item stored in the bin,
  // but it's physically absent — clear its shelf location (audit_remove_lot) so
  // it stops showing here and is flagged unlocated (found via Lot Lookup with no
  // location) for follow-up. Staged-for-pickup items are refused server-side (a
  // pickup-flow problem, not shelf inventory).
  const removeFromBin = useCallback(
    async (e: ExpectedLot) => {
      if (!bin) return;
      setRemovingId(e.id);
      try {
        const { data, error: rpcErr } = await supabase.rpc('audit_remove_lot', {
          p_lot_id: e.id,
          p_bin_id: bin.id,
        });
        if (rpcErr) throw rpcErr;
        const res = data as { ok?: boolean; reason?: string } | null;
        if (!res?.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setError({
            title: "Couldn't remove",
            detail:
              res?.reason === 'staged_for_pickup'
                ? 'This item is staged for a customer pickup — handle it from the pickup flow, not the shelf audit.'
                : 'This item is no longer recorded in this bin.',
          });
          return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setExpected((prev) => prev.filter((x) => x.id !== e.id));
        setRemoved((prev) => (prev.some((r) => r.id === e.id) ? prev : [...prev, e]));
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError({ title: 'Remove failed', detail: (err as Error).message });
      } finally {
        setRemovingId(null);
      }
    },
    [bin],
  );

  function reset() {
    setBin(null);
    setExpected([]);
    setFoundIds(new Set());
    setExtras([]);
    setCorrected([]);
    setRemoved([]);
    setError(null);
    setManualCode('');
    setManualLotCode('');
    binLockRef.current = false;
    lastScanRef.current = null;
    processedRef.current = new Set();
  }

  if (role.kind !== 'staff') return null;

  if (!hasPermission) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 12 }}>
          Camera access is required to audit a bin. You can also type a bin code to start.
        </Text>
        <Pressable onPress={requestPermission} style={{ padding: 14, backgroundColor: colors.primary, borderRadius: 8 }}>
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900' }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const missing = expected.filter((e) => !foundIds.has(e.id));
  const foundCount = expected.length - missing.length;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
      <ScrollView
        testID="bin-audit-screen"
        contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
          {bin ? `auditing ${bin.code}` : 'scan or type a bin to audit'}
        </Text>
        <Text style={{ color: colors.text, fontSize: 26, ...type.displayHero, marginTop: 4, marginBottom: 8 }}>
          Bin audit
        </Text>

        {!bin && (
          <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
            Scan a bin — or type its code — then scan the items actually in it. You&apos;ll get a
            live list of what&apos;s present, what&apos;s missing, and anything misplaced (with where
            it belongs). Read-only.
          </Text>
        )}

        {error && (
          <View style={s.errorBox}>
            <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '900' }}>{error.title}</Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 }}>{error.detail}</Text>
            <Pressable onPress={() => setError(null)} hitSlop={10} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>Dismiss</Text>
            </Pressable>
          </View>
        )}

        {/* Camera stays active in both phases: resolve a bin, then scan items. */}
        {device && (
          <View style={s.cameraBox}>
            <Camera
              ref={cameraRef}
              style={{ flex: 1 }}
              device={device}
              isActive={cameraGate && (!busy)}
              codeScanner={scanner}
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

        {!bin && (
          <>
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              Or type a bin code:
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={manualCode}
                onChangeText={setManualCode}
                placeholder="13-4-1"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
                style={s.input}
                returnKeyType="search"
                onSubmitEditing={onBinManual}
              />
              <Pressable
                onPress={onBinManual}
                disabled={!manualCode.trim() || busy}
                style={[s.primaryBtn, { opacity: !manualCode.trim() || busy ? 0.5 : 1 }]}
              >
                <Text style={{ color: '#000', fontWeight: '900' }}>Audit</Text>
              </Pressable>
            </View>
          </>
        )}

        {bin && (
          <>
            <View style={s.tallyRow}>
              <Tally label="Found" value={`${foundCount}/${expected.length}`} tone="ok" />
              <Tally label="Missing" value={String(missing.length)} tone={missing.length ? 'warn' : 'muted'} />
              <Tally label="Misplaced" value={String(extras.length)} tone={extras.length ? 'bad' : 'muted'} />
              <Pressable onPress={reset} style={s.scanAgainBtn} hitSlop={10}>
                <Text style={s.scanAgainText}>New bin</Text>
              </Pressable>
            </View>
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 8 }}>
              Scan each item in the bin. Green = accounted for.
            </Text>

            {/* Manual lot-code entry — for a damaged/unreadable barcode. Types
                a lot or sticker code and resolves it exactly like a scan. */}
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              Barcode won&apos;t scan? Type the lot code:
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={manualLotCode}
                onChangeText={setManualLotCode}
                placeholder="e.g. BRN-000173"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
                style={s.input}
                returnKeyType="search"
                onSubmitEditing={onLotManual}
              />
              <Pressable
                onPress={onLotManual}
                disabled={!manualLotCode.trim() || busy}
                style={[s.primaryBtn, { opacity: !manualLotCode.trim() || busy ? 0.5 : 1 }]}
              >
                <Text style={{ color: '#000', fontWeight: '900' }}>Enter</Text>
              </Pressable>
            </View>

            {extras.length > 0 && (
              <Section title={`Misplaced — here but belong elsewhere (${extras.length})`}>
                {extras.map((x) => (
                  <View key={x.id} style={[s.lotCard, { borderColor: colors.danger }]}>
                    <Text style={s.lotCode}>
                      {lotDisplayCode({ sticker_code: x.sticker_code, lot_code: x.lot_code, display_code: x.display_code }) ?? x.lot_code}
                    </Text>
                    <Text style={s.lotTitle} numberOfLines={2}>{x.title}</Text>
                    <Text style={{ color: colors.danger, fontSize: 12, marginTop: 6, fontWeight: '700' }}>
                      Belongs in: {x.belongs}
                    </Text>
                    <Pressable
                      onPress={() => moveHere(x)}
                      disabled={relocatingId === x.id}
                      style={[s.moveBtn, { opacity: relocatingId === x.id ? 0.6 : 1 }]}
                    >
                      <Text style={s.moveBtnText}>
                        {relocatingId === x.id ? 'Moving…' : `Move to ${bin.code}`}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </Section>
            )}

            {corrected.length > 0 && (
              <Section title={`Moved to this bin (${corrected.length})`}>
                {corrected.map((x) => (
                  <View key={x.id} style={[s.lotCard, { borderColor: colors.primary }]}>
                    <Text style={s.lotCode}>
                      {lotDisplayCode({ sticker_code: x.sticker_code, lot_code: x.lot_code, display_code: x.display_code }) ?? x.lot_code}
                    </Text>
                    <Text style={s.lotTitle} numberOfLines={2}>{x.title}</Text>
                    <Text style={{ color: colors.primary, fontSize: 12, marginTop: 6, fontWeight: '800' }}>
                      ✓ Now recorded in {bin.code}
                    </Text>
                  </View>
                ))}
              </Section>
            )}

            {missing.length > 0 && (
              <Section title={`Not yet scanned (${missing.length})`}>
                {missing.map((e) => (
                  <View key={e.id} style={s.lotCard}>
                    <Text style={s.lotCode}>
                      {lotDisplayCode({ sticker_code: e.sticker_code, lot_code: e.lot_code, display_code: e.display_code }) ?? e.lot_code}
                    </Text>
                    <Text style={s.lotTitle} numberOfLines={2}>{e.title}</Text>
                    <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
                      {e.source === 'staged' ? 'staged for pickup' : 'stored here'}
                    </Text>
                    {e.source !== 'staged' && (
                      <Pressable
                        onPress={() => removeFromBin(e)}
                        disabled={removingId === e.id}
                        style={[s.removeBtn, { opacity: removingId === e.id ? 0.6 : 1 }]}
                      >
                        <Text style={s.removeBtnText}>
                          {removingId === e.id ? 'Removing…' : 'Not here — remove from bin'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </Section>
            )}

            {removed.length > 0 && (
              <Section title={`Removed from this bin (${removed.length})`}>
                {removed.map((x) => (
                  <View key={x.id} style={[s.lotCard, { borderColor: colors.textMuted }]}>
                    <Text style={s.lotCode}>
                      {lotDisplayCode({ sticker_code: x.sticker_code, lot_code: x.lot_code, display_code: x.display_code }) ?? x.lot_code}
                    </Text>
                    <Text style={s.lotTitle} numberOfLines={2}>{x.title}</Text>
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>
                      Location cleared — now unlocated
                    </Text>
                  </View>
                ))}
              </Section>
            )}

            {expected.length > 0 && missing.length === 0 && (
              <View style={[s.lotCard, { borderColor: colors.primary, marginTop: 14 }]}>
                <Text style={{ color: colors.primary, fontWeight: '900' }}>
                  ✓ All {expected.length} expected item{expected.length === 1 ? '' : 's'} accounted for.
                </Text>
              </View>
            )}
            {expected.length === 0 && (
              <View style={[s.lotCard, { marginTop: 14 }]}>
                <Text style={{ color: colors.textMuted }}>
                  The system shows nothing stored or staged in this bin. Anything you scan here will
                  be flagged as misplaced.
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Tally({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const color =
    tone === 'ok' ? colors.primary : tone === 'warn' ? '#f0b428' : tone === 'bad' ? colors.danger : colors.textMuted;
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ color, fontSize: 20, fontWeight: '900' }}>{value}</Text>
      <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 18 }}>
      <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '900', letterSpacing: 0.5, marginBottom: 8 }}>
        {title}
      </Text>
      <View style={{ gap: 10 }}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  cameraBox: { height: 300, borderRadius: 12, overflow: 'hidden', marginTop: 12 },
  cameraBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  errorBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerDim,
  },
  input: {
    flex: 1,
    padding: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  primaryBtn: { paddingHorizontal: 18, justifyContent: 'center', backgroundColor: colors.primary, borderRadius: 10 },
  tallyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scanAgainBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  scanAgainText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  lotCard: { padding: 14, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  lotCode: {
    color: colors.primary,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '900',
  },
  lotTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  moveBtn: {
    marginTop: 10,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  moveBtnText: { color: '#000', fontSize: 13, fontWeight: '900' },
  removeBtn: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.textMuted,
    alignItems: 'center',
  },
  removeBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: '800' },
});
