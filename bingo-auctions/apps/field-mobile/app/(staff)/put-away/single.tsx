// Intake — flip a pending_intake lot to in_inventory by scanning
// its label + a bin QR. The lot moves out of "manifest record" and
// into "physically here, ready to be auctioned."
//
// Flow:
//   1. Scan the lot label (encodes either lot_code or lot UUID).
//   2. Confirm the resolved lot.
//   3. Scan a bin QR (the existing bin sticker — same qr_token used
//      by the post-auction stage flow).
//   4. Server: intake_lot_to_bin RPC sets status = 'in_inventory',
//      intake_bin_id, warehouse_id (from the bin), intake_at.
//   5. Done. Loop back for the next item — pickers chain these.

import { useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Alert,
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
import { ALL_RETAIL_CODE_TYPES, firstCodeValue, type DecodedCode } from '@/lib/vision-camera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { CrossWarehouseWarning, useForeignWarehouseName } from '@/features/location/CrossWarehouseWarning';
import { useWarehouse } from '@/features/location/WarehouseContext';
import { resolveTypedBin } from '@/lib/typed-bin-lookup';
import { resolveLotScan, type ScanRow } from '@/lib/resolve-lot-scan';
import {
  binLookupWarehouseId,
  transferDoneLine,
  transferInputsReady,
  transferMessage,
  transferReasonChoices,
  transferReasonText,
  OTHER_REASON,
  type TransferResult,
} from '@/lib/warehouse-transfer';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode, runWithRetry } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 2026-05-25: widened to match both formats found in production:
//   * BinGo Auctions native:  BIN-000047 (operator-prefix + dash + zeropadded digits)
//   * Legacy import:    TEA4951695, BRN4366058, PNK4858781 (prefix + digits, NO dash)
// The prior dash-required pattern silently skipped lot_code lookup for the
// 91k BinGo imported lots — fallback to external_code never found them either
// (their external_code is null) → every scan returned "lot not found".
const LOT_CODE_RE = /^[A-Z]{2,4}-?\d{4,10}$/;

type Step = 'scan_lot' | 'confirm_lot' | 'scan_bin' | 'submitting' | 'done';

type ResolvedLot = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  title: string;
  status: string;
  category: string | null;
  msrp_cents: number | null;
  /** The building this box is stocked in, for the cross-location warning. */
  warehouse_id: string | null;
};

const REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Sign in again — your session expired.',
  not_operator_staff: "You're not on staff for any operator.",
  lot_not_found: 'No lot matched that QR/code.',
  // W4 (mig 0142): put-away no longer silent-mints from manifest. If the
  // scan doesn't match an existing lot's qr_token / lot_code / sticker_code,
  // the server returns this reason and the operator goes to Lotting first.
  not_lotted_yet: 'Not lotted yet — open Lotting to create a draft, then scan again.',
  lot_other_operator: 'That lot belongs to a different operator.',
  lot_not_in_intake_state: 'That lot is already past inventory state.',
  bin_not_found: 'No bin matched that QR.',
  bin_not_found_or_revoked: 'That bin QR was revoked or never existed.',
  bin_retired: 'That bin is retired — pick an active bin.',
  bin_other_operator: 'That bin belongs to a different operator.',
};

