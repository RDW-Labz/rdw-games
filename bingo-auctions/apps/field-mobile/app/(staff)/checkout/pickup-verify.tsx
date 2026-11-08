// Pickup verification — staff-mediated handoff flow.
//
// Steps:
//   1. scan_token   — Staff scans bidder's "bingo://pickup/<token>" QR
//                     shown in the bidder app's pickup detail screen.
//   2. confirm_id   — Display invoice + bidder details. Staff visually confirms
//                     the person in front of them matches the name on screen.
//   3. verify_lots  — Per-lot checklist. Staff can scan the bin QR for each
//                     lot to physically verify the right item is handed over.
//                     Auto-checks the lot when the scanned bin matches.
//                     Also has "Scan unknown item" mode (W6-P2) for wrong-
//                     customer detection during busy handoffs.
//   4. sign         — SVG path-drawing signature canvas (W6-P2). The rendered
//                     canvas is rasterised to a base64 PNG (renders in a RN
//                     <Image>, browser, AND PDF) and stored as a data URI in
//                     pickups.bidder_signature_url before the RPC fires, with
//                     the serialised SVG XML as a fallback.
//   5. submitting   — Calls staff_confirm_pickup RPC.
//   6. done         — Success / warning banner, then navigate home.
//                     Post-verify refund photo capture (W6-P2) shown here.
//
// Conventions: mirror apps/field-mobile/app/(staff)/picker/stage.tsx
//   - useBackCamera() for lens selection
//   - useTapToFocus() for tap-to-focus UX
//   - useCodeScanner from react-native-vision-camera v4
//   - QR_ONLY + firstCodeValue from @/lib/vision-camera
//   - Dark (#0b0d12) background throughout
//
// The bidder QR encodes:  bingo://pickup/<bidder_check_in_token UUID>
// If the QR cannot be parsed as that scheme, we fall back to treating the
// raw value as a bare UUID (for back-compat with any legacy QR format).
//
// W6-P2 additions:
//   Signature: react-native-signature-canvas is NOT in the project.
//   Instead we use React Native's PanResponder to track finger paths on
//   a <View> and render them into an SVG via react-native-svg (already
//   a dependency). On confirm we rasterise the rendered <Svg> to a base64
//   PNG via react-native-svg's built-in toDataURL (no new package) and store
//   it inline in pickups.bidder_signature_url as a data:image/png;base64,...
//   data URI — a PNG renders in a RN <Image>, the browser, AND a PDF receipt,
//   whereas an SVG data URI only renders in browsers/PDF. If rasterisation is
//   unavailable or fails we fall back to the serialised SVG XML
//   (data:image/svg+xml;base64,...) so capture can never fail. The
//   pickup-signatures bucket approach from 0079 is documented there but would
//   need a file upload; storing inline is a functionally equivalent,
//   zero-new-packages alternative.

import { useRef, useState, useCallback, useMemo, useEffect, memo, type MutableRefObject } from 'react';
import { ownerPickupStatus } from '@/lib/owner-pickup-status';
import {
  View,
  Text,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  TextInput,
  PanResponder,
  type GestureResponderEvent,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { Svg, Path } from 'react-native-svg';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { QR_ONLY, ALL_RETAIL_CODE_TYPES, firstCodeValue, TAKE_PHOTO_OPTIONS, safeFlash, translateCaptureError, type DecodedCode } from '@/lib/vision-camera';
import { resolveLotScan, type ScanRow } from '@/lib/resolve-lot-scan';
import { supabase } from '@auction-platform/supabase-client';
import {
  buildConfirmUniverse,
  checkoutLotLabel,
  planConfirmCodes,
  resolveCheckoutScan,
} from '@/lib/checkout-lot-label';
import { uploadImageFromUri } from '../../../lib/upload-image';
import { getFreshAccessToken, forceRefreshAccessToken } from '../../../lib/fresh-token';
import { callWithLoginRetry, STAFF_LOGIN_EXPIRED_TITLE, STAFF_LOGIN_EXPIRED_MESSAGE } from '@/lib/scan-login-retry';
import { fetchWithTimeout } from '../../../lib/fetch-with-timeout';
import * as Haptics from 'expo-haptics';
import { extractScanCandidates, type Symbology } from '@auction-platform/scan-extract';
import { RefundItemsSheet } from '../../../components/RefundItemsSheet';
import { WarehouseFilterChip } from '@/features/location/WarehouseFilterChip';
import { filterRowsByWarehouse } from '@/lib/warehouse-filter';

// ── Types ─────────────────────────────────────────────────────────────────────

type LotRow = {
  lot_id: string;
  lot_code: string | null;
  // mig 0185 surfaces sticker_code on lots; rendered via lotDisplayCode (BRN).
  sticker_code: string | null;
  display_code: string | null;
  // The lot sticker QR encodes https://bingoauctions.com/l/<qr_token>. Carried on the
  // row so a checkout lot-QR scan can be matched locally to the right item.
  qr_token: string | null;
  // 2026-07-10 (large-pickup feedback): staff scan whatever barcode is facing
  // them — often the product UPC, the Amazon LPN, or the FedEx tracking label
  // the box shipped back with — and the item IS on the order. Carry those
  // identifiers so the verify scan matches any of them, not just our sticker.
  upc: string | null;
  lpn: string | null;
  tracking_number: string | null;
  title: string;
  winning_bid_cents: number;
  bin_code: string | null;
  bin_id: string | null;
  assignment_status: 'unstaged' | 'staged' | 'picked_up';
  // 0217: invoice_lots.picked_up_at — set when a PRIOR partial round handed
  // this lot over. Covers never-staged (manual-checkout) lots that have no
  // bin_assignments flip to read.
  invoice_picked_up_at: string | null;
  // COMBINED CHECKOUT: the invoice this lot belongs to. One scan merges every
  // active order onto one screen, so per-lot writes (manual-checkout audit,
  // the confirm RPC grouping) must key on the lot's OWN invoice.
  invoice_id: string;
};

// One per-invoice entry inside the combined order group. RefundItemsSheet and
// the confirm RPC operate per invoice, so the group keeps the breakdown.
type OrderEntry = {
  invoice_id: string;
  total_cents: number;
  lot_count: number;
  /** The invoice's pickups row — missing-item outcomes key on
   *  (pickup_id, lot_id) (mig 0243). Null only if the row is absent. */
  pickup_id: string | null;
};

type InvoiceInfo = {
  // COMBINED CHECKOUT: one scan loads ALL of the bidder's active paid orders
  // onto a single screen. invoice_id stays as the FIRST order's id for the
  // places that need one representative id; per-lot / per-order writes use
  // lots[].invoice_id and orders[].
  invoice_id: string;
  orders: OrderEntry[];
  bidder_name: string | null;
  bidder_email: string;
  total_cents: number;
  lots: LotRow[];
  operator_id: string | null;
  // Membership perk 3 (staging & prep): true when this winning bidder holds an
  // active/trialing membership at this operator whose plan has staging_prep.
  // Read-only signal telling staff WHO gets the white-glove treatment — it does
  // NOT change any pickup_mode or write bin_assignments. (mig 0177 schema.)
  is_stage_prep: boolean;
};

/**
 * Membership perk 3 — does this (bidder, operator) pair have an active/trialing
 * membership whose plan has staging_prep=true? Pure read signal for the badge.
 *
 * RLS: bidder_subscriptions has an operator-staff read policy
 * (operator_id = current_operator_id(), mig 0013) and operator_pro_plans is
 * staff-readable for its operator (mig 0177), so this resolves under the
 * staff session. operator_pro_plans/plan_id arrive in mig 0177 — the generated
 * types in this worktree predate it, so the embed is read via an explicit cast
 * (consistent with this screen's other PostgREST reads).
 */
async function resolveStagePrep(
  bidderId: string | null | undefined,
  operatorId: string | null,
): Promise<boolean> {
  if (!bidderId || !operatorId) return false;
  const { data } = await supabase
    .from('bidder_subscriptions')
    .select('status, current_period_end, operator_pro_plans(staging_prep)')
    .eq('bidder_id', bidderId)
    .eq('operator_id', operatorId)
    .in('status', ['active', 'trialing'])
    .maybeSingle();
  const row = data as unknown as {
    status: string;
    current_period_end: string | null;
    operator_pro_plans: { staging_prep: boolean | null } | null;
  } | null;
  if (!row) return false;
  // Treat an expired period as no active membership (NULL = open-ended).
  if (row.current_period_end != null && new Date(row.current_period_end).getTime() <= Date.now()) {
    return false;
  }
  return row.operator_pro_plans?.staging_prep === true;
}

type LotVerifyState = {
  lot_id: string;
  lot_code: string | null;
  // Visible sticker code (e.g. BIN-000173) — matched when staff TYPE a code.
  sticker_code: string | null;
  display_code: string | null;
  // The lot sticker QR's qr_token UUID — matched when staff SCAN the lot QR.
  qr_token: string | null;
  // Item title — surfaced in the "✓ scanned" feedback banner so staff never
  // have to scroll the list to confirm what just checked off.
  title: string;
  // Alternate physical barcodes on the box (see LotRow): product UPC, Amazon
  // LPN, FedEx return tracking. Any of them checks the item off.
  upc: string | null;
  lpn: string | null;
  tracking_number: string | null;
  checked: boolean;
  bin_id: string | null; // expected bin for this lot
  // COMBINED CHECKOUT: which order this lot belongs to (confirm groups by it).
  invoice_id: string;
  // CHK-03: set when this lot was checked via the manual-checkout escape hatch
  // (QR unreadable) rather than a successful bin scan. Drives the "manual"
  // badge and is recorded in operator_audit_log server-side.
  manual_override?: boolean;
};

/**
 * #819: every invoice line the server resolves against — owed lines AND hidden
 * siblings (refunded / picked up / forfeited) that are not on the checklist.
 * Kept separately from `lotStates` so a confirmation code can be proved unique
 * against the whole invoice, not just the rows staff can see.
 */
type AliasLot = {
  lot_id: string;
  lot_code: string | null;
  sticker_code: string | null;
  display_code: string | null;
  invoice_id: string;
};

/**
 * #813: never pick one of several matching boxes. The counter is told which
 * physical labels collided so they can scan the item's own code instead.
 */
function ambiguousCheckoutCodeMessage(lots: LotVerifyState[], indices: number[]): string {
  const labels = indices
    .map((i) => lots[i])
    .filter((lot): lot is LotVerifyState => Boolean(lot))
    .map((lot) => lot.lot_code ?? lot.sticker_code ?? '?');
  return `That code matches ${labels.length} items on this order (${labels.join(
    ', ',
  )}). Scan or type the item's own lot code or sticker instead.`;
}

// CHK-01 / CHK-02 — the operator's checkout-flow policy, read from the
// PUBLISHED operator_policies row (mig 0193). Defaults preserve today's
// behavior when the row or columns are absent: identity always required,
// signature optional.
type CheckoutPolicy = {
  require_identity_check: boolean;
  identity_check_threshold_cents: number;
  require_signature: boolean;
};

const DEFAULT_CHECKOUT_POLICY: CheckoutPolicy = {
  require_identity_check: true,
  identity_check_threshold_cents: 0,
  require_signature: false,
};

// CHK-03 reason codes for a manual (QR-unreadable) checkout override.
const MANUAL_CHECKOUT_REASONS = [
  { value: 'damaged_qr', label: 'Damaged QR' },
  { value: 'missing_label', label: 'Missing label' },
  { value: 'not_staged', label: 'Not staged' },
  { value: 'scanner_failure', label: 'Scanner failure' },
] as const;

type ManualCheckoutReason = (typeof MANUAL_CHECKOUT_REASONS)[number]['value'];

// Result row from staff_search_bidder_invoices RPC.
type SearchResult = {
  invoice_id: string;
  bidder_id: string;
  display_name: string | null;
  email: string;
  status: string;
  total_cents: number;
  created_at: string;
  warehouse_id?: string | null;
};

// Result from scanning an unknown QR in "wrong-customer detection" mode.
type UnknownScanResult =
  | { kind: 'same_invoice' }
  | { kind: 'different_invoice'; bidder_label: string }
  | { kind: 'not_lotted' }
  | { kind: 'idle' };

type Step =
  | 'scan_token'
  | 'loading'
  | 'confirm_id'
  | 'verify_lots'
  | 'sign'
  | 'submitting'
  | 'done';

// SVG path recording types for the signature canvas.
type SvgPoint = { x: number; y: number };
type SvgStroke = SvgPoint[];

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNATURE_CANVAS_WIDTH = 320;
const SIGNATURE_CANVAS_HEIGHT = 160;
// Min squared distance (px²) between recorded points; drops sub-1.5px jitter.
const SIGNATURE_MIN_POINT_DISTANCE_SQ = 1.5 * 1.5;

// operator-web base URL — resolved the same way RefundItemsSheet does. React
// Native has no document origin, so the CHK-03 manual-checkout POST below MUST
// use an absolute URL. Used only to write the operator_audit_log override row
// (operator_audit_log has no client INSERT policy — service-role only).
const API_BASE = (
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'https://bingoauctions.com'
).replace(/\/$/, '');

// ── UUID / deep-link helpers ──────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractToken(raw: string): string | null {
  const trimmed = raw.trim();

  // bingo://pickup/<uuid>  or  pickup://<uuid>
  const deepLink = trimmed.match(/pickup[:/]+([0-9a-f-]{36})/i);
  if (deepLink?.[1] && UUID_RE.test(deepLink[1])) return deepLink[1];

  // bare UUID
  if (UUID_RE.test(trimmed)) return trimmed;

  // UUID anywhere in the string
  const anywhere = trimmed.match(/([0-9a-f-]{36})/i);
  if (anywhere?.[1] && UUID_RE.test(anywhere[1])) return anywhere[1];

  return null;
}

