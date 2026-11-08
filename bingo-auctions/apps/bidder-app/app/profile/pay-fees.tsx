// /profile/pay-fees — settle outstanding relot fees in one tap.
//
// 2026-05-21 (migration 0105) + 2026-05-29 (migrations 0157/0158):
// when a bidder's auto-charge fails AND they don't update their card
// before the operator's grace window expires, the lot is auto-relisted
// and an operator-configured relot fee (operator_policies.relist_fee_cents)
// is added to bidders.unpaid_fees_cents. The bidder cannot place new bids
// (place_bid §B rejects with reason='unpaid_fees') until they pay it off.
//
// This screen:
//   1. Reads bidders.unpaid_fees_cents + bidder_fee_ledger via Supabase.
//   2. Shows the breakdown ("Relot fee on lot CLR-000087 — $5.00").
//   3. "Pay $X" button → POST /api/bidders/me/pay-fees, which creates
//      an off-session PaymentIntent against the saved card and calls
//      clear_paid_relot_fees() on success.
//   4. On success: success state, then router.back().
//   5. On failure (card declined): error message + "Update card" CTA.

import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { formatCents } from '@auction-platform/shared';
import { requireZip } from '@/lib/zip-gate';

const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

type FeeRow = {
  id: string;
  amount_cents: number;
  reason: string;
  created_at: string;
  invoice_id: string | null;
  invoices: {
    invoice_lots: Array<{
      lots: { lot_code: string | null } | null;
    }>;
  } | null;
};

type State =
  | { kind: 'loading' }
  | { kind: 'no_balance' }
  | { kind: 'ready'; totalCents: number; rows: FeeRow[] }
  | { kind: 'paying' }
  | { kind: 'success'; chargedCents: number }
  | { kind: 'error'; message: string; needsCardUpdate: boolean };