// Pull an identifier from a scanned QR or barcode. Tries our
// formats first (lot_code → UUID), then falls back to handing the
// raw scan to the server for external_code resolution. Operators
// using pre-stickered inventory scan supplier UPCs / SKUs / route
// stops here — the server's intake_lot_to_bin RPC resolves those
// against lots.external_code (operator-scoped).
function extractLotId(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (LOT_CODE_RE.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  if (UUID_RE.test(trimmed)) return trimmed;
  // Embedded match (e.g. when scanner returns extra payload around the code).
  // Widened in 2026-05-25 to mirror LOT_CODE_RE — dashed OR legacy non-dashed.
  const codeMatch = trimmed.toUpperCase().match(/[A-Z]{2,4}-?\d{4,10}/);
  if (codeMatch) return codeMatch[0];
  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  // Fallback: hand the raw scan to the server. The RPC will try
  // external_code lookup. Cap length so we don't ship absurdly long
  // QR payloads (e.g. URLs with query strings) — 120 matches the
  // schema cap on lots.external_code.
  if (trimmed.length > 120) return null;
  return trimmed;
}

export default function IntakeScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const [step, setStep] = useState<Step>('scan_lot');
  const [lot, setLot] = useState<ResolvedLot | null>(null);
  // Typed bin codes are scoped to a warehouse (codes repeat across locations).
  const { warehouse: activeWarehouse, available: warehouses } = useWarehouse();
  const [busy, setBusy] = useState(false);
  const [manualEntry, setManualEntry] = useState('');
  // Separate manual input for the bin step. Mirrors the lot-code
  // manual fallback so testing without a label printer (phone +
  // laptop) works end-to-end.
  const [manualBinCode, setManualBinCode] = useState('');
  const [lastResult, setLastResult] = useState<{ lotCode: string; binCode: string; alreadyHere?: boolean; transferLine?: string } | null>(null);
  // 0473: a box from another building is a TRANSFER, not a put-away. It needs
  // the typed staff name (logins are shared) and a reason, both audited.
  const foreignWarehouse = useForeignWarehouseName(lot?.warehouse_id);
  const isTransfer = foreignWarehouse != null;
  const [transferName, setTransferName] = useState('');
  // Reason is a one-tap pick (owner 2026-10-27); "Other" asks for text.
  const [transferPick, setTransferPick] = useState<string | null>(null);
  const [transferOther, setTransferOther] = useState('');
  const transferReason = transferReasonText(transferPick, transferOther);
  // C1: persistent error banner. Unlike the transient Alert dialogs (which
  // vanish on OK and leave staff unsure WHY put-away didn't complete), this
  // sticks at the top of the screen with the specific non-success reason
  // (bad bin / not lotted yet / pending move / wrong status) until the next
  // scan attempt or an explicit dismiss. Paired with an error haptic so the
  // failure is felt as well as seen on a noisy warehouse floor.
  const [errorBanner, setErrorBanner] = useState<{ title: string; detail: string } | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(cameraRef);
  // 2026-05-25: debounce ref. The camera fires onCodeScanned on every
  // frame, so when a scan resolves with "lot not found" the alert
  // dismisses and the SAME barcode immediately re-triggers, looping
  // the alert until the UI hangs. lastScanRef gates this: same value
  // within SCAN_DEBOUNCE_MS is suppressed, so the user gets one alert
  // per scan attempt and can deliberately re-aim.
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);
  const SCAN_DEBOUNCE_MS = 1500;
  // 2026-05-25 hotfix: when a scan results in "Lot not found", the
  // 1500ms debounce expires before the user can move the camera off
  // the label, so the alert re-fires immediately and looks identical
  // to "OK does nothing". notFoundRef holds the raw scan value for
  // NOT_FOUND_COOLDOWN_MS — long enough that the team can deliberately
  // remove the label from view and re-aim. Cleared automatically by
  // time-out.
  const notFoundRef = useRef<{ value: string; at: number } | null>(null);
  const NOT_FOUND_COOLDOWN_MS = 30_000;
  // A connection-error alert used to just clear `busy`; 1.5s later the same
  // label in view re-fired and replaced the alert with an identical one, so
  // staff saw an alert that "OK does nothing". Suppress the SAME code until a
  // different label comes into view, the user taps Retry, or a short cooldown
  // expires. The cooldown matters: moving away and re-aiming at the same
  // sticker produces no different code, so a permanent suppression (RED TEAM
  // #770 MEDIUM 2) would leave staff unable to rescan after wifi came back.
  const connectionErrorRef = useRef<{ value: string; at: number } | null>(null);
  // Long enough to stop the camera's frame-rate loop, short enough that a
  // deliberate re-aim after restoring connectivity works without leaving the
  // screen.
  const CONNECTION_ERROR_COOLDOWN_MS = 5_000;
  // A persistent, dismissible banner keeps Retry reachable after the transient
  // alert is gone (RED TEAM #770 MEDIUM 2).
  const [connectionError, setConnectionError] = useState<{ rawIdentifier: string; detail: string } | null>(null);
  const CONNECTION_ERROR_TITLE = "Can't reach the server";
  // A lookup that never settles must not leave the screen busy forever. One
  // bounded attempt (no retry ladder: the user is standing at a label and can
  // rescan) aborts the underlying queries and shows a recoverable error.
  const LOOKUP_TIMEOUT_MS = 12_000;
  const LOOKUP_TIMEOUT_MESSAGE =
    'The lot lookup timed out before it could answer. Check the connection and scan the sticker again.';

  // C1: surface a non-success put-away outcome as a persistent banner +
  // error haptic. `reason` is the RPC reason code; we resolve it through
  // REASON_MESSAGES so staff see WHY (bad bin / not lotted / wrong status)
  // rather than a toast that disappears before they can read it.
  function showError(title: string, reason: string) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setErrorBanner({
      title,
      detail: REASON_MESSAGES[reason] ?? `Server: ${reason}`,
    });
  }
  // Two scan steps (lot + bin) share a single useCodeScanner — the
  // `step`-aware callback routes the decoded value to the right handler.
  //
  // BUG-LL-08 fix: accept ALL retail code types (UPC, Code128, Code39,
  // QR, PDF417, etc.) instead of QR-only. Bin labels stay QR-only
  // (printed via our QR-sheet route — known format) but lot labels may
  // be Code128 from Zebra ZPL printers, UPC barcodes peeled off the
  // original retailer packaging, or QR codes we printed ourselves.
  // The bin-scan path validates the decoded value as a UUID below
  // (UUID_RE) so non-QR codes won't be accidentally accepted as bins.
  const qrScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      const c = firstCodeValue(codes);
      if (!c || busy) return;
      const now = Date.now();
      // A code whose lookup failed on the connection stays suppressed while it
      // is the label in view. Seeing a DIFFERENT code means the camera moved,
      // so the old failure is stale and a deliberate re-aim is allowed. The
      // cooldown bounds the suppression even when the camera never sees a
      // different code (staff moved away and re-aimed at the same sticker).
      const connectionFailed = connectionErrorRef.current;
      if (
        connectionFailed &&
        connectionFailed.value === c.data &&
        now - connectionFailed.at < CONNECTION_ERROR_COOLDOWN_MS
      ) {
        return;
      }
      if (connectionFailed) connectionErrorRef.current = null;
      // Suppress codes recently declared "not found" — the team won't
      // be able to clear the alert otherwise (camera re-fires the same
      // code within ms after OK dismisses it).
      const nf = notFoundRef.current;
      if (nf && nf.value === c.data && now - nf.at < NOT_FOUND_COOLDOWN_MS) {
        return;
      }
      const last = lastScanRef.current;
      if (last && last.value === c.data && now - last.at < SCAN_DEBOUNCE_MS) {
        return;
      }
      lastScanRef.current = { value: c.data, at: now };
      if (step === 'scan_lot') void onLotScan(c);
      else if (step === 'scan_bin') void onBinScan(c);
    },
  });

  async function onLotScan(scan: DecodedCode) {
    if (busy) return;
    void cameraRef;
    await resolveLot(scan.data);
  }

  async function resolveLot(rawIdentifier: string) {
    const id = extractLotId(rawIdentifier);
    // C1: clear any stale put-away banner when starting a fresh lot scan.
    setErrorBanner(null);
    setConnectionError(null);
    // 2026-05-25: hold busy=true while the error alert is up so the
    // camera's repeated onCodeScanned fires hit the `if (busy) return`
    // gate. Without this the alert dismisses → busy=false → camera
    // fires again on the same code → new alert → loop (3-4 OK presses
    // before user wins). The OK button's onPress is the only path that
    // clears busy.
    setBusy(true);
    if (!id) {
      Alert.alert('Not recognized', 'Empty or unreadable scan.', [
        { text: 'OK', onPress: () => setBusy(false) },
      ], { cancelable: false });
      return;
    }
    // One resolver for every identifier a label can carry. This used to be a
    // gated ladder — `lot_code` if the code matched LOT_CODE_RE, else
    // `qr_token`/`id`, then `external_code`, then the sticker suffix — and the
    // FIRST hit won. Two things went wrong with that:
    //
    //   • `lot_code` before `sticker_code`. After a relist the box's label is
    //     the retired parent's lot_code and the live child's sticker at the
    //     same time (855 pairs on prod), so put-away filed the box's location
    //     against a tombstone nothing points at.
    //   • the LOT_CODE_RE gate. A legacy label (PNK4860473) matches the regex,
    //     so the lot_code probe ran and the sticker probe was only reached on a
    //     miss — which is how a bound sticker read as "Lot not found".
    //
    // `resolveLotScan` probes all of them at once and prefers the live
    // incarnation, hopping down `relisted_from_lot_id` if every match is
    // history. Soft-deleted lots stay excluded (0057) — they must be restored
    // from /lotting/trash before intake.
    const cols = 'title, category, msrp_cents';
    // A failed query and a "no such lot" answer both used to arrive here as an
    // empty result, so a dropped session or RLS/wifi error told staff the
    // sticker did not exist. `resolveLotScan` can tell them apart; use it.
    let lookupError: string | null = null;
    let data: ResolvedLot | null = null;

    // Bound the primary lookup so a request that never settles cannot hold the
    // screen busy forever. The attempt signal aborts the underlying queries.
    const primary = await runWithRetry(
      async (_attempt, signal) => {
        const resolved = await resolveLotScan<ResolvedLot & ScanRow>(id, cols, {
          onQueryError: (message) => {
            lookupError = message;
          },
          // Any failed probe (identity, sticker, or relist lineage) means we
          // cannot prove which row is in the caller's hand. Returning a
          // lower-priority or tombstone row here would put away the wrong box.
          failClosed: true,
          signal,
        });
        return resolved?.lot ?? null;
      },
      { attempts: 1, timeoutMs: LOOKUP_TIMEOUT_MS },
    );
    if (primary.ok) {
      data = primary.value;
    } else {
      // A thrown or hung lookup is still a failed lookup, not a missing sticker.
      lookupError = primary.timedOut
        ? LOOKUP_TIMEOUT_MESSAGE
        : primary.error instanceof Error
          ? primary.error.message
          : String(primary.error);
    }

    // Only try the external_code alias after an authoritative, SUCCESSFUL
    // canonical miss. When the canonical lookup errored or timed out it says
    // nothing about whether the sticker exists; falling through to a different
    // alias row could select the wrong lot to put away or transfer.
    if (!data && !lookupError) {
      // Operator-private catch-all, kept last: external_code is not an identity
      // column, so it must never out-rank a real lot_code/sticker match. RLS
      // scopes lots to the caller's operator.
      const fallback = await runWithRetry(
        async (_attempt, signal) => {
          const r = await supabase
            .from('lots')
            .select(
              'id, lot_code, sticker_code, display_code, title, status, category, msrp_cents, warehouse_id',
            )
            .eq('external_code', id)
            .is('deleted_at', null)
            .abortSignal(signal)
            .maybeSingle();
          if (r.error) throw r.error;
          return (r.data as ResolvedLot | null) ?? null;
        },
        { attempts: 1, timeoutMs: LOOKUP_TIMEOUT_MS },
      );
      if (fallback.ok) {
        data = fallback.value;
      } else {
        lookupError = fallback.timedOut
          ? LOOKUP_TIMEOUT_MESSAGE
          : fallback.error instanceof Error
            ? fallback.error.message
            : String(fallback.error);
      }
    }
    if (!data) {
      if (lookupError) {
        // Say the lookup failed instead of blaming the sticker — staff were
        // re-scanning good labels because the message claimed they were missing.
        // A persistent banner (not a transient alert) keeps Retry reachable
        // after the user dismisses, and the timestamped ref bounds how long a
        // re-aim at the same sticker is suppressed (#770 MEDIUM 2).
        setConnectionError({
          rawIdentifier,
          detail:
            'The lot lookup did not complete, so this may not be a missing lot. Check the connection and scan the sticker again.',
        });
        return;
      }
      // Hold busy=true; cleared only by the OK button. Prevents
      // the camera from re-firing the same not-found code in a loop.
      // 2026-05-25 hotfix: ALSO record the raw scan value in
      // notFoundRef so the scanner suppresses the same code for
      // NOT_FOUND_COOLDOWN_MS (30s). Without this the SAME code
      // re-fires after the 1500ms debounce → alert immediately
      // reappears → operator thinks "OK does nothing".
      Alert.alert('Lot not found', `No match for "${id}".`, [
        { text: 'OK', onPress: () => {
          setBusy(false);
          notFoundRef.current = { value: rawIdentifier, at: Date.now() };
        }},
      ], { cancelable: false });
      return;
    }
    setBusy(false);
    setLot(data);
    setManualEntry('');
    setStep('confirm_lot');
  }

  async function onBinScan(scan: DecodedCode) {
    if (busy || !lot) return;
    setBusy(true);
    setErrorBanner(null);
    const trimmed = scan.data.trim();
    const m = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!m) {
      // Hold busy=true until OK dismisses — see resolveLot comment.
      Alert.alert('Not a bin QR', "Couldn't read a bin token.", [
        { text: 'OK', onPress: () => setBusy(false) },
      ], { cancelable: false });
      return;
    }
    setStep('submitting');
    const binTokenScanned = m[0];
    if (isTransfer) {
      await runTransfer(binTokenScanned);
      return;
    }
    try {
      const { data, error } = await supabase.rpc('intake_lot_to_bin', {
        p_lot_identifier: lot.lot_code,
        p_bin_qr_token: binTokenScanned,
      });
      if (error) throw error;
      const result = data as {
        ok: boolean;
        reason: string;
        lot_id: string | null;
        lot_code: string | null;
        bin_code: string | null;
        from_bin_code: string | null;  // W10: source bin on pending_move / ok_already_here
      };

      // W10 (mig 0143): three-outcome branching.
      //   ok_intaked        — pending_intake → in_inventory (standard success)
      //   ok_already_here   — same bin re-scan, no-op (info alert)
      //   pending_move      — different bin; server held back the move,
      //                       client must confirm via modal then call
      //                       confirm_move_lot_to_bin
      // Any other ok=false reason is a real error.

      if (!result.ok && result.reason === 'pending_move') {
        Alert.alert(
          'Move this lot?',
          `Lot ${result.lot_code ?? lot.lot_code} is currently in bin ${result.from_bin_code ?? '?'}. Move it to ${result.bin_code ?? '?'}?`,
          [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => { setBusy(false); setStep('scan_bin'); },
            },
            {
              text: 'Move',
              onPress: async () => {
                if (!result.lot_id) {
                  Alert.alert('Move failed', 'Missing lot id from server.', [
                    { text: 'OK', onPress: () => { setBusy(false); setStep('scan_bin'); } },
                  ], { cancelable: false });
                  return;
                }
                try {
                  const { data: moveData, error: moveErr } = await supabase.rpc('confirm_move_lot_to_bin', {
                    p_lot_id: result.lot_id,
                    p_bin_qr_token: binTokenScanned,
                  });
                  if (moveErr) throw moveErr;
                  const move = moveData as {
                    ok: boolean;
                    reason: string;
                    lot_code: string | null;
                    bin_code: string | null;
                    from_bin_code: string | null;
                  };
                  if (!move.ok) {
                    Alert.alert(
                      'Move failed',
                      REASON_MESSAGES[move.reason] ?? `Server: ${move.reason}`,
                      [{ text: 'OK', onPress: () => { setBusy(false); setStep('scan_bin'); } }],
                      { cancelable: false },
                    );
                    return;
                  }
                  setLastResult({ lotCode: move.lot_code ?? '', binCode: move.bin_code ?? '' });
                  setStep('done');
                  setBusy(false);
                } catch (err) {
                  Alert.alert('Move failed', (err as Error).message, [
                    { text: 'OK', onPress: () => { setBusy(false); setStep('scan_bin'); } },
                  ], { cancelable: false });
                }
              },
            },
          ],
          { cancelable: false },
        );
        return;
      }

      if (!result.ok) {
        // C1: persistent banner + error haptic instead of a vanishing toast,
        // so the specific reason (bad bin / not lotted yet / wrong status)
        // stays on screen. The lot did NOT move to Inventory.
        showError("Couldn't put away — lot stayed put", result.reason);
        setBusy(false);
        setStep('scan_bin');
        return;
      }

      // ok_intaked AND ok_already_here are BOTH successes — the lot is in the
      // scanned bin either way. "Already here" is not a warning and nothing is
      // wrong, so show the same green confirmation (no interrupting modal to
      // dismiss) with an already-here flavor. (staff report 2026-07-22)
      setLastResult({
        lotCode: result.lot_code ?? '',
        binCode: result.bin_code ?? '',
        alreadyHere: result.reason === 'ok_already_here',
      });
      setStep('done');
      setBusy(false);
    } catch (err) {
      // C1: network/RPC exception — persistent banner + error haptic.
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorBanner({ title: 'Put-away failed', detail: (err as Error).message });
      setBusy(false);
      setStep('scan_bin');
    }
  }

  // Resolve a typed bin code (e.g. "A-01") to its qr_token, then run
  // the same intake_lot_to_bin RPC the QR scanner uses. Operator-scoped
  // via RLS — the bins table only returns the caller's operator's bins.
  async function submitManualBin() {
    if (busy || !lot) return;
    const code = manualBinCode.trim().toUpperCase();
    if (!code) return;

    setBusy(true);
    setErrorBanner(null);
    setStep('submitting');
    try {
      // C1 bin-code validation: resolve the TYPED code against a real
      // bins.code before we ever call the RPC. RLS scopes bins to the
      // caller's operator so a typo can't leak another operator's bins.
      // An unknown code is rejected here with a clear, persistent banner
      // instead of being passed through to fail server-side with an
      // opaque reason.
      // Codes repeat across warehouses (every location uses 1-01-01, ...), so
      // scope to the lot's own warehouse (else the active location) and to
      // active, unretired bins. maybeSingle() on an unscoped code used to fail
      // with "multiple rows" for any code shared with another building.
      const scopeWarehouseId = binLookupWarehouseId(isTransfer, lot.warehouse_id, activeWarehouse?.id ?? null);
      let binQuery = supabase
        .from('bins')
        .select('qr_token, code, warehouse_id')
        .eq('code', code)
        .eq('is_active', true)
        .is('retired_at', null);
      if (scopeWarehouseId) binQuery = binQuery.eq('warehouse_id', scopeWarehouseId);
      const { data: binRows, error: lookupErr } = await binQuery.limit(10);
      if (lookupErr) throw lookupErr;
      const resolved = resolveTypedBin(
        (binRows ?? []) as Array<{ qr_token: string; code: string; warehouse_id: string | null }>,
        code,
        (scopeWarehouseId && warehouses.find((w) => w.id === scopeWarehouseId)?.name) || null,
        new Map(warehouses.map((w) => [w.id, w.name])),
      );
      if (resolved.kind !== 'one') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorBanner({ title: resolved.title, detail: resolved.detail });
        setStep('scan_bin');
        setBusy(false);
        return;
      }
      const bin = resolved.bin;

      if (isTransfer) {
        await runTransfer(bin.qr_token);
        return;
      }

      const { data, error } = await supabase.rpc('intake_lot_to_bin', {
        p_lot_identifier: lot.lot_code,
        p_bin_qr_token: bin.qr_token,
      });
      if (error) throw error;
      const result = data as {
        ok: boolean;
        reason: string;
        lot_code: string | null;
        bin_code: string | null;
      };
      if (!result.ok) {
        // C1: persistent banner + error haptic — lot stayed put.
        showError("Couldn't put away — lot stayed put", result.reason);
        setStep('scan_bin');
        return;
      }
      setLastResult({
        lotCode: result.lot_code ?? '',
        binCode: result.bin_code ?? '',
        alreadyHere: result.reason === 'ok_already_here',
      });
      setStep('done');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorBanner({ title: 'Put-away failed', detail: (err as Error).message });
      setStep('scan_bin');
    } finally {
      setBusy(false);
    }
  }

  // 0473: the only way a lot moves to a shelf in another building. The
  // server refuses lots in a sale, sold, with an open invoice or staged for
  // pickup, and takes a lot off its closed auction first (like Relist ->
  // inventory). Nothing moves on any refusal.
  async function runTransfer(binQrToken: string) {
    if (!lot) return;
    try {
      const { data, error } = await supabase.rpc('transfer_lot_to_bin', {
        p_lot_id: lot.id,
        p_bin_qr_token: binQrToken,
        p_staff_name: transferName.trim(),
        p_reason: transferReason.trim(),
      });
      if (error) throw error;
      const result = data as TransferResult;
      if (!result.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorBanner({ title: "Couldn't transfer — lot stayed put", detail: transferMessage(result.reason) });
        setStep('scan_bin');
        return;
      }
      setLastResult({
        lotCode: result.lot_code ?? '',
        binCode: result.bin_code ?? '',
        transferLine: transferDoneLine(result),
      });
      setTransferPick(null);
      setTransferOther('');
      setStep('done');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorBanner({ title: 'Transfer failed', detail: (err as Error).message });
      setStep('scan_bin');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setLot(null);
    setLastResult(null);
    // Keep the typed name for the next box (same person chaining); the
    // reason is per box.
    setTransferPick(null);
    setTransferOther('');
    setManualEntry('');
    setManualBinCode('');
    setErrorBanner(null);
    setStep('scan_lot');
  }

  if (!hasPermission) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 12 }}>
          Camera access is required to scan QR codes.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 14, backgroundColor: colors.primary, borderRadius: 6 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '700' }}>
            Allow camera
          </Text>
        </Pressable>
      </View>
    );
  }

  const stepLabel =
    step === 'scan_lot'
      ? '1 of 2 · scan or type lot code'
      : step === 'confirm_lot'
        ? '2 of 2 · scan bin'
        : step === 'scan_bin'
          ? '2 of 2 · scan bin'
          : step === 'submitting'
            ? 'submitting…'
            : 'done';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 11,
            ...type.label,
          }}
        >
          {stepLabel}
        </Text>

        {/* C1: disambiguate intake-vs-stage. This screen runs the real
            put-away — it flips the lot to IN INVENTORY. Staging a won lot
            into a pickup bin (assign-only, status unchanged) is a different
            flow under Check Out. Make that explicit so staff don't think a
            stage = a put-away. */}
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 12,
            marginTop: 6,
            lineHeight: 17,
          }}
        >
          Put-away moves the lot to{' '}
          <Text style={{ color: colors.success, fontWeight: '800' }}>Inventory</Text>. To stage a
          won lot for pickup (which does not change inventory status), use Check Out instead.
        </Text>

        {/* C1: persistent non-success banner. Stays until the next scan or
            an explicit dismiss so staff can read the exact reason. */}
        {errorBanner && (
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
              {errorBanner.title}
            </Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 }}>
              {errorBanner.detail}
            </Text>
            <Pressable onPress={() => setErrorBanner(null)} hitSlop={10} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>
                Dismiss
              </Text>
            </Pressable>
          </View>
        )}

        {/* #770 MEDIUM 2: a lookup that never reached the server is not a miss.
            Keep Retry on screen after the transient alert is gone; Dismiss only
            starts a short same-label cooldown, not an indefinite lockout. */}
        {connectionError && (
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
              {CONNECTION_ERROR_TITLE}
            </Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 }}>
              {connectionError.detail}
            </Text>
            <View style={{ flexDirection: 'row', gap: 20, marginTop: 8 }}>
              <Pressable
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => {
                  const retryId = connectionError.rawIdentifier;
                  connectionErrorRef.current = null;
                  setConnectionError(null);
                  void resolveLot(retryId);
                }}
              >
                <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '900' }}>Retry</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                hitSlop={10}
                onPress={() => {
                  connectionErrorRef.current = {
                    value: connectionError.rawIdentifier,
                    at: Date.now(),
                  };
                  setConnectionError(null);
                  setBusy(false);
                }}
              >
                <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                  Dismiss
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {step === 'scan_lot' && (
          <>
            {device && (
              <View
                style={{
                  height: 320,
                  borderRadius: 12,
                  overflow: 'hidden',
                  marginTop: 12,
                }}
              >
                <Camera
                  ref={cameraRef}
                  style={{ flex: 1 }}
                  device={device}
                  isActive={cameraGate && (step === 'scan_lot' && !busy)}
                  codeScanner={qrScanner}
                />
                <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
                {focus.indicator}
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
              Or type a lot code:
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={manualEntry}
                onChangeText={setManualEntry}
                placeholder="RDW-000123 or supplier code"
                // textDim on surface = ~1.8:1 contrast — failed WCAG AA
                // and was hard to read against the warehouse glare.
                // textMuted is the lowest-allowed token for body text.
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
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
                returnKeyType="done"
                onSubmitEditing={() => manualEntry.trim() && resolveLot(manualEntry)}
              />
              <Pressable
                onPress={() => manualEntry.trim() && resolveLot(manualEntry)}
                disabled={!manualEntry.trim() || busy}
                style={{
                  paddingHorizontal: 18,
                  justifyContent: 'center',
                  backgroundColor: colors.primary,
                  borderRadius: 10,
                  opacity: !manualEntry.trim() || busy ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#000', fontWeight: '900' }}>Find</Text>
              </Pressable>
            </View>
          </>
        )}

        {step === 'confirm_lot' && lot && (
          <View style={{ marginTop: 16 }}>
            {/* 2026-08-14: putting a Harrison box onto a Dodge City shelf is a
                real transfer, and it happened silently. Warn BEFORE the bin is
                scanned — this is the last screen where backing out is free. */}
            <CrossWarehouseWarning
              lotWarehouseId={lot.warehouse_id}
              detail={`Moving it to ${activeWarehouse?.name ?? 'this building'} is a transfer. Type your name and pick why it is moving.`}
            />
            {isTransfer && (
              <View style={{ marginBottom: 12, gap: 8 }}>
                <TextInput
                  value={transferName}
                  onChangeText={setTransferName}
                  placeholder="Your name"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="words"
                  autoCorrect={false}
                  style={{
                    padding: 12,
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    borderWidth: 1,
                    borderRadius: 10,
                    color: colors.text,
                    fontSize: 16,
                  }}
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {transferReasonChoices(foreignWarehouse === 'another' ? null : foreignWarehouse).map((choice) => {
                    const on = transferPick === choice;
                    return (
                      <Pressable
                        key={choice}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        onPress={() => setTransferPick(choice)}
                        style={{
                          paddingVertical: 10,
                          paddingHorizontal: 12,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: on ? colors.primary : colors.border,
                          backgroundColor: on ? colors.primaryDim : colors.surface,
                        }}
                      >
                        <Text style={{ color: on ? colors.primary : colors.text, fontSize: 14, fontWeight: on ? '800' : '500' }}>
                          {choice}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {transferPick === OTHER_REASON && (
                  <TextInput
                    value={transferOther}
                    onChangeText={setTransferOther}
                    placeholder="Why is it moving?"
                    placeholderTextColor={colors.textMuted}
                    style={{
                      padding: 12,
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderWidth: 1,
                      borderRadius: 10,
                      color: colors.text,
                      fontSize: 16,
                    }}
                  />
                )}
              </View>
            )}
            <View
              style={{
                padding: 16,
                backgroundColor: colors.surface,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.primary, fontSize: 13, fontFamily: 'monospace', fontWeight: '900' }}>
                {lotDisplayCode(lot) ?? lot.lot_code}
              </Text>
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 4 }}>
                {lot.title}
              </Text>
              {lot.category && (
                <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>
                  {lot.category}
                </Text>
              )}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 10,
                }}
              >
                <View
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 999,
                    backgroundColor:
                      lot.status === 'pending_intake'
                        ? colors.primaryDim
                        : colors.successDim,
                  }}
                >
                  <Text
                    style={{
                      color:
                        lot.status === 'pending_intake' ? colors.primary : colors.success,
                      fontSize: 11,
                      fontWeight: '900',
                      letterSpacing: 0.6,
                    }}
                  >
                    {lot.status === 'pending_intake'
                      ? 'PENDING INTAKE'
                      : lot.status === 'in_inventory'
                        ? 'IN INVENTORY'
                        : lot.status.toUpperCase()}
                  </Text>
                </View>
                {lot.msrp_cents != null && (
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                    MSRP ${(lot.msrp_cents / 100).toFixed(2)}
                  </Text>
                )}
              </View>
            </View>
            <Pressable
              onPress={() => setStep('scan_bin')}
              disabled={isTransfer && !transferInputsReady(transferName, transferReason)}
              style={{
                marginTop: 14,
                padding: 14,
                backgroundColor: colors.primary,
                borderRadius: 10,
                opacity: isTransfer && !transferInputsReady(transferName, transferReason) ? 0.5 : 1,
              }}
            >
              <Text
                style={{
                  color: '#000',
                  textAlign: 'center',
                  fontSize: 14,
                  ...type.label,
                }}
              >
                {isTransfer ? `Transfer → scan a ${activeWarehouse?.name ?? ''} bin` : 'Continue → scan bin'}
              </Text>
            </Pressable>
            <Pressable
              onPress={reset}
              style={{
                marginTop: 8,
                padding: 14,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
                Wrong lot — rescan
              </Text>
            </Pressable>
          </View>
        )}

        {step === 'scan_bin' && (
          <View>
            {device && (
              <View style={{ height: 280, borderRadius: 12, overflow: 'hidden', marginTop: 12 }}>
                <Camera
                  ref={cameraRef}
                  style={{ flex: 1 }}
                  device={device}
                  isActive={cameraGate && (step === 'scan_bin' && !busy)}
                  codeScanner={qrScanner}
                />
                <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
                {focus.indicator}
              </View>
            )}
            <Text
              style={{
                color: colors.textMuted,
                fontSize: 12,
                marginTop: 12,
                textAlign: 'center',
              }}
            >
              or type the bin code below
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TextInput
                style={{
                  flex: 1,
                  padding: 14,
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 10,
                  color: colors.text,
                  fontSize: 16,
                  fontFamily: 'monospace',
                  textAlign: 'center',
                  letterSpacing: 1,
                }}
                placeholder="A-01"
                placeholderTextColor={colors.textMuted}
                autoCorrect={false}
                autoCapitalize="characters"
                value={manualBinCode}
                onChangeText={setManualBinCode}
                onSubmitEditing={() => manualBinCode.trim() && submitManualBin()}
                returnKeyType="done"
              />
              <Pressable
                onPress={() => manualBinCode.trim() && submitManualBin()}
                disabled={!manualBinCode.trim() || busy}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  backgroundColor: colors.primary,
                  borderRadius: 10,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: !manualBinCode.trim() || busy ? 0.5 : 1,
                  minWidth: 90,
                }}
              >
                <Text style={{ color: '#000', fontWeight: '900', fontSize: 14 }}>
                  Put away
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {step === 'submitting' && (
          <View style={{ alignItems: 'center', marginTop: 32 }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {step === 'done' && lastResult && (
          <View style={{ marginTop: 16 }}>
            <View
              style={{
                padding: 16,
                backgroundColor: colors.successDim,
                borderColor: colors.success,
                borderWidth: 1,
                borderRadius: 12,
              }}
            >
              <Text style={{ color: colors.success, fontSize: 13, ...type.label }}>
                {lastResult.alreadyHere ? '✓ Already in this bin' : lastResult.transferLine ? 'Transfer confirmed' : 'Intake confirmed'}
              </Text>
              <Text style={{ color: colors.text, marginTop: 6, fontSize: 14 }}>
                <Text style={{ fontFamily: 'monospace', fontWeight: '900' }}>
                  {/* `lot` (a ResolvedLot incl. sticker_code) is still set here —
                      reset() is the only thing that nulls it and it leaves 'done'.
                      Show the BRN to match the rest of the app; fall back to the
                      RPC's lot_code. */}
                  {(lot ? lotDisplayCode(lot) : null) ?? lastResult.lotCode}
                </Text>{' '}
                {lastResult.alreadyHere
                  ? `is already in bin ${lastResult.binCode} — no action needed.`
                  : lastResult.transferLine ?? `→ bin ${lastResult.binCode}`}
              </Text>
            </View>
            <Pressable
              onPress={reset}
              style={{
                marginTop: 16,
                padding: 14,
                backgroundColor: colors.primary,
                borderRadius: 10,
              }}
            >
              <Text
                style={{
                  color: '#000',
                  textAlign: 'center',
                  fontSize: 14,
                  ...type.label,
                }}
              >
                Intake another item
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
