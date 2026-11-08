// /profile/invoices — bidder-app invoice list.
//
// Mirrors apps/operator-web/src/app/profile/invoices/page.tsx so the
// bidder gets the same surface whether they use the app or the browser.
// Previously the bidder-app Receipts NavCard (profile.tsx) pointed at
// /(tabs)/my-bids because no list screen existed; user reported 2026-06-01
// that tapping a won row from there often surfaces "invoice still being
// prepared" inside the 30s build_invoice_jobs debounce window. This
// dedicated list screen breaks that confusing routing.
//
// Auth: RLS policy invoices_self_read (bidder_id = auth.uid()) restricts
// rows automatically. Explicit .eq('bidder_id', uid) is belt-and-
// braces — matches invoices_bidder_idx so the planner picks the cheap
// path.
//
// Tap target → /invoice/[id] (existing receipt screen). Empty state
// links to the browse tab (no invoices yet).

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase, getCurrentUserId } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { BrandedButton, colors } from '@auction-platform/design-system';
import { ErrorBoundary } from '../../components/ErrorBoundary';

const SCREEN_BG = colors.bg;
const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const TEXT_DIM = '#5a6276';
const BRAND_GREEN = '#5FE065';

interface InvoiceRow {
  id: string;
  status: string;
  total_cents: number;
  created_at: string;
  paid_at: string | null;
  auction_id: string;
  operator_id: string;
  auctions: { title: string | null } | null;
  operators: { business_name: string | null } | null;
}

function statusPill(status: string): { bg: string; fg: string; label: string } {
  switch (status) {
    case 'paid':
      return { bg: 'rgba(95, 224, 101, 0.12)', fg: BRAND_GREEN, label: 'Paid' };
    case 'pending':
      return { bg: 'rgba(255, 184, 0, 0.12)', fg: '#FFB800', label: 'Pending' };
    case 'refunded':
      return { bg: 'rgba(99, 144, 255, 0.12)', fg: '#6390FF', label: 'Refunded' };
    case 'partially_refunded':
      return { bg: 'rgba(99, 144, 255, 0.12)', fg: '#6390FF', label: 'Partial refund' };
    case 'unpaid_no_show':
    case 'payment_failed_grace':
    case 'payment_failed_relisted':
      return { bg: 'rgba(255, 59, 59, 0.12)', fg: '#FF3B3B', label: 'Action needed' };
    case 'canceled':
    default:
      return { bg: '#232839', fg: TEXT_MUTED, label: status };
  }
}

export default function InvoicesScreen(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <InvoicesScreenInner />
    </ErrorBoundary>
  );
}

function InvoicesScreenInner(): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState<boolean>(true);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const uid = await getCurrentUserId();
    if (!uid) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('invoices')
      .select(
        'id, status, total_cents, created_at, paid_at, auction_id, operator_id, ' +
        'auctions(title), operators:operators_public(business_name)',
      )
      .eq('bidder_id', uid)
      .order('created_at', { ascending: false })
      .limit(200);
    setInvoices((data as unknown as InvoiceRow[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: SCREEN_BG, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={BRAND_GREEN} />
      </View>
    );
  }

  if (invoices.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: SCREEN_BG, padding: 24, paddingTop: 64 }}>
        <Text style={{ fontSize: 11, color: TEXT_DIM, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 }}>
          Account
        </Text>
        <Text style={{ fontSize: 28, fontWeight: '900', color: TEXT_PRIMARY, marginBottom: 8 }}>
          Receipts
        </Text>
        <Text style={{ fontSize: 14, color: TEXT_MUTED, lineHeight: 22, marginBottom: 24 }}>
          You haven&apos;t won anything yet. Receipts will appear here after you win an auction.
        </Text>
        <BrandedButton variant="primary" onPress={() => router.push('/(tabs)' as never)}>
          Browse auctions
        </BrandedButton>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: SCREEN_BG }}
      contentContainerStyle={{ padding: 16, paddingTop: 48, paddingBottom: 64 }}
    >
      <Text style={{ fontSize: 11, color: TEXT_DIM, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 }}>
        Account
      </Text>
      <Text style={{ fontSize: 28, fontWeight: '900', color: TEXT_PRIMARY, marginBottom: 4 }}>
        Receipts
      </Text>
      <Text style={{ fontSize: 14, color: TEXT_MUTED, marginBottom: 20 }}>
        {invoices.length === 1 ? '1 invoice' : `${invoices.length} invoices`}
      </Text>

      <View style={{ gap: 10 }}>
        {invoices.map((inv) => (
          <InvoiceCard key={inv.id} invoice={inv} onPress={() => router.push(`/invoice/${inv.id}` as never)} />
        ))}
      </View>
    </ScrollView>
  );
}

function InvoiceCard({ invoice, onPress }: { invoice: InvoiceRow; onPress: () => void }): React.JSX.Element {
  const pill = statusPill(invoice.status);
  const operatorName = invoice.operators?.business_name ?? '—';
  const auctionTitle = invoice.auctions?.title ?? 'Auction';
  const dateRaw = invoice.status === 'paid' && invoice.paid_at ? invoice.paid_at : invoice.created_at;
  const dateLabel = invoice.status === 'paid' && invoice.paid_at ? 'Paid' : 'Created';
  let dateStr = '';
  try {
    dateStr = new Date(dateRaw).toLocaleDateString();
  } catch {
    dateStr = '';
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Receipt for ${auctionTitle}, ${pill.label}, ${formatCents(invoice.total_cents)}`}
      style={({ pressed }) => ({
        backgroundColor: CARD_BG,
        borderWidth: 1,
        borderColor: CARD_BORDER,
        borderRadius: 12,
        padding: 16,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 10,
              fontWeight: '800',
              color: TEXT_DIM,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
            numberOfLines={1}
          >
            {operatorName}
          </Text>
          <Text style={{ fontSize: 16, fontWeight: '700', color: TEXT_PRIMARY }} numberOfLines={1}>
            {auctionTitle}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <View
              style={{
                backgroundColor: pill.bg,
                paddingVertical: 2,
                paddingHorizontal: 8,
                borderRadius: 4,
              }}
            >
              <Text style={{ fontSize: 10, fontWeight: '800', color: pill.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {pill.label}
              </Text>
            </View>
            {dateStr && (
              <Text style={{ fontSize: 11, color: TEXT_MUTED }}>
                {dateLabel} {dateStr}
              </Text>
            )}
          </View>
          {/* Pay now CTA — only on payment_failed_grace rows. Routes to the
              invoice detail screen where Update-card + Retry buttons live.
              Does NOT duplicate the charge buttons here — just provides a
              prominent entry point from the list. */}
          {invoice.status === 'payment_failed_grace' && (
            <View style={{ marginTop: 10 }}>
              <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`Pay now for ${auctionTitle}`}
                style={({ pressed }) => ({
                  alignSelf: 'flex-start',
                  paddingVertical: 8,
                  paddingHorizontal: 14,
                  backgroundColor: pressed ? '#1a9e3f' : '#22c55e',
                  borderRadius: 6,
                })}
              >
                <Text style={{ color: '#000', fontSize: 13, fontWeight: '800' }}>
                  Pay now →
                </Text>
              </Pressable>
            </View>
          )}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 20, fontWeight: '900', color: TEXT_PRIMARY }}>
            {formatCents(invoice.total_cents)}
          </Text>
          <Text style={{ fontSize: 11, color: BRAND_GREEN, fontWeight: '600', marginTop: 4 }}>
            View receipt →
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
