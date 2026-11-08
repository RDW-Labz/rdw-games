// Lot lookup — READ-ONLY "where is this item?" search.
//
// Pickup-day recap 2026-07-08: staff want to scan an item's lot QR and
// immediately see where it's SUPPOSED to be. Today the only screen that reads
// a lot's location is buried in the staging wizard. This is the mirror of
// Bin lookup (layout/bins/contents.tsx): scan a lot QR — or type a lot /
// sticker code — and see the item plus its current location.
//
// Location source of truth: a lot staged for pickup lives at its latest
// `bin_assignments` (status='staged') bin — that's the pickup location. If it
// hasn't been staged, it's on its intake shelf (lots.intake_bin_id). We show
// the staging bin when present (labeled "Pickup location") and otherwise the
// intake bin ("Stored in"), so staff are pointed at the right shelf.
//
// Still writes nothing itself. It now offers two things it used to withhold:
//
//   EDIT (2026-08-18, staff report): "We need to be able to edit an item from
//   lot look up. We can only edit it from inventory, but you can't find all the
//   items in the inventory on the table tablets." The edit screen already
//   exists at /worklist/[id]; the only thing missing was a way to reach it from
//   the one screen that can resolve ANY code. So this links there rather than
//   duplicating an editor — one save path, one set of rules.
//
//   LOCATION HISTORY (same report): "so many relisted items not being found in
//   the location it says they are in. It would be nice if it showed us every
//   location it's ever been on." A relist mints a NEW lots row, so the current
//   answer belongs to the newest generation while the box may still be sitting
//   where an older one put it. lot_location_history (mig 0328) walks the whole
//   relist chain and returns every shelf, newest first.
//
// Conventions mirror layout/bins/contents.tsx (camera, scan dedup, manual entry).

import { useRef, useState, useCallback } from 'react';
import { ownerPickupStatus } from '@/lib/owner-pickup-status';
import {
  View,
  Text,
  Image,
  Pressable,
  ActivityIndicator,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
} from 'react-native';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import * as Haptics from 'expo-haptics';
import { useRouter, type Href } from 'expo-router';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { ALL_RETAIL_CODE_TYPES, firstCodeValue, type DecodedCode } from '@/lib/vision-camera';
import { getActiveLottingWorkerId } from '@auction-platform/domain-lotting';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { CrossWarehouseWarning } from '@/features/location/CrossWarehouseWarning';
import { resolveLotScan, type ScanRow } from '@/lib/resolve-lot-scan';
import { colors, type } from '@auction-platform/design-system';
import { loadMissingMark, type MissingMark } from '@/lib/missing-mark';
import { refundedRelotTarget } from '@/lib/refunded-relot';

type BinRef = { code: string | null; aisle: string | null; bay: string | null };

/** One row of lot_location_history (mig 0328). */
type HistoryRow = {
  lot_id: string;
  lot_code: string;
  /** Null on a REMOVAL row: the RPC LEFT JOINs bins, and audit_remove_lot
   *  clears intake_bin_id, so the logged event carries no bin. */
  bin_code: string | null;
  kind: 'intake' | 'staged';
  occurred_at: string;
  is_current: boolean;
  source: 'logged' | 'derived';
};

/** Statuses /worklist/[id] will actually let staff edit — anything past an
 *  auction is console-only, and offering a button that refuses is worse than
 *  not offering one.
 *
 *  'draft' added 2026-08-20 (staff member): "when you are listing an item and you
 *  accidentally back out it puts it into the drafts and then it says it can't
 *  be changed from here." A draft is an unfinished listing — the state most
 *  in need of editing — and the detail screen has always been able to open
 *  one. Only this list said otherwise, and it said so with auction copy that
 *  did not even describe the situation. */
const EDITABLE_STATUSES = ['draft', 'pending_intake', 'in_inventory', 'unsold'];

/** Statuses this screen will offer Relot / Dispose / Bin Store for. Mirrors
 *  what relist_lot_into_auction accepts after 0353 — 'won' is included because
 *  a fully refunded sale is stock again, and the RPC re-checks that server-side
 *  (a lot still owed to a customer is refused there, not here). */
const RELOTTABLE_HERE = ['unsold', 'in_inventory', 'relisted', 'won'];

// Winning-customer / fulfillment context for a sold lot (staff_scan_lot_owner,
// mig 0257) — so Lot Lookup can answer "is this on a customer's Pickup Pass?"
// (Jared 2026-07-22, the same info the relot + checkout screens already show).
type OwnerInfo = {
  bidder_name: string | null;
  bidder_number: number | null;
  invoice_id: string | null;
  invoice_status: string | null;
  picked_up_at: string | null;
  refunded_at: string | null;
  pickup_status: string | null;
  pickup_completed_at?: string | null;
};

