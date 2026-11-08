// "As listed" — read-only, staff-only view of a sold lot exactly as it was
// advertised: title, description, condition, photos, the auction it sold in,
// and what it hammered for. Opened by tapping a lot row on the checkout
// screen (pickup-verify.tsx) during a cashier handoff.
//
// `lotId` is the invoice_lots.lot_id of the line the cashier tapped — the
// EXACT lot row that sold. A relist always mints a brand-new lots row
// (relisted_from_lot_id points back at the source), so this never needs to
// walk any lineage to find "the lot that sold" — it's always this id.
//
// `invoiceId` (query param) is used only to read invoices.paid_at, the sale
// moment used for the best-effort "edited after sale" note — see
// lib/lot-as-listed.ts for exactly what that can and cannot detect. No
// invoiceId means no sale-time comparison and the note never renders.
//
// No edit affordances anywhere on this screen — it's read-only by
// construction, not by a disabled button.

import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Image, ActivityIndicator, StyleSheet, Modal } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { resolveLotAsListedSnapshot, lotConditionLabel } from '@/lib/lot-as-listed';

type LotFetch = {
  id: string;
  title: string;
  description: string | null;
  condition: string | null;
  photo_urls: string[] | null;
  lot_code: string | null;
  sticker_code: string | null;
  display_code: string | null;
  auction_id: string | null;
  updated_at: string | null;
  auctions: { title: string | null } | { title: string | null }[] | null;
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}


