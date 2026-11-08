// Alerts — chronological feed of pushes the platform sent to this bidder.
//
// Backstory: a user reported 2026-06-01 that they "didn't win a bid due to
// card declined" and "couldn't find where to pay for that unpaid invoice."
// The platform DID enqueue a payment_failed push (mig 0077's
// notifications_outbox + outbox worker), but until mig 0164 there was no
// bidder SELECT policy on notifications_outbox, so even a working push
// notification was strictly fire-and-forget — bidders could not page back
// through their alert history after the OS notification was dismissed.
//
// Source of truth: notifications_outbox (one row per outbound push, kept
// indefinitely; the worker just flips processed_at/emailed_at/smsed_at).
// We read the bidder's own rows via RLS (target_user_id = auth.uid()) and
// render kind/payload-derived title + body. Tap routes to payload.deep_link
// if present; otherwise the bidder reads the row in context.

import { useCallback, useEffect, useState } from 'react';
import { OUTBID_HEADLINE, outbidBody, formatCents } from '@auction-platform/shared';
import { View, Text, FlatList, Pressable, RefreshControl, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase, getCurrentUserId } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { markAlertsSeen } from '../../lib/unread-alerts';

// Mirrors the notification_kind enum (migs 0006 + 0077 + 0158 + 0159).
// Any new value added server-side falls through to the generic title/body
// below until this map is extended — that's an intentional graceful-degrade.
const KIND_LABEL: Record<string, string> = {
  // From @auction-platform/shared so this row, the web list, the push, the
  // email and the SMS cannot describe one event five different ways. The
  // comment above used to say this map "mirrors" the web's — which is another
  // way of saying two people maintained the same sentence by hand.
  outbid: OUTBID_HEADLINE,
  won: 'You won!',
  pickup_ready: 'Pickup ready',
  pickup_confirmed: 'Pickup confirmed',
  dispute_update: 'Dispute update',
  payment_failed: 'Payment failed',
  payment_retry_reminder: 'Payment reminder',
  dispute_opened: 'Dispute opened',
  dispute_evidence_due: 'Evidence due',
  lot_relisted_no_show: 'Lot relisted',
  // Added mig 0158 / 0159 / 0166 (E8 backfill — 2026-06-01)
  closing_soon: 'Closing soon',
  saved_search_hit: 'Saved search match',
  payment_requires_action: 'Action required',
  relot_fee_applied: 'Relot fee charged',
  pickup_no_show_forfeit: 'Pickup forfeited',
  pickup_no_show_refund_pending: 'Refund pending',
  refund_completed: 'Refund issued',
  refund_failed: 'Refund failed',
};

const KIND_TONE: Record<string, 'danger' | 'success' | 'warn' | 'info'> = {
  outbid: 'warn',
  won: 'success',
  pickup_ready: 'success',
  pickup_confirmed: 'info',
  dispute_update: 'warn',
  payment_failed: 'danger',
  payment_retry_reminder: 'danger',
  dispute_opened: 'danger',
  dispute_evidence_due: 'danger',
  lot_relisted_no_show: 'warn',
  // Added mig 0158 / 0159 / 0166 (E8 backfill — 2026-06-01)
  closing_soon: 'warn',
  saved_search_hit: 'info',
  payment_requires_action: 'danger',
  relot_fee_applied: 'warn',
  pickup_no_show_forfeit: 'danger',
  pickup_no_show_refund_pending: 'warn',
  refund_completed: 'success',
  refund_failed: 'danger',
};

type Payload = {
  lot_id?: string;
  lot_title?: string;
  invoice_id?: string;
  current_bid_cents?: number;
  winning_bid_cents?: number;
  // deep_link: convention used by the outbox worker since mig 0124.
  // Form: '/invoice/<uuid>' or '/lot/<uuid>'. Optional — server may omit.
  deep_link?: string;
  // Fields added for mig 0158/0159/0166 notification kinds (E8 backfill).
  search_name?: string;
  total_cents?: number;
  restock_fee_cents?: number;
  policy?: string;
  closing_in_seconds?: number;
};

