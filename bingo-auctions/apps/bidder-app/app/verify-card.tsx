// /verify-card — post-charge-failure recovery surface for the bidder app.
//
// Landing target for the `payment_requires_action` push (mig 0124) and the
// `bingo://verify-card?invoice_id=<uuid>` deep link. Under the pre-cutover
// Stripe flow this ran Stripe PaymentSheet SCA against
// invoices.authentication_client_secret. Post the Square single-account
// cutover there is no Stripe SCA and Square card-on-file MIT charges don't
// produce a client secret, so the only meaningful recovery is to update the
// card on file. This screen now shows the affected invoice and routes to the
// card screen (which drives the Square web card handoff). No Stripe SDK — the
// native @stripe/stripe-react-native module was removed from the app.
//
// Auth: RLS-scoped read of invoices via the bidder's Supabase session.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

type LotLink = { lots: { lot_code: string | null } | null };

type InvoiceForVerify = {
  id: string;
  total_cents: number;
  status: string;
  auctions: { title: string | null } | null;
  operators: { business_name: string | null } | null;
  invoice_lots: LotLink[];
};

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function VerifyCardScreen() {
  const router = useRouter();
  const { invoice_id } = useLocalSearchParams<{ invoice_id?: string }>();

  const [invoice, setInvoice] = useState<InvoiceForVerify | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInvoice = useCallback(async () => {
    if (typeof invoice_id !== 'string' || invoice_id.length === 0) {
      setError('Missing invoice id.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // RLS scopes this to the calling bidder's own invoices.
      const { data, error: err } = await supabase
        .from('invoices')
        .select(
          `id, total_cents, status,
           auctions(title), operators:operators_public(business_name),
           invoice_lots(lots(lot_code))`,
        )
        .eq('id', invoice_id)
        .maybeSingle();
      if (err) {
        setError(err.message);
        return;
      }
      const row = (data as unknown as InvoiceForVerify | null) ?? null;
      if (!row) {
        setError("We couldn't find that invoice on your account.");
        return;
      }
      setInvoice(row);
    } finally {
      setLoading(false);
    }
  }, [invoice_id]);

  useEffect(() => {
    loadInvoice();
  }, [loadInvoice]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error || !invoice) {
    return (
      <ScrollView contentContainerStyle={{ padding: 20, backgroundColor: colors.bg, flexGrow: 1 }}>
        <Text style={{ color: colors.text, fontSize: 22, marginBottom: 12, ...type.display }}>Update your card</Text>
        <View
          style={{
            padding: 14,
            borderRadius: 10,
            backgroundColor: 'rgba(255,59,59,0.10)',
            borderWidth: 1,
            borderColor: 'rgba(255,59,59,0.40)',
          }}
        >
          <Text style={{ color: '#ff6b6b', lineHeight: 20 }}>
            {error ?? 'We could not load this invoice.'}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/profile/payment-method' as never)}
          style={({ pressed }) => ({
            marginTop: 16,
            paddingVertical: 14,
            borderRadius: 10,
            backgroundColor: pressed ? colors.surfaceAlt : colors.primary,
            alignItems: 'center',
          })}
        >
          <Text style={{ color: '#000', fontWeight: '800' }}>Update card</Text>
        </Pressable>
        <Pressable
          onPress={() => router.replace('/(tabs)' as never)}
          style={{ paddingVertical: 14, alignItems: 'center', marginTop: 8 }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Back to home</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const lotCode = invoice.invoice_lots?.[0]?.lots?.lot_code ?? null;
  const operatorName = invoice.operators?.business_name ?? 'Operator';
  const auctionTitle = invoice.auctions?.title ?? 'Auction';
  const isPaid = invoice.status === 'paid';

  return (
    <ScrollView contentContainerStyle={{ padding: 20, backgroundColor: colors.bg, flexGrow: 1 }}>
      <Text
        style={{
          fontSize: 11,
          color: colors.textDim,
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 6,
        }}
      >
        Payment
      </Text>
      <Text style={{ color: colors.text, fontSize: 28, marginBottom: 8, ...type.displayHero }}>
        {isPaid ? 'All caught up' : 'Update your card'}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 15, lineHeight: 22, marginBottom: 24 }}>
        {isPaid
          ? 'This charge is already settled. Tap below to view the invoice.'
          : "We couldn't complete the charge on your card. Update your card on file to finish paying — we'll retry automatically."}
      </Text>

      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: colors.border,
          marginBottom: 16,
        }}
      >
        <Text
          style={{
            fontSize: 10,
            fontWeight: '800',
            color: colors.textDim,
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            marginBottom: 4,
          }}
        >
          {operatorName}
        </Text>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
          {auctionTitle}
        </Text>
        {lotCode ? (
          <Text style={{ color: colors.textMuted, fontSize: 13, marginBottom: 8 }}>
            lot {lotCode}
          </Text>
        ) : null}
        <Text style={{ fontSize: 28, fontWeight: '900', color: colors.text, marginTop: 4 }}>
          {fmtMoney(invoice.total_cents)}
        </Text>
      </View>

      {isPaid ? (
        <Pressable
          onPress={() => router.replace({ pathname: '/invoice/[id]', params: { id: invoice.id } })}
          style={({ pressed }) => ({
            paddingVertical: 16,
            borderRadius: 10,
            backgroundColor: pressed ? colors.surfaceAlt : colors.primary,
            alignItems: 'center',
          })}
        >
          <Text style={{ color: '#000', fontWeight: '800', fontSize: 16 }}>View invoice</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={() => router.push('/profile/payment-method' as never)}
          style={({ pressed }) => ({
            paddingVertical: 16,
            borderRadius: 10,
            backgroundColor: pressed ? colors.surfaceAlt : colors.primary,
            alignItems: 'center',
          })}
        >
          <Text style={{ color: '#000', fontWeight: '800', fontSize: 16 }}>Update card</Text>
        </Pressable>
      )}

      <Pressable
        onPress={() => router.back()}
        style={{ paddingVertical: 14, alignItems: 'center', marginTop: 8 }}
      >
        <Text style={{ color: colors.textMuted, fontSize: 14 }}>Not now</Text>
      </Pressable>
    </ScrollView>
  );
}
