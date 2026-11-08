// RefundItemsSheet — staff-mediated per-lot partial refund.
//
// Triggered from pickup-verify's 'done' step. Lets the staff member at
// the counter refund individual lots (defective / wrong item / damaged
// in transit / other) without zeroing the whole invoice.
//
// Server contract: POST /api/invoices/<invoiceId>/refund-items
//   Body: { items: [{lot_id, amount_cents}], sub_reason, reason_note? }
//   Server enforces: AAL2, role, refund window via operator_policies,
//     admin override (refund.override capability + admin_can_refund_outside_window), per-lot cap.
//
// What this sheet does itself (additive client-side UX, server is
// authoritative):
//   - Fetches the invoice's money breakdown (subtotal/premium/tax/
//     shipping/app_fee/total) so it can compute the per-lot cap.
//   - Fetches the operator_policies row to show the refund window in
//     human-readable form ("48-hour window") and warn when outside.
//   - Fetches pickups.completed_at / checked_in_at to surface "X hours
//     left" or "outside window — admin override required".
//   - Surfaces the destination-charge gotcha banner ("This will pull
//     funds from the operator's Connect balance — may create a negative
//     balance if payouts already cleared").

import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { getFreshAccessToken, forceRefreshAccessToken } from '../lib/fresh-token';
import { fetchWithTimeout } from '../lib/fetch-with-timeout';
import { refundFailureMessage, refundSuccessMessage, type RefundResponseBody } from '../lib/refund-result-copy';

// operator-web base URL — resolved the same way the staff app does
// (apps/field-mobile/app/(staff)/_layout.tsx). React Native has no document
// origin, so the refund POST below MUST use an absolute URL.
const API_BASE = (
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'https://bingoauctions.com'
).replace(/\/$/, '');

// Re-implemented locally so the sheet doesn't need to import operator-web
// code into the mobile bundle. Behavior is identical to
// apps/operator-web/src/lib/refund-math.ts:computeLotFullRefundableCents.
function computeLotFullRefundableCents(
  invoice: InvoiceMoney,
  winningBidCents: number,
): number {
  if (winningBidCents <= 0) return 0;
  const subtotal = invoice.subtotal_cents ?? 0;
  if (subtotal <= 0) return winningBidCents;
  const ratio = winningBidCents / subtotal;
  return (
    winningBidCents +
    Math.round((invoice.buyer_premium_cents ?? 0) * ratio) +
    Math.round((invoice.tax_cents ?? 0) * ratio) +
    Math.round((invoice.shipping_cents ?? 0) * ratio)
  );
}

const SUB_REASONS = [
  { value: 'defective_item', label: 'Defective item' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'damaged_in_transit', label: 'Damaged in transit' },
  { value: 'other', label: 'Other (note required)' },
] as const;

type SubReason = (typeof SUB_REASONS)[number]['value'];

type LotInput = {
  lot_id: string;
  lot_code: string | null;
  // mig 0185 / passed in from pickup-verify; rendered via lotDisplayCode (BRN).
  sticker_code?: string | null;
  title: string;
  winning_bid_cents: number;
};

type InvoiceMoney = {
  id: string;
  subtotal_cents: number | null;
  buyer_premium_cents: number | null;
  tax_cents: number | null;
  shipping_cents: number | null;
  application_fee_cents: number | null;
  total_cents: number | null;
};

type PolicyRow = {
  refund_window_post_pickup_hours: number | null;
  admin_can_refund_outside_window: boolean | null;
};

type PickupRow = {
  completed_at: string | null;
  checked_in_at: string | null;
};

type LotRowState = LotInput & {
  selected: boolean;
  amountCents: number;
  capCents: number;
};

type Props = {
  invoiceId: string;
  bidderName: string | null;
  operatorId: string;
  lots: LotInput[];
  onClose: () => void;
  onSuccess?: (jobIds: string[]) => void;
  // When true, every lot row starts selected (amount = full cap). Used when the
  // sheet is opened pre-scoped to a single lot from the checkout scan flow, so
  // staff don't have to tick the one item they already chose to refund.
  autoSelectAll?: boolean;
};