type ResolvedLot = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  /** Computed column (mig 0315): the label actually printed on the box. */
  display_code: string | null;
  title: string;
  status: string;
  photo_urls: string[] | null;
  auction_title: string | null;
  auction_status: string | null;
  // Who owns it + pickup state, when the lot is sold. Null otherwise.
  owner: OwnerInfo | null;
  // Where it is: staging bin (pickup) takes priority over intake shelf.
  location: BinRef | null;
  locationKind: 'staged' | 'intake' | 'none';
  /** Set only for a canceled/disposed lot: the shelf it was LAST recorded on.
   *  Never presented as a place to go — see the dead-lot notice below. */
  deadLotBin: BinRef | null;
  /** Set when the scanned label was a tombstone and lineage led to this row. */
  hoppedFrom: string | null;
  /** The building this box is stocked in, for the cross-location warning. */
  warehouse_id: string | null;
  /** PIN-identified person who lotted this box (0338). Null when none was
   *  stamped — pre-0281 lots and importer-created ones — which is an ordinary
   *  state, not a failure, so it simply renders nothing. */
  lottedBy: string | null;
  /** What it sold for last time, so staff can see the item's history without
   *  walking to a computer. */
  soldPriceCents: number | null;
  /** Set when this lot has already been relotted onto a live successor, so the
   *  screen can say "already handled, it lives on X" instead of offering a
   *  Relot button that mig 0275 will refuse. */
  relotChildCode: string | null;
  /** The successor's status, so the card can answer "has it already been put
   *  back in an auction?" and not just "has it been relotted?". */
  relotChildStatus: string | null;
  /** Marked missing and not found since (pickup outcome or 'missing' removal).
   *  Drives the red MARKED MISSING banner. */
  missingMark: MissingMark | null;
};

// Appended to SCAN_BASE_COLUMNS by `resolveLotScan` (which supplies id,
// lot_code, sticker_code, legacy_lot_code, status, created_at).
const LOT_SELECT =
  'title, photo_urls, intake_bin_id, intake_at, removal_kind, removed_at, removal_note, auction_id, current_bid_cents, intake_bin:bins!lots_intake_bin_id_fkey(code, aisle, bay), auctions(title, status)';

type FindRow = ScanRow & Record<string, unknown>;

function toBinRef(rel: unknown): BinRef | null {
  const node = Array.isArray(rel) ? rel[0] : rel;
  if (node && typeof node === 'object') {
    const n = node as { code?: string | null; aisle?: string | null; bay?: string | null };
    return { code: n.code ?? null, aisle: n.aisle ?? null, bay: n.bay ?? null };
  }
  return null;
}

function formatLocation(b: BinRef): string {
  const parts: string[] = [];
  if (b.aisle) parts.push(`Aisle ${b.aisle}`);
  if (b.bay) parts.push(`Bay ${b.bay}`);
  if (parts.length === 0 && b.code) return b.code;
  return b.code ? `${parts.join(', ')} (${b.code})` : parts.join(', ');
}