type NotificationRow = {
  id: string;
  kind: string;
  payload: Payload;
  created_at: string;
};

// ── SMS opt-in nudge (2026-07-07) ─────────────────────────────────────────────
// The SMS pipeline (Twilio drain, outbid/won/closing-soon texts) has existed
// since 0014 but is opt-in and the toggle lives in Profile → Edit, so nobody
// found it: 0 of 79 phone-on-file bidders had it on. This card sits on the
// alerts tab — the exact audience already reading notifications — and enables
// texts in one tap. Dismissal persists locally and never re-nags.

const SMS_NUDGE_DISMISSED_KEY = 'sms_nudge_dismissed_v1';

function SmsNudgeCard() {
  const [state, setState] = useState<'hidden' | 'show' | 'saving' | 'done'>('hidden');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dismissed = await AsyncStorage.getItem(SMS_NUDGE_DISMISSED_KEY).catch(() => null);
      if (dismissed) return;
      const uid = await getCurrentUserId();
      if (!uid || cancelled) return;
      const { data } = await supabase
        .from('bidders')
        .select('phone, sms_enabled')
        .eq('id', uid)
        .maybeSingle();
      const row = data as { phone: string | null; sms_enabled: boolean | null } | null;
      // Only nudge bidders who already have a number on file and texts off.
      if (!cancelled && row?.phone && !row.sms_enabled) setState('show');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'hidden') return null;

  const enable = async () => {
    setState('saving');
    const uid = await getCurrentUserId();
    if (!uid) return setState('show');
    const { error } = await supabase
      .from('bidders')
      .update({ sms_enabled: true })
      .eq('id', uid);
    if (error) {
      Alert.alert('Could not enable texts', error.message);
      setState('show');
      return;
    }
    setState('done');
    void AsyncStorage.setItem(SMS_NUDGE_DISMISSED_KEY, '1');
  };

  const dismiss = () => {
    setState('hidden');
    void AsyncStorage.setItem(SMS_NUDGE_DISMISSED_KEY, '1');
  };

  return (
    <View
      style={{
        marginBottom: 8,
        padding: 14,
        borderRadius: 12,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 8,
      }}
    >
      {state === 'done' ? (
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
          ✓ Texts on — we&apos;ll message you when you&apos;re outbid or win. Change anytime
          in Profile → Edit.
        </Text>
      ) : (
        <>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>
            Want these as texts too?
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            You have a phone number on file. Get a text the moment you&apos;re outbid,
            when lots close soon, and when you win.
          </Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
            <Pressable
              onPress={enable}
              disabled={state === 'saving'}
              style={{
                backgroundColor: colors.primary,
                borderRadius: 8,
                paddingVertical: 8,
                paddingHorizontal: 18,
              }}
            >
              <Text style={{ color: '#0b0d12', fontSize: 13, fontWeight: '800' }}>
                {state === 'saving' ? 'Saving…' : 'Turn on texts'}
              </Text>
            </Pressable>
            <Pressable onPress={dismiss} style={{ paddingVertical: 8, paddingHorizontal: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '600' }}>
                No thanks
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

export default function NotificationsScreen() {
  return (
    <ErrorBoundary label="Notifications screen">
      <NotificationsScreenInner />
    </ErrorBoundary>
  );
}

function NotificationsScreenInner() {
  const router = useRouter();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-render every 60s so relative-time labels (e.g. "2h ago") stay fresh
  // without a per-row interval.
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    const uid = await getCurrentUserId();
    if (!uid) {
      setRows([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const { data, error: qErr } = await supabase
      .from('notifications_outbox')
      .select('id, kind, payload, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (qErr) {
      setError(qErr.message);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setRows((data ?? []) as unknown as NotificationRow[]);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      // Opening the tab = the bidder has looked at their alerts; clear the
      // unread badge immediately (store stamps "seen up to now").
      void markAlertsSeen();
    }, [load]),
  );

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const onPressRow = useCallback(
    (row: NotificationRow) => {
      const link = row.payload?.deep_link;
      if (link && typeof link === 'string' && link.startsWith('/')) {
        router.push(link as never);
        return;
      }
      // Fallbacks by kind — keeps taps useful even when the server forgot
      // to emit a deep_link.
      if (row.payload?.invoice_id) {
        router.push({ pathname: '/invoice/[id]', params: { id: row.payload.invoice_id } });
        return;
      }
      if (row.payload?.lot_id) {
        router.push({ pathname: '/lot/[id]', params: { id: row.payload.lot_id } });
      }
    },
    [router],
  );

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.textMuted }}>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {error && (
        <View
          style={{
            margin: 12,
            padding: 10,
            backgroundColor: colors.dangerDim,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.danger,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '700' }}>
            Couldn&apos;t load alerts
          </Text>
          <Text style={{ color: colors.text, fontSize: 12, marginTop: 4 }}>{error}</Text>
        </View>
      )}
      <FlatList
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textMuted}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 32 }}
        ListHeaderComponent={<SmsNudgeCard />}
        renderItem={({ item }) => (
          <NotificationRowView row={item} onPress={() => onPressRow(item)} />
        )}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Text
              style={{
                color: colors.text,
                fontSize: 16,
                fontWeight: '700',
                marginBottom: 8,
                textAlign: 'center',
              }}
            >
              No alerts yet
            </Text>
            <Text
              style={{
                color: colors.textMuted,
                textAlign: 'center',
                lineHeight: 20,
              }}
            >
              When you&apos;re outbid, win an auction, or have a pickup ready, we&apos;ll let you know here.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function NotificationRowView({
  row,
  onPress,
}: {
  row: NotificationRow;
  onPress: () => void;
}) {
  const tone = KIND_TONE[row.kind] ?? 'info';
  const accent =
    tone === 'danger'
      ? colors.danger
      : tone === 'success'
        ? colors.success
        : tone === 'warn'
          ? colors.winning
          : colors.textMuted;
  const title = KIND_LABEL[row.kind] ?? formatKindFallback(row.kind);
  const body = describeBody(row);
  const tapable =
    !!row.payload?.deep_link || !!row.payload?.invoice_id || !!row.payload?.lot_id;

  return (
    <Pressable
      onPress={tapable ? onPress : undefined}
      style={({ pressed }) => ({
        padding: 14,
        borderRadius: 12,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        flexDirection: 'row',
        gap: 12,
        opacity: pressed && tapable ? 0.7 : 1,
        minHeight: 48, // a11y tap target
      })}
    >
      <View
        style={{
          width: 4,
          alignSelf: 'stretch',
          borderRadius: 2,
          backgroundColor: accent,
        }}
      />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            style={{
              color: accent,
              fontSize: 11,
              fontWeight: '900',
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              flex: 1,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 11 }}>
            {formatRelative(row.created_at)}
          </Text>
        </View>
        {body && (
          <Text
            style={{
              color: colors.text,
              fontSize: 14,
              marginTop: 4,
              lineHeight: 19,
            }}
            numberOfLines={3}
          >
            {body}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function describeBody(row: NotificationRow): string | null {
  const p = row.payload ?? {};
  const lotTitle = typeof p.lot_title === 'string' ? p.lot_title : null;
  switch (row.kind) {
    case 'outbid':
      // Shared copy — see the module header for why "Someone outbid you" went.
      return outbidBody({
        // No lotCode: the drains decorate row.payload with lot_code in
        // memory at send time and never write it back, so the STORED payload
        // has none. describeLot degrades to the title alone — the sentence is
        // identical to the push and email, only the parenthetical code is
        // absent, which is what these lists have always shown.
        lotTitle,
        price:
          typeof p.current_bid_cents === 'number'
            ? formatCents(p.current_bid_cents)
            : null,
      });
    case 'won':
      return lotTitle
        ? `You won "${lotTitle}". Tap to view your invoice.`
        : 'You won an auction. Tap to view your invoice.';
    case 'pickup_ready':
      return 'Your items are staged and ready for pickup.';
    case 'pickup_confirmed':
      return 'Pickup confirmed. Thanks!';
    case 'payment_failed':
      return 'Your card was declined. Tap to update your card and pay.';
    case 'payment_retry_reminder':
      return 'You have an unpaid invoice. Tap to pay before it expires.';
    case 'dispute_opened':
      return 'A dispute was opened on your invoice. Tap to see details.';
    case 'dispute_evidence_due':
      return 'Evidence is due on a disputed invoice.';
    case 'dispute_update':
      return 'There is an update on your dispute.';
    case 'lot_relisted_no_show':
      return lotTitle
        ? `"${lotTitle}" was relisted because the invoice was not paid in time.`
        : 'A won lot was relisted because the invoice was not paid in time.';
    // ── E8 backfill: 8 newer kinds (migs 0158 / 0159 / 0166) ────────────────
    case 'closing_soon': {
      const secs = typeof p.closing_in_seconds === 'number' ? p.closing_in_seconds : null;
      const timeStr = secs !== null && secs < 3600
        ? `${Math.ceil(secs / 60)} min`
        : secs !== null
          ? `${Math.ceil(secs / 3600)} hr`
          : null;
      return lotTitle
        ? timeStr
          ? `"${lotTitle}" closes in ${timeStr}. Tap to bid.`
          : `"${lotTitle}" is closing soon. Tap to bid.`
        : "An auction you're watching is closing soon. Tap to bid.";
    }
    case 'saved_search_hit': {
      const searchName = typeof p.search_name === 'string' ? p.search_name : null;
      return searchName
        ? `A new lot matches your saved search "${searchName}". Tap to view.`
        : 'A new lot matches one of your saved searches. Tap to view.';
    }
    case 'payment_requires_action':
      return 'Your payment requires additional verification. Tap to complete it.';
    case 'relot_fee_applied': {
      const total = typeof p.total_cents === 'number' ? `$${(p.total_cents / 100).toFixed(2)}` : null;
      return total
        ? `A $${total} relot fee was applied to your account for a failed pickup.`
        : 'A relot fee was applied to your account for a failed pickup.';
    }
    case 'pickup_no_show_forfeit':
      return 'You missed your pickup window. Your lots have been relisted and your payment was forfeited. Tap to view your invoice.';
    case 'pickup_no_show_refund_pending': {
      const restock = typeof p.restock_fee_cents === 'number'
        ? `$${(p.restock_fee_cents / 100).toFixed(2)}`
        : null;
      return restock
        ? `You missed your pickup window. A refund minus a ${restock} restock fee is on the way.`
        : 'You missed your pickup window. A refund is being processed.';
    }
    case 'refund_completed':
      return 'Your refund has been issued. It may take 5–10 business days to appear.';
    case 'refund_failed':
      return 'We could not process your refund automatically. Please contact support.';
    default:
      // Unknown kind: render whatever the payload had. Better than blank.
      return lotTitle ?? null;
  }
}

function formatKindFallback(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Same helper used in stats.tsx. Inlined here to avoid pulling the entire
// stats module just for this one function.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 60 * 1000) return 'Just now';
  if (diffMs < 60 * 60 * 1000) {
    const m = Math.round(diffMs / (60 * 1000));
    return `${m}m ago`;
  }
  if (diffMs < 24 * 60 * 60 * 1000) {
    const h = Math.round(diffMs / (60 * 60 * 1000));
    return `${h}h ago`;
  }
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months === 1) return '1mo ago';
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}
