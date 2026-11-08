// Invoice detail — receipt-only after migration 0105.
//
// Background (migration 0105):
// The old flow was "win → tap Pay → Stripe PaymentSheet". The new
// policy is auto-charge at close, so this screen is now a passive
// status board. The bidder doesn't pay manually; the auto-charge
// worker drains auto_charge_jobs and either charges the saved card
// or surfaces a grace-window failure here.
//
// Status branches:
//   - 'pending'                  → "Charging your card on file…" + poll.
//   - 'paid'                     → "Paid $X on {date} to •••• {last4}".
//   - 'payment_failed_grace'     → "Card declined. Update by {grace_until}
//                                  to keep this lot." + Update / Retry CTAs.
//   - 'payment_failed_relisted'  → "Lot was relisted. $5 fee on your
//                                  account." + Pay fees CTA.
//   - 'refunded' / 'partially_refunded' → original + refund detail.
//
// Polling: only while the invoice is in a non-terminal state. As soon
// as we see 'paid' / 'payment_failed_relisted' / 'refunded' /
// 'partially_refunded' we stop polling.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { useLocalSearchParams, useRouter, Link } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents, lotDisplayCode } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';
import { captureWonLot, capturePaymentCompleted } from '@/lib/analytics';

type FulfillmentMethod = 'pickup' | 'ship';

type WarehouseInfo = {
  name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string | null;
};

type Invoice = {
  id: string;
  status: string;
  subtotal_cents: number;
  buyer_premium_cents: number;
  tax_cents: number;
  shipping_cents: number;
  total_cents: number;
  fulfillment_method: FulfillmentMethod | null;
  shipping_address: ShippingAddress | null;
  shipping_carrier: string | null;
  shipping_tracking_number: string | null;
  shipped_at: string | null;
  created_at: string;
  paid_at: string | null;
  grace_until: string | null;
  last_auto_charge_at: string | null;
  last_auto_charge_error: string | null;
  refunded_at: string | null;
  operator_id: string;
  operators: {
    business_name: string;
    offers_pickup: boolean;
    offers_shipping: boolean;
  } | null;
  // B1: auction join for pickup window + warehouse address.
  auctions: {
    pickup_starts_at: string | null;
    pickup_ends_at: string | null;
    warehouses: WarehouseInfo | null;
  } | null;
  invoice_lots: Array<{
    lot_id: string;
    winning_bid_cents: number;
    // 0245 stamps this per LINE. Without it a partial refund rendered every
    // line identically under a whole-invoice "refunded" banner, so the bidder
    // believed items they still own had been refunded too.
    refunded_at: string | null;
    picked_up_at: string | null;
    /** 0301: per-line forfeit stamp. Preferred over the invoice-wide pickup
     *  status so a line can be reasoned about on its own. */
    forfeited_at: string | null;
    lots: { title: string; lot_code: string | null; sticker_code: string | null } | null;
  }>;
};

type ShippingAddress = {
  name?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
};

// PR-B (2026-05-29, mig 0157): operator fee/refund policy shape for the
// status-banner copy. Fetched separately after the invoice loads so the
// banners can render operator-specific dollar amounts instead of the old
// hardcoded "$5 fee" / "48 hours" defaults.
type OperatorPolicyMinimal = {
  no_show_policy: 'full_forfeit' | 'refund_minus_restock';
  restock_fee_cents: number;
  relist_fee_cents: number;
  refund_window_post_pickup_hours: number;
  // 0219: gates the bidder-facing "Report a problem" entry only.
  allow_bidder_disputes: boolean;
};

const DEFAULT_OPERATOR_POLICY: OperatorPolicyMinimal = {
  no_show_policy: 'full_forfeit',
  restock_fee_cents: 500,
  relist_fee_cents: 500,
  // M6: default 48h (matches seed + staff route). 0 meant "all sales final"
  // and would hide the "Report a problem" entry on the fallback path when the
  // operator_policies row fails to load. Keeps bidder/staff windows aligned.
  refund_window_post_pickup_hours: 48,
  allow_bidder_disputes: true,
};

type Quote = {
  shipmentId: string;
  rateId: string;
  carrier: string;
  service: string;
  totalCents: number;
  etaDays: number | null;
};

type CardInfo = {
  has_card: boolean;
  last4: string | null;
  brand: string | null;
};

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

// Terminal states — once we reach one, stop polling. 'paid' is a
// settled invoice; 'payment_failed_relisted' means the lot is gone and
// a fee was applied; refunded statuses are post-pay terminals.
const TERMINAL_STATES = new Set<string>([
  'paid',
  'payment_failed_relisted',
  'refunded',
  'partially_refunded',
  'canceled',
]);

const POLL_INTERVAL_MS = 5_000;

const EMPTY_ADDRESS: ShippingAddress = {
  name: '',
  street1: '',
  street2: '',
  city: '',
  state: '',
  zip: '',
};