export default function PayFeesScreen() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setState({ kind: 'error', message: 'Sign in to continue.', needsCardUpdate: false });
      return;
    }

    // Aggregate from the bidders row first — that's the value place_bid
    // checks. If it's zero, no fees to pay.
    const { data: bidder } = await supabase
      .from('bidders')
      .select('unpaid_fees_cents')
      .eq('id', u.user.id)
      .single();
    const total = (bidder?.unpaid_fees_cents as number | null) ?? 0;
    if (total <= 0) {
      setState({ kind: 'no_balance' });
      return;
    }

    // Read the unpaid ledger rows with the lot code for context.
    const { data: rows } = await supabase
      .from('bidder_fee_ledger')
      .select(
        `id, amount_cents, reason, created_at, invoice_id,
         invoices(invoice_lots(lots(lot_code)))`,
      )
      .eq('bidder_id', u.user.id)
      .is('paid_at', null)
      .order('created_at', { ascending: false });

    setState({
      kind: 'ready',
      totalCents: total,
      rows: (rows as unknown as FeeRow[]) ?? [],
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function pay() {
    if (state.kind !== 'ready') return;
    // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
    // paying fees is a checkout path. Resolves instantly once on file.
    const hasZip = await requireZip();
    if (!hasZip) return;
    setState({ kind: 'paying' });
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setState({
          kind: 'error',
          message: 'Sign-in expired.',
          needsCardUpdate: false,
        });
        return;
      }

      const res = await fetch(`${API_BASE}/api/bidders/me/pay-fees`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok && body.ok) {
        setState({ kind: 'success', chargedCents: body.charged_cents ?? 0 });
        // Give the user a beat to see the confirmation, then pop.
        setTimeout(() => router.back(), 1500);
        return;
      }

      // Card-related failures: surface an "Update card" CTA.
      const reason: string = body.reason ?? '';
      const cardIssues = [
        'card_declined',
        'requires_action',
        'requires_payment_method',
        'no_payment_method',
        'no_stripe_customer',
      ];
      const needsCardUpdate = cardIssues.includes(reason);
      const message =
        reason === 'card_declined'
          ? 'Your card was declined. Try updating it.'
          : reason === 'requires_action'
            ? 'Your card needs extra verification. Update it and try again.'
            : reason === 'no_payment_method'
              ? 'You don’t have a card on file yet.'
              : body.detail ?? body.error ?? `Payment failed (${res.status}).`;
      setState({ kind: 'error', message, needsCardUpdate });
    } catch (err) {
      setState({
        kind: 'error',
        message: (err as Error).message ?? 'Network error.',
        needsCardUpdate: false,
      });
    }
  }

  if (state.kind === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (state.kind === 'no_balance') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 22, ...type.display, marginBottom: 8 }}>
          You&apos;re all clear
        </Text>
        <Text style={{ color: colors.textMuted, textAlign: 'center', marginBottom: 24 }}>
          No outstanding fees on your account.
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 32,
            backgroundColor: colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 14, ...type.label }}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (state.kind === 'success') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <Text style={{ fontSize: 56, marginBottom: 12 }}>✓</Text>
        <Text style={{ color: colors.success, fontSize: 22, ...type.display, marginBottom: 6 }}>
          Paid {formatCents(state.chargedCents)}
        </Text>
        <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
          Your account is cleared. You can bid again.
        </Text>
      </View>
    );
  }

  const totalCents =
    state.kind === 'ready'
      ? state.totalCents
      : state.kind === 'error'
        ? 0
        : 0;
  const rows = state.kind === 'ready' ? state.rows : [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 24, paddingBottom: 64 }}
    >
      <Text
        style={{
          color: colors.textMuted,
          fontSize: 11,
          ...type.label,
          marginBottom: 6,
        }}
      >
        Fees due
      </Text>
      <Text
        style={{
          color: colors.danger,
          fontSize: 40,
          ...type.displayHero,
          marginBottom: 8,
        }}
      >
        {formatCents(totalCents)}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 24 }}>
        You can&apos;t place new bids until this is paid. We&apos;ll charge
        the card on file.
      </Text>

      {rows.length > 0 && (
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            marginBottom: 24,
            overflow: 'hidden',
          }}
        >
          {rows.map((row, idx) => {
            const lotCode =
              row.invoices?.invoice_lots?.[0]?.lots?.lot_code ?? null;
            const label =
              row.reason === 'relot_fee'
                ? lotCode
                  ? `Relot fee on lot ${lotCode}`
                  : 'Relot fee'
                : row.reason;
            return (
              <View
                key={row.id}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: colors.border,
                }}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ color: colors.text, fontSize: 14 }}>{label}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                    {new Date(row.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={{ color: colors.text, fontSize: 15, ...type.display }}>
                  {formatCents(row.amount_cents)}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {state.kind === 'error' && (
        <View
          style={{
            padding: 14,
            backgroundColor: colors.dangerDim,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.danger,
            marginBottom: 16,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
            {state.message}
          </Text>
        </View>
      )}

      {state.kind === 'error' && state.needsCardUpdate ? (
        <>
          <Pressable
            onPress={() => router.push('/profile/payment-method' as never)}
            style={{
              padding: 18,
              backgroundColor: colors.primary,
              borderRadius: 12,
              marginBottom: 12,
            }}
          >
            <Text
              style={{
                color: '#000',
                textAlign: 'center',
                fontSize: 15,
                ...type.label,
              }}
            >
              Update card
            </Text>
          </Pressable>
          <Pressable
            onPress={load}
            style={{
              padding: 14,
              backgroundColor: colors.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: colors.text, textAlign: 'center', fontSize: 14, ...type.label }}>
              Try again
            </Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          onPress={pay}
          disabled={state.kind === 'paying' || state.kind === 'error'}
          style={{
            padding: 18,
            backgroundColor: colors.primary,
            borderRadius: 12,
            opacity: state.kind === 'paying' ? 0.6 : 1,
          }}
        >
          {state.kind === 'paying' ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text
              style={{
                color: '#000',
                textAlign: 'center',
                fontSize: 15,
                ...type.label,
              }}
            >
              Pay {formatCents(totalCents)}
            </Text>
          )}
        </Pressable>
      )}
    </ScrollView>
  );
}