function extractBinToken(raw: string): string | null {
  // Bin QRs encode the bin qr_token UUID, possibly wrapped in a URI.
  const trimmed = raw.trim();
  const m = trimmed.match(UUID_RE) ?? trimmed.match(/([0-9a-f-]{36})/i);
  return m && UUID_RE.test(m[0]) ? m[0] : null;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * CHK-01 — does the operator's policy require the identity-confirmation step
 * for an invoice of this total? Identity is forced when require_identity_check
 * is true AND (threshold == 0 OR invoice total >= threshold). When false, the
 * scan auto-advances straight to lot verification.
 *
 * NOTE: there is no per-lot 'cage'/'high_value' attribute in the schema, so the
 * gate is on the invoice total only.
 */
function identityStepRequired(policy: CheckoutPolicy, invoiceTotalCents: number): boolean {
  if (!policy.require_identity_check) return false;
  if (policy.identity_check_threshold_cents <= 0) return true;
  return invoiceTotalCents >= policy.identity_check_threshold_cents;
}

// ── Signature helpers ─────────────────────────────────────────────────────────

/** Convert an array of strokes to an SVG path data string. */
function strokesToPathData(stroke: SvgStroke): string {
  if (stroke.length === 0) return '';
  const [first, ...rest] = stroke;
  if (!first) return '';
  const parts = [`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`];
  for (const pt of rest) {
    parts.push(`L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`);
  }
  return parts.join(' ');
}

/**
 * Serialise all strokes as a standalone SVG XML string, then base64-encode it
 * and return a data URI suitable for storage in `pickups.bidder_signature_url`.
 */
function strokesToDataUri(strokes: SvgStroke[], w: number, h: number): string {
  const paths = strokes
    .map((s) => `<path d="${strokesToPathData(s)}" stroke="#1a1a2e" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="background:#f8f8f0">${paths}</svg>`;
  // btoa is available in RN 0.74+ / Hermes.
  // encodeURIComponent → percent-decode to latin1 bytes so btoa works on
  // non-ASCII SVG content (e.g. any Unicode in lot titles if ever embedded).
  const b64 = btoa(
    encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );
  return `data:image/svg+xml;base64,${b64}`;
}

/**
 * Rasterise the rendered signature <Svg> to a base64 PNG data URI via
 * react-native-svg's built-in `toDataURL(callback, options?)`. Unlike an SVG
 * data URI, a PNG renders in a React Native <Image> (as well as web + PDF), so
 * a future receipt/pickup-proof screen can display the signature anywhere.
 *
 * Promisified + timeout-guarded so capture can NEVER hang or throw — resolves
 * null on any failure so the caller can fall back to the SVG string.
 */
function svgRefToPngDataUri(
  ref: MutableRefObject<Svg | null>,
  w: number,
  h: number,
  timeoutMs = 1500,
): Promise<string | null> {
  return new Promise((resolve) => {
    const svg = ref.current;
    if (!svg || typeof (svg as { toDataURL?: unknown }).toDataURL !== 'function') {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const t = setTimeout(() => done(null), timeoutMs);
    try {
      (svg as {
        toDataURL: (cb: (base64: string) => void, opts?: { width: number; height: number }) => void;
      }).toDataURL(
        (base64: string) => {
          clearTimeout(t);
          done(base64 ? `data:image/png;base64,${base64}` : null);
        },
        { width: w, height: h },
      );
    } catch {
      clearTimeout(t);
      done(null);
    }
  });
}

/**
 * Memoised layer for the already-committed (pen-lifted) strokes. Rendering these
 * in their own `memo`-wrapped component means they are NOT recomputed on every
 * `onPanResponderMove` tick — only the live stroke re-renders during a drag.
 * The `committedStrokes` array reference only changes on commit/clear, so this
 * subtree stays stable while the finger is down. (Fix for the per-move lag.)
 */
const CommittedSignatureLayer = memo(function CommittedSignatureLayer({
  strokes,
}: {
  strokes: SvgStroke[];
}) {
  return (
    <>
      {strokes.map((stroke, si) => {
        const pathData = strokesToPathData(stroke);
        if (!pathData) return null;
        return (
          <Path
            key={si}
            d={pathData}
            stroke="#1a1a2e"
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
    </>
  );
});

type CheckoutLotCodeFields = {
  lot_id: string;
  lot_code: string | null;
  sticker_code: string | null;
  display_code?: string | null;
};

function CheckoutLotCodeText({ lot }: { lot: CheckoutLotCodeFields }) {
  const { primary, secondary, noSticker } = checkoutLotLabel(lot);
  return (
    <>
      {primary}
      {secondary != null ? <Text style={s.lotCodeSecondary}> · {secondary}</Text> : null}
      {noSticker ? <Text style={s.noStickerFlag}> NO STICKER</Text> : null}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PickupVerifyScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const router = useRouter();
  const device = useBackCamera();

  // Read-only "as listed" view of the exact lot row that sold (title,
  // description, condition, photos) — tapping a lot row during checkout.
  const openAsListed = useCallback(
    (lotId: string, invoiceId: string) => {
      router.push(`/checkout/as-listed/${lotId}?invoiceId=${invoiceId}` as Href);
    },
    [router],
  );

  // Camera refs for the scan steps
  const tokenCamRef = useRef<Camera | null>(null);
  // verify_lots scans each item's LOT QR (sticker encodes
  // https://bingoauctions.com/l/<qr_token>) — NOT the bin QR (bin scanning is the
  // put-away flow). Replaced the per-lot bin camera on 2026-06-11.
  const verifyCamRef = useRef<Camera | null>(null);
  const unknownCamRef = useRef<Camera | null>(null);
  const refundCameraRef = useRef<Camera | null>(null);
  const tokenFocus = useTapToFocus(tokenCamRef);
  const verifyFocus = useTapToFocus(verifyCamRef);
  const unknownFocus = useTapToFocus(unknownCamRef);
  const refundFocus = useTapToFocus(refundCameraRef);

  // verify_lots: free-typed lot code (or sticker code) entry — the fallback
  // when the lot QR can't be scanned.
  const [lotCodeInput, setLotCodeInput] = useState('');

  // CHK-03: manual-checkout (QR-unreadable) override modal state.
  // manualLotIdx = the lot index whose override confirm modal is open (null =
  // closed). The bin-scan path stays the default; this is the visible exception.
  const [manualLotIdx, setManualLotIdx] = useState<number | null>(null);
  const [manualAcknowledged, setManualAcknowledged] = useState(false);
  const [manualReason, setManualReason] = useState<ManualCheckoutReason | null>(null);
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // W6-P2: "Scan unknown item" state
  const [unknownScanMode, setUnknownScanMode] = useState(false);
  const [unknownResult, setUnknownResult] = useState<UnknownScanResult>({ kind: 'idle' });

  // W6-P2: Signature canvas state.
  // committedStrokes = completed pen-lifts. liveStroke = current in-progress
  // stroke rendered live during the gesture. Keeping them separate avoids the
  // accumulation bug where onPanResponderMove appends the whole live stroke
  // to the committed array on every touch event.
  const [committedStrokes, setCommittedStrokes] = useState<SvgStroke[]>([]);
  const [liveStroke, setLiveStroke] = useState<SvgStroke | null>(null);
  // Ref holds the live path points so the PanResponder closure (created once
  // via useRef) can append without stale-closure issues.
  const currentStrokeRef = useRef<SvgPoint[]>([]);
  // On-screen origin of the canvas <View>, measured via measureInWindow. The
  // PanResponder captures pageX/pageY (screen-absolute, consistent across
  // iOS/Android) and subtracts this origin, instead of nativeEvent.locationX/Y
  // which on Android is relative to whichever CHILD is under the finger and so
  // jumps/offsets between the abs-fill <Svg> and the "Sign here" <Text>.
  const canvasRef = useRef<View | null>(null);
  const canvasOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Ref on the signature <Svg> so we can rasterise it to a PNG data URI via
  // react-native-svg's built-in toDataURL (no new dependency). It wraps the
  // committed-strokes layer + the live path, so it captures the whole signature.
  const signatureSvgRef = useRef<Svg | null>(null);
  // The page ScrollView steals vertical drags. We disable scrolling for the
  // duration of a signature gesture (set false on grant, true on release AND
  // terminate) so a drag draws instead of scrolls and never gets stuck off.
  const [scrollEnabled, setScrollEnabled] = useState(true);

  /** Re-measure the canvas origin (the ScrollView may have scrolled). */
  const measureCanvas = useCallback(() => {
    canvasRef.current?.measureInWindow((x, y) => {
      canvasOriginRef.current = { x, y };
    });
  }, []);

  /** All strokes including the live in-progress one — used for serialisation. */
  const signatureStrokes: SvgStroke[] = liveStroke
    ? [...committedStrokes, liveStroke]
    : committedStrokes;

  /** Path data for the single live (in-progress) stroke, rendered on its own. */
  const liveStrokePathData = useMemo(
    () => (liveStroke ? strokesToPathData(liveStroke) : ''),
    [liveStroke],
  );

  // W6-P2: Refund photo state (post-done)
  const [showRefundCapture, setShowRefundCapture] = useState(false);
  // PR-C (2026-05-29) — toggle for the per-lot refund sheet. Server is the
  // canonical gate (refund_window_post_pickup_hours, admin_can_refund_outside_window,
  // super-admin check); the sheet shows window status as guidance only.
  // Which order's refund sheet is open (invoice_id), or null when closed —
  // combined checkout can have several orders, each refunding separately.
  const [showRefundItems, setShowRefundItems] = useState<string | null>(null);
  const [refundPhotoUri, setRefundPhotoUri] = useState<string | null>(null);
  const [refundPhotoUploading, setRefundPhotoUploading] = useState(false);
  const [refundPhotoUrl, setRefundPhotoUrl] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('scan_token');
  const [busy, setBusy] = useState(false);

  // ── S12: customer-search fallback ──────────────────────────────────────────
  // Used when the bidder QR cannot be scanned (dark screen, dead battery, etc.)
  const [warehouseFilterId, setWarehouseFilterId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    [],
  );
  const [invoice, setInvoice] = useState<InvoiceInfo | null>(null);
  const [lotStates, setLotStates] = useState<LotVerifyState[]>([]);
  // #819: the full invoice alias universe — every line on the loaded orders,
  // including hidden siblings the checklist filters out. Used to prove a
  // confirmation code resolves to exactly the intended box on its own invoice.
  const aliasUniverseRef = useRef<AliasLot[]>([]);
  // 2026-07-10 (large-pickup feedback): instant, can't-miss scan confirmation.
  // Every successful check-off buzzes + shows a green "✓ <item>" banner pinned
  // above the camera — no scrolling a 50-item list to find the checkmark.
  const [lastScanFeedback, setLastScanFeedback] = useState<
    { kind: 'ok' | 'dupe'; title: string } | null
  >(null);

  // Option 1 checkout refund (2026-07-13): when set, an inline RefundItemsSheet
  // pre-scoped to this single lot is shown so staff can refund an item without
  // leaving checkout or hunting for the invoice. Opened from the per-scan
  // Pick Up / Refund / Hold prompt and the per-lot "Refund this item" action.
  const [scanRefundLot, setScanRefundLot] = useState<{
    invoiceId: string;
    lot: {
      lot_id: string;
      lot_code: string | null;
      sticker_code: string | null;
      display_code: string | null;
      title: string;
      winning_bid_cents: number;
    };
  } | null>(null);
  // COMBINED CHECKOUT: one scan loads ALL a bidder's active orders onto ONE
  // verify screen (per-order iteration — "Order 1 of 2" — tested worse at the
  // real counter, Jared retest 2026-07-06). Per-order breakdown lives in
  // invoice.orders; confirm groups checked lots by lots[].invoice_id.
  // Operator's post-pickup refund window. null = not yet loaded.
  // 0 = all sales final; >0 = N-hour window.
  const [refundWindowHours, setRefundWindowHours] = useState<number | null>(null);
  // ── Missing items (mig 0243, Jared build-6 feedback) ──────────────────────
  // Lots the staffer marked "can't find it" this visit (or a prior one).
  // Writing pickup_lot_outcomes drops the lot into the dashboard's
  // "Missing items awaiting refund" queue — the refund itself stays a manager
  // action there, so counter staff never need dashboard access.
  const [missingLotIds, setMissingLotIds] = useState<Set<string>>(new Set());
  const [missingBusyLotId, setMissingBusyLotId] = useState<string | null>(null);
  // CHK-01 / CHK-02 — operator's checkout-flow policy. Defaults preserve
  // today's behavior until the published row loads.
  const [checkoutPolicy, setCheckoutPolicy] = useState<CheckoutPolicy>(
    DEFAULT_CHECKOUT_POLICY,
  );
  const [rpcResult, setRpcResult] = useState<{
    pickup_id: string;
    lots_picked: number;
    warning: string | null;
  } | null>(null);

  // ── Step 1: scan bidder token QR ─────────────────────────────────────────

  // SCANNER-LOOP fix (2026-06-11): the token scanner fires ~10 frames/sec. With
  // only the busy/step guard, a QR that fails to resolve (a partial frame, a
  // non-pickup QR, or a just-completed pickup still in view after "Verify
  // another pickup") re-triggered onTokenScan every frame and stacked Alert
  // modals until the app had to be force-quit. Two refs break the storm:
  //   scanLockRef       — held true while an alert is up; cleared on dismiss.
  //   lastTokenScanRef  — suppresses the SAME decoded value within a cooldown.
  const scanLockRef = useRef(false);
  const lastTokenScanRef = useRef<{ value: string; at: number } | null>(null);
  const SCAN_DEDUP_MS = 2500;

  // verify_lots lot-QR scanner guards — same storm-prevention idiom as the
  // token scanner above. verifyScanLockRef is held while an Alert is up;
  // lastVerifyScanRef suppresses the SAME decoded value within SCAN_DEDUP_MS.
  const verifyScanLockRef = useRef(false);
  const lastVerifyScanRef = useRef<{ value: string; at: number } | null>(null);

  const tokenScanner = useCodeScanner({
    codeTypes: QR_ONLY,
    onCodeScanned: (codes) => {
      if (busy || step !== 'scan_token' || scanLockRef.current) return;
      const c = firstCodeValue(codes);
      if (!c) return;
      const prev = lastTokenScanRef.current;
      const nowMs = Date.now();
      if (prev && prev.value === c.data && nowMs - prev.at < SCAN_DEDUP_MS) return;
      lastTokenScanRef.current = { value: c.data, at: nowMs };
      void onTokenScan(c);
    },
  });

  async function onTokenScan(scan: DecodedCode) {
    if (busy) return;
    const token = extractToken(scan.data);
    if (!token) {
      // Lock the scanner while the alert is up so per-frame scans don't restack it.
      scanLockRef.current = true;
      Alert.alert(
        'Not a pickup QR',
        'Could not read a pickup token. Ask the bidder to show their pickup QR from the BinGo Auctions app.',
        [{ text: 'OK', onPress: () => { scanLockRef.current = false; } }],
      );
      return;
    }

    setBusy(true);
    setStep('loading');

    // A pickup QR never expires; the STAFF sign-in can (idle device). Refresh
    // it first when it's near expiry, and retry once on a stale-JWT failure, so
    // a dead staff token is never shown as the customer's code failing (10-13).
    await getFreshAccessToken();
    const { data, error, loginExpired } = await callWithLoginRetry(
      async () => supabase.rpc('staff_scan_bidder_token', { p_token: token }),
      forceRefreshAccessToken,
    );
    if (loginExpired) {
      setBusy(false);
      scanLockRef.current = true;
      Alert.alert(STAFF_LOGIN_EXPIRED_TITLE, STAFF_LOGIN_EXPIRED_MESSAGE, [{ text: 'OK', onPress: () => { scanLockRef.current = false; } }]);
      setStep('scan_token');
      return;
    }
    if (error) {
      setBusy(false);
      scanLockRef.current = true;
      Alert.alert('Lookup failed', error.message ?? 'Try again.', [{ text: 'OK', onPress: () => { scanLockRef.current = false; } }]);
      setStep('scan_token');
      return;
    }
    const res = data as {
      ok: boolean; reason?: string;
      bidder?: { id: string; name: string | null; email: string | null };
      pickups?: Array<{ invoice_id: string }>;
      total_lots?: number;
    } | null;
    if (!res?.ok) {
      setBusy(false);
      scanLockRef.current = true;
      const msg = res?.reason === 'other_operator'
        ? 'This pickup QR belongs to another auctioneer.'
        : 'No active pickup matched this QR. Try again or ask the bidder to refresh their app.';
      Alert.alert('Token not found', msg, [{ text: 'OK', onPress: () => { scanLockRef.current = false; } }]);
      setStep('scan_token');
      return;
    }
    const pickups = res.pickups ?? [];
    if (pickups.length === 0) {
      setBusy(false);
      scanLockRef.current = true;
      Alert.alert('Nothing to pick up', `No active orders found for ${res.bidder?.name ?? 'this bidder'}.`, [{ text: 'OK', onPress: () => { scanLockRef.current = false; } }]);
      setStep('scan_token');
      return;
    }
    await loadInvoices(pickups.map((p) => p.invoice_id), res.bidder?.name ?? null, res.bidder?.email ?? '');
  }

  // Shared invoice loader — COMBINED CHECKOUT: loads every given invoice and
  // merges all their lots onto one verify screen. Callers set
  // busy(true)+step('loading') first; this owns the try/finally(setBusy(false))
  // and the terminal setStep. `displayName`/`email` override the RLS-blocked
  // bidders embed (staff can't read bidders directly).
  async function loadInvoices(invoiceIds: string[], displayName: string | null, email: string) {
    try {
      const { data: invData, error: invErr } = await supabase
        .from('invoices')
        .select(`
          id,
          bidder_id,
          status,
          operator_id,
          bidders ( display_name, email ),
          invoice_lots (
            lot_id,
            winning_bid_cents,
            picked_up_at,
            refunded_at,
            forfeited_at,
            lots ( id, title, lot_code, sticker_code, display_code, qr_token, upc, lpn, intake_bin_id,
                   intake_bin:bins!lots_intake_bin_id_fkey(code),
                   import_row:import_rows!lots_import_row_id_fkey(tracking_number) )
          )
        `)
        .in('id', invoiceIds);

      type InvRow = {
        id: string;
        bidder_id: string;
        status: string;
        operator_id: string | null;
        bidders: { display_name: string | null; email: string } | null;
        invoice_lots: Array<{
          lot_id: string;
          winning_bid_cents: number;
          // 0217: per-lot handover stamp — set by a prior partial pickup.
          picked_up_at: string | null;
          // 0245: per-lot refund stamp — a refunded lot is no longer owed.
          refunded_at: string | null;
          // No-show / write-off stamp — also ends the obligation.
          forfeited_at: string | null;
          lots: {
            id: string;
            title: string;
            lot_code: string | null;
            sticker_code: string | null;
            display_code: string | null;
            // Lot sticker QR encodes https://bingoauctions.com/l/<qr_token> — used to
            // match a checkout lot-QR scan to this row.
            qr_token: string | null;
            upc: string | null;
            lpn: string | null;
            intake_bin_id: string | null;
            // Put-away/intake shelf — H3 fallback when nothing is staged.
            intake_bin: { code: string | null } | null;
            // The manifest row the lot was minted from — its FedEx return
            // tracking is often the only barcode left on the box at pickup.
            import_row: { tracking_number: string | null } | null;
          } | null;
        }>;
      };
      const fetched = (invData ?? []) as unknown as InvRow[];
      if (invErr || fetched.length === 0) {
        Alert.alert('Invoice not found', invErr?.message ?? 'Could not load invoice details.');
        setStep('scan_token');
        return;
      }

      // The scan RPC returns paid + partially_refunded invoices (0245 — a
      // partial refund leaves the un-refunded lots owed); the search path can
      // hand us an unpaid one. Proceed with the collectable subset, alert
      // only when NOTHING is payable.
      const invoicesData = invoiceIds
        .map((id) => fetched.find((r) => r.id === id))
        .filter(
          (r): r is InvRow =>
            Boolean(r) && (r!.status === 'paid' || r!.status === 'partially_refunded'),
        );
      if (invoicesData.length === 0) {
        const st = fetched[0]?.status ?? 'unknown';
        Alert.alert('Invoice not paid', `Invoice status is "${st}". Pickup cannot proceed.`);
        setStep('scan_token');
        return;
      }

      // A line is OWED only if it is still outstanding. Three stamps end it:
      //
      //   refunded_at   (0245) the office refunded it
      //   picked_up_at  the customer already took it
      //   forfeited_at  the no-show sweep wrote it off
      //
      // Only `refunded_at` was checked. So an item handed over on an earlier
      // visit came back on the next one and staff were asked to find it again
      // — 127 such lines in prod, and the reason months-old July visits were
      // still showing items on 2026-08-27 (owner report, with photos). It is
      // also the client half of a staff member's "customer already picked these up"
      // report: the data was repaired, but the screen would have re-created
      // the same confusion on the next mismatch.
      const isOwedLine = (il: {
        refunded_at: string | null;
        picked_up_at: string | null;
        forfeited_at?: string | null;
      }) => il.refunded_at == null && il.picked_up_at == null && il.forfeited_at == null;

      const allInvoiceLots = invoicesData.flatMap((inv) =>
        inv.invoice_lots.filter(isOwedLine).map((il) => ({ ...il, invoice_id: inv.id })),
      );
      // #819: keep the complete alias universe for confirmation-code resolution.
      // The checklist below only carries OWED lines; 0487/0509 resolve against
      // every invoice line, so hidden siblings must stay in view when choosing a
      // code that resolves to exactly the intended box.
      aliasUniverseRef.current = invoicesData.flatMap((inv) =>
        inv.invoice_lots.map((il) => ({
          lot_id: il.lot_id,
          lot_code: il.lots?.lot_code ?? null,
          sticker_code: il.lots?.sticker_code ?? null,
          display_code: il.lots?.display_code ?? null,
          invoice_id: inv.id,
        })),
      );
      const lotIds = allInvoiceLots.map((il) => il.lot_id);

      // Fetch latest bin assignments for these lots
      const { data: assignments } = lotIds.length
        ? await supabase
            .from('bin_assignments')
            .select('lot_id, bin_id, status, assigned_at, bins(code)')
            .in('lot_id', lotIds)
            .order('assigned_at', { ascending: false })
        : { data: [] };

      const latestByLot = new Map<
        string,
        { bin_id: string; status: string; bin_code: string | null }
      >();
      // bin_assignments.bins is returned as an array from the Supabase
      // PostgREST embed even though the FK is to a single row — pick [0].
      const rawAssignments = (assignments ?? []) as Array<{
        lot_id: string;
        bin_id: string;
        status: string;
        bins: { code: string } | { code: string }[] | null;
      }>;
      for (const a of rawAssignments) {
        const bin = Array.isArray(a.bins) ? a.bins[0] ?? null : a.bins;
        if (!latestByLot.has(a.lot_id)) {
          latestByLot.set(a.lot_id, {
            bin_id: a.bin_id,
            status: a.status,
            bin_code: bin?.code ?? null,
          });
        }
      }

      const lots: LotRow[] = allInvoiceLots.map((il) => {
        const a = latestByLot.get(il.lot_id);
        const importRow = Array.isArray(il.lots?.import_row)
          ? (il.lots?.import_row[0] as { tracking_number: string | null } | undefined)
          : il.lots?.import_row;
        return {
          lot_id: il.lot_id,
          lot_code: il.lots?.lot_code ?? null,
          sticker_code: il.lots?.sticker_code ?? null,
          display_code: il.lots?.display_code ?? null,
          qr_token: il.lots?.qr_token ?? null,
          upc: il.lots?.upc ?? null,
          lpn: il.lots?.lpn ?? null,
          tracking_number: importRow?.tracking_number ?? null,
          title: il.lots?.title ?? 'Lot',
          winning_bid_cents: il.winning_bid_cents,
          invoice_picked_up_at: il.picked_up_at ?? null,
          invoice_id: il.invoice_id,
          // H3: prefer the staging bin; fall back to the put-away/intake bin
          // (lots.intake_bin_id) so staff see the storage shelf even when the
          // lot was never staged (counter_pickup / self_serve handoffs).
          bin_code: a?.bin_code ?? il.lots?.intake_bin?.code ?? null,
          bin_id: a?.bin_id ?? null,
          assignment_status: !a
            ? 'unstaged'
            : a.status === 'picked_up'
            ? 'picked_up'
            : 'staged',
        };
      });

      const total = lots.reduce((s, l) => s + l.winning_bid_cents, 0);
      // Pickup ids + any already-recorded missing outcomes for these orders —
      // the "mark missing" workflow (mig 0243) writes pickup_lot_outcomes
      // directly (staff RLS policy), so badges must survive a rescan.
      const { data: pickupIdRows } = await supabase
        .from('pickups')
        .select('id, invoice_id')
        .in('invoice_id', invoicesData.map((inv) => inv.id));
      const pickupIdByInvoice = new Map(
        ((pickupIdRows ?? []) as Array<{ id: string; invoice_id: string }>).map((r) => [
          r.invoice_id,
          r.id,
        ]),
      );
      const pickupIds = Array.from(pickupIdByInvoice.values());
      const { data: outcomeRows } = pickupIds.length
        ? await supabase
            .from('pickup_lot_outcomes')
            .select('lot_id, outcome')
            .in('pickup_id', pickupIds)
            .eq('outcome', 'missing')
        : { data: [] };
      setMissingLotIds(
        new Set(
          ((outcomeRows ?? []) as Array<{ lot_id: string }>).map((r) => r.lot_id),
        ),
      );

      const orders: OrderEntry[] = invoicesData.map((inv) => {
        // Count only still-owed line items so the per-order header matches the
        // list staff actually verify. Same three stamps as isOwedLine above.
        const owed = inv.invoice_lots.filter(
          (il) => il.refunded_at == null && il.picked_up_at == null && il.forfeited_at == null,
        );
        return {
          invoice_id: inv.id,
          total_cents: owed.reduce((s, il) => s + il.winning_bid_cents, 0),
          lot_count: owed.length,
          pickup_id: pickupIdByInvoice.get(inv.id) ?? null,
        };
      });

      // Fetch operator refund window so we can display it at confirm_id.
      // Fall back to 48 if the policy row is missing (matches the DB default).
      // All of a bidder's invoices belong to the one operator (single-operator
      // platform), so the first row's operator drives policy + stage-prep.
      const first = invoicesData[0]!;
      const operatorId = first.operator_id ?? null;
      // Read the operator's PUBLISHED policy row (operator_policies is
      // versioned — mirror /api/invoices/[id]/refund-items: published=true,
      // newest version). Pulls the refund window (display) AND the CHK-01/02
      // checkout-flow columns (mig 0193) in one round-trip.
      let policyForFlow: CheckoutPolicy = DEFAULT_CHECKOUT_POLICY;
      if (operatorId) {
        const { data: policy } = await supabase
          .from('operator_policies')
          .select(
            'refund_window_post_pickup_hours, require_identity_check, identity_check_threshold_cents, require_signature',
          )
          .eq('operator_id', operatorId)
          .eq('published', true)
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle();
        const row = policy as {
          refund_window_post_pickup_hours?: number;
          require_identity_check?: boolean;
          identity_check_threshold_cents?: number;
          require_signature?: boolean;
        } | null;
        setRefundWindowHours(row?.refund_window_post_pickup_hours ?? 48);
        policyForFlow = {
          require_identity_check: row?.require_identity_check ?? true,
          identity_check_threshold_cents: row?.identity_check_threshold_cents ?? 0,
          require_signature: row?.require_signature ?? false,
        };
      } else {
        setRefundWindowHours(48);
      }
      setCheckoutPolicy(policyForFlow);

      // Membership perk 3: flag the white-glove (stage & prep) badge.
      const isStagePrep = await resolveStagePrep(first.bidder_id, operatorId);

      setInvoice({
        invoice_id: first.id,
        orders,
        // #2 fix: prefer the RPC-supplied name/email (bypasses RLS); fall back
        // to the embedded bidders row in case search path supplies null/empty.
        bidder_name: displayName ?? first.bidders?.display_name ?? null,
        bidder_email: email || first.bidders?.email || '',
        total_cents: total,
        lots,
        operator_id: operatorId,
        is_stage_prep: isStagePrep,
      });

      setLotStates(
        lots.map((l) => ({
          lot_id: l.lot_id,
          lot_code: l.lot_code,
          sticker_code: l.sticker_code,
          display_code: l.display_code,
          qr_token: l.qr_token,
          title: l.title,
          upc: l.upc,
          lpn: l.lpn,
          tracking_number: l.tracking_number,
          // Pre-check lots already handed over — bin flip OR the 0217
          // invoice_lots stamp (covers never-staged manual-checkout lots
          // from a prior partial round).
          checked: l.assignment_status === 'picked_up' || l.invoice_picked_up_at != null,
          bin_id: l.bin_id,
          invoice_id: l.invoice_id,
        })),
      );

      // CHK-01: only force the identity step when the operator's policy
      // requires it for this invoice total. Otherwise auto-advance straight
      // to lot verification.
      setStep(identityStepRequired(policyForFlow, total) ? 'confirm_id' : 'verify_lots');
    } finally {
      setBusy(false);
    }
  }

  // ── S12: customer search — calls staff_search_bidder_invoices RPC ──────────
  // Debounced: fires 400 ms after the user stops typing. The RPC returns
  // 0 rows (no error) for queries < 2 chars, so we skip the call entirely.

  function onSearchChange(q: string) {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => void runSearch(q.trim()), 400);
  }

  async function runSearch(q: string) {
    setSearchBusy(true);
    try {
      const { data, error } = await supabase.rpc('staff_search_bidder_invoices', {
        p_query: q,
      });
      if (error) {
        // Surface to dev; in prod this is a non-fatal degradation.
        console.warn('[S12 search] RPC error:', error.message);
        setSearchResults([]);
        return;
      }
      const base = (data as SearchResult[]) ?? [];
      if (base.length === 0) {
        setSearchResults([]);
        return;
      }
      const { data: pickupRows } = await supabase
        .from('pickups')
        .select('invoice_id, warehouse_id')
        .in('invoice_id', base.map((r) => r.invoice_id));
      const whByInvoice = new Map(
        (pickupRows ?? []).map((p) => [p.invoice_id as string, p.warehouse_id as string | null]),
      );
      setSearchResults(
        base.map((r) => ({
          ...r,
          warehouse_id: whByInvoice.get(r.invoice_id) ?? null,
        })),
      );
    } finally {
      setSearchBusy(false);
    }
  }

  // Called when the user taps a search result.
  //
  // 2026-08-14: "If a customer's phone is dead or their QR code will not scan,
  // searching their name and selecting an invoice only opens that single
  // invoice. It does not combine all of their invoices like the QR checkout
  // does. I had to search the customer's name again for every invoice, which
  // made checkout take much longer."
  //
  // This used to load exactly [result.invoice_id] on the assumption that
  // picking a specific invoice meant wanting only that one. But the two paths
  // reach the same counter with the same customer standing at it — the QR path
  // merges every active order onto one screen, and the name path is the
  // FALLBACK used precisely when the QR won't scan. Making the fallback slower
  // than the happy path is backwards.
  //
  // So the tapped invoice now just identifies the BIDDER, and we load every
  // paid order they have. 'paid' matches staff_search_bidder_invoices (0173)
  // and the QR path — staff are fulfilling pickups, not browsing.
  async function onSearchResultPress(result: SearchResult) {
    if (busy) return;
    setBusy(true);
    setStep('loading');
    setSearchQuery('');
    setSearchResults([]);

    // Best-effort: if this lookup fails we still open the invoice they tapped,
    // because a degraded single-invoice checkout beats no checkout at the
    // counter. RLS scopes invoices to the caller's operator.
    let invoiceIds = [result.invoice_id];
    try {
      const { data: siblings, error: sibErr } = await supabase
        .from('invoices')
        .select('id')
        .eq('bidder_id', result.bidder_id)
        .eq('status', 'paid')
        .order('created_at', { ascending: true });
      if (!sibErr && siblings && siblings.length > 0) {
        const ids = siblings.map((r) => r.id as string);
        // Keep the tapped invoice even if it somehow fell outside the filter,
        // and de-dupe so loadInvoices never merges the same order twice.
        invoiceIds = Array.from(new Set([...ids, result.invoice_id]));
      }
    } catch {
      // Fall through with the single tapped invoice.
    }

    await loadInvoices(invoiceIds, result.display_name, result.email);
  }

  // ── Step 3: verify each item by scanning its LOT QR (or typing its code) ───
  // The item's lot sticker encodes https://bingoauctions.com/l/<qr_token>. We match
  // the scanned/extracted qr_token against the invoice's own lot rows entirely
  // CLIENT-SIDE — no bin lookup. (Bin scanning is the put-away flow; scanning
  // the bin at checkout was a coding mistake.) One always-on camera serves the
  // whole step; the matched row is checked off.

  const verifyLotScanner = useCodeScanner({
    // BinGo's pre-printed roll labels (BRN/GRA/TEA… stored as lot_code) are
    // Code128 / UPC, NOT QR — a QR-only decoder never read them at checkout, so
    // PR #311's prefix-strip match was correct but unreachable. Accept all retail
    // symbologies, matching the put-away scanner. (The onVerifyLotScan matcher
    // already resolves qr_token / lot_code / stickerLabel, so no logic change.)
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      if (busy || step !== 'verify_lots' || unknownScanMode || verifyScanLockRef.current) {
        return;
      }
      const c = firstCodeValue(codes);
      if (!c) return;
      const prev = lastVerifyScanRef.current;
      const nowMs = Date.now();
      if (prev && prev.value === c.data && nowMs - prev.at < SCAN_DEDUP_MS) return;
      lastVerifyScanRef.current = { value: c.data, at: nowMs };
      void onVerifyLotScan(c);
    },
  });

  // 2026-08-14: "When a lot code is typed into manual checkout instead of
  // scanned, it does not show the same Pickup, Refund or Leave options that
  // appear when the item is scanned."
  //
  // It didn't, because this prompt lived inline in the SCAN handler and the
  // typed path (checkOffByCode) just flipped `checked` and moved on. So typing
  // a code silently committed a pick-up: a customer refusing a damaged item at
  // the counter had no refund option unless their QR happened to scan, which is
  // precisely the situation where it doesn't.
  //
  // Extracted so both paths call ONE prompt. It stays the single definition of
  // what staff may do with an item at the counter — a future fourth option
  // cannot reach one entry point and miss the other.
  //
  // verifyScanLockRef is held for the typed path too: the verify camera is live
  // behind this screen, and an unlocked scanner can restack the alert under it.
  const promptItemDisposition = useCallback(
    (idx: number, matched: LotVerifyState) => {
      verifyScanLockRef.current = true;
      const matchedLot = invoice?.lots.find((l) => l.lot_id === matched.lot_id);
      Alert.alert(
        matched.title,
        'What are you doing with this item?',
        [
          {
            text: 'Pick up',
            onPress: () => {
              verifyScanLockRef.current = false;
              setLastScanFeedback({ kind: 'ok', title: matched.title });
              setLotStates((prev) =>
                prev.map((ls, i) => (i === idx ? { ...ls, checked: true } : ls)),
              );
            },
          },
          {
            text: 'Refund',
            onPress: () => {
              verifyScanLockRef.current = false;
              setScanRefundLot({
                invoiceId: matched.invoice_id,
                lot: {
                  lot_id: matched.lot_id,
                  lot_code: matched.lot_code,
                  sticker_code: matched.sticker_code,
                  display_code: matched.display_code,
                  title: matched.title,
                  winning_bid_cents: matchedLot?.winning_bid_cents ?? 0,
                },
              });
            },
          },
          {
            // Hold = leave the lot unchecked. It stays owed and can be picked
            // up later via the partial-pickup path — no dedicated state needed.
            text: 'Hold / later',
            style: 'cancel',
            onPress: () => {
              verifyScanLockRef.current = false;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            },
          },
        ],
        { cancelable: false },
      );
    },
    [invoice],
  );

  const onVerifyLotScan = useCallback(
    async (scan: DecodedCode) => {
      if (busy || verifyScanLockRef.current) return;
      // extractBinToken pulls the qr_token UUID out of the /l/<qr_token> sticker
      // URL — the same helper onUnknownItemScan uses for lot stickers. This is
      // what operator-web PDF stickers (https://bingoauctions.com/l/<qr_token>) encode.
      const token = extractBinToken(scan.data);

      // 1) qr_token match (operator-web PDF sticker URLs).
      let idx = token ? lotStates.findIndex((ls) => ls.qr_token && ls.qr_token === token) : -1;

      // 2) Expand the raw scan into alternate candidates FIRST, then resolve the
      // raw string and the alternates TOGETHER. #819: the direct sticker match
      // used to short-circuit before the UPC/LPN/tracking guard ran, so a scan
      // that named one box's sticker and a different box's LPN selected the
      // first without noticing the collision. `resolveCheckoutScan` refuses
      // when the two namespaces name different boxes.
      //
      // 2026-07-10: staff scan whatever faces them — the product UPC, the Amazon
      // LPN, or the FedEx return-tracking label — and the item IS on the order.
      // Expand the scan like QuickLot does (composite barcodes carry the
      // 12-digit tracking as a suffix).
      let candidates: string[] = [scan.data];
      try {
        candidates = extractScanCandidates(
          scan.data,
          (scan.type ?? 'unknown') as Symbology,
        ).candidates;
      } catch {
        // extraction is best-effort — the raw value alone still probes below.
      }
      const digits = scan.data.replace(/\D/g, '');
      if (digits.length > 12 && !candidates.includes(digits.slice(-12))) {
        candidates = [...candidates, digits.slice(-12)];
      }
      // FedEx 2D block (PDF417/DataMatrix): the tracking sits as an interior
      // digit field in an ANSI payload — harvest every long digit run too.
      for (const run of scan.data.match(/\d{12,}/g) ?? []) {
        for (const c of [run, run.slice(-12)]) {
          if (!candidates.includes(c)) candidates = [...candidates, c];
        }
      }

      // 3) Direct lot_code/sticker/display codes and alternate physical barcodes.
      if (idx === -1) {
        const scanMatch = resolveCheckoutScan(lotStates, scan.data, candidates);
        if (scanMatch.kind === 'ambiguous') {
          // #813/#816/#819: refuse before selecting a line. Submitting one
          // line's canonical lot_code would hide the ambiguity from 0509, and a
          // cross-namespace collision would stamp the wrong box without it.
          verifyScanLockRef.current = true;
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
          Alert.alert(
            'Code matches more than one item',
            ambiguousCheckoutCodeMessage(lotStates, scanMatch.indices),
            [{ text: 'OK', onPress: () => { verifyScanLockRef.current = false; } }],
          );
          return;
        }
        if (scanMatch.kind === 'unique') idx = scanMatch.index;
      }

      // Nothing on THIS order matched — identify whose item it is so staff can
      // redirect the box without leaving the screen (mig 0257).
      if (idx === -1) {
        verifyScanLockRef.current = true;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        let alertTitle = 'Not on this order';
        let alertMsg = "That code isn't on this customer's invoice.";
        try {
          const { data } = await supabase.rpc('staff_scan_lot_owner', {
            p_candidates: candidates,
          });
          const info = data as {
            ok?: boolean;
            lot?: { lot_code?: string | null; title?: string | null; status?: string | null };
            owner?: {
              bidder_name?: string | null;
              bidder_number?: number | null;
              auction_title?: string | null;
              invoice_id?: string | null;
              invoice_status?: string | null;
              picked_up_at?: string | null;
              refunded_at?: string | null;
              pickup_status?: string | null;
              pickup_completed_at?: string | null;
            } | null;
          } | null;
          if (info?.ok && info.lot) {
            const lotLabel = [info.lot.title, info.lot.lot_code].filter(Boolean).join(' · ');
            if (info.owner) {
              const o = info.owner;
              // 0476 / 2026-10-28: same wording as Lot Lookup and Relot.
              const status = ownerPickupStatus(o);
              alertTitle = 'Different customer’s item';
              alertMsg =
                `${lotLabel}\n\n` +
                `Belongs to: ${o.bidder_name ?? 'Unknown'}` +
                (o.bidder_number != null ? ` (Bidder #${o.bidder_number})` : '') +
                (o.auction_title ? `\nAuction: ${o.auction_title}` : '') +
                `\nStatus: ${status}` +
                (o.invoice_id ? `\nInvoice: …${o.invoice_id.slice(-8)}` : '');
            } else {
              alertTitle = 'Not sold to anyone';
              alertMsg = `${lotLabel}\n\nThis item has no invoice (lot status: ${info.lot.status ?? 'unknown'}).`;
            }
          }
        } catch {
          // Lookup is best-effort — fall back to the generic copy.
        }
        Alert.alert(alertTitle, alertMsg, [
          { text: 'OK', onPress: () => { verifyScanLockRef.current = false; } },
        ]);
        return;
      }

      const matched = lotStates[idx];
      if (!matched) return;

      // Already checked → tell staff loudly (double-scan on a big order feels
      // identical to a fresh scan otherwise) but don't restack alerts.
      if (matched.checked) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        setLastScanFeedback({ kind: 'dupe', title: matched.title });
        return;
      }

      // Option 1 (2026-07-13): on a fresh match, let staff choose what's
      // happening with the item right at the scan — Pick up / Refund / Hold —
      // so a defective/unwanted item is refunded without leaving checkout.
      // Lock the scanner while the prompt is open so the ~10fps camera loop
      // doesn't restack the alert.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      promptItemDisposition(idx, matched);
    },
    [busy, lotStates, promptItemDisposition],
  );

  // Free-typed lot-code / sticker-code entry — the fallback when the lot QR
  // can't be scanned. Matches lot_code OR sticker_code (case-insensitive), and
  // #819 also cross-checks the alternate physical barcodes so a typed code
  // cannot silently select one box when it also names another's UPC/LPN.
  const checkOffByCode = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      const scan = resolveCheckoutScan(lotStates, code, [code]);
      if (scan.kind === 'ambiguous') {
        // #813/#819: don't collapse a collision to the first line and submit
        // its canonical code. Leave the typed code in the box so it can be
        // edited.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(
          'Code matches more than one item',
          ambiguousCheckoutCodeMessage(lotStates, scan.indices),
        );
        return;
      }
      if (scan.kind === 'none') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('No match', `No item with code "${code}" on this order.`);
        return;
      }
      const idx = scan.index;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const typedMatch = lotStates[idx];
      // Clear the field before prompting: the disposition is decided in the
      // alert, and leaving the code sitting there invites a second submit
      // against an item already being dealt with.
      setLotCodeInput('');
      // Same three options as a scan — Pick up / Refund / Hold. Typing a code
      // used to commit a pick-up outright, with no way to refund at the counter.
      if (typedMatch) promptItemDisposition(idx, typedMatch);
    },
    [lotStates, promptItemDisposition],
  );

  // Open the single-lot refund sheet for a lot on this order. Looks the lot up
  // in invoice.lots to get winning_bid_cents (the checklist state doesn't carry
  // it) and its invoice_id, so the correct invoice is auto-located — no
  // invoice hunting (2026-07-13 feedback).
  const openRefundForLot = useCallback(
    (lotId: string) => {
      const lot = invoice?.lots.find((l) => l.lot_id === lotId);
      if (!lot) return;
      setScanRefundLot({
        invoiceId: lot.invoice_id,
        lot: {
          lot_id: lot.lot_id,
          lot_code: lot.lot_code,
          sticker_code: lot.sticker_code,
          display_code: lot.display_code,
          title: lot.title,
          winning_bid_cents: lot.winning_bid_cents,
        },
      });
    },
    [invoice],
  );

  // ── CHK-03: manual checkout (QR unreadable) ───────────────────────────────
  // The per-lot checkbox can only be flipped by a successful bin scan
  // (W6-P1 removed the silent manual bypass). This escape hatch lets a staffer
  // mark a lot picked up WITHOUT a bin scan when the QR is unreadable — but it
  // is gated by an explicit physical-verification acknowledgement + a reason
  // code, and it ALWAYS writes an operator_audit_log row. The bin-scan path
  // stays the default; this is the visible exception.

  function openManualCheckout(idx: number) {
    setManualLotIdx(idx);
    setManualAcknowledged(false);
    setManualReason(null);
  }

  function closeManualCheckout() {
    setManualLotIdx(null);
    setManualAcknowledged(false);
    setManualReason(null);
  }

  async function confirmManualCheckout() {
    if (manualLotIdx === null || !invoice) return;
    const idx = manualLotIdx;
    const ls = lotStates[idx];
    if (!ls) return;
    if (!manualAcknowledged) {
      Alert.alert('Confirm physical check', 'Acknowledge that you physically verified the item.');
      return;
    }
    if (!manualReason) {
      Alert.alert('Pick a reason', 'Select why the QR could not be scanned.');
      return;
    }

    setManualSubmitting(true);
    try {
      // Record the override in operator_audit_log. operator_audit_log has no
      // client INSERT policy (service-role only), so we POST to operator-web
      // which writes it server-side — same Bearer-token pattern as
      // RefundItemsSheet. We require the audit write to SUCCEED before flipping
      // the checkbox, so a manual checkout can never be un-audited.
      //
      // 2026-07-10: token freshness + one refresh-retry on 401. The cached
      // access token can be expired (iPad idle past the JWT lifetime) or
      // revoked (shared staff account signed out elsewhere — signOut used to
      // be global-scope); a silent refresh recovers both without making the
      // staffer sign back in mid-pickup.
      const token = await getFreshAccessToken();
      if (!token) {
        Alert.alert('Not signed in', 'Your session expired. Sign in again and retry.');
        return;
      }
      const postOverride = (bearer: string) =>
        fetchWithTimeout(
          // COMBINED CHECKOUT: audit against the lot's OWN invoice, not the group's
          // representative id — the merged screen spans multiple invoices.
          `${API_BASE}/api/invoices/${ls.invoice_id}/manual-checkout`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${bearer}`,
            },
            body: JSON.stringify({ lot_id: ls.lot_id, reason: manualReason }),
          },
        );
      let res = await postOverride(token);
      if (res.status === 401) {
        const retryToken = await forceRefreshAccessToken();
        if (!retryToken) {
          Alert.alert('Session expired', 'Sign in again and retry the override.');
          return;
        }
        res = await postOverride(retryToken);
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        Alert.alert(
          'Could not record override',
          data.error ?? `Server returned ${res.status}. The lot was NOT checked off — try again.`,
        );
        return;
      }

      // Audit row written — now flip the lot to checked + flag it as a manual
      // override (drives the badge and feeds staff_confirm_pickup like any
      // checked lot; the RPC is lot_code-based and needs no bin scan).
      setLotStates((prev) =>
        prev.map((x, i) =>
          i === idx ? { ...x, checked: true, manual_override: true } : x,
        ),
      );
      closeManualCheckout();
    } catch (err) {
      Alert.alert('Network error', (err as Error)?.message ?? 'Try again.');
    } finally {
      setManualSubmitting(false);
    }
  }

  // ── W6-P2: "Scan unknown item" scanner ───────────────────────────────────
  // Used when the staffer wants to scan ANY lot QR during a busy pickup window
  // to verify it actually belongs to the current customer.

  const unknownItemScanner = useCodeScanner({
    // Same as verifyLotScanner — accept Code128/UPC pre-stickered labels, not
    // just QR, so the "scan any lot to verify" mode reads BinGo's roll labels.
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      const c = firstCodeValue(codes);
      if (!c || busy || step !== 'verify_lots' || !unknownScanMode) return;
      void onUnknownItemScan(c);
    },
  });

  const onUnknownItemScan = useCallback(
    async (scan: DecodedCode) => {
      if (busy || !invoice) return;
      // The extracted UUID is the lot's qr_token (the sticker encodes
      // https://bingoauctions.com/l/<qr_token>), NOT the lot's primary key. It is
      // looked up via .eq('qr_token', …) below — matching put-away/single +
      // batch, which also key lot scans on qr_token.
      const token = extractBinToken(scan.data);
      const raw = scan.data.trim();
      if (!token && !raw) {
        setUnknownResult({ kind: 'not_lotted' });
        return;
      }

      setBusy(true);
      try {
        // Look up the lot + its invoice_lot join. operator-web PDF stickers
        // encode /l/<qr_token> (a UUID); BinGo's pre-stickered roll labels
        // (PNK/BRN…) are scanned as a bare code.
        //
        // The bare-code branch used to be `.ilike('lot_code', raw)` and nothing
        // else. On a relisted item that code belongs to the retired PARENT,
        // which is on no invoice — so a box a customer had genuinely won read
        // as "not lotted" at the counter, and staff had no way to tell it from
        // a stranger's item. `resolveLotScan` matches the sticker too and
        // prefers the live incarnation, which is the row the invoice cites.
        const sel = 'title, invoice_lots(invoice_id, invoices(bidder_id, bidders(display_name, email)))';
        const resolvedLot = await resolveLotScan<ScanRow & Record<string, unknown>>(
          token ?? raw,
          sel,
        );
        const lotRow = resolvedLot?.lot ?? null;

        if (!lotRow) {
          setUnknownResult({ kind: 'not_lotted' });
          return;
        }

        const typedLot = lotRow as unknown as {
          id: string;
          title: string;
          invoice_lots: Array<{
            invoice_id: string;
            invoices: {
              bidder_id: string;
              bidders: { display_name: string | null; email: string } | null;
            } | null;
          }>;
        };

        const firstIl = typedLot.invoice_lots[0];
        if (!firstIl) {
          // Lot exists but is not on any invoice — never won
          setUnknownResult({ kind: 'not_lotted' });
          return;
        }

        // COMBINED CHECKOUT: "same order" means ANY of this bidder's loaded
        // invoices — the merged screen spans all of them.
        if (invoice.orders.some((o) => o.invoice_id === firstIl.invoice_id)) {
          setUnknownResult({ kind: 'same_invoice' });
        } else {
          const bidder = firstIl.invoices?.bidders;
          const bidderLabel = bidder?.display_name ?? bidder?.email ?? 'another customer';
          setUnknownResult({ kind: 'different_invoice', bidder_label: bidderLabel });
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, invoice],
  );

  // ── W6-P2: Signature canvas PanResponder ─────────────────────────────────

  /**
   * Map a touch event to a canvas-local point. We use pageX/pageY (screen-
   * absolute, consistent across iOS/Android) minus the canvas origin rather
   * than nativeEvent.locationX/Y (which on Android is relative to whichever
   * child is under the finger). Clamp to the canvas box so strokes can't
   * escape it (and so the stored SVG stays within its viewBox).
   */
  const pointFromEvent = useCallback((e: GestureResponderEvent): SvgPoint => {
    const origin = canvasOriginRef.current;
    const rawX = e.nativeEvent.pageX - origin.x;
    const rawY = e.nativeEvent.pageY - origin.y;
    const x = Math.max(0, Math.min(SIGNATURE_CANVAS_WIDTH, rawX));
    const y = Math.max(0, Math.min(SIGNATURE_CANVAS_HEIGHT, rawY));
    return { x, y };
  }, []);

  /** Commit the in-progress stroke (shared by release + terminate). */
  const commitLiveStroke = useCallback(() => {
    const finished = [...currentStrokeRef.current];
    if (finished.length > 1) {
      setCommittedStrokes((prev) => [...prev, finished]);
    }
    setLiveStroke(null);
    currentStrokeRef.current = [];
  }, []);

  const signaturePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Don't yield the gesture back to the parent ScrollView mid-stroke, and
      // block the native ScrollView from claiming it (Android). Belt + braces
      // with the scrollEnabled toggle below.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        // Stop the ScrollView from scrolling for the duration of the stroke.
        setScrollEnabled(false);
        // Re-measure: the ScrollView may have scrolled since onLayout fired.
        measureCanvas();
        const pt = pointFromEvent(e);
        currentStrokeRef.current = [pt];
        setLiveStroke([pt]);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const pt = pointFromEvent(e);
        // Throttle: skip points within ~1.5px of the last recorded one. Cuts
        // point count + smooths the line + reduces setState churn per move.
        const last = currentStrokeRef.current[currentStrokeRef.current.length - 1];
        if (last) {
          const dx = pt.x - last.x;
          const dy = pt.y - last.y;
          if (dx * dx + dy * dy < SIGNATURE_MIN_POINT_DISTANCE_SQ) return;
        }
        const updated = [...currentStrokeRef.current, pt];
        currentStrokeRef.current = updated;
        // setLiveStroke re-renders only the live <Path>; committed strokes are
        // in a memoised layer and do not recompute on this tick.
        setLiveStroke(updated);
      },
      onPanResponderRelease: () => {
        commitLiveStroke();
        setScrollEnabled(true);
      },
      // If the gesture is interrupted (e.g. a system gesture wins), commit the
      // in-progress stroke just like a normal release so it isn't lost, and
      // re-enable scrolling so it never gets stuck off.
      onPanResponderTerminate: () => {
        commitLiveStroke();
        setScrollEnabled(true);
      },
    }),
  ).current;

  // ── W6-P2: Save signature then confirm ───────────────────────────────────

  async function onConfirmWithSignature() {
    if (!invoice) return;

    if (committedStrokes.length === 0 && !liveStroke) {
      Alert.alert('Signature required', 'Have the bidder sign in the box before confirming.');
      return;
    }

    // Rasterise the rendered <Svg> to a PNG data URI (renders in RN <Image>,
    // browser, AND PDF). Fall back to the SVG-string data URI if toDataURL is
    // unavailable or fails, so signature capture can NEVER fail.
    const png = await svgRefToPngDataUri(signatureSvgRef, SIGNATURE_CANVAS_WIDTH, SIGNATURE_CANVAS_HEIGHT);
    const dataUri = png ?? strokesToDataUri(signatureStrokes, SIGNATURE_CANVAS_WIDTH, SIGNATURE_CANVAS_HEIGHT);

    setBusy(true);
    setStep('submitting');

    try {
      // Step 1: store the signature on EVERY loaded order's pickup row before
      // the confirm RPCs fire — one signature covers the combined handoff.
      // Stored inline as a data URI in the TEXT column (no size limit). dataUri
      // is a base64 PNG (via react-native-svg's toDataURL) so it renders in a
      // RN <Image>, the browser, AND a PDF receipt; it falls back to an
      // SVG-string data URI only if rasterisation fails. No new dependency
      // (react-native-view-shot not needed). Revisit if the pickup-signatures
      // bucket upload is preferred in a follow-up (W6-P3).
      await supabase
        .from('pickups')
        .update({ bidder_signature_url: dataUri })
        .in('invoice_id', invoice.orders.map((o) => o.invoice_id));

      // Step 2: call the RPC(s) to complete the pickup(s)
      await callConfirmRpc();
    } catch (err) {
      Alert.alert('Confirm failed', (err as Error).message);
      setStep('sign');
      setBusy(false);
    }
  }

  async function setLotMissing(lotId: string, missing: boolean) {
    if (!invoice) return;
    const ls = lotStates.find((x) => x.lot_id === lotId);
    const order = invoice.orders.find((o) => o.invoice_id === ls?.invoice_id);
    if (!ls || !order?.pickup_id) {
      Alert.alert('Cannot record', 'No pickup row found for this order.');
      return;
    }
    setMissingBusyLotId(lotId);
    try {
      if (missing) {
        const { data: sessionData } = await supabase.auth.getSession();
        const { error } = await supabase.from('pickup_lot_outcomes').upsert(
          {
            pickup_id: order.pickup_id,
            lot_id: lotId,
            outcome: 'missing',
            decided_by: sessionData.session?.user.id ?? null,
          },
          { onConflict: 'pickup_id,lot_id' },
        );
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('pickup_lot_outcomes')
          .delete()
          .eq('pickup_id', order.pickup_id)
          .eq('lot_id', lotId)
          .eq('outcome', 'missing');
        if (error) throw error;
      }
      setMissingLotIds((prev) => {
        const next = new Set(prev);
        if (missing) next.add(lotId);
        else next.delete(lotId);
        return next;
      });
    } catch (err) {
      Alert.alert('Could not record', (err as Error).message);
    } finally {
      setMissingBusyLotId(null);
    }
  }

  function confirmMarkMissing(lotId: string, title: string) {
    Alert.alert(
      'Mark item missing?',
      `"${title}" will go to the office's missing-items refund queue. Finish this pickup without it — the refund is handled from the dashboard afterward.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark missing', style: 'destructive', onPress: () => void setLotMissing(lotId, true) },
      ],
    );
  }

  // ── Step 5: call staff_confirm_pickup RPC (once per order) ────────────────
  //
  // COMBINED CHECKOUT: the merged screen spans every active order, so confirm
  // groups the checked lots by their invoice and completes each one. The
  // partial-handover gate runs CLIENT-SIDE first — the screen already knows
  // exactly which lots are unchecked — so the dialog appears before ANY order
  // is touched (no half-committed state while the staffer decides). The DB's
  // pickup_incomplete guard (mig 0147/0217) stays as the backstop. Orders with
  // NOTHING scanned are skipped entirely: they stay 'pending' (bidder QR keeps
  // working, the 0183 no-show sweep still applies) instead of being flipped to
  // checked_in by an empty partial round.

  async function callConfirmRpc(allowIncomplete = false) {
    if (!invoice) return;

    const checked = lotStates.filter((ls) => ls.checked && ls.lot_code);
    // lotStates holds only OWED lines (refunded ones are filtered out when the
    // orders load), so an empty list means there is genuinely nothing to hand
    // over — every item on this visit was refunded.
    //
    // Reported 2026-08-21 (staff member, with a screen recording): "When a customer
    // only has one item or if you do a refund before you check any items out,
    // it will not let you continue. It wants you to check an item 1st even
    // though they only have one item and it's refunded."
    //
    // The old guard demanded a check that could not be performed, so the visit
    // could not be closed at the counter at all. The server never had this
    // problem — staff_confirm_pickup excludes refunded lots from its missing
    // set, so it completes an all-refunded invoice happily. Only the client
    // stood in the way.
    const owed = lotStates.filter((ls) => ls.lot_code);
    if (checked.length === 0 && owed.length > 0) {
      Alert.alert('No lots checked', 'Check at least one lot before confirming pickup.');
      setBusy(false);
      setStep('verify_lots');
      return;
    }

    // #816: choose each line's submitted code against its OWN invoice. A line
    // whose canonical lot_code collides with a sibling sticker is sent by its
    // sticker label instead, so a uniquely scanned box is neither refused by
    // 0509 nor stamped as the sibling by 0487. If no alias is unique we abort
    // instead of guessing.
    // #819: resolve each submitted code against EVERY line on its invoice —
    // hidden siblings (refunded / picked up / forfeited) included — while only
    // owed, checked lines are actually submitted. A hidden sibling's sticker can
    // otherwise collide with a checked line's canonical code and never be seen.
    const universe =
      aliasUniverseRef.current.length > 0
        ? buildConfirmUniverse(aliasUniverseRef.current, lotStates)
        : lotStates;
    const plan = planConfirmCodes(universe);
    if (!plan.ok) {
      const conflicts = plan.blocked
        .map((row) => row.lot_code ?? row.sticker_code ?? '?')
        .join(', ');
      setBusy(false);
      setStep('verify_lots');
      Alert.alert(
        'Cannot confirm these items',
        `These lots share a code with another item on the order: ${conflicts}. Ask a manager to resolve the duplicate codes before handing them over.`,
      );
      return;
    }

    // Client-side partial gate — unchecked lots across ALL loaded orders.
    const unchecked = lotStates.filter((ls) => !ls.checked && ls.lot_code);
    if (unchecked.length > 0 && !allowIncomplete) {
      const missing = unchecked.map((ls) => ls.lot_code as string);
      const nMissing = missing.length;
      const nPresent = checked.length;
      const shown =
        nMissing <= 6 ? missing.join(', ') : `${missing.slice(0, 6).join(', ')} +${nMissing - 6} more`;
      setBusy(false);
      setStep('verify_lots');
      Alert.alert(
        `${nMissing} lot${nMissing === 1 ? '' : 's'} not scanned`,
        `Not scanned: ${shown}\n\nHand over the ${nPresent} scanned lot${
          nPresent === 1 ? '' : 's'
        } now? The missing ${nMissing === 1 ? 'lot stays' : 'lots stay'} owed and can be picked up later.`,
        [
          { text: 'Keep scanning', style: 'cancel' },
          {
            text: `Hand over ${nPresent}`,
            style: 'destructive',
            onPress: () => {
              setBusy(true);
              setStep('submitting');
              void callConfirmRpc(true);
            },
          },
        ],
      );
      return;
    }

    // Group checked lot codes by their order; skip orders with nothing scanned.
    const codesByInvoice = new Map<string, string[]>();
    for (const [invoiceId, codes] of Object.entries(plan.codesByInvoice)) {
      if (codes.length > 0) codesByInvoice.set(invoiceId, codes);
    }

    // busy + step='submitting' already set by callers
    try {
      let firstPickupId: string | null = null;
      let lotsPicked = 0;
      let remainingTotal = 0;
      const extraWarnings: string[] = [];
      const failures: string[] = [];

      for (const order of invoice.orders) {
        const codes = codesByInvoice.get(order.invoice_id);
        if (!codes || codes.length === 0) {
          // order.lot_count counts OWED lines only. Greater than zero means
          // the staffer scanned nothing for this order — leave it pending, as
          // before, so the bidder's QR keeps working. Zero means everything on
          // it was refunded: confirm it with an empty scan list so the pickup
          // actually closes instead of hanging around forever.
          if (order.lot_count > 0) {
            remainingTotal += order.lot_count;
            continue;
          }
        }
        try {
          const { data, error } = await supabase.rpc('staff_confirm_pickup', {
            p_invoice_id: order.invoice_id,
            // Empty for an all-refunded order — the RPC's FOREACH simply does
            // not iterate, and its missing-set already ignores refunded lines.
            p_lot_codes: codes ?? [],
            p_allow_incomplete: allowIncomplete,
          });
          if (error) throw error;
          const result = data as unknown as {
            out_pickup_id: string;
            out_lots_picked_count: number;
            out_warning: string | null;
          };
          firstPickupId = firstPickupId ?? result.out_pickup_id;
          lotsPicked += result.out_lots_picked_count;
          if (result.out_warning?.startsWith('partial:')) {
            const m = result.out_warning.match(/partial: (\d+)/);
            remainingTotal += m ? parseInt(m[1]!, 10) : 0;
            const rest = result.out_warning.split('; ').slice(1);
            extraWarnings.push(...rest);
          } else if (result.out_warning && result.out_warning !== 'already_completed') {
            extraWarnings.push(result.out_warning);
          }
        } catch (err) {
          // Backstop for the DB pickup_incomplete guard (shouldn't fire — the
          // client gate above already covered it — but a concurrent change can
          // race us) and any real per-order failure. Record and keep going so
          // one bad order doesn't strand the rest of the handoff.
          const msg = (err as Error)?.message ?? 'unknown error';
          failures.push(`Order ${formatCents(order.total_cents)}: ${msg}`);
        }
      }

      if (firstPickupId === null) {
        // Nothing succeeded — surface the first failure and stay on the list.
        Alert.alert('Confirm failed', failures[0] ?? 'No orders could be confirmed.');
        setStep('verify_lots');
        return;
      }

      const warningParts: string[] = [];
      if (remainingTotal > 0) {
        warningParts.push(`partial: ${remainingTotal} lot(s) still owed — invoice stays open`);
      }
      warningParts.push(...extraWarnings, ...failures);

      setRpcResult({
        pickup_id: firstPickupId,
        lots_picked: lotsPicked,
        warning: warningParts.length > 0 ? warningParts.join('; ') : null,
      });
      setStep('done');
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!invoice) return;

    const checkedLotCodes = lotStates
      .filter((ls) => ls.checked && ls.lot_code)
      .map((ls) => ls.lot_code as string);

    // Same rule as callConfirmRpc: only demand a check when something is
    // actually owed. An all-refunded visit has nothing to scan.
    const owedLines = lotStates.filter((ls) => ls.lot_code);
    if (checkedLotCodes.length === 0 && owedLines.length > 0) {
      Alert.alert('No lots checked', 'Check at least one lot before confirming pickup.');
      return;
    }

    setBusy(true);
    setStep('submitting');
    await callConfirmRpc();
  }

  // ── W6-P2: Refund photo capture (post-done) ───────────────────────────────

  async function takeRefundPhoto() {
    if (!refundCameraRef.current) return;
    setRefundPhotoUploading(true);
    try {
      const photo = await refundCameraRef.current.takePhoto({
        flash: safeFlash(device, 'auto'),
        ...TAKE_PHOTO_OPTIONS,
      });
      setRefundPhotoUri(`file://${photo.path}`);
    } catch (err) {
      Alert.alert('Capture failed', translateCaptureError(err));
    } finally {
      setRefundPhotoUploading(false);
    }
  }

  async function uploadRefundPhoto() {
    if (!refundPhotoUri || !invoice || !rpcResult) return;
    setRefundPhotoUploading(true);
    try {
      // Path convention from migration 0077: <operator_id>/<dispute_id>/<filename>
      // Since this is a pre-dispute photo (item-not-as-described, before a
      // formal Stripe dispute is raised), we use the pickup_id as the context
      // identifier: <operator_id>/pickup-<pickup_id>/refund-evidence.jpg
      const operatorId = invoice.operator_id ?? 'unknown';
      const path = `${operatorId}/pickup-${rpcResult.pickup_id}/refund-evidence.jpg`;
      const result = await uploadImageFromUri('dispute-evidence', path, refundPhotoUri, {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (result.ok) {
        setRefundPhotoUrl(result.url);
        Alert.alert('Photo saved', 'Refund evidence photo uploaded successfully.');
      } else {
        Alert.alert('Upload failed', result.reason);
      }
    } finally {
      setRefundPhotoUploading(false);
    }
  }

  function reset() {
    setInvoice(null);
    setLotStates([]);
    aliasUniverseRef.current = [];
    setRpcResult(null);
    setLotCodeInput('');
    setRefundWindowHours(null);
    setCheckoutPolicy(DEFAULT_CHECKOUT_POLICY);
    setManualLotIdx(null);
    setManualAcknowledged(false);
    setManualReason(null);
    setUnknownScanMode(false);
    setUnknownResult({ kind: 'idle' });
    setCommittedStrokes([]);
    setLiveStroke(null);
    setShowRefundCapture(false);
    setShowRefundItems(null);
    setScanRefundLot(null);
    setMissingLotIds(new Set());
    setMissingBusyLotId(null);
    setRefundPhotoUri(null);
    setRefundPhotoUrl(null);
    // S12: clear search state
    setSearchQuery('');
    setSearchResults([]);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    // SCANNER-LOOP: clear scan guards so the next bidder's QR scans immediately.
    scanLockRef.current = false;
    lastTokenScanRef.current = null;
    verifyScanLockRef.current = false;
    lastVerifyScanRef.current = null;
    setStep('scan_token');
  }

  // ── Permission gate ────────────────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <View style={s.permissionRoot}>
        <Text style={s.permissionText}>
          Camera access is required to scan the bidder QR and bin codes.
        </Text>
        <Pressable onPress={requestPermission} style={s.btn}>
          <Text style={s.btnText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  // Plain computation, not useMemo: this sits below early returns, and a hook
  // here would change the hook order between renders.
  const visibleSearchResults = filterRowsByWarehouse(
    searchResults,
    warehouseFilterId,
    (r) => r.warehouse_id,
  );

  const stepLabel =
    step === 'scan_token'
      ? '1 of 5 · scan bidder QR'
      : step === 'loading'
      ? 'loading…'
      : step === 'confirm_id'
      ? '2 of 5 · confirm identity'
      : step === 'verify_lots'
      ? '3 of 5 · verify lots'
      : step === 'sign'
      ? '4 of 5 · signature'
      : step === 'submitting'
      ? 'submitting…'
      : 'done';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ScrollView
      testID="pickup-verify-screen"
      style={{ flex: 1, backgroundColor: '#0b0d12' }}
      contentContainerStyle={{ padding: 16 }}
      scrollEnabled={scrollEnabled}
    >
      <WarehouseFilterChip value={warehouseFilterId} onChange={setWarehouseFilterId} />
      <Text style={s.eyebrow}>{stepLabel}</Text>

      {/* ── Step 1: scan bidder QR ── */}
      {step === 'scan_token' && (
        <View>
          <Text style={s.instruction}>
            Ask the bidder to open BinGo Auctions and show their pickup QR. Scan it to begin.
          </Text>
          {device ? (
            <View style={s.cameraWrap}>
              <Camera
                ref={tokenCamRef}
                style={{ flex: 1 }}
                device={device}
                isActive={cameraGate && (step === 'scan_token' && !busy)}
                codeScanner={tokenScanner}
              />
              <Pressable style={StyleSheet.absoluteFillObject} onPress={tokenFocus.onTap} />
              {tokenFocus.indicator}
            </View>
          ) : (
            <Text style={s.muted}>Camera not available</Text>
          )}

          {/* ── S12: customer-search fallback ── */}
          <View style={s.searchSection}>
            <Text style={s.searchLabel}>QR won&apos;t scan? Search by name, email, or phone</Text>
            <TextInput
              style={s.searchInput}
              value={searchQuery}
              onChangeText={onSearchChange}
              placeholder="e.g. Jane Smith, jane@example.com, 555-1234"
              placeholderTextColor="#4a5068"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search customers by name, email, or phone"
            />

            {searchBusy && (
              <ActivityIndicator color="#4f8cff" style={{ marginTop: 8 }} />
            )}

            {!searchBusy &&
              searchQuery.trim().length >= 2 &&
              visibleSearchResults.length === 0 && (
              <Text style={[s.muted, { marginTop: 8 }]}>No paid invoices found.</Text>
            )}

            {visibleSearchResults.length > 0 && (
              <View style={{ marginTop: 8, gap: 6 }}>
                {visibleSearchResults.map((r) => (
                  <Pressable
                    key={r.invoice_id}
                    style={s.searchResultRow}
                    onPress={() => void onSearchResultPress(r)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select invoice for ${r.display_name ?? r.email}`}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#e8eaf0', fontSize: 14, fontWeight: '600' }}>
                        {r.display_name ?? r.email}
                      </Text>
                      {r.display_name && (
                        <Text style={s.muted}>{r.email}</Text>
                      )}
                      <Text style={s.muted}>
                        {formatCents(r.total_cents)} · {new Date(r.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text style={{ color: '#4f8cff', fontSize: 13, fontWeight: '600' }}>
                      Select
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </View>
      )}

      {/* ── Loading ── */}
      {(step === 'loading' || step === 'submitting') && (
        <View style={{ alignItems: 'center', marginTop: 32 }}>
          <ActivityIndicator color="#4f8cff" />
        </View>
      )}

      {/* ── Step 2: confirm identity ── */}
      {step === 'confirm_id' && invoice && (
        <View style={{ marginTop: 16 }}>
          <View style={s.card}>
            <Text style={s.label}>Bidder</Text>
            <Text style={s.value}>
              {/* BIDDER-BLANK fix (2026-06-11): use || + a final fallback so an
                  empty-string display_name/email never renders a blank label. */}
              {invoice.bidder_name || invoice.bidder_email || 'Bidder (no name on file)'}
            </Text>
            {invoice.bidder_name && (
              <Text style={[s.muted, { fontSize: 12 }]}>{invoice.bidder_email}</Text>
            )}
            {/* Membership perk 3: white-glove signal. Read-only — staging
                itself is unchanged; this just tells staff WHO gets it. */}
            {invoice.is_stage_prep && (
              <View testID="pro-stage-prep-badge" style={s.proBadge}>
                <Text style={s.proBadgeText}>PRO · stage &amp; prep</Text>
              </View>
            )}
            {/* COMBINED CHECKOUT: every active order is on this one screen. */}
            {invoice.orders.length > 1 && (
              <Text style={[s.muted, { fontSize: 12, marginTop: 4 }]}>
                {invoice.orders.length} orders combined · one checkout
              </Text>
            )}
          </View>

          <View style={[s.card, { marginTop: 8 }]}>
            <Text style={s.label}>
              {invoice.orders.length > 1 ? `Total across ${invoice.orders.length} invoices` : 'Invoice total'}
            </Text>
            <Text style={s.value}>{formatCents(invoice.total_cents)}</Text>
            <Text style={[s.muted, { fontSize: 12 }]}>
              {invoice.lots.length} lot{invoice.lots.length === 1 ? '' : 's'}
            </Text>
          </View>

          <View style={[s.card, { marginTop: 8 }]}>
            <Text style={s.label}>Items</Text>
            {invoice.lots.map((l) => (
              <View key={l.lot_id} style={s.lotRow}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => openAsListed(l.lot_id, l.invoice_id)}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${l.title} as listed`}
                >
                  <Text style={{ color: '#e8eaf0', fontSize: 13 }}>{l.title}</Text>
                  <Text style={s.muted}>
                    <CheckoutLotCodeText lot={l} />
                    {l.bin_code ? ` · bin ${l.bin_code}` : ' · not staged'}
                    {invoice.orders.length > 1
                      ? ` · order ${invoice.orders.findIndex((o) => o.invoice_id === l.invoice_id) + 1}`
                      : ''}
                  </Text>
                </Pressable>
                <Text style={{ color: '#e8eaf0', fontSize: 13 }}>
                  {formatCents(l.winning_bid_cents)}
                </Text>
              </View>
            ))}
          </View>

          {/* Refund policy banner — shown at the acknowledgement moment so the
              terms are unambiguous before the bidder signs. refundWindowHours===0
              means "all sales final after pickup" (e.g. BinGo Auctions). */}
          {refundWindowHours !== null && (
            <View
              testID="refund-policy-banner"
              style={[
                s.policyBanner,
                refundWindowHours === 0 ? s.policyBannerFinal : s.policyBannerWindow,
              ]}
            >
              <Text style={[s.policyBannerText, refundWindowHours === 0 ? s.policyBannerTextFinal : s.policyBannerTextWindow]}>
                {refundWindowHours === 0
                  ? 'All sales final once you leave the warehouse. Please verify everything before signing.'
                  : `${refundWindowHours}-hour return window after pickup. After ${refundWindowHours} hours, all sales are final.`}
              </Text>
            </View>
          )}

          <Text style={[s.muted, { marginTop: 12, lineHeight: 18 }]}>
            Visually confirm the person in front of you matches the name above.
          </Text>
          <Pressable
            style={[s.btn, { marginTop: 12 }]}
            onPress={() => setStep('verify_lots')}
          >
            <Text style={s.btnText}>Identity confirmed — check items</Text>
          </Pressable>
          <Pressable style={[s.btnSecondary, { marginTop: 8 }]} onPress={reset}>
            <Text style={s.btnSecondaryText}>Wrong person — rescan</Text>
          </Pressable>
        </View>
      )}

      {/* ── Step 3: per-lot verification ── */}
      {step === 'verify_lots' && invoice && (
        <View style={{ marginTop: 16 }}>
          <Text style={[s.muted, { marginBottom: 12, lineHeight: 18 }]}>
            Scan each item&apos;s lot QR — or type its lot code — to check it off.
          </Text>

          {/* 2026-07-10: can't-miss scan confirmation, pinned above the camera.
              Success buzzes + shows the item just checked; the running count
              means nobody scrolls a 50-item list to confirm a scan landed. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              marginBottom: 10,
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: lastScanFeedback
                ? lastScanFeedback.kind === 'ok'
                  ? '#22c55e'
                  : '#eab308'
                : '#2a3050',
              backgroundColor: lastScanFeedback
                ? lastScanFeedback.kind === 'ok'
                  ? 'rgba(34,197,94,0.14)'
                  : 'rgba(234,179,8,0.12)'
                : 'rgba(42,48,80,0.35)',
            }}
            accessibilityLiveRegion="polite"
          >
            <Text style={{ fontSize: 22 }}>
              {lastScanFeedback ? (lastScanFeedback.kind === 'ok' ? '✅' : '⚠️') : '📷'}
            </Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{ color: '#e8eaf0', fontSize: 14, fontWeight: '700' }}
                numberOfLines={2}
              >
                {lastScanFeedback
                  ? lastScanFeedback.kind === 'ok'
                    ? lastScanFeedback.title
                    : `Already checked: ${lastScanFeedback.title}`
                  : 'Ready to scan'}
              </Text>
              <Text style={{ color: '#9aa3c0', fontSize: 12, marginTop: 2 }}>
                {lotStates.filter((x) => x.checked).length} of {lotStates.length} verified
              </Text>
            </View>
          </View>

          {/* Always-on lot-QR scanner for the whole step. Scanning a matching
              lot sticker checks that row off. (Bin QR is the put-away flow and
              is intentionally NOT used here.) Paused while the unknown-item
              wrong-customer scanner below is active so they don't compete. */}
          {device ? (
            <View style={[s.cameraWrap, { height: 200, marginBottom: 12 }]}>
              <Camera
                ref={verifyCamRef}
                style={{ flex: 1 }}
                device={device}
                isActive={cameraGate && (step === 'verify_lots' && !busy && !unknownScanMode)}
                codeScanner={verifyLotScanner}
              />
              <Pressable style={StyleSheet.absoluteFillObject} onPress={verifyFocus.onTap} />
              {verifyFocus.indicator}
            </View>
          ) : (
            <Text style={s.muted}>Camera not available</Text>
          )}

          {/* Lot-code entry fallback (when the QR can't be scanned). */}
          <View style={[s.card, { marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
            <TextInput
              style={[s.searchInput, { flex: 1 }]}
              value={lotCodeInput}
              onChangeText={setLotCodeInput}
              placeholder="Enter lot code (e.g. TEA4840014)"
              placeholderTextColor="#4a5068"
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => checkOffByCode(lotCodeInput)}
              accessibilityLabel="Enter a lot code to check it off"
            />
            <Pressable
              style={s.btnSmall}
              onPress={() => checkOffByCode(lotCodeInput)}
              accessibilityRole="button"
              accessibilityLabel="Check off the entered lot code"
            >
              <Text style={s.btnSmallText}>Check off</Text>
            </Pressable>
          </View>

          {invoice.lots.map((lot, idx) => {
            const ls = lotStates[idx];
            if (!ls) return null;
            return (
              <View key={lot.lot_id} style={[s.card, { marginBottom: 8 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  {/* Checkbox — display-only. Scanning the item's lot QR (or
                      typing its lot code) is what flips checked=true; the manual
                      toggle was a money-loss bypass (staff could mark a lot
                      picked up without verifying the physical item). The
                      Pressable still allows TAP-TO-UNCHECK as an escape hatch
                      (in case a scan accidentally matched the wrong row).
                  */}
                  <Pressable
                    onPress={() => {
                      // Only allow un-checking. Checking requires a lot-QR scan
                      // or a typed lot code.
                      if (!ls.checked) return;
                      setLotStates((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, checked: false } : x)),
                      );
                    }}
                    style={[s.checkbox, ls.checked && s.checkboxChecked]}
                    accessibilityLabel={ls.checked ? 'Verified — tap to undo' : 'Pending verification; scan the lot QR or enter the lot code to verify'}
                  >
                    {ls.checked && <Text style={{ color: '#0b0d12', fontWeight: '700' }}>✓</Text>}
                  </Pressable>

                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => openAsListed(lot.lot_id, lot.invoice_id)}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${lot.title} as listed`}
                  >
                    <Text style={{ color: '#e8eaf0', fontSize: 14, fontWeight: '600' }}>
                      {lot.title}
                    </Text>
                    <Text style={s.muted}>
                      <CheckoutLotCodeText lot={lot} />
                      {lot.bin_code ? ` · bin ${lot.bin_code}` : ' · not staged'}
                      {invoice.orders.length > 1
                        ? ` · order ${invoice.orders.findIndex((o) => o.invoice_id === lot.invoice_id) + 1}`
                        : ''}
                    </Text>
                    <Text style={s.muted}>{formatCents(lot.winning_bid_cents)}</Text>
                    {/* CHK-03: flag lots checked via the manual override path. */}
                    {ls.manual_override && (
                      <View style={s.manualBadge}>
                        <Text style={s.manualBadgeText}>MANUAL CHECKOUT · QR unreadable</Text>
                      </View>
                    )}
                    {/* Missing item (mig 0243) — queued for a dashboard refund. */}
                    {missingLotIds.has(lot.lot_id) && (
                      <View style={s.missingBadge}>
                        <Text style={s.missingBadgeText}>MISSING · refund queued</Text>
                      </View>
                    )}
                  </Pressable>
                </View>

                {/* CHK-03: manual checkout (QR unreadable) — the visible
                    exception. Opens a confirm modal requiring physical-verify
                    acknowledgement + a reason; always audited server-side. */}
                {!ls.checked && (
                  <Pressable
                    onPress={() => openManualCheckout(idx)}
                    style={s.manualLink}
                    accessibilityRole="button"
                    accessibilityLabel="Manual checkout because the QR is unreadable"
                  >
                    <Text style={s.manualLinkText}>Manual checkout (QR unreadable)</Text>
                  </Pressable>
                )}
                {!ls.checked && (
                  <Pressable
                    onPress={() =>
                      missingLotIds.has(lot.lot_id)
                        ? void setLotMissing(lot.lot_id, false)
                        : confirmMarkMissing(lot.lot_id, lot.title)
                    }
                    disabled={missingBusyLotId === lot.lot_id}
                    style={s.manualLink}
                    accessibilityRole="button"
                    accessibilityLabel={
                      missingLotIds.has(lot.lot_id)
                        ? 'Undo missing mark'
                        : 'Mark this item missing from the warehouse'
                    }
                  >
                    <Text style={[s.manualLinkText, missingLotIds.has(lot.lot_id) && { color: '#f87171' }]}>
                      {missingBusyLotId === lot.lot_id
                        ? 'Saving…'
                        : missingLotIds.has(lot.lot_id)
                          ? 'Marked missing — tap to undo'
                          : "Can't find it? Mark missing"}
                    </Text>
                  </Pressable>
                )}
                {/* Option 1 (2026-07-13): refund an item during checkout without
                    leaving the screen or hunting for the invoice. Also reachable
                    from the per-scan prompt; kept here for items whose QR won't
                    scan or that staff decide to refund before scanning. */}
                {!ls.checked && !missingLotIds.has(lot.lot_id) && (
                  <Pressable
                    onPress={() => openRefundForLot(lot.lot_id)}
                    style={s.manualLink}
                    accessibilityRole="button"
                    accessibilityLabel="Refund this item"
                  >
                    <Text style={s.manualLinkText}>Refund this item (defective / wrong / damaged)</Text>
                  </Pressable>
                )}
              </View>
            );
          })}

          {/* Option 1 single-lot refund sheet — opened from the per-scan prompt
              or a per-lot "Refund this item" action. Pre-scoped to one lot so
              the correct invoice is auto-located; on success the lot leaves the
              checklist and staff keep scanning (no navigation). */}
          {scanRefundLot && invoice.operator_id && (
            <RefundItemsSheet
              invoiceId={scanRefundLot.invoiceId}
              bidderName={invoice.bidder_name}
              operatorId={invoice.operator_id}
              lots={[scanRefundLot.lot]}
              autoSelectAll
              onClose={() => setScanRefundLot(null)}
              onSuccess={() => {
                const refundedId = scanRefundLot.lot.lot_id;
                const refundedTitle = scanRefundLot.lot.title;
                // Server stamped invoice_lots.refunded_at; drop the lot from the
                // local checklist so it isn't also picked up and confirm skips
                // it. lotStates stays index-aligned with invoice.lots (both
                // filtered by the same lot_id).
                setInvoice((prev) =>
                  prev ? { ...prev, lots: prev.lots.filter((l) => l.lot_id !== refundedId) } : prev,
                );
                setLotStates((prev) => prev.filter((ls) => ls.lot_id !== refundedId));
                setLastScanFeedback({ kind: 'ok', title: `Refunded — ${refundedTitle}` });
                setScanRefundLot(null);
              }}
            />
          )}

          {/* ── W6-P2: Scan unknown item — wrong-customer detection ── */}
          <View style={[s.card, { marginTop: 8, marginBottom: 8 }]}>
            <Text style={s.label}>Wrong-customer check</Text>
            <Text style={[s.muted, { fontSize: 12, marginBottom: 8 }]}>
              If you&apos;re unsure an item belongs to this order, scan its lot QR here.
            </Text>

            <Pressable
              style={[s.btnSmall, { alignSelf: 'flex-start' }]}
              onPress={() => {
                setUnknownScanMode(!unknownScanMode);
                setUnknownResult({ kind: 'idle' });
              }}
            >
              <Text style={s.btnSmallText}>
                {unknownScanMode ? 'Cancel scan' : 'Scan unknown item QR'}
              </Text>
            </Pressable>

            {/* Camera for unknown-item scan */}
            {unknownScanMode && device && (
              <View style={[s.cameraWrap, { height: 200, marginTop: 8 }]}>
                <Camera
                  ref={unknownCamRef}
                  style={{ flex: 1 }}
                  device={device}
                  isActive={cameraGate && (unknownScanMode && !busy)}
                  codeScanner={unknownItemScanner}
                />
                <Pressable
                  style={StyleSheet.absoluteFillObject}
                  onPress={unknownFocus.onTap}
                />
                {unknownFocus.indicator}
              </View>
            )}

            {/* Result banners */}
            {unknownResult.kind === 'same_invoice' && (
              <View style={s.unknownResultOk}>
                <Text style={s.unknownResultOkText}>
                  This lot is on this invoice — safe to hand over.
                </Text>
              </View>
            )}
            {unknownResult.kind === 'different_invoice' && (
              <View style={s.unknownResultWarn}>
                <Text style={s.unknownResultWarnText}>
                  This lot belongs to a different customer. Do not hand it over.
                </Text>
              </View>
            )}
            {unknownResult.kind === 'not_lotted' && (
              <View style={s.unknownResultAmber}>
                <Text style={s.unknownResultAmberText}>
                  Not lotted yet — item has no matching lot record.
                </Text>
              </View>
            )}
          </View>

          {/* ── CHK-03: manual-checkout confirm modal ── */}
          {manualLotIdx !== null && (() => {
            const mlot = invoice.lots[manualLotIdx];
            return (
              <View testID="manual-checkout-modal" style={[s.card, s.manualModal]}>
                <Text style={[s.label, { color: '#f5a623' }]}>
                  Manual checkout — QR unreadable
                </Text>
                <Text style={[s.muted, { fontSize: 12, marginTop: 4, marginBottom: 10, lineHeight: 18 }]}>
                  Use this only when the lot QR and code both can&apos;t be read.
                  Scanning the lot QR or entering the lot code is the preferred
                  path. This override is recorded in the audit log.
                </Text>

                {mlot && (
                  <Text style={{ color: '#e8eaf0', fontSize: 13, marginBottom: 10 }}>
                    {mlot.title}
                    {'  '}
                    <Text style={s.muted}>
                      <CheckoutLotCodeText lot={mlot} />
                    </Text>
                  </Text>
                )}

                {/* (a) physical-verification acknowledgement */}
                <Pressable
                  onPress={() => setManualAcknowledged((v) => !v)}
                  style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: manualAcknowledged }}
                  accessibilityLabel="I physically verified this is the correct item"
                >
                  <View style={[s.checkbox, { width: 24, height: 24 }, manualAcknowledged && s.checkboxChecked]}>
                    {manualAcknowledged && <Text style={{ color: '#0b0d12', fontWeight: '700' }}>✓</Text>}
                  </View>
                  <Text style={{ color: '#e8eaf0', fontSize: 13, flex: 1, lineHeight: 18 }}>
                    I physically verified this is the correct item for this customer.
                  </Text>
                </Pressable>

                {/* (b) reason code */}
                <Text style={[s.muted, { fontSize: 12, marginBottom: 6 }]}>Reason</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {MANUAL_CHECKOUT_REASONS.map((r) => {
                    const selected = manualReason === r.value;
                    return (
                      <Pressable
                        key={r.value}
                        onPress={() => setManualReason(r.value)}
                        style={[s.reasonChip, selected && s.reasonChipSelected]}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                      >
                        <Text style={[s.reasonChipText, selected && s.reasonChipTextSelected]}>
                          {r.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Pressable
                  style={[
                    s.btn,
                    { marginTop: 14 },
                    (manualSubmitting || !manualAcknowledged || !manualReason) && { opacity: 0.5 },
                  ]}
                  disabled={manualSubmitting || !manualAcknowledged || !manualReason}
                  onPress={confirmManualCheckout}
                >
                  <Text style={s.btnText}>
                    {manualSubmitting ? 'Recording…' : 'Confirm manual checkout'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[s.btnSecondary, { marginTop: 8 }]}
                  onPress={closeManualCheckout}
                  disabled={manualSubmitting}
                >
                  <Text style={s.btnSecondaryText}>Cancel</Text>
                </Pressable>
              </View>
            );
          })()}

          {/* CHK-02: when the operator requires a signature, present the
              signature step as the primary path (today's behavior). When not,
              hide the signature button and confirm the pickup directly. */}
          <View style={{ marginTop: 8, gap: 8 }}>
            {checkoutPolicy.require_signature ? (
              <>
                <Pressable
                  style={s.btn}
                  onPress={() => setStep('sign')}
                  disabled={busy}
                >
                  <Text style={s.btnText}>Continue to signature</Text>
                </Pressable>
                <Pressable
                  style={s.btnSecondary}
                  onPress={onConfirm}
                  disabled={busy}
                >
                  <Text style={s.btnSecondaryText}>Skip signature — confirm now</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={s.btn}
                onPress={onConfirm}
                disabled={busy}
              >
                <Text style={s.btnText}>Confirm pickup</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* ── Step 4: signature canvas (W6-P2) ── */}
      {step === 'sign' && (
        <View style={{ marginTop: 16 }}>
          <View style={s.card}>
            <Text style={s.label}>Bidder signature</Text>
            <Text style={[s.muted, { fontSize: 12, marginBottom: 8 }]}>
              Have the bidder sign in the white box below using their finger.
            </Text>

            {/* Drawing surface: PanResponder captures touch; SVG renders paths.
                ref + onLayout measure the canvas origin so pageX/pageY can be
                mapped to canvas-local coords. */}
            <View
              ref={canvasRef}
              onLayout={measureCanvas}
              style={s.signatureCanvas}
              {...signaturePanResponder.panHandlers}
            >
              <Svg
                ref={signatureSvgRef}
                width={SIGNATURE_CANVAS_WIDTH}
                height={SIGNATURE_CANVAS_HEIGHT}
                style={StyleSheet.absoluteFillObject}
              >
                {/* Committed strokes in a memoised layer — not recomputed mid-drag. */}
                <CommittedSignatureLayer strokes={committedStrokes} />
                {/* Live in-progress stroke as a single separate <Path>. */}
                {liveStrokePathData ? (
                  <Path
                    d={liveStrokePathData}
                    stroke="#1a1a2e"
                    strokeWidth={2}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null}
              </Svg>
              {committedStrokes.length === 0 && !liveStroke && (
                <Text style={s.signaturePlaceholder}>Sign here</Text>
              )}
            </View>

            {committedStrokes.length > 0 && (
              <Pressable
                onPress={() => {
                  setCommittedStrokes([]);
                  setLiveStroke(null);
                  currentStrokeRef.current = [];
                }}
                style={[s.btnSmall, { marginTop: 8, alignSelf: 'flex-end' }]}
              >
                <Text style={s.btnSmallText}>Clear</Text>
              </Pressable>
            )}
          </View>

          <Pressable
            style={[s.btn, { marginTop: 12 }]}
            onPress={onConfirmWithSignature}
            disabled={busy}
          >
            <Text style={s.btnText}>
              {busy ? 'Confirming…' : 'Confirm pickup with signature'}
            </Text>
          </Pressable>
          <Pressable
            style={[s.btnSecondary, { marginTop: 8 }]}
            onPress={onConfirm}
            disabled={busy}
          >
            <Text style={s.btnSecondaryText}>Skip signature — confirm now</Text>
          </Pressable>
          <Pressable
            style={[s.btnSecondary, { marginTop: 8 }]}
            onPress={() => setStep('verify_lots')}
            disabled={busy}
          >
            <Text style={s.btnSecondaryText}>Back to lot check</Text>
          </Pressable>
        </View>
      )}

      {/* ── Done ── */}
      {step === 'done' && rpcResult && invoice && (
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
            <Text style={{ color: '#34d39a', fontWeight: '700', fontSize: 16 }}>
              {rpcResult.warning?.startsWith('partial:')
                ? 'Partial pickup recorded'
                : 'Pickup confirmed'}
            </Text>
            <Text style={{ color: '#e8eaf0', marginTop: 4 }}>
              {rpcResult.lots_picked} lot{rpcResult.lots_picked === 1 ? '' : 's'} handed over to{' '}
              {invoice.bidder_name ?? invoice.bidder_email}.
            </Text>
            {/* 0217: partial handover — the pickup row stays open, the
                bidder's QR keeps working, remaining lots stay owed. */}
            {rpcResult.warning?.startsWith('partial:') ? (
              <Text style={{ color: '#f5a623', marginTop: 8, fontSize: 13 }}>
                {rpcResult.warning.replace('partial: ', '')}. The bidder scans the
                same QR when they come back for the rest.
              </Text>
            ) : (
              rpcResult.warning && (
                <Text style={{ color: '#f5a623', marginTop: 8, fontSize: 13 }}>
                  Warning: {rpcResult.warning}
                </Text>
              )
            )}
          </View>

          {/* Missing items are the OFFICE's refund queue (mig 0243), not a
              counter action — say so here or staff hunt through the refund
              sheets looking for something to process (Jared, 2026-07-07). */}
          {missingLotIds.size > 0 && (
            <View
              style={[
                s.card,
                { marginTop: 12, borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.08)' },
              ]}
            >
              <Text style={{ color: '#f5a623', fontSize: 13, fontWeight: '800' }}>
                {missingLotIds.size} item{missingLotIds.size === 1 ? '' : 's'} marked missing —
                refund queued for the office
              </Text>
              <Text style={[s.muted, { fontSize: 12, marginTop: 4, lineHeight: 17 }]}>
                Nothing to do here. The office processes it from the Pickups dashboard
                (&ldquo;Missing items awaiting refund&rdquo;). The refund screens below are only
                for items the customer received that are defective, wrong, or damaged.
              </Text>
            </View>
          )}

          {/* ── W6-P2: Refund photo capture (post-pickup, item-not-as-described) ── */}
          {!showRefundCapture && !refundPhotoUrl && (
            <Pressable
              style={[s.btnSecondary, { marginTop: 12 }]}
              onPress={() => setShowRefundCapture(true)}
            >
              <Text style={s.btnSecondaryText}>
                Capture refund photo (item not as described)
              </Text>
            </Pressable>
          )}

          {/* ── PR-C: Per-lot refund sheet ── */}
          {/* COMBINED CHECKOUT: refunds post to a specific invoice, so with
              multiple orders there is one button/sheet per order. */}
          {showRefundItems === null &&
            invoice.orders.map((o, oi) => (
              <Pressable
                key={o.invoice_id}
                style={[s.btnSecondary, { marginTop: 12 }]}
                onPress={() => setShowRefundItems(o.invoice_id)}
              >
                <Text style={s.btnSecondaryText}>
                  Refund items (defective / wrong / damaged)
                  {invoice.orders.length > 1 ? ` — order ${oi + 1} (${formatCents(o.total_cents)})` : ''}
                  {invoice.lots.some(
                    (l) => l.invoice_id === o.invoice_id && missingLotIds.has(l.lot_id),
                  )
                    ? ' · missing item already queued'
                    : ''}
                </Text>
              </Pressable>
            ))}
          {showRefundItems !== null && invoice && invoice.operator_id && (
            <RefundItemsSheet
              invoiceId={showRefundItems}
              bidderName={invoice.bidder_name}
              operatorId={invoice.operator_id}
              lots={invoice.lots
                // Missing-marked lots were never handed over — they live in the
                // office refund queue, not the counter refund sheet.
                .filter((l) => l.invoice_id === showRefundItems && !missingLotIds.has(l.lot_id))
                .map((l) => ({
                  lot_id: l.lot_id,
                  lot_code: l.lot_code,
                  sticker_code: l.sticker_code,
                  title: l.title,
                  winning_bid_cents: l.winning_bid_cents,
                }))}
              onClose={() => setShowRefundItems(null)}
            />
          )}

          {showRefundCapture && !refundPhotoUrl && (
            <View style={[s.card, { marginTop: 12 }]}>
              <Text style={s.label}>Refund evidence photo</Text>
              <Text style={[s.muted, { fontSize: 12, marginBottom: 8 }]}>
                Photograph the actual item condition. This uploads to the dispute-evidence
                bucket and will be attached to any chargeback or refund case.
              </Text>

              {refundPhotoUri ? (
                <View>
                  <View
                    style={{
                      width: '100%',
                      height: 200,
                      borderRadius: 8,
                      overflow: 'hidden',
                      backgroundColor: '#1c2e49',
                      marginBottom: 8,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={s.muted}>Photo captured — ready to upload.</Text>
                  </View>
                  <Pressable
                    style={s.btn}
                    onPress={uploadRefundPhoto}
                    disabled={refundPhotoUploading}
                  >
                    <Text style={s.btnText}>
                      {refundPhotoUploading ? 'Uploading…' : 'Upload refund photo'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[s.btnSecondary, { marginTop: 8 }]}
                    onPress={() => setRefundPhotoUri(null)}
                  >
                    <Text style={s.btnSecondaryText}>Retake</Text>
                  </Pressable>
                </View>
              ) : (
                <View>
                  {device && (
                    <View style={[s.cameraWrap, { height: 260 }]}>
                      <Camera
                        ref={refundCameraRef}
                        style={{ flex: 1 }}
                        device={device}
                        isActive={showRefundCapture && !refundPhotoUri}
                        photo={true}
                      />
                      <Pressable
                        style={StyleSheet.absoluteFillObject}
                        onPress={refundFocus.onTap}
                      />
                      {refundFocus.indicator}
                    </View>
                  )}
                  <Pressable
                    style={[s.btn, { marginTop: 8 }]}
                    onPress={takeRefundPhoto}
                    disabled={refundPhotoUploading}
                  >
                    <Text style={s.btnText}>
                      {refundPhotoUploading ? 'Capturing…' : 'Capture refund photo'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[s.btnSecondary, { marginTop: 8 }]}
                    onPress={() => setShowRefundCapture(false)}
                  >
                    <Text style={s.btnSecondaryText}>Cancel</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}

          {refundPhotoUrl && (
            <View
              style={[
                s.card,
                {
                  marginTop: 12,
                  backgroundColor: 'rgba(52, 211, 154, 0.05)',
                  borderColor: '#34d39a',
                },
              ]}
            >
              <Text style={{ color: '#34d39a', fontSize: 13, fontWeight: '600' }}>
                Refund photo saved
              </Text>
              <Text style={[s.muted, { fontSize: 11, marginTop: 4 }]}>
                Uploaded to dispute-evidence bucket. Attach to any refund or chargeback case.
              </Text>
            </View>
          )}

          <Pressable style={[s.btn, { marginTop: 16 }]} onPress={reset}>
            <Text style={s.btnText}>Verify another pickup</Text>
          </Pressable>
          <Pressable
            style={[s.btnSecondary, { marginTop: 8 }]}
            onPress={() => router.replace('/(staff)/checkout' as Href)}
          >
            <Text style={s.btnSecondaryText}>Back to check out</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  eyebrow: {
    color: '#8a93a6',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  instruction: {
    color: '#8a93a6',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  cameraWrap: {
    height: 360,
    borderRadius: 8,
    overflow: 'hidden',
  },
  card: {
    backgroundColor: '#1c2e49',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#232839',
    padding: 14,
  },
  label: {
    color: '#8a93a6',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  value: {
    color: '#e8eaf0',
    fontSize: 18,
    fontWeight: '700',
  },
  muted: {
    color: '#8a93a6',
    fontSize: 13,
  },
  lotCodeSecondary: {
    fontSize: 11,
    opacity: 0.6,
    color: '#8a93a6',
  },
  noStickerFlag: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: '#f5a623',
    borderWidth: 1,
    borderColor: '#f5a623',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 6,
    overflow: 'hidden',
  },
  lotRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#232839',
    gap: 8,
    marginTop: 4,
  },
  btn: {
    padding: 14,
    backgroundColor: '#4f8cff',
    borderRadius: 8,
  },
  btnText: {
    color: '#fff',
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 15,
  },
  btnSecondary: {
    padding: 14,
    backgroundColor: '#232839',
    borderRadius: 8,
  },
  btnSecondaryText: {
    color: '#8a93a6',
    textAlign: 'center',
    fontWeight: '500',
    fontSize: 14,
  },
  btnSmall: {
    padding: 10,
    backgroundColor: '#232839',
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  btnSmallText: {
    color: '#8a93a6',
    fontSize: 13,
    fontWeight: '500',
  },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#4f8cff',
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: '#4f8cff',
    borderColor: '#4f8cff',
  },
  proBadge: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(245, 166, 35, 0.14)',
    borderWidth: 1,
    borderColor: '#f5a623',
  },
  proBadgeText: {
    color: '#f5a623',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  // ── CHK-03 manual-checkout styles ───────────────────────────────────────────
  manualBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(245, 166, 35, 0.14)',
    borderWidth: 1,
    borderColor: '#f5a623',
  },
  manualBadgeText: {
    color: '#f5a623',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  missingBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(248,113,113,0.15)',
    borderWidth: 1,
    borderColor: '#f87171',
  },
  missingBadgeText: {
    color: '#f87171',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  // Deliberately understated (text link, not a button) so the bin-scan path
  // reads as the default and manual checkout reads as the exception.
  manualLink: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  manualLinkText: {
    color: '#8a93a6',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  manualModal: {
    marginTop: 8,
    marginBottom: 8,
    borderColor: '#f5a623',
    backgroundColor: 'rgba(245, 166, 35, 0.06)',
  },
  reasonChip: {
    borderColor: '#232839',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#0b0d12',
  },
  reasonChipSelected: {
    borderColor: '#f5a623',
    backgroundColor: 'rgba(245, 166, 35, 0.12)',
  },
  reasonChipText: {
    color: '#8a93a6',
    fontSize: 12,
  },
  reasonChipTextSelected: {
    color: '#f5a623',
    fontWeight: '700',
  },
  permissionRoot: {
    flex: 1,
    padding: 24,
    backgroundColor: '#0b0d12',
    justifyContent: 'center',
  },
  permissionText: {
    color: '#e8eaf0',
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 16,
  },
  policyBanner: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  policyBannerFinal: {
    backgroundColor: 'rgba(248, 113, 113, 0.08)',
    borderColor: '#f87171',
  },
  policyBannerWindow: {
    backgroundColor: 'rgba(79, 140, 255, 0.08)',
    borderColor: '#4f8cff',
  },
  policyBannerText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  policyBannerTextFinal: {
    color: '#f87171',
  },
  policyBannerTextWindow: {
    color: '#4f8cff',
  },
  // ── W6-P2 styles ────────────────────────────────────────────────────────────
  signatureCanvas: {
    width: SIGNATURE_CANVAS_WIDTH,
    height: SIGNATURE_CANVAS_HEIGHT,
    backgroundColor: '#f8f8f0',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#232839',
    overflow: 'hidden',
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  signaturePlaceholder: {
    color: '#c0c0c0',
    fontSize: 14,
  },
  unknownResultOk: {
    marginTop: 8,
    padding: 10,
    backgroundColor: 'rgba(52, 211, 154, 0.1)',
    borderColor: '#34d39a',
    borderWidth: 1,
    borderRadius: 6,
  },
  unknownResultOkText: {
    color: '#34d39a',
    fontSize: 13,
    fontWeight: '600',
  },
  unknownResultWarn: {
    marginTop: 8,
    padding: 10,
    backgroundColor: 'rgba(248, 113, 113, 0.12)',
    borderColor: '#f87171',
    borderWidth: 2,
    borderRadius: 6,
  },
  unknownResultWarnText: {
    color: '#f87171',
    fontSize: 14,
    fontWeight: '700',
  },
  unknownResultAmber: {
    marginTop: 8,
    padding: 10,
    backgroundColor: 'rgba(245, 166, 35, 0.1)',
    borderColor: '#f5a623',
    borderWidth: 1,
    borderRadius: 6,
  },
  unknownResultAmberText: {
    color: '#f5a623',
    fontSize: 13,
    fontWeight: '600',
  },
  // ── S12: customer-search fallback ───────────────────────────────────────────
  searchSection: {
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#232839',
  },
  searchLabel: {
    color: '#8a93a6',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  searchInput: {
    padding: 12,
    backgroundColor: '#1c2e49',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#232839',
    color: '#e8eaf0',
    fontSize: 14,
    fontFamily: 'System',
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#1c2e49',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#232839',
    gap: 8,
  },
});