export default function AsListedScreen() {
  const router = useRouter();
  const { lotId, invoiceId } = useLocalSearchParams<{ lotId: string; invoiceId?: string }>();
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lot, setLot] = useState<LotFetch | null>(null);
  const [winningBidCents, setWinningBidCents] = useState<number | null>(null);
  const [paidAt, setPaidAt] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErrorMsg(null);
      const { data: lotRow, error: lotErr } = await supabase
        .from('lots')
        .select(
          'id, title, description, condition, photo_urls, lot_code, sticker_code, display_code, auction_id, updated_at, auctions(title)',
        )
        .eq('id', lotId)
        .maybeSingle();
      if (cancelled) return;
      if (lotErr || !lotRow) {
        setErrorMsg(lotErr?.message ?? 'Lot not found.');
        setLoading(false);
        return;
      }
      setLot(lotRow as unknown as LotFetch);

      if (invoiceId) {
        const [{ data: lineRow }, { data: invRow }] = await Promise.all([
          supabase
            .from('invoice_lots')
            .select('winning_bid_cents')
            .eq('invoice_id', invoiceId)
            .eq('lot_id', lotId)
            .maybeSingle(),
          supabase.from('invoices').select('paid_at').eq('id', invoiceId).maybeSingle(),
        ]);
        if (cancelled) return;
        setWinningBidCents((lineRow as { winning_bid_cents?: number } | null)?.winning_bid_cents ?? null);
        setPaidAt((invRow as { paid_at?: string | null } | null)?.paid_at ?? null);
      }
      setLoading(false);
    }
    if (lotId) void load();
    return () => {
      cancelled = true;
    };
  }, [lotId, invoiceId]);

  const auctionTitle = lot
    ? Array.isArray(lot.auctions)
      ? (lot.auctions[0]?.title ?? null)
      : (lot.auctions?.title ?? null)
    : null;

  const snapshot = lot
    ? resolveLotAsListedSnapshot(
        {
          title: lot.title,
          description: lot.description,
          condition: lot.condition,
          photoUrls: lot.photo_urls ?? [],
          lotUpdatedAt: lot.updated_at,
        },
        { paidAt },
      )
    : null;

  const code = lot ? (lotDisplayCode(lot) ?? lot.lot_code ?? lot.id.slice(0, 8)) : null;

  return (
    <View style={styles.screen}>
      {loading && (
        <View style={styles.center}>
          <ActivityIndicator color="#4f8cff" />
        </View>
      )}

      {!loading && errorMsg && (
        <View style={styles.center}>
          <Text style={styles.muted}>{errorMsg}</Text>
          <Pressable onPress={() => router.back()} style={[styles.btn, { marginTop: 16 }]}>
            <Text style={styles.btnText}>Back</Text>
          </Pressable>
        </View>
      )}

      {!loading && lot && snapshot && (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <Text style={styles.eyebrow}>As listed · read-only</Text>

          {snapshot.photoUrls.length > 0 ? (
            <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}>
              {snapshot.photoUrls.map((url, i) => (
                <Pressable key={url + i} onPress={() => setLightboxIndex(i)}>
                  <Image source={{ uri: url }} style={styles.photo} resizeMode="cover" />
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <View style={[styles.photo, styles.center]}>
              <Text style={styles.muted}>No photos</Text>
            </View>
          )}

          <View style={{ padding: 16, gap: 10 }}>
            <Text style={styles.title}>{snapshot.title}</Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {code && <Text style={styles.code}>{code}</Text>}
              {lotConditionLabel(snapshot.condition) && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{lotConditionLabel(snapshot.condition)}</Text>
                </View>
              )}
            </View>

            {snapshot.description && <Text style={styles.description}>{snapshot.description}</Text>}

            <View style={styles.card}>
              {auctionTitle && (
                <Text style={styles.muted}>Sold in: {auctionTitle}</Text>
              )}
              {winningBidCents !== null && (
                <Text style={styles.value}>{formatCents(winningBidCents)}</Text>
              )}
            </View>

            {/* No "edited after sale" warning: lots.updated_at moves for many
                unrelated reasons (load backfill 0437 touched ~17k lots on 10-24,
                bin moves, status changes), so it would fire on most lots. Say
                plainly what this screen can and can't promise instead. */}
            <Text style={[styles.warnText, { marginTop: 12, opacity: 0.8 }]}>
              Shows this lot's current text and photos. Edits made after the sale aren't tracked.
            </Text>
          </View>
        </ScrollView>
      )}

      <Modal visible={lightboxIndex !== null} transparent animationType="fade" onRequestClose={() => setLightboxIndex(null)}>
        <Pressable style={styles.lightboxBg} onPress={() => setLightboxIndex(null)}>
          {lightboxIndex !== null && snapshot && (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ flex: 1 }}
              maximumZoomScale={4}
              minimumZoomScale={1}
              centerContent
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
            >
              <Image
                source={{ uri: snapshot.photoUrls[lightboxIndex] }}
                style={styles.lightboxImage}
                resizeMode="contain"
              />
            </ScrollView>
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0d12' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  eyebrow: {
    color: '#8a93a6',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  photo: { width: 360, height: 270, backgroundColor: '#1c2e49' },
  title: { color: '#e8eaf0', fontSize: 20, fontWeight: '700' },
  code: { color: '#8a93a6', fontSize: 13, fontFamily: 'monospace' },
  badge: {
    backgroundColor: '#232839',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#2e3550',
  },
  badgeText: { color: '#e8eaf0', fontSize: 11, fontWeight: '700' },
  description: { color: '#c4c9d4', fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: '#1c2e49',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#232839',
    padding: 14,
    gap: 4,
  },
  muted: { color: '#8a93a6', fontSize: 13 },
  value: { color: '#e8eaf0', fontSize: 18, fontWeight: '700' },
  warnBanner: {
    backgroundColor: '#3a2a12',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f5a623',
    padding: 12,
  },
  warnText: { color: '#f5a623', fontSize: 12, lineHeight: 17 },
  btn: { padding: 14, backgroundColor: '#4f8cff', borderRadius: 8 },
  btnText: { color: '#fff', textAlign: 'center', fontWeight: '600', fontSize: 15 },
  lightboxBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  lightboxImage: { width: '100%', height: '100%' },
});