export function RefundItemsSheet({
  invoiceId,
  bidderName,
  operatorId,
  lots,
  onClose,
  onSuccess,
  autoSelectAll = false,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [invoiceMoney, setInvoiceMoney] = useState<InvoiceMoney | null>(null);
  const [policy, setPolicy] = useState<PolicyRow | null>(null);
  const [pickup, setPickup] = useState<PickupRow | null>(null);

  const [rows, setRows] = useState<LotRowState[]>(() =>
    lots.map((l) => ({
      ...l,
      selected: autoSelectAll,
      amountCents: 0,
      capCents: 0,
    })),
  );
  const [subReason, setSubReason] = useState<SubReason>('defective_item');
  const [reasonNote, setReasonNote] = useState('');

  // Fetch invoice money, policy, pickup in parallel on mount.
  useEffect(() => {
    let canceled = false;
    (async () => {
      const [invRes, polRes, pickRes] = await Promise.all([
        supabase
          .from('invoices')
          .select(
            'id, subtotal_cents, buyer_premium_cents, tax_cents, shipping_cents, application_fee_cents, total_cents',
          )
          .eq('id', invoiceId)
          .maybeSingle(),
        supabase
          .from('operator_policies')
          .select('refund_window_post_pickup_hours, admin_can_refund_outside_window')
          .eq('operator_id', operatorId)
          .eq('published', true)
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('pickups')
          .select('completed_at, checked_in_at')
          .eq('invoice_id', invoiceId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (canceled) return;
      const inv = invRes.data as unknown as InvoiceMoney | null;
      const pol = polRes.data as unknown as PolicyRow | null;
      const pck = pickRes.data as unknown as PickupRow | null;
      setInvoiceMoney(inv);
      setPolicy(pol);
      setPickup(pck);

      if (inv) {
        setRows((prev) =>
          prev.map((r) => {
            const cap = computeLotFullRefundableCents(inv, r.winning_bid_cents);
            return { ...r, capCents: cap, amountCents: cap };
          }),
        );
      }
      setLoading(false);
    })();
    return () => {
      canceled = true;
    };
  }, [invoiceId, operatorId]);

  const refundWindowHours = policy?.refund_window_post_pickup_hours ?? 48;
  const adminCanOverride = policy?.admin_can_refund_outside_window ?? true;
  const referenceAt = pickup?.completed_at ?? pickup?.checked_in_at ?? null;
  const windowInfo = useMemo(() => {
    if (!referenceAt) return { inWindow: false, hoursLeft: 0 };
    const refTs = Date.parse(referenceAt);
    if (!Number.isFinite(refTs)) return { inWindow: false, hoursLeft: 0 };
    const windowMs = refundWindowHours * 60 * 60 * 1000;
    const remainingMs = refTs + windowMs - Date.now();
    return { inWindow: remainingMs > 0, hoursLeft: Math.max(0, remainingMs / 3600000) };
  }, [referenceAt, refundWindowHours]);

  const selectedRows = rows.filter((r) => r.selected && r.amountCents > 0);

  // Each row's cap is hammer + rounded premium share + rounded tax share, so
  // selecting every lot can total a cent or two over what the bidder actually
  // paid (subtotal + premium + tax). Cap the refund at that true max, trimming
  // the overshoot off the largest selected line — mirrors the server so the
  // amount shown here is exactly what gets refunded (staff report 2026-07-10:
  // "$15.12" on a $15.11 invoice failed with refund_exceeds_invoice_total).
  const invoiceRefundableMax =
    (invoiceMoney?.subtotal_cents ?? 0) +
    (invoiceMoney?.buyer_premium_cents ?? 0) +
    (invoiceMoney?.tax_cents ?? 0);
  const refundItems = selectedRows.map((r) => ({
    lot_id: r.lot_id,
    amount_cents: r.amountCents,
  }));
  const rawSelectedSum = refundItems.reduce((sum, i) => sum + i.amount_cents, 0);
  if (invoiceRefundableMax > 0 && rawSelectedSum > invoiceRefundableMax) {
    const over = rawSelectedSum - invoiceRefundableMax;
    let idxMax = 0;
    for (let i = 1; i < refundItems.length; i++) {
      if (refundItems[i]!.amount_cents > refundItems[idxMax]!.amount_cents) idxMax = i;
    }
    refundItems[idxMax]!.amount_cents = Math.max(
      1,
      refundItems[idxMax]!.amount_cents - over,
    );
  }
  const totalRequestedCents = refundItems.reduce((sum, i) => sum + i.amount_cents, 0);

  function setRowSelected(lotId: string, selected: boolean) {
    setRows((prev) =>
      prev.map((r) => (r.lot_id === lotId ? { ...r, selected } : r)),
    );
  }
  function setRowAmount(lotId: string, amountCents: number) {
    setRows((prev) =>
      prev.map((r) =>
        r.lot_id === lotId
          ? { ...r, amountCents: Math.max(0, Math.min(amountCents, r.capCents)) }
          : r,
      ),
    );
  }

  async function submit() {
    if (selectedRows.length === 0) {
      Alert.alert('Pick at least one lot');
      return;
    }
    if (subReason === 'other' && !reasonNote.trim()) {
      Alert.alert('Add a note', 'A note is required when sub-reason is "Other".');
      return;
    }
    setSubmitting(true);
    try {
      // refundItems is already clamped to the invoice's true refundable max
      // (see above) so the sum never trips the server's over-refund guard.
      const body = {
        items: refundItems,
        sub_reason: subReason,
        reason_note: reasonNote.trim() || undefined,
      };
      // Mobile → operator-web: absolute URL + Bearer token (same pattern as
      // lib/lottr-client.ts). A relative URL network-errors in RN, and the
      // route's bearer-auth path needs the access token to resolve the user.
      // 2026-07-10: fresh token + one refresh-retry on 401 — the cached token
      // can be expired (idle iPad) or revoked (shared staff account signed
      // out on another device); this was the "refund failed" staff report.
      const token = await getFreshAccessToken();
      if (!token) {
        Alert.alert('Not signed in', 'Your session expired. Sign in again and retry.');
        setSubmitting(false);
        return;
      }
      const postRefund = (bearer: string) =>
        fetchWithTimeout(`${API_BASE}/api/invoices/${invoiceId}/refund-items`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(body),
        });
      let res = await postRefund(token);
      if (res.status === 401) {
        const retryToken = await forceRefreshAccessToken();
        if (!retryToken) {
          Alert.alert('Session expired', 'Sign in again and retry the refund.');
          setSubmitting(false);
          return;
        }
        res = await postRefund(retryToken);
      }
      const data = (await res.json().catch(() => ({}))) as RefundResponseBody & {
        job_ids?: string[];
      };
      if (!res.ok) {
        // 2026-10-27: staff saw a bare code ("no_payment_to_refund"); say
        // the cause and what to do next.
        Alert.alert('Refund failed', refundFailureMessage(data, res.status));
        setSubmitting(false);
        return;
      }
      Alert.alert(
        'Refund done',
        refundSuccessMessage(selectedRows.length, data),
        [
          {
            text: 'OK',
            onPress: () => {
              onSuccess?.(data.job_ids ?? []);
              onClose();
            },
          },
        ],
      );
    } catch (err) {
      Alert.alert('Network error', (err as Error)?.message ?? 'Try again.');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View
        style={{
          marginTop: 16,
          padding: 16,
          backgroundColor: '#1c2e49',
          borderRadius: 8,
          borderColor: '#2a2f3b',
          borderWidth: 1,
        }}
      >
        <ActivityIndicator color="#34d39a" />
        <Text style={{ color: '#8a93a6', marginTop: 8, textAlign: 'center' }}>
          Loading refund details…
        </Text>
      </View>
    );
  }

  if (!invoiceMoney) {
    return (
      <View style={sheetBase}>
        <Text style={{ color: '#f87171' }}>
          Could not load invoice details. Close and reopen the sheet.
        </Text>
        <Pressable style={btnSecondary} onPress={onClose}>
          <Text style={btnSecondaryText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  const showOutsideWindowWarning = referenceAt !== null && !windowInfo.inWindow;

  return (
    <View style={sheetBase}>
      <Text style={{ color: '#e8eaf0', fontWeight: '700', fontSize: 16 }}>
        Refund items{bidderName ? ` — ${bidderName}` : ''}
      </Text>

      {/* Window status */}
      {referenceAt && windowInfo.inWindow && (
        <Text style={{ color: '#8a93a6', marginTop: 4, fontSize: 12 }}>
          {Math.ceil(windowInfo.hoursLeft)}h left in the {refundWindowHours}h refund
          window.
        </Text>
      )}
      {showOutsideWindowWarning && (
        <View style={warnBox}>
          <Text style={warnText}>
            Outside the {refundWindowHours}h refund window.
            {adminCanOverride
              ? ' An operator admin can still issue this refund; others will be rejected by the server.'
              : ' Operator policy blocks refunds outside the window.'}
          </Text>
        </View>
      )}

      {/* Balance gotcha banner */}
      <View style={[warnBox, { borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.08)' }]}>
        <Text style={[warnText, { color: '#f5a623' }]}>
          This refund is issued immediately from the Square balance and can't be
          undone once submitted.
        </Text>
      </View>

      {/* Lot list */}
      <Text style={{ color: '#e8eaf0', marginTop: 12, fontWeight: '600' }}>
        Select lot(s) to refund
      </Text>
      <ScrollView style={{ maxHeight: 260, marginTop: 8 }}>
        {rows.map((row) => (
          <View key={row.lot_id} style={lotRow}>
            <Pressable
              onPress={() => setRowSelected(row.lot_id, !row.selected)}
              style={checkbox}
            >
              <Text style={{ color: row.selected ? '#34d39a' : '#8a93a6', fontSize: 18 }}>
                {row.selected ? '☑' : '☐'}
              </Text>
            </Pressable>
            <View style={{ flex: 1, marginLeft: 8 }}>
              <Text style={{ color: '#e8eaf0' }} numberOfLines={1}>
                {lotDisplayCode(row) ?? row.lot_code ?? '—'} · {row.title}
              </Text>
              <Text style={{ color: '#8a93a6', fontSize: 12 }}>
                Winning bid: ${(row.winning_bid_cents / 100).toFixed(2)} · Max
                refundable: ${(row.capCents / 100).toFixed(2)}
              </Text>
            </View>
            <View style={{ marginLeft: 8, width: 96 }}>
              <TextInput
                editable={row.selected}
                style={[input, !row.selected && { opacity: 0.4 }]}
                keyboardType="decimal-pad"
                value={
                  row.amountCents === 0 ? '' : (row.amountCents / 100).toFixed(2)
                }
                onChangeText={(t) => {
                  const dollars = parseFloat(t || '0');
                  if (!Number.isFinite(dollars)) return;
                  setRowAmount(row.lot_id, Math.round(dollars * 100));
                }}
                placeholder="0.00"
                placeholderTextColor="#5b6072"
              />
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Sub-reason picker */}
      <Text style={{ color: '#e8eaf0', marginTop: 12, fontWeight: '600' }}>Reason</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, gap: 6 }}>
        {SUB_REASONS.map((r) => (
          <Pressable
            key={r.value}
            onPress={() => setSubReason(r.value)}
            style={[
              chip,
              subReason === r.value && { borderColor: '#34d39a', backgroundColor: 'rgba(52,211,154,0.12)' },
            ]}
          >
            <Text
              style={{
                color: subReason === r.value ? '#34d39a' : '#8a93a6',
                fontSize: 12,
              }}
            >
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Note */}
      <Text style={{ color: '#e8eaf0', marginTop: 12, fontWeight: '600' }}>
        Note (optional)
      </Text>
      <TextInput
        style={[input, { height: 60, marginTop: 4 }]}
        value={reasonNote}
        onChangeText={setReasonNote}
        multiline
        placeholder="e.g. Bottom panel cracked, customer agreed to partial refund."
        placeholderTextColor="#5b6072"
      />

      {/* Summary + actions */}
      <View
        style={{
          marginTop: 12,
          padding: 8,
          borderRadius: 6,
          backgroundColor: 'rgba(52,211,154,0.06)',
        }}
      >
        <Text style={{ color: '#e8eaf0', fontWeight: '600' }}>
          Total to refund: ${(totalRequestedCents / 100).toFixed(2)}
        </Text>
        <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
          {selectedRows.length} lot{selectedRows.length === 1 ? '' : 's'} selected
        </Text>
      </View>

      <View style={{ flexDirection: 'row', marginTop: 12, gap: 8 }}>
        <Pressable style={[btnSecondary, { flex: 1 }]} onPress={onClose}>
          <Text style={btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[
            btnPrimary,
            { flex: 1 },
            (submitting || selectedRows.length === 0) && { opacity: 0.5 },
          ]}
          disabled={submitting || selectedRows.length === 0}
          onPress={submit}
        >
          <Text style={btnPrimaryText}>
            {submitting ? 'Queueing…' : 'Queue refund'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── styles ────────────────────────────────────────────────────────────

const sheetBase = {
  marginTop: 16,
  padding: 16,
  backgroundColor: '#1c2e49',
  borderRadius: 8,
  borderColor: '#2a2f3b',
  borderWidth: 1,
} as const;

const warnBox = {
  marginTop: 8,
  padding: 8,
  borderRadius: 6,
  borderWidth: 1,
  borderColor: 'rgba(248,113,113,0.5)',
  backgroundColor: 'rgba(248,113,113,0.08)',
} as const;

const warnText = { color: '#f87171', fontSize: 12 } as const;

const lotRow = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  paddingVertical: 8,
  borderBottomWidth: 1,
  borderBottomColor: '#1f2330',
};

const checkbox = {
  width: 28,
  height: 28,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};

const input = {
  borderColor: '#2a2f3b',
  borderWidth: 1,
  borderRadius: 6,
  paddingHorizontal: 8,
  paddingVertical: 6,
  color: '#e8eaf0',
  backgroundColor: '#0b0d12',
  fontSize: 14,
};

const chip = {
  borderColor: '#2a2f3b',
  borderWidth: 1,
  borderRadius: 12,
  paddingHorizontal: 10,
  paddingVertical: 5,
  backgroundColor: '#0b0d12',
};

const btnPrimary = {
  backgroundColor: '#34d39a',
  borderRadius: 8,
  padding: 12,
  alignItems: 'center' as const,
};
const btnPrimaryText = { color: '#0b0d12', fontWeight: '700' as const };

const btnSecondary = {
  borderColor: '#34d39a',
  borderWidth: 1,
  borderRadius: 8,
  padding: 12,
  alignItems: 'center' as const,
  backgroundColor: 'transparent',
};
const btnSecondaryText = { color: '#34d39a', fontWeight: '700' as const };