export default function InvoiceScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [card, setCard] = useState<CardInfo | null>(null);
  const [retrying, setRetrying] = useState(false);
  // PR-B (mig 0157): operator's policy for banner copy. Defaults applied
  // until the load() side-effect fills it from operator_policies.
  const [operatorPolicy, setOperatorPolicy] =
    useState<OperatorPolicyMinimal>(DEFAULT_OPERATOR_POLICY);
  // M6: pickup completion time, for the post-pickup refund window that gates
  // the "Report a problem" (dispute → refund) entry. null until completed.
  const [pickupCompletedAt, setPickupCompletedAt] = useState<string | null>(null);
  const [pickupForfeited, setPickupForfeited] = useState(false);
  // Refs that gate one-shot analytics events. `wonLotFiredRef` makes
  // sure we emit won_lot exactly once per mount on the first sighting
  // of a paid invoice (whether it loaded paid or transitioned to paid
  // mid-poll). `paymentCompletedFiredRef` requires an actual transition
  // — it only fires if we previously saw a non-terminal state in this
  // session.
  const wonLotFiredRef = useRef(false);
  const sawNonTerminalRef = useRef(false);
  const paymentCompletedFiredRef = useRef(false);

  // Fulfillment chooser state — only relevant if we still need to
  // commit a method before charge (auto-charge only fires once the
  // invoice has a method set + a known total). For pickup-only and
  // ship-only operators we snap to that method on load.
  const [method, setMethod] = useState<FulfillmentMethod | null>(null);
  const [addr, setAddr] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    // `invoices` has NO `refunded_cents` column (only `refunded_at`). Selecting
    // it 400'd the ENTIRE query, and load() ignored the error + treated the null
    // result as "not found" — so EVERY invoice/receipt showed "Invoice not found"
    // in the app (Harrison field report, 2026-06-04). Select real columns only,
    // capture the error, and use maybeSingle so a genuinely-absent invoice
    // (e.g. before build_invoice_jobs runs) returns null cleanly instead of erroring.
    const { data, error } = await supabase
      .from('invoices')
      .select(
        `id, status, subtotal_cents, buyer_premium_cents, tax_cents, shipping_cents,
         total_cents, fulfillment_method, shipping_address, shipping_carrier,
         shipping_tracking_number, shipped_at, created_at, paid_at, grace_until,
         last_auto_charge_at, last_auto_charge_error, refunded_at,
         operator_id,
         operators:operators_public(business_name, offers_pickup, offers_shipping),
         auctions(pickup_starts_at, pickup_ends_at,
           warehouses(name, address_line1, address_line2, city, state, postal_code, timezone)),
         invoice_lots(lot_id, winning_bid_cents, refunded_at, picked_up_at, forfeited_at, lots(title, lot_code, sticker_code, display_code))`,
      )
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.warn('[invoice] failed to load', id, error.message);
    }
    const inv = (data as unknown as Invoice) ?? null;
    setInvoice(inv);

    // PR-B (mig 0157): pull the operator's published policy so the banners
    // below render operator-specific dollar amounts (relist_fee_cents,
    // restock_fee_cents) instead of the legacy hardcoded "$5". Anon SELECT
    // is allowed via mig 0088 RLS `select_published_for_anon`.
    if (inv?.operator_id) {
      const { data: pol } = await supabase
        .from('operator_policies')
        .select(
          'no_show_policy, restock_fee_cents, relist_fee_cents, refund_window_post_pickup_hours, allow_bidder_disputes',
        )
        .eq('operator_id', inv.operator_id)
        .eq('published', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      setOperatorPolicy(
        (pol as unknown as OperatorPolicyMinimal | null) ?? DEFAULT_OPERATOR_POLICY,
      );
    }

    // M6: pull the pickup row's completion time so we can gate the dispute /
    // "Report a problem" entry by the post-pickup refund window. Bidder reads
    // their own pickup via pickups_self_read (mig 0002). maybeSingle — a
    // ship-only invoice has no pickup row, which simply leaves it null.
    const { data: pickupRow } = await supabase
      .from('pickups')
      // `status` (2026-07-29): a forfeited pickup means the no-show window
      // closed and the bidder lost these items -- the goods go back to the
      // store. Without it the per-line labels below call every un-refunded,
      // un-collected line "Ready to collect", which on prod would tell 72
      // bidders that 151 items they no longer own are still theirs.
      .select('completed_at, status')
      .eq('invoice_id', id)
      .maybeSingle();
    const pickupData = pickupRow as { completed_at?: string | null; status?: string | null } | null;
    setPickupCompletedAt(pickupData?.completed_at ?? null);
    setPickupForfeited(pickupData?.status === 'forfeited');

    if (inv) {
      if (inv.fulfillment_method) {
        setMethod(inv.fulfillment_method);
        if (inv.shipping_address) setAddr(inv.shipping_address);
      } else if (inv.operators?.offers_pickup && !inv.operators?.offers_shipping) {
        setMethod('pickup');
      } else if (!inv.operators?.offers_pickup && inv.operators?.offers_shipping) {
        setMethod('ship');
      }
    }
    setLoading(false);
  }, [id]);

  // Initial load + once-on-mount card fetch (so we can render the
  // last4 in the "Paid to •••• 4242" line). Card metadata is fetched
  // from the GET endpoint added in migration 0105's helper route.
  useEffect(() => {
    load();
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;
        const res = await fetch(`${API_BASE}/api/bidder/payment-method`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.ok) setCard((await res.json()) as CardInfo);
      } catch {
        // Non-fatal — the receipt just renders without the last4.
      }
    })();
  }, [load]);

  // Analytics: fire won_lot once per mount when we first see a paid
  // invoice, and payment_completed only when a non-terminal → paid
  // transition was actually observed during the session. This lets
  // dashboards distinguish a bidder revisiting an already-paid invoice
  // (won_lot only) from the moment auto-charge succeeded (both events).
  useEffect(() => {
    if (!invoice) return;
    if (!TERMINAL_STATES.has(invoice.status)) {
      sawNonTerminalRef.current = true;
      return;
    }
    if (invoice.status === 'paid') {
      if (!wonLotFiredRef.current) {
        wonLotFiredRef.current = true;
        captureWonLot({
          invoice_id: invoice.id,
          total_cents: invoice.total_cents,
          lot_count: invoice.invoice_lots?.length ?? 0,
        });
      }
      if (sawNonTerminalRef.current && !paymentCompletedFiredRef.current) {
        paymentCompletedFiredRef.current = true;
        capturePaymentCompleted({
          invoice_id: invoice.id,
          total_cents: invoice.total_cents,
        });
      }
    }
  }, [invoice]);

  // Poll every 5s while we're in a non-terminal state. As soon as the
  // status flips to terminal, stop. The poll also stops automatically
  // when the screen unmounts.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!invoice) return;
    if (TERMINAL_STATES.has(invoice.status)) {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(() => {
      load();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [invoice, load]);

  async function getQuote() {
    if (!invoice) return;
    setQuoteErr(null);
    if (!addr.street1.trim() || !addr.city.trim() || !addr.state.trim() || !addr.zip.trim()) {
      setQuoteErr('Address required (street, city, state, ZIP).');
      return;
    }
    setQuoting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(`${API_BASE}/api/shipping/quote`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          invoiceId: invoice.id,
          toAddress: {
            name: addr.name?.trim() || undefined,
            street1: addr.street1.trim(),
            street2: addr.street2?.trim() || undefined,
            city: addr.city.trim(),
            state: addr.state.trim().toUpperCase(),
            zip: addr.zip.trim(),
            country: 'US',
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          body.message ?? body.error ?? `Could not get shipping rate (HTTP ${res.status})`,
        );
      }
      setQuote({
        shipmentId: body.shipmentId,
        rateId: body.rateId,
        carrier: body.carrier,
        service: body.service,
        totalCents: body.totalCents,
        etaDays: body.etaDays ?? null,
      });
    } catch (err) {
      setQuoteErr((err as Error).message);
      setQuote(null);
    } finally {
      setQuoting(false);
    }
  }

  // Commit the chosen fulfillment method. With auto-charge, the bidder
  // has to commit BEFORE the auto-charge worker picks the invoice up
  // (otherwise the total_cents doesn't include shipping). The worker
  // skips invoices without a committed method, so this is the only
  // bidder action remaining on the pre-charge path.
  async function commitMethod() {
    if (!invoice || !method) return;
    setCommitting(true);
    try {
      const args =
        method === 'ship'
          ? {
              p_invoice_id: invoice.id,
              p_method: 'ship',
              p_shipping_addr: {
                name: addr.name?.trim() || undefined,
                street1: addr.street1.trim(),
                street2: addr.street2?.trim() || undefined,
                city: addr.city.trim(),
                state: addr.state.trim().toUpperCase(),
                zip: addr.zip.trim(),
                country: 'US',
              },
              p_shipping_cents: quote?.totalCents ?? 0,
              p_easypost_shipment_id: quote?.shipmentId ?? null,
              p_easypost_rate_id: quote?.rateId ?? null,
            }
          : {
              p_invoice_id: invoice.id,
              p_method: 'pickup',
              p_shipping_addr: null,
              p_shipping_cents: 0,
              p_easypost_shipment_id: null,
              p_easypost_rate_id: null,
            };
      const { data, error } = await supabase.rpc('set_invoice_fulfillment', args as never);
      if (error) {
        Alert.alert("Couldn't save choice", error.message);
        return;
      }
      const result = data as { ok?: boolean; error?: string } | null;
      if (result && result.ok === false) {
        Alert.alert("Couldn't save choice", result.error ?? 'Unknown error');
        return;
      }
      await load();
    } finally {
      setCommitting(false);
    }
  }

  async function retryAutoCharge() {
    if (!invoice) return;
    setRetrying(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(
        `${API_BASE}/api/invoices/${invoice.id}/retry-auto-charge`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Server returned ${res.status}`);
      }
      Alert.alert(
        'Retry queued',
        'We&apos;ll try your saved card again in the next minute or two.',
      );
      await load();
    } catch (err) {
      Alert.alert("Couldn't retry", (err as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  const isMethodLocked = useMemo(() => {
    if (!invoice) return false;
    // Once the invoice has paid / failed terminally / been refunded /
    // is in grace, fulfillment is locked. We only allow editing when
    // the invoice is fresh ('pending') and needs commit.
    return invoice.status !== 'pending';
  }, [invoice]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#8a93a6" />
      </View>
    );
  }

  if (!invoice) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, alignItems: 'center' }}>
        <Text style={{ color: '#8a93a6' }}>Invoice not found.</Text>
      </View>
    );
  }

  const offerPickup = invoice.operators?.offers_pickup ?? true;
  const offerShipping = invoice.operators?.offers_shipping ?? false;
  const offersBoth = offerPickup && offerShipping;
  const needsMethod = invoice.status === 'pending' && !invoice.fulfillment_method;
  const cardLast4 = card?.last4 ?? null;

  // M6: discoverable refund/return entry. The dispute flow IS the bidder's
  // refund path — they report a problem and the OPERATOR decides refund/deny.
  // Previously the only entry point was the pickup screen, gated to staged /
  // picked-up lots, so counter_pickup / self_serve buyers (whose lots are
  // never staged) had no way in. Surface it here on the receipt, gated by:
  //   - the invoice being in a state where the bidder actually has the goods
  //     (paid, or already (partially) refunded — a prior issue), and
  //   - the operator's post-pickup refund window:
  //       window 0h            → "all sales final" → hidden.
  //       window >0, no pickup yet OR within completed_at+window → shown.
  // operatorPolicy defaults to 48h if the policy row fails to load.
  const refundWindowHours = operatorPolicy.refund_window_post_pickup_hours;
  const refundEligibleStatus =
    invoice.status === 'paid' ||
    invoice.status === 'partially_refunded' ||
    invoice.status === 'refunded';
  const refundWindowOpen =
    // 0219: zero-refund storefronts (BinGo) hide the dispute invitation
    // outright — the refund window column stays in service of STAFF tooling.
    (operatorPolicy.allow_bidder_disputes ?? true) &&
    refundEligibleStatus &&
    refundWindowHours > 0 &&
    (!pickupCompletedAt ||
      Date.now() <=
        new Date(pickupCompletedAt).getTime() + refundWindowHours * 60 * 60 * 1000);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {invoice.operators?.business_name ?? 'Operator'}
      </Text>
      <Text style={{ color: '#e8eaf0', fontSize: 24, fontWeight: '700', marginTop: 4 }}>
        Invoice {invoice.id.slice(0, 8)}
      </Text>
      <Text style={{ color: '#8a93a6', fontSize: 13, marginTop: 4 }}>
        {new Date(invoice.created_at).toLocaleString()}
      </Text>

      {/* Status banner — first thing the bidder sees. Each branch is
          its own visual treatment so the urgency reads at a glance. */}
      <StatusBanner
        invoice={invoice}
        cardLast4={cardLast4}
        retrying={retrying}
        policy={operatorPolicy}
        pickupForfeited={pickupForfeited}
        onUpdateCard={() =>
          router.push('/profile/payment-method' as never)
        }
        onRetry={retryAutoCharge}
        onPayFees={() => router.push('/profile/pay-fees' as never)}
      />

      {/* Line items */}
      <View style={{ marginTop: 24 }}>
        {invoice.invoice_lots.map((il) => (
          <View
            key={il.lot_id}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              padding: 12,
              borderBottomWidth: 1,
              borderBottomColor: '#232839',
            }}
          >
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text
                style={{
                  color: il.refunded_at ? '#8a93a6' : '#e8eaf0',
                  textDecorationLine: il.refunded_at ? 'line-through' : 'none',
                }}
              >
                {il.lots?.title ?? 'Lot'}
              </Text>
              {/* The lot code must survive a partial refund: it is how the
                  bidder and the counter find the items they DO still own. */}
              {il.lots?.lot_code && (
                <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
                  {lotDisplayCode(il.lots) ?? il.lots.lot_code}
                </Text>
              )}
              {il.refunded_at ? (
                <Text style={{ color: '#ff5470', fontSize: 12, marginTop: 3, fontWeight: '600' }}>
                  Refunded
                </Text>
              ) : il.picked_up_at ? (
                <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 3 }}>Collected</Text>
              ) : il.forfeited_at || pickupForfeited ? (
                // Forfeited: the pickup window closed without collection, so
                // this line is neither refunded nor collectable. Saying
                // "Ready to collect" here sends the bidder to a counter for an
                // item that has already gone back into inventory.
                <Text style={{ color: '#f0a83c', fontSize: 12, marginTop: 3, fontWeight: '600' }}>
                  Not collected in time
                </Text>
              ) : (
                <Text style={{ color: '#4ade80', fontSize: 12, marginTop: 3, fontWeight: '600' }}>
                  Ready to collect
                </Text>
              )}
            </View>
            <Text
              style={{
                color: il.refunded_at ? '#8a93a6' : '#e8eaf0',
                textDecorationLine: il.refunded_at ? 'line-through' : 'none',
              }}
            >
              {formatCents(il.winning_bid_cents)}
            </Text>
          </View>
        ))}
      </View>

      {/* M6: Report a problem / request a refund. The dispute flow is the
          bidder's refund path (operator decides). One entry per lot so the
          bidder picks which item. Gated by the operator's post-pickup refund
          window (refundWindowOpen). */}
      {refundWindowOpen && (
        <View
          style={{
            marginTop: 16,
            padding: 14,
            backgroundColor: '#1c2e49',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#232839',
          }}
        >
          <Text
            style={{
              color: '#8a93a6',
              fontSize: 10,
              fontWeight: '800',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              marginBottom: 8,
            }}
          >
            Need help with an item?
          </Text>
          {invoice.invoice_lots.map((il) => (
            <Link
              key={il.lot_id}
              href={{
                pathname: '/dispute/new',
                params: { lotId: il.lot_id, invoiceId: invoice.id },
              }}
              asChild
            >
              <Pressable
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: 10,
                }}
              >
                <Text style={{ color: '#e8eaf0', fontSize: 13, flex: 1, paddingRight: 12 }}>
                  {il.lots?.title ?? 'Lot'}
                </Text>
                <Text style={{ color: '#ff5470', fontSize: 13, fontWeight: '600' }}>
                  Report a problem →
                </Text>
              </Pressable>
            </Link>
          ))}
          <Text style={{ color: '#8a93a6', fontSize: 11, marginTop: 4, lineHeight: 16 }}>
            {refundWindowHours}-hour return window after pickup. Your operator
            reviews each request and decides on a refund.
          </Text>
        </View>
      )}

      {/* Fulfillment chooser — only while the bidder still has to commit.
          Auto-charge won't fire until method + (if ship) address + rate
          are locked in. Once committed (or once we've moved past
          'pending') the chooser is hidden. */}
      {!isMethodLocked && offersBoth && (
        <View style={{ marginTop: 24 }}>
          <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginBottom: 8 }}>
            How do you want your items?
          </Text>

          <Pressable
            onPress={() => setMethod('pickup')}
            style={{
              padding: 14,
              backgroundColor: method === 'pickup' ? '#14213d' : '#1c2e49',
              borderRadius: 10,
              borderWidth: 2,
              borderColor: method === 'pickup' ? '#4f8cff' : '#232839',
              marginBottom: 8,
            }}
          >
            <Text style={{ color: '#e8eaf0', fontWeight: '600' }}>Pick up at the warehouse</Text>
            <Text style={{ color: '#8a93a6', fontSize: 13, marginTop: 2 }}>
              No shipping cost. You collect items during the operator&apos;s pickup hours.
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setMethod('ship')}
            style={{
              padding: 14,
              backgroundColor: method === 'ship' ? '#14213d' : '#1c2e49',
              borderRadius: 10,
              borderWidth: 2,
              borderColor: method === 'ship' ? '#4f8cff' : '#232839',
            }}
          >
            <Text style={{ color: '#e8eaf0', fontWeight: '600' }}>Ship to me</Text>
            <Text style={{ color: '#8a93a6', fontSize: 13, marginTop: 2 }}>
              We&apos;ll send your items to the address you provide. Shipping cost is added to your invoice.
            </Text>
          </Pressable>
        </View>
      )}

      {!isMethodLocked && method === 'ship' && (
        <View
          style={{
            marginTop: 16,
            padding: 14,
            backgroundColor: '#1c2e49',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#232839',
            gap: 10,
          }}
        >
          <Text style={{ color: '#e8eaf0', fontWeight: '600' }}>Shipping address</Text>
          <AddrField label="Name" value={addr.name ?? ''} onChange={(v) => setAddr({ ...addr, name: v })} />
          <AddrField label="Street" value={addr.street1} onChange={(v) => setAddr({ ...addr, street1: v })} />
          <AddrField label="Apt / Suite (optional)" value={addr.street2 ?? ''} onChange={(v) => setAddr({ ...addr, street2: v })} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 2 }}>
              <AddrField label="City" value={addr.city} onChange={(v) => setAddr({ ...addr, city: v })} />
            </View>
            <View style={{ flex: 1 }}>
              <AddrField label="State" value={addr.state} onChange={(v) => setAddr({ ...addr, state: v.toUpperCase() })} max={2} />
            </View>
            <View style={{ flex: 1 }}>
              <AddrField label="ZIP" value={addr.zip} onChange={(v) => setAddr({ ...addr, zip: v })} max={10} />
            </View>
          </View>

          <Pressable
            onPress={getQuote}
            disabled={quoting}
            style={{
              padding: 12,
              backgroundColor: quoting ? '#232839' : '#1e2c4d',
              borderRadius: 8,
              alignItems: 'center',
              marginTop: 4,
            }}
          >
            {quoting ? (
              <ActivityIndicator color="#8a93a6" />
            ) : (
              <Text style={{ color: '#e8eaf0', fontWeight: '600' }}>
                {quote ? 'Refresh shipping rate' : 'Get shipping rate'}
              </Text>
            )}
          </Pressable>

          {quoteErr && (
            <Text style={{ color: '#ff5470', fontSize: 13 }}>{quoteErr}</Text>
          )}
          {quote && (
            <View style={{ padding: 10, backgroundColor: colors.bg, borderRadius: 6 }}>
              <Text style={{ color: '#34d39a', fontWeight: '700' }}>
                {quote.carrier} {quote.service} · {formatCents(quote.totalCents)}
              </Text>
              {quote.etaDays != null && (
                <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>
                  ETA ~{quote.etaDays} business day{quote.etaDays === 1 ? '' : 's'}
                </Text>
              )}
            </View>
          )}
        </View>
      )}

      {/* Commit button — only when the invoice still needs a method
          selection. Auto-charge can't run until this is set. */}
      {needsMethod && (
        <Pressable
          onPress={commitMethod}
          disabled={
            committing || !method || (method === 'ship' && !quote)
          }
          style={{
            marginTop: 16,
            padding: 16,
            backgroundColor:
              !method || (method === 'ship' && !quote) ? '#232839' : '#4f8cff',
            borderRadius: 8,
            opacity: committing ? 0.6 : 1,
          }}
        >
          {committing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 15 }}>
              {!method
                ? 'Choose pickup or shipping'
                : method === 'ship' && !quote
                  ? 'Get shipping rate to continue'
                  : 'Confirm fulfillment & auto-charge'}
            </Text>
          )}
        </Pressable>
      )}

      {/* Totals */}
      <View
        style={{
          marginTop: 16,
          padding: 16,
          backgroundColor: '#1c2e49',
          borderRadius: 8,
          gap: 6,
        }}
      >
        <Row label="Subtotal" value={formatCents(invoice.subtotal_cents)} />
        <Row label="Buyer's premium" value={formatCents(invoice.buyer_premium_cents)} />
        {invoice.tax_cents > 0 && <Row label="Tax" value={formatCents(invoice.tax_cents)} />}
        {invoice.shipping_cents > 0 && (
          <Row label="Shipping" value={formatCents(invoice.shipping_cents)} />
        )}
        <View style={{ height: 1, backgroundColor: '#232839', marginVertical: 6 }} />
        <Row label="Total" value={formatCents(invoice.total_cents)} bold />
        {/* Refund amount is not on the invoice row (no refunded_cents column);
            the refund status + date is surfaced by the StatusBanner below. */}
      </View>

      {/* Shipped detail — only when actually shipped. */}
      {invoice.fulfillment_method === 'ship' && invoice.status === 'paid' && (
        <View
          style={{
            marginTop: 16,
            padding: 14,
            backgroundColor: '#1c2e49',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#232839',
          }}
        >
          <Text style={{ color: '#e8eaf0', fontSize: 13 }}>
            {invoice.shipped_at ? '📦 Shipped' : '📦 Your items will ship soon'}
          </Text>
          {invoice.shipping_carrier && invoice.shipping_tracking_number && (
            <Text style={{ color: '#8a93a6', fontSize: 13, marginTop: 4 }}>
              {invoice.shipping_carrier} · {invoice.shipping_tracking_number}
            </Text>
          )}
        </View>
      )}

      {/* Pickup address block — B1 (S11). Rendered whenever the invoice
          is for pickup and we have at least a warehouse name or address.
          All joins are nullable (warehouse may not be set on the auction);
          we render nothing rather than crashing. Mirrors the web receipt at
          apps/operator-web/src/app/profile/invoices/[id]/page.tsx ~441-491. */}
      {invoice.fulfillment_method === 'pickup' &&
        (invoice.auctions?.warehouses?.name ??
          invoice.auctions?.warehouses?.address_line1 ??
          invoice.auctions?.pickup_starts_at) ? (
        <PickupBlock invoice={invoice} />
      ) : null}

      {/* App feedback — deliberately the quietest thing on this screen.
          Owner, 2026-08-29: put it on the invoice screen "but not in the way".
          Bidders live on this screen and nowhere near Profile, which is why
          the feedback card buried four rows down there has taken zero reports
          in sixteen days.

          A plain text link, not a card, and LAST — because the money-bearing
          "Report a problem" above it (dispute -> refund) must stay the
          obvious choice for anything about an ITEM. The copy names the
          difference explicitly: someone with a missing item who files app
          feedback instead of a dispute gets no refund, and that failure would
          be caused by us putting two similarly-worded links on one screen. */}
      <Link href={{ pathname: '/profile/feedback', params: { from: 'invoice' } }} asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Report a problem with the app"
          hitSlop={8}
          style={{ marginTop: 20, paddingVertical: 10, alignItems: 'center' }}
        >
          <Text style={{ color: '#8a93a6', fontSize: 12 }}>
            Something wrong with the app itself? Tell us
          </Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}

// B1: Pickup address + window, mirroring the web receipt page.
// Rendered only when fulfillment_method === 'pickup' and the auction has
// warehouse data. All warehouse fields are treated as nullable — if the
// operator hasn't linked a warehouse, we silently skip the block.
function PickupBlock({ invoice }: { invoice: Invoice }) {
  const wh = invoice.auctions?.warehouses ?? null;
  const pickupStart = invoice.auctions?.pickup_starts_at ?? null;
  const pickupEnd = invoice.auctions?.pickup_ends_at ?? null;

  // Build address lines defensively — skip any null/empty segment.
  const line1 = wh?.address_line1 ?? null;
  const line2 = wh?.address_line2 ?? null;
  const cityState = [wh?.city, wh?.state].filter(Boolean).join(', ');
  const postalCode = wh?.postal_code ?? null;
  const cityStateLine = [cityState, postalCode].filter(Boolean).join(' ');

  const DEFAULT_INVOICE_TZ = 'America/Chicago';

  // Format pickup window in the auction's warehouse timezone so the receipt
  // shows the same wall-clock time as the physical warehouse.
  function fmtDate(iso: string, tz: string | null | undefined): string {
    const zone = tz && tz.length > 0 ? tz : DEFAULT_INVOICE_TZ;
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: zone,
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  const tz = wh?.timezone ?? null;
  const windowLine =
    pickupStart && pickupEnd
      ? `${fmtDate(pickupStart, tz)} – ${fmtDate(pickupEnd, tz)}`
      : pickupStart
        ? `From ${fmtDate(pickupStart, tz)}`
        : null;

  return (
    <View
      style={{
        marginTop: 16,
        padding: 14,
        backgroundColor: '#1c2e49',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#232839',
        gap: 4,
      }}
    >
      <Text
        style={{
          color: '#8a93a6',
          fontSize: 10,
          fontWeight: '800',
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          marginBottom: 6,
        }}
      >
        Pickup
      </Text>
      {wh?.name ? (
        <Text style={{ color: '#e8eaf0', fontSize: 14, fontWeight: '600' }}>{wh.name}</Text>
      ) : null}
      {line1 ? (
        <Text style={{ color: '#e8eaf0', fontSize: 13 }}>
          {line1}{line2 ? `, ${line2}` : ''}
        </Text>
      ) : null}
      {cityStateLine ? (
        <Text style={{ color: '#e8eaf0', fontSize: 13 }}>{cityStateLine}</Text>
      ) : null}
      {windowLine ? (
        <Text style={{ color: '#8a93a6', fontSize: 13, marginTop: 4 }}>
          Window: {windowLine}
        </Text>
      ) : null}
    </View>
  );
}

function StatusBanner({
  invoice,
  cardLast4,
  retrying,
  policy,
  pickupForfeited,
  onUpdateCard,
  onRetry,
  onPayFees,
}: {
  invoice: Invoice;
  cardLast4: string | null;
  retrying: boolean;
  policy: OperatorPolicyMinimal;
  /** Forfeited pickup: nothing on this invoice is still collectable, so the
   *  "still yours to collect" remainder must not be claimed. */
  pickupForfeited: boolean;
  onUpdateCard: () => void;
  onRetry: () => void;
  onPayFees: () => void;
}) {
  const status = invoice.status;

  if (status === 'paid') {
    const paidLabel = invoice.paid_at
      ? new Date(invoice.paid_at).toLocaleString()
      : 'recently';
    return (
      <View
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 10,
          backgroundColor: 'rgba(52, 211, 154, 0.10)',
          borderWidth: 1,
          borderColor: '#34d39a',
        }}
      >
        <Text style={{ color: '#34d39a', fontWeight: '700' }}>Paid</Text>
        <Text style={{ color: '#e8eaf0', fontSize: 14, marginTop: 6 }}>
          {`${formatCents(invoice.total_cents)} on ${paidLabel}`}
          {cardLast4 ? ` to •••• ${cardLast4}` : ''}
        </Text>
      </View>
    );
  }

  if (status === 'pending') {
    return (
      <View
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 10,
          backgroundColor: '#1c2e49',
          borderWidth: 1,
          borderColor: '#232839',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <ActivityIndicator color="#4f8cff" />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#e8eaf0', fontWeight: '700' }}>
            Charging your card on file
          </Text>
          <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 4 }}>
            {cardLast4
              ? `•••• ${cardLast4} — usually under a minute.`
              : 'Usually under a minute.'}
          </Text>
        </View>
      </View>
    );
  }

  if (status === 'payment_failed_grace') {
    const graceLabel = invoice.grace_until
      ? new Date(invoice.grace_until).toLocaleString()
      : 'soon';
    return (
      <View
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 10,
          backgroundColor: 'rgba(255, 59, 59, 0.10)',
          borderWidth: 1,
          borderColor: '#ff3b3b',
          gap: 12,
        }}
      >
        <Text style={{ color: '#ff3b3b', fontWeight: '700' }}>Payment failed</Text>
        <Text style={{ color: '#e8eaf0', fontSize: 14, lineHeight: 20 }}>
          {policy.relist_fee_cents > 0
            ? `Update your payment method by ${graceLabel} to keep your items and to keep bidding. After that, your lots are relisted — and if you'd like to bid again you'll pay a ${formatCents(policy.relist_fee_cents)} relisting fee.`
            : `Update your payment method by ${graceLabel} to keep your items and to keep bidding. After that, your lots are relisted.`}
        </Text>
        {invoice.last_auto_charge_error && (
          <Text style={{ color: '#8a93a6', fontSize: 12 }}>
            Last error: {invoice.last_auto_charge_error}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={onUpdateCard}
            style={{
              flex: 1,
              padding: 14,
              backgroundColor: '#22c55e',
              borderRadius: 8,
            }}
          >
            <Text style={{ color: '#000', fontWeight: '700', textAlign: 'center' }}>
              Update card
            </Text>
          </Pressable>
          <Pressable
            onPress={onRetry}
            disabled={retrying}
            style={{
              flex: 1,
              padding: 14,
              backgroundColor: '#1e2c4d',
              borderRadius: 8,
              opacity: retrying ? 0.6 : 1,
            }}
          >
            {retrying ? (
              <ActivityIndicator color="#e8eaf0" />
            ) : (
              <Text style={{ color: '#e8eaf0', fontWeight: '700', textAlign: 'center' }}>
                Retry payment
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  if (status === 'payment_failed_relisted') {
    return (
      <View
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 10,
          backgroundColor: 'rgba(255, 59, 59, 0.10)',
          borderWidth: 1,
          borderColor: '#ff3b3b',
          gap: 12,
        }}
      >
        <Text style={{ color: '#ff3b3b', fontWeight: '700' }}>Lot relisted</Text>
        <Text style={{ color: '#e8eaf0', fontSize: 14, lineHeight: 20 }}>
          {policy.relist_fee_cents > 0
            ? `Sorry — your card couldn't be charged in time. The lot was relisted and a ${formatCents(policy.relist_fee_cents)} fee was added to your account. Pay it off to start bidding again.`
            : `Sorry — your card couldn't be charged in time. The lot was relisted.`}
        </Text>
        <Pressable
          onPress={onPayFees}
          style={{
            padding: 14,
            backgroundColor: '#22c55e',
            borderRadius: 8,
          }}
        >
          <Text style={{ color: '#000', fontWeight: '700', textAlign: 'center' }}>
            Pay fees
          </Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'refunded' || status === 'partially_refunded') {
    // invoices has no refunded_cents column — show refund status + date only
    // (the exact refunded amount lives on operator_settlements, not exposed to
    // the bidder; this mirrors the web receipt, which shows no cents figure).
    return (
      <View
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 10,
          backgroundColor: '#1c2e49',
          borderWidth: 1,
          borderColor: '#232839',
          gap: 8,
        }}
      >
        <Text style={{ color: '#e8eaf0', fontWeight: '700' }}>
          {status === 'refunded' ? 'Refunded' : 'Partially refunded'}
        </Text>
        <Text style={{ color: '#8a93a6', fontSize: 13 }}>
          Original {formatCents(invoice.total_cents)}
          {invoice.refunded_at
            ? ` · refunded on ${new Date(invoice.refunded_at).toLocaleDateString()}`
            : ''}
        </Text>
        {/* A partial refund leaves items the bidder still owns. Saying only
            "Partially refunded" read as "everything was refunded" and sent
            people away from the counter without collecting — while the staff
            scan still showed those items as owed. Name the remainder. */}
        {status === 'partially_refunded' &&
          !pickupForfeited &&
          (() => {
            // Forfeited invoices are excluded above: nothing on them is "still
            // yours to collect", so promising a remainder would be a false
            // claim rather than a merely unhelpful one.
            const stillOwed = invoice.invoice_lots.filter(
              (il) => !il.refunded_at && !il.picked_up_at,
            ).length;
            if (stillOwed === 0) return null;
            return (
              <Text style={{ color: '#4ade80', fontSize: 13, fontWeight: '600' }}>
                {stillOwed} {stillOwed === 1 ? 'item is' : 'items are'} still yours to
                collect — see the list above.
              </Text>
            );
          })()}
      </View>
    );
  }

  // Fallback for any unmapped status.
  return (
    <View
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 10,
        backgroundColor: '#1c2e49',
        borderWidth: 1,
        borderColor: '#232839',
      }}
    >
      <Text style={{ color: '#e8eaf0', fontWeight: '700' }}>{status}</Text>
    </View>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ color: bold ? '#e8eaf0' : '#8a93a6', fontWeight: bold ? '700' : '400' }}>
        {label}
      </Text>
      <Text style={{ color: '#e8eaf0', fontWeight: bold ? '700' : '400' }}>{value}</Text>
    </View>
  );
}

function AddrField({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  return (
    <View>
      <Text style={{ color: '#8a93a6', fontSize: 11, marginBottom: 4 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        maxLength={max}
        autoCapitalize={label === 'State' ? 'characters' : 'words'}
        style={{
          backgroundColor: colors.bg,
          borderWidth: 1,
          borderColor: '#232839',
          borderRadius: 6,
          padding: 10,
          color: '#e8eaf0',
        }}
      />
    </View>
  );
}
