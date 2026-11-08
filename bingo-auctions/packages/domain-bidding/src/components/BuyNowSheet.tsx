// BuyNowSheet — alternative to PlaceBidSheet for non-standard formats.
//
// Two flavors:
//   - Last Chance: shows flat_price_cents; "Buy" calls buy_flat_price RPC.
//   - Dutch: shows live current price (refreshed every second); "Buy" calls
//     buy_dutch with max_acceptable_cents = the price the bidder saw, so a
//     fast tick doesn't surprise them with a worse price.

import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { track } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { formatCents } from '@auction-platform/shared';

const REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Please sign in to buy.',
  not_a_bidder: 'Your bidder account is missing.',
  lot_not_found: 'This lot no longer exists.',
  lot_not_available: 'This lot is no longer available.',
  already_sold: 'Someone else just bought this.',
  wrong_format: 'This lot can\'t be bought directly.',
  not_started: 'This auction hasn\'t started yet.',
  price_above_max: 'The price ticked above what you saw — try again.',
  not_flat_price_lot: 'This isn\'t a flat-price lot.',
  not_dutch_lot: 'This isn\'t a Dutch lot.',
};

export type BuyNowSheetProps = {
  lotId: string;
  format: 'dutch' | 'last_chance';
  flatPriceCents: number | null;
  dutchStartCents: number | null;
  dutchFloorCents: number | null;
  dutchDeclinePerMinuteCents: number | null;
  auctionStartsAt: string;
  onPurchased?: (price: number) => void;
  // Optional pre-flight gate. See PlaceBidSheet.beforeBid for the
  // contract; we mirror it here so the per-operator policy modal also
  // intercepts dutch / last_chance buy actions.
  beforeBuy?: () => Promise<boolean>;
};

export function BuyNowSheet(props: BuyNowSheetProps) {
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null,
  );

  // Tick once a second so Dutch price stays current. Pure client clock — the
  // server is authoritative on the real price; the bidder's max_acceptable
  // arg gives them protection from a bad tick.
  useEffect(() => {
    if (props.format !== 'dutch') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [props.format]);

  const currentPriceCents = useMemo(() => {
    if (props.format === 'last_chance') return props.flatPriceCents ?? 0;
    if (
      props.dutchStartCents == null ||
      props.dutchDeclinePerMinuteCents == null
    ) {
      return null;
    }
    const elapsedMs = Math.max(0, now - new Date(props.auctionStartsAt).getTime());
    const elapsedMin = elapsedMs / 60000;
    const raw = props.dutchStartCents - elapsedMin * props.dutchDeclinePerMinuteCents;
    const clamped = props.dutchFloorCents != null ? Math.max(raw, props.dutchFloorCents) : raw;
    return Math.max(0, Math.round(clamped));
  }, [props, now]);

  async function buy() {
    if (currentPriceCents == null) return;
    setFeedback(null);

    // Per-operator policy gate. Same contract as PlaceBidSheet.beforeBid:
    // caller (lot screen) opens its own acceptance modal and resolves
    // true once the bidder accepts, false on cancel.
    if (props.beforeBuy) {
      const proceed = await props.beforeBuy();
      if (!proceed) return;
    }

    setSubmitting(true);
    const rpcName = props.format === 'last_chance' ? 'buy_flat_price' : 'buy_dutch';
    const args =
      props.format === 'last_chance'
        ? { p_lot_id: props.lotId }
        : { p_lot_id: props.lotId, p_max_acceptable_cents: currentPriceCents };
    const { data, error } = await supabase.rpc(rpcName, args);
    setSubmitting(false);

    if (error) {
      setFeedback({ type: 'error', text: error.message });
      return;
    }
    const result = data as {
      ok: boolean;
      reason: string;
      final_price_cents: number | null;
    };
    if (!result.ok) {
      setFeedback({
        type: 'error',
        text: REASON_MESSAGES[result.reason] ?? `Server: ${result.reason}`,
      });
      track('buy_rejected', { lot_id: props.lotId, format: props.format, reason: result.reason });
      return;
    }
    track('buy_succeeded', {
      lot_id: props.lotId,
      format: props.format,
      final_price_cents: result.final_price_cents,
    });
    setFeedback({
      type: 'success',
      text: `Bought at ${formatCents(result.final_price_cents ?? 0)}.`,
    });
    props.onPurchased?.(result.final_price_cents ?? 0);
  }

  const disabled = submitting || currentPriceCents == null || currentPriceCents <= 0;
  return (
    <View
      style={{
        marginTop: 20,
        padding: 16,
        backgroundColor: colors.surface,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
        {props.format === 'last_chance' ? 'Buy now · flat price' : 'Buy now · Dutch'}
      </Text>
      <Text
        style={{
          color: colors.text,
          fontSize: 36,
          marginTop: 4,
          ...type.displayHero,
        }}
      >
        {currentPriceCents != null ? formatCents(currentPriceCents) : '—'}
      </Text>
      {props.format === 'dutch' && props.dutchFloorCents != null && (
        <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 6 }}>
          Drops to {formatCents(props.dutchFloorCents)} over time.
        </Text>
      )}
      {feedback && (
        <View
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            backgroundColor:
              feedback.type === 'error' ? colors.dangerDim : colors.successDim,
          }}
        >
          <Text
            style={{
              color: feedback.type === 'error' ? colors.danger : colors.success,
              fontSize: 13,
              fontWeight: '700',
            }}
          >
            {feedback.text}
          </Text>
        </View>
      )}
      <Pressable
        onPress={buy}
        disabled={disabled}
        style={{
          marginTop: 16,
          padding: 18,
          backgroundColor: disabled ? colors.surfaceHi : colors.primary,
          borderRadius: 12,
          opacity: submitting ? 0.6 : 1,
        }}
      >
        {submitting ? (
          <ActivityIndicator color={disabled ? colors.textMuted : '#000'} />
        ) : (
          <Text
            style={{
              color: disabled ? colors.textMuted : '#000',
              textAlign: 'center',
              fontSize: 15,
              ...type.label,
            }}
          >
            Buy now
          </Text>
        )}
      </Pressable>
    </View>
  );
}