function lotStatusLabel(status: string): string {
  switch (status) {
    case 'pending_intake': return 'Pending intake';
    case 'in_inventory': return 'In inventory';
    case 'draft': return 'Draft';
    case 'scheduled': return 'Scheduled';
    case 'live': return 'Live';
    case 'won': return 'Won';
    case 'unsold': return 'Unsold';
    case 'canceled': return 'Canceled';
    case 'relisted': return 'Relisted';
    case 'disposed': return 'Disposed';
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export default function LotFindScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const role = useOperatorRole();
  const device = useBackCamera();
  const cameraRef = useRef<Camera | null>(null);
  const focus = useTapToFocus(cameraRef);

  const [lot, setLot] = useState<ResolvedLot | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // The most recent SHELF this box sat on (staging bins are a different thing).
  // lot_location_history returns newest first, so the first 'intake' row is it.
  // Used to tell "never put away" apart from "put away, then taken off a shelf"
  // — indistinguishable from intake_bin_id alone, which is null for both.
  const lastShelf = history.find((h) => h.kind === 'intake' && !!h.bin_code) ?? null;
  const router = useRouter();

  const [acting, setActing] = useState(false);
  const scanLockRef = useRef(false);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const SCAN_DEDUP_MS = 2500;

  const resolveLot = useCallback(async (rawOrToken: string) => {
    setBusy(true);
    setError(null);
    setHistory([]);
    setHistoryOpen(false);
    scanLockRef.current = true;
    try {
      // One shared resolver for every staff scanner (put-away, bin audit,
      // pickup verify, relot). It unwraps a QR URL, matches lot_code /
      // sticker_code / legacy_lot_code CASE-INSENSITIVELY — the local ladder
      // this replaced used a case-sensitive `.like('%:CODE')`, and 8 lots on
      // prod store a lowercase sticker_code, so a scanner emitting lowercase
      // matched nothing — ranks collisions (a legacy import lot and its
      // re-lotted twin both answer to one code), and walks
      // `relisted_from_lot_id` forward when the best match is a tombstone.
      const result = await resolveLotScan<FindRow>(rawOrToken, LOT_SELECT);
      const row = (result?.lot as Record<string, unknown> | undefined) ?? null;

      if (!row) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setError({
          title: 'Lot not found',
          detail: 'No lot matched that QR or code for your operator. Check the label and try again.',
        });
        scanLockRef.current = false;
        return;
      }

      const lotId = row.id as string;

      // Staging assignment (pickup location) — latest 'staged' row, if any.
      const { data: asgData } = await supabase
        .from('bin_assignments')
        .select('assigned_at, bins(code, aisle, bay)')
        .eq('lot_id', lotId)
        .eq('status', 'staged')
        .order('assigned_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const stagedBin = asgData ? toBinRef((asgData as { bins?: unknown }).bins) : null;
      const intakeBin = toBinRef(row.intake_bin);
      const auction = Array.isArray(row.auctions) ? row.auctions[0] : row.auctions;

      // A canceled or disposed lot is not on a shelf, whatever intake_bin_id
      // still says.
      //
      // Reported 2026-08-28 (staff report): "Tea3822650 shows as a duplicate/
      // ghost … the item is disposed but still shows … if you physically
      // checked the location and it is not there."
      //
      // Bin Lookup and Bin Audit are already clean — bin_present_lots (0334)
      // returns zero canceled and zero disposed rows across every bin. This
      // screen was the leak: it read intake_bin with no regard for status, so
      // scanning a dead box answered "STORED IN 1-18-01" and sent someone to a
      // shelf the item left. 694 lots are in that state (570 canceled, 124
      // disposed) — they keep intake_bin_id because nothing clears it when a
      // lot dies, and clearing it in the database would destroy the only
      // record of where the box was last seen.
      //
      // So the row keeps its history and this screen stops asserting presence:
      // the shelf still gets named below, as "last recorded", never as "go
      // here". Same distinction #283 drew between "never put away" and "taken
      // off a shelf" — the data was right, the sentence was wrong.
      const isDeadLot = row.status === 'canceled' || row.status === 'disposed';

      const location = isDeadLot ? null : (stagedBin ?? intakeBin);
      const locationKind: ResolvedLot['locationKind'] = isDeadLot
        ? 'none'
        : stagedBin
          ? 'staged'
          : intakeBin
            ? 'intake'
            : 'none';
      // Where it was last recorded, kept only to show under the dead-lot
      // notice. lot_location_events only starts 2026-08-19, so for an older
      // a box created in May: intake_bin is the ONLY surviving
      // record — falling back to `lastShelf` alone would print the
      // "may not be put away yet" hint, which is the exact wrong sentence.
      const deadLotBin = isDeadLot ? (stagedBin ?? intakeBin) : null;

      // Sold-item context (Jared 2026-07-22): when the lot is won, resolve WHO
      // owns it + invoice + pickup state via the shared staff_scan_lot_owner
      // RPC. We pass the RESOLVED lot's own lot_code first — for a re-lotted
      // BIN-#### lot that's globally unique, so the RPC's scan ladder
      // re-resolves to THIS lot, never back to a stale legacy twin.
      let owner: OwnerInfo | null = null;
      if ((row.status as string) === 'won') {
        const { data: ownerRes } = await supabase.rpc('staff_scan_lot_owner', {
          p_candidates: [row.lot_code, row.sticker_code].filter(Boolean) as string[],
        });
        const parsed = ownerRes as { ok?: boolean; owner?: OwnerInfo | null } | null;
        if (parsed?.ok && parsed.owner) owner = parsed.owner;
      }

      // Has this box already been dealt with? A relot mints a NEW lots row and
      // leaves this one behind, so a refunded item that somebody already put
      // back to work still looks untouched from here. Without this the screen
      // would offer a Relot button that mig 0275's one-active-lot guard then
      // refuses, which reads as the app being broken rather than the job being
      // done. Same liveness set 0329 uses when it decides that very question.
      const { data: childRow } = await supabase
        .from('lots')
        .select('lot_code, status')
        .eq('relisted_from_lot_id', lotId)
        .is('deleted_at', null)
        .in('status', ['draft', 'scheduled', 'live', 'in_inventory', 'won'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const relotChildCode = (childRow as { lot_code?: string } | null)?.lot_code ?? null;
      const relotChildStatus = (childRow as { status?: string } | null)?.status ?? null;

      // Marked missing? Same rule as mig 0345 (and the Auction Builder): the
      // latest 'missing' pickup outcome with no put-away since, or a 'missing'
      // removal. A failed read just means no banner, never a failed lookup.
      const missingMark = await loadMissingMark(supabase, lotId, row).catch(() => null);

      // Who lotted it (0338). Requested 2026-08-26 (staff member): "It would be
      // nice to have each lot show what lotter lotted it." Deliberately NOT
      // lots.lotted_by — that is the shared station account the tablet signs
      // in as, so it would name the same device for every lot. The RPC reads
      // the PIN-identified worker and returns only their name; `workers` is
      // RLS-closed because the row also carries pin_hash.
      const { data: lotterRes } = await supabase.rpc('lot_lotter_name', {
        p_lot_id: lotId,
      });
      const lottedBy =
        typeof lotterRes === 'string' && lotterRes.trim() ? lotterRes.trim() : null;

      // Every shelf this box has been on, across the relist chain (0328).
      // Fetched with the result rather than on demand: it is one small RPC and
      // the whole point is that it is there the moment the current location
      // looks wrong — a second tap to find out is a second chance to give up.
      const { data: histData, error: histErr } = await supabase.rpc(
        'lot_location_history',
        { p_lot_id: lotId },
      );
      if (histErr) {
        // Non-fatal. The lookup itself succeeded, and a missing history is a
        // smaller loss than an error screen over the answer they came for.
        setHistory([]);
      } else {
        const rows = (histData ?? []) as HistoryRow[];
        setHistory(rows);
        // Collapsed is right when the location above IS the answer. When there
        // is no current location but the box has been on a shelf, the answer is
        // in here — so open it rather than making them find the toggle.
        if (
          locationKind === 'none' &&
          rows.some((h) => h.kind === 'intake' && !!h.bin_code)
        ) {
          setHistoryOpen(true);
        }
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLot({
        id: lotId,
        lot_code: row.lot_code as string,
        sticker_code: (row.sticker_code as string | null) ?? null,
        display_code: (row.display_code as string | null) ?? null,
        title: row.title as string,
        status: row.status as string,
        photo_urls: (row.photo_urls as string[] | null) ?? null,
        auction_title: (auction as { title?: string } | null)?.title ?? null,
        auction_status: (auction as { status?: string } | null)?.status ?? null,
        owner,
        location,
        locationKind,
        deadLotBin,
        hoppedFrom: result?.hoppedFrom ?? null,
        warehouse_id: (row.warehouse_id as string | null) ?? null,
        lottedBy,
        soldPriceCents: (row.current_bid_cents as number | null) ?? null,
        relotChildCode,
        relotChildStatus,
        missingMark,
      });
      setManualCode('');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError({ title: 'Lookup failed', detail: (err as Error).message });
      scanLockRef.current = false;
    } finally {
      setBusy(false);
    }
  }, []);

  // ── Refunded stock that nobody has dealt with ────────────────────────────
  //
  // Owner, 2026-09-10: "When a customer receives a refund, the physical item is
  // returned to its assigned warehouse bin. Because it is physically in the
  // correct bin, the bin audit says it is where it is supposed to be. However,
  // the system does not alert employees that the refunded item is still sitting
  // there and has never been relotted or otherwise handled. The problem is not
  // that the item is missing or stored in the wrong bin. The problem is that
  // the system considers it accounted for even though it still needs action."
  //
  // He is right, and it is not a handful: 853 refunded lots are still in status
  // 'won', 847 of them occupying a bin, averaging 30 days and oldest 69. Four
  // have ever been relotted. Nothing surfaces them because 'won' reads as sold,
  // so no unsold sweep and no report reaches them — and a bin audit calls them
  // correct, because they ARE in the right bin. This banner is the alert that
  // was missing, on the one screen staff already scan at the shelf.
  const needsAction =
    lot !== null &&
    lot.status === 'won' &&
    !!lot.owner?.refunded_at &&
    lot.relotChildCode === null &&
    // A missing item cannot be relotted (0345); its own banner says what to do.
    lot.missingMark === null;

  const daysSinceRefund =
    lot?.owner?.refunded_at != null
      ? Math.floor((Date.now() - new Date(lot.owner.refunded_at).getTime()) / 86_400_000)
      : null;

  // remove_lot_from_inventory is admin/manager only, and RLS answers a picker
  // with a refusal rather than an error. Better to say so up front than to show
  // a button that fails after they have already carried the item somewhere.
  const canRemove = role.kind === 'staff' && (role.role === 'admin' || role.role === 'manager');

  // 0475 refunded status: the item is back in stock but must go through
  // relist_refunded_lot() (manager PIN + audit). Route to the existing form
  // instead of showing a dead-end "can't be relotted from here".
  const refundedRelot = lot
    ? refundedRelotTarget({
        status: lot.status,
        lotCode: lot.lot_code,
        relotChildCode: lot.relotChildCode,
      })
    : null;

  const runRemoval = useCallback(
    async (kind: 'destroyed' | 'bin_store', label: string) => {
      if (!lot) return;
      setActing(true);
      try {
        const { data, error: rpcErr } = await supabase.rpc('remove_lot_from_inventory', {
          p_lot_id: lot.id,
          p_kind: kind,
          p_note: `From Lot Lookup on the handheld — ${label}.`,
        });
        if (rpcErr) throw new Error(rpcErr.message);
        const res = (data ?? {}) as { ok?: boolean; reason?: string };
        if (res.ok === false) {
          const reason = res.reason ?? 'could not remove this item';
          throw new Error(
            reason.startsWith('already_removed_as_')
              ? `Already removed as "${reason.replace('already_removed_as_', '')}". That cannot be changed.`
              : reason.replace(/_/g, ' '),
          );
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(label, `${lot.display_code ?? lot.lot_code} is out of inventory.`);
        void resolveLot(lot.lot_code);
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(`Could not ${label.toLowerCase()}`, (err as Error).message);
      } finally {
        setActing(false);
      }
    },
    [lot, resolveLot],
  );

  const runRelot = useCallback(async () => {
    if (!lot) return;
    setActing(true);
    try {
      // 0353: NULL auction. Relot returns the item to inventory unscheduled —
      // assignment to an auction is always a separate deliberate act.
      const { data: newLotId, error: rpcErr } = await supabase.rpc('relist_lot_into_auction', {
        p_lot_id: lot.id,
        p_auction_id: null,
        p_lotted_by_worker: getActiveLottingWorkerId(),
      });
      if (rpcErr) throw new Error(rpcErr.message);
      if (!newLotId) throw new Error('The lot vanished between the scan and the save. Scan it again.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Relotted to inventory',
        'This item has a new lot code and is back in inventory.\n\nIt is NOT in an auction — someone assigns it to one deliberately.',
        [{ text: 'Edit new listing', onPress: () => router.push(`/worklist/${String(newLotId)}` as Href) },
         { text: 'Done', style: 'cancel' }],
      );
    } catch (err) {
      const msg = (err as Error).message;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Could not relot',
        msg.includes('relist_source_wrong_status')
          ? 'This item still belongs to a customer — at least one line on their invoice has not been refunded.'
          : msg.includes('missing')
            ? 'This item was refunded as MISSING. Somebody has to physically find it and put it away before it can go back on an auction.'
            : msg,
      );
    } finally {
      setActing(false);
    }
  }, [lot, router]);

  // 2026-07-09: the BRN/PNK/TEA pre-sticker rolls print 1D barcodes, not QR —
  // QR-only scanning couldn't read an item's sticker at all. Same set as
  // lotting; non-lot codes resolve to nothing and show "Lot not found".
  const lotScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      if (busy || scanLockRef.current || lot) return;
      const c = firstCodeValue(codes);
      if (!c) return;
      const prev = lastScanRef.current;
      const nowMs = Date.now();
      if (prev && prev.value === c.data && nowMs - prev.at < SCAN_DEDUP_MS) return;
      lastScanRef.current = { value: c.data, at: nowMs };
      void onLotScan(c);
    },
  });

  function onLotScan(scan: DecodedCode) {
    void resolveLot(scan.data);
  }

  function submitManualCode() {
    const code = manualCode.trim();
    if (code) void resolveLot(code);
  }

  function reset() {
    setLot(null);
    setManualCode('');
    setError(null);
    scanLockRef.current = false;
    lastScanRef.current = null;
  }

  if (role.kind !== 'staff') return null;

  if (!hasPermission) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 12 }}>
          Camera access is required to scan a lot QR. You can also type a lot code instead.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 14, backgroundColor: colors.primary, borderRadius: 8 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900' }}>Allow camera</Text>
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
        testID="lot-find-screen"
        contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
          {lot ? 'item location' : 'scan or type a lot code'}
        </Text>
        <Text style={{ color: colors.text, fontSize: 26, ...type.displayHero, marginTop: 4, marginBottom: 8 }}>
          Lot lookup
        </Text>

        {!lot && (
          <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
            Scan an item&apos;s QR — or type its lot / sticker code — to see where it&apos;s stored.
            Read-only; nothing is moved or changed.
          </Text>
        )}

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
            <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '900' }}>{error.title}</Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 }}>
              {error.detail}
            </Text>
            <Pressable onPress={() => setError(null)} hitSlop={10} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>Dismiss</Text>
            </Pressable>
          </View>
        )}

        {!lot && (
          <>
            {device && (
              <View style={s.cameraBox}>
                <Camera
                  ref={cameraRef}
                  style={{ flex: 1 }}
                  device={device}
                  isActive={cameraGate && (!lot && !busy)}
                  codeScanner={lotScanner}
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

            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
              Or type a lot / sticker code:
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={manualCode}
                onChangeText={setManualCode}
                placeholder="LOT-000123"
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
                onSubmitEditing={submitManualCode}
              />
              <Pressable
                onPress={submitManualCode}
                disabled={!manualCode.trim() || busy}
                style={{
                  paddingHorizontal: 18,
                  justifyContent: 'center',
                  backgroundColor: colors.primary,
                  borderRadius: 10,
                  opacity: !manualCode.trim() || busy ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#000', fontWeight: '900' }}>Find</Text>
              </Pressable>
            </View>
          </>
        )}

        {lot && (
          <>
            <View style={s.header}>
              <View style={{ flex: 1 }}>
                <Text style={s.lotCode}>
                  {lotDisplayCode({ sticker_code: lot.sticker_code, lot_code: lot.lot_code, display_code: lot.display_code }) ?? lot.lot_code}
                </Text>
                <Text style={s.lotTitle} numberOfLines={3}>{lot.title}</Text>
              </View>
              <Pressable onPress={reset} style={s.scanAgainBtn} hitSlop={10}>
                <Text style={s.scanAgainText}>Scan another</Text>
              </Pressable>
            </View>

            {/* The label points at a retired lot; a relist moved the sticker
                onto this child. Say so, or the code on screen silently
                disagrees with the code in the staffer's hand. */}
            {lot.hoppedFrom && (
              <Text style={s.hopNotice}>
                That label is on retired lot {lot.hoppedFrom} — it was relotted. Showing the
                item&apos;s current listing.
              </Text>
            )}

            {/* Listing photos — the box / packaging / labels / condition we
                shot during lotting, so staff can eyeball the item to locate a
                missing/misplaced box (feature request 2026-07-17). */}
            {lot.photo_urls && lot.photo_urls.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginTop: 14 }}
                contentContainerStyle={{ gap: 8 }}
              >
                {lot.photo_urls.map((url, i) => (
                  <Image
                    key={`${url}-${i}`}
                    source={{ uri: url }}
                    style={{
                      width: 132,
                      height: 132,
                      borderRadius: 10,
                      backgroundColor: colors.surface,
                    }}
                    resizeMode="cover"
                  />
                ))}
              </ScrollView>
            )}

            {/* 2026-08-14: a Harrison box scanned in Dodge City rendered as an
                ordinary result. The warning sits ABOVE the location box so it
                is read before the shelf, not after. */}
            <CrossWarehouseWarning
              lotWarehouseId={lot.warehouse_id}
              detail="Its shelf below is in that location, not the one you are working in."
            />

            {/* Location — the answer to "where is it?" */}
            <View style={s.locationBox}>
              <Text style={s.locationLabel}>
                {lot.locationKind === 'staged'
                  ? 'PICKUP LOCATION'
                  : lot.locationKind === 'intake'
                    ? 'STORED IN'
                    : 'LOCATION'}
              </Text>
              <Text style={s.locationValue}>
                {lot.location
                  ? formatLocation(lot.location)
                  : lot.deadLotBin
                    ? `Not in inventory — ${lotStatusLabel(lot.status).toLowerCase()}`
                    : 'No location on file'}
              </Text>
              {lot.locationKind === 'staged' && (
                <Text style={s.locationHint}>Staged for pickup — collect it here.</Text>
              )}
              {/* Dead lot: name the last shelf, but never as somewhere to go.
                  The staff report was someone walking to a bin for a box that
                  had been canceled — the shelf was real history, the
                  instruction was not. */}
              {lot.deadLotBin && (
                <Text style={s.locationHint}>
                  Last recorded on {formatLocation(lot.deadLotBin)}. This lot is{' '}
                  {lotStatusLabel(lot.status).toLowerCase()}, so the box should not be
                  there — don&apos;t go looking for it.
                </Text>
              )}
              {/* A dead lot renders its own notice above; this "where has it
                  been" hint is for a LIVE box with no current shelf, and both
                  at once contradict each other. */}
              {lot.locationKind === 'none' &&
                !lot.deadLotBin &&
                (lastShelf ? (
                  // It HAS been on a shelf — say where and stop implying the
                  // lotter skipped a step.
                  //
                  // Reported 2026-08-25 (staff member): "I scanned an item that had for
                  // sure been put away two weeks ago, but when I looked up the
                  // lot code it showed that the item had never been put away."
                  // She was reading this hint, and for her item it was simply
                  // false: the box was put away, and a later bin audit's "not
                  // here" cleared its location (audit_remove_lot is the only
                  // thing in the database that nulls intake_bin_id). Six lots
                  // are in exactly that state — put away 08-19/08-20, cleared
                  // 08-25/08-26.
                  //
                  // "Not put away yet" and "taken off a shelf and never
                  // relocated" need completely different follow-up, and we
                  // already know which one this is.
                  <Text style={s.locationHint}>
                    Last seen on {lastShelf.bin_code}
                    {' — '}
                    removed from its shelf, not yet put back. History below.
                  </Text>
                ) : (
                  <Text style={s.locationHint}>
                    This lot isn&apos;t assigned to a bin. It may not be put away yet.
                  </Text>
                ))}
            </View>

            {/* Every shelf it has been on. Collapsed by default: the common
                case is "the location above is right", and an always-open list
                would push the answer off the screen. It opens to the count,
                so a relisted box with three past shelves advertises that
                before anyone taps. */}
            {history.length > 0 && (
              <View style={s.historyBox}>
                <Pressable
                  onPress={() => setHistoryOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: historyOpen }}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={s.historyToggle}>
                    {historyOpen ? '▾' : '▸'} Every location it&apos;s been (
                    {history.length})
                  </Text>
                </Pressable>

                {historyOpen && (
                  <View style={{ marginTop: 8, gap: 8 }}>
                    {history.map((h) => (
                      <View
                        key={`${h.lot_id}-${h.kind}-${h.occurred_at}`}
                        style={s.historyRow}
                      >
                        <Text style={s.historyBin}>
                          {/* lot_location_history LEFT JOINs bins, so a row
                              with no bin is a REMOVAL — the audit's "not here"
                              clearing intake_bin_id. Rendering h.bin_code
                              straight through printed an empty line for the
                              one event staff most need to see. */}
                          {h.bin_code ?? 'Taken off shelf'}
                          {h.is_current ? '  · current' : ''}
                        </Text>
                        <Text style={s.historyMeta}>
                          {h.kind === 'staged' ? 'Staged for pickup' : 'Put away'}
                          {' · '}
                          {new Date(h.occurred_at).toLocaleDateString()}
                          {/* The lot code matters when it is NOT the one they
                              scanned — that is the relist generation the box
                              may still physically be filed under. */}
                          {h.lot_code !== lot.lot_code ? ` · as ${h.lot_code}` : ''}
                        </Text>
                      </View>
                    ))}
                    <Text style={s.historyHint}>
                      A relist creates a new record, so an older entry can be
                      where the box actually is.
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* The alert the owner asked for: red, at the top of the card, on
                the screen staff already have open at the shelf. */}
            {/* Same red treatment as the refunded banner (staff member via Jared
                2026-10-15). Display only. */}
            {lot.missingMark && (
              <View style={s.needsAction} testID="missing-banner">
                <Text style={s.needsActionTitle}>MARKED MISSING</Text>
                <Text style={s.needsActionBody}>
                  {lot.missingMark.source === 'pickup'
                    ? 'Not found at pickup'
                    : 'Removed from inventory as missing'}
                  {lot.missingMark.at
                    ? ` on ${new Date(lot.missingMark.at).toLocaleDateString()}`
                    : ''}
                  .
                </Text>
                <Text style={s.needsActionBody}>
                  Reason: {lot.missingMark.reason ?? 'none recorded'}
                </Text>
                <Text style={s.needsActionPick}>
                  {lot.missingMark.source === 'pickup'
                    ? 'If this is the box, put it away again — then it can go back in an auction.'
                    : 'If this is the box, tell a manager so it can be re-lotted.'}
                </Text>
              </View>
            )}

            {needsAction && (
              <View style={s.needsAction}>
                <Text style={s.needsActionTitle}>REFUNDED — NEEDS ACTION</Text>
                <Text style={s.needsActionBody}>
                  This item was refunded{' '}
                  {daysSinceRefund != null
                    ? daysSinceRefund === 0
                      ? 'today'
                      : `${daysSinceRefund} day${daysSinceRefund === 1 ? '' : 's'} ago`
                    : ''}
                  {lot.owner?.refunded_at
                    ? ` (${new Date(lot.owner.refunded_at).toLocaleDateString()})`
                    : ''}
                  . It has never been relotted, disposed of, or moved to the bin store — it is
                  just sitting on the shelf.
                </Text>
                <Text style={s.needsActionBody}>
                  {lot.soldPriceCents != null
                    ? `It last sold for $${(lot.soldPriceCents / 100).toFixed(2)}`
                    : 'No previous sale price on file'}
                  {lot.auction_title ? ` in "${lot.auction_title}".` : '.'}
                </Text>
                <Text style={s.needsActionPick}>Pick one: Relot, Dispose, or Bin Store.</Text>
              </View>
            )}

            {/* Already handled — say so instead of offering a button that the
                one-active-lot guard (0275) would refuse. */}
            {lot.relotChildCode && (
              <View style={s.handledBox}>
                <Text style={s.handledText}>
                  Already relotted — this item now lives on lot{' '}
                  <Text style={s.handledCode}>{lot.relotChildCode}</Text>.{' '}
                  {lot.relotChildStatus === 'in_inventory'
                    ? 'That lot is in inventory and has NOT been put in an auction yet.'
                    : lot.relotChildStatus === 'won'
                      ? 'That lot has already sold.'
                      : lot.relotChildStatus
                        ? `That lot is ${lot.relotChildStatus.replace(/_/g, ' ')} in an auction.`
                        : ''}{' '}
                  Look that code up; this record is retired.
                </Text>
              </View>
            )}

            {/* 0475: refunded stock. Same action the Inventory -> Refunded row
                offers, now reachable from the screen staff scan at the shelf. */}
            {refundedRelot && (
              <View style={s.actionBlock}>
                <Pressable
                  testID="lot-find-relot-refunded"
                  onPress={() => router.push(refundedRelot)}
                  style={[s.actionBtn, s.actionPrimary]}
                >
                  <Text style={s.actionPrimaryText}>Relot refunded item — manager PIN</Text>
                </Pressable>
                <Text style={s.actionNote}>
                  A manager approves with their PIN; your name and the reason go in the audit log.
                </Text>
              </View>
            )}

            {/* Relot / Dispose / Bin Store, so nobody has to walk to a computer.
                Owner, 2026-09-10: "When I scan an item through Item Lookup or
                during a Bin Audit, I should not have to walk to a computer to
                understand its status or take action." Dispose used to live
                ONLY inside the relot flow, which is why disposing of a chair
                meant relotting it first — and the relot scheduled it into an
                auction on the way past. */}
            {RELOTTABLE_HERE.includes(lot.status) && lot.relotChildCode === null && (
              <View style={s.actionBlock}>
                <Pressable
                  testID="lot-find-relot"
                  disabled={acting}
                  onPress={runRelot}
                  style={[s.actionBtn, s.actionPrimary, acting && s.actionDisabled]}
                >
                  <Text style={s.actionPrimaryText}>
                    {acting ? 'Working…' : 'Relot — back into inventory'}
                  </Text>
                </Pressable>

                {canRemove ? (
                  <View style={s.actionRow}>
                    <Pressable
                      testID="lot-find-binstore"
                      disabled={acting}
                      onPress={() =>
                        Alert.alert(
                          'Move to Bin Store?',
                          'This takes the item out of auction inventory for good. It will not be listed again.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Bin Store',
                              onPress: () => void runRemoval('bin_store', 'Moved to Bin Store'),
                            },
                          ],
                        )
                      }
                      style={[s.actionBtn, s.actionSecondary, s.actionHalf, acting && s.actionDisabled]}
                    >
                      <Text style={s.actionSecondaryText}>Bin Store</Text>
                    </Pressable>

                    <Pressable
                      testID="lot-find-dispose"
                      disabled={acting}
                      onPress={() =>
                        Alert.alert(
                          'Dispose of this item?',
                          'For items broken beyond sale. This cannot be undone.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Dispose',
                              style: 'destructive',
                              onPress: () => void runRemoval('destroyed', 'Disposed'),
                            },
                          ],
                        )
                      }
                      style={[s.actionBtn, s.actionDanger, s.actionHalf, acting && s.actionDisabled]}
                    >
                      <Text style={s.actionDangerText}>Dispose</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={s.actionNote}>
                    Dispose and Bin Store need a manager or admin — ask one to do it, or relot the
                    item and let them deal with it later.
                  </Text>
                )}
              </View>
            )}

            {/* Edit, for the codes Inventory cannot surface on a tablet. Routes
                to the existing detail screen instead of duplicating an editor,
                and only for statuses that screen will accept. */}
            {EDITABLE_STATUSES.includes(lot.status) ? (
              <Pressable
                testID="lot-find-edit"
                onPress={() => router.push(`/worklist/${lot.id}` as Href)}
                style={s.editButton}
              >
                <Text style={s.editButtonText}>Edit item</Text>
              </Pressable>
            ) : (
              <Text style={s.editBlocked}>
                {/* Say which wall they hit. The old copy claimed "already in an
                    auction" for every non-editable status, which was simply
                    wrong for a draft and sent people to the console for
                    nothing. */}
                {lot.status === 'won' || lot.status === 'live'
                  ? 'This one is live or sold — edit it from the operator console.'
                  : `Can't edit a ${lotStatusLabel(lot.status).toLowerCase()} lot here — use the operator console.`}
              </Text>
            )}

            <View style={s.badgeRow}>
              <View style={s.badge}>
                <Text style={s.badgeText}>{lotStatusLabel(lot.status)}</Text>
              </View>
              {lot.auction_title ? (
                <View style={[s.badge, s.auctionBadge]}>
                  <Text style={[s.badgeText, { color: colors.primary }]} numberOfLines={1}>
                    {lot.auction_title}
                    {lot.auction_status ? ` · ${lot.auction_status}` : ''}
                  </Text>
                </View>
              ) : (
                <Text style={s.noAuction}>— not in an auction</Text>
              )}
            </View>

            {/* Who lotted it (staff member 2026-08-26). Rendered only when a PIN
                worker was actually stamped — about three quarters of lots. A
                blank line saying "Lotted by —" would read as a data error for
                the quarter that legitimately has none. */}
            {lot.lottedBy && (
              <Text style={s.lottedBy}>
                Lotted by <Text style={s.lottedByName}>{lot.lottedBy}</Text>
              </Text>
            )}

            {/* Winning-customer + pickup state (Jared 2026-07-22): when the lot
                is sold, staff need to see it's on a customer's Pickup Pass —
                not just "Won" — plus who owns it and the invoice. */}
            {lot.owner && (
              <View style={s.ownerBox}>
                <Text style={s.ownerLabel}>Winning customer</Text>
                <Text style={s.ownerName}>
                  {lot.owner.bidder_name ?? '—'}
                  {lot.owner.bidder_number != null ? ` · Bidder #${lot.owner.bidder_number}` : ''}
                </Text>
                <Text style={s.ownerMeta}>
                  Invoice {(lot.owner.invoice_status ?? '—').replace(/_/g, ' ')}
                  {lot.owner.invoice_id ? ` · #${lot.owner.invoice_id.slice(-8)}` : ''}
                </Text>
                <Text style={s.ownerPickup}>
                  {/* 0476 / 2026-10-28: never a bare "awaiting pickup" default. */}
                  {ownerPickupStatus(lot.owner)}
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  needsAction: {
    backgroundColor: '#FDECEA',
    borderLeftWidth: 5,
    borderLeftColor: '#C62828',
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
    gap: 6,
  },
  needsActionTitle: { color: '#B71C1C', fontSize: 14, fontWeight: '900', letterSpacing: 0.6 },
  needsActionBody: { color: '#5D2020', fontSize: 13, lineHeight: 19 },
  needsActionPick: { color: '#B71C1C', fontSize: 13, fontWeight: '800', marginTop: 2 },
  handledBox: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginTop: 14,
  },
  handledText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  handledCode: { color: colors.primary, fontWeight: '900' },
  actionBlock: { marginTop: 14, gap: 10 },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionBtn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  actionHalf: { flex: 1 },
  actionPrimary: { backgroundColor: colors.primary },
  actionPrimaryText: { color: '#000', fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
  actionSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  actionSecondaryText: { color: colors.text, fontSize: 15, fontWeight: '800' },
  actionDanger: { backgroundColor: '#7F1D1D' },
  actionDangerText: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  actionDisabled: { opacity: 0.5 },
  actionNote: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  cameraBox: { height: 320, borderRadius: 12, overflow: 'hidden', marginTop: 12 },
  cameraBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  lotCode: {
    color: colors.primary,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '900',
  },
  lotTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 4 },
  scanAgainBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  scanAgainText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  hopNotice: { color: colors.winning, fontSize: 13, lineHeight: 19, marginTop: 10 },
  locationBox: {
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  locationLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  locationValue: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 6 },
  locationHint: { color: colors.textMuted, fontSize: 12, marginTop: 8, lineHeight: 17 },
  historyBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  historyToggle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  historyRow: {
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  historyBin: { color: colors.text, fontSize: 16, fontWeight: '800' },
  historyMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  historyHint: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  editButton: {
    marginTop: 14,
    minHeight: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  editButtonText: { color: '#000', fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
  editBlocked: {
    marginTop: 14,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.border },
  auctionBadge: { backgroundColor: colors.primaryDim, maxWidth: '70%' },
  badgeText: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
  noAuction: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
  lottedBy: { color: colors.textMuted, fontSize: 12, marginTop: 6 },
  lottedByName: { color: colors.text, fontWeight: '700' },
  ownerBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 3,
  },
  ownerLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  ownerName: { color: colors.text, fontSize: 15, fontWeight: '800', marginTop: 2 },
  ownerMeta: { color: colors.textMuted, fontSize: 12 },
  ownerPickup: { color: colors.primary, fontSize: 13, fontWeight: '700', marginTop: 2 },
});
