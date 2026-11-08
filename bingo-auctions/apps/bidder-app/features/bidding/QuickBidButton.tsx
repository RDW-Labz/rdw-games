// Quick Bid — place a bid straight from the auction thumbnail.
//
// Customer request (2026-07-29): "Some customers have requested the ability to
// place a bid directly from the auction thumbnail without opening the full
// listing. During the final seconds of an auction, opening the listing can take
// too long, causing them to miss the opportunity... consider adding a Quick Bid
// button directly on each auction thumbnail (with a confirmation prompt if
// needed)."
//
// Two things make this safe to put one tap away from real money:
//
// 1. It confirms. The request said "if needed" — it is needed. A grid of
//    thumbnails is scrolled with a thumb, and an accidental brush must not
//    commit a bid. The confirm names the exact amount, so the cost of the
//    second tap buys certainty about what is being spent. It is still far
//    faster than loading the listing, which is the actual complaint.
//
// 2. The amount is a PROXY MAX, and the server decides. place_bid takes
//    p_max_amount_cents and places only what is needed up to it. We pass the
//    next minimum, so max == the amount shown: the bid cannot silently escalate
//    beyond what the dialog said.
//
// On the estimate: nextMinimumBidCents mirrors the DB's
// min_bid_increment_cents, but LotCardData carries no bid_increment_schedule,
// so on an auction with a custom schedule the estimate can be off. That is
// contained — place_bid is authoritative. Too low and the server rejects with
// bid_too_low, which is shown; it never places a bid the bidder did not see.
//
// Self-contained by design: LotCard's memo comparator ignores the quickBid prop
// (see its doc comment), so busy state has to live here or the button would
// render once and then freeze.

import { useState } from 'react';
import { Alert, Pressable, Text, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { supabase } from '@auction-platform/supabase-client';
import { nextMinimumBidCents } from '@auction-platform/shared';
import type { LotCardData } from '@auction-platform/domain-bidding';
import { requireZip } from '@/lib/zip-gate';

function formatCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

// place_bid rejection reasons worth naming on a thumbnail. Anything else falls
// back to the raw reason so a new server gate is never swallowed silently.
const QUICK_BID_REASON_COPY: Record<string, string> = {
  bid_too_low: 'Someone just bid — open the listing to see the new price.',
  lot_not_live: 'Bidding has closed on this lot.',
  auction_not_live: 'This auction is not open for bidding.',
  no_payment_method: 'Add a payment method before bidding.',
  unpaid_fees: 'You have unpaid fees — settle them before bidding.',
  unpaid_invoice: 'You have an unpaid invoice — settle it before bidding.',
  not_authenticated: 'Sign in to bid.',
  self_outbid: "You're already the highest bidder.",
  identity_verification_required: 'This bid needs identity verification — open the listing.',
};

export function QuickBidButton({
  lot,
  onBidPlaced,
}: {
  lot: LotCardData;
  /** Lets the grid refresh the card's price without a full reload. */
  onBidPlaced?: (lotId: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  // Only for lots actually open for bidding.
  if (lot.status !== 'live') return null;

  const amount = nextMinimumBidCents(lot.current_bid_cents, lot.starting_bid_cents);

  async function placeBid() {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('place_bid', {
        p_lot_id: lot.id,
        p_max_amount_cents: amount,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { ok?: boolean; reason?: string };
      if (!res.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Bid not placed',
          QUICK_BID_REASON_COPY[res.reason ?? ''] ?? res.reason ?? 'Please try again.',
        );
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onBidPlaced?.(lot.id);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Bid not placed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    Alert.alert(
      `Bid ${formatCents(amount)}?`,
      `${lot.title}\n\nThis places a bid of ${formatCents(amount)} — it will not go higher on its own.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: `Bid ${formatCents(amount)}`, style: 'default', onPress: () => void placeBid() },
      ],
    );
  }

  // Mandatory ZIP block, one-time: resolves instantly once a ZIP is on file.
  // Checked before the confirm dialog even shows, so a bidder who still
  // needs it sees the ZIP step first, not a confirm for a bid that then
  // fails.
  async function onPress() {
    if (busy) return;
    setBusy(true);
    const hasZip = await requireZip();
    setBusy(false);
    if (!hasZip) return;
    confirm();
  }

  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={busy}
      // Keep the press off the card's navigation handler.
      onStartShouldSetResponder={() => true}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`Quick bid ${formatCents(amount)} on ${lot.title}`}
      style={{
        marginTop: 8,
        paddingVertical: 9,
        borderRadius: 8,
        alignItems: 'center',
        backgroundColor: busy ? '#3a4155' : '#f6911e',
        opacity: busy ? 0.7 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color="#0b0d12" size="small" />
      ) : (
        <Text style={{ color: '#0b0d12', fontSize: 13, fontWeight: '900' }}>
          Quick bid {formatCents(amount)}
        </Text>
      )}
    </Pressable>
  );
}
