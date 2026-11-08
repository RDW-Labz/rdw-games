// PlaceBidSheet — bid input with proxy/max bidding.
// Calls the `place_bid` Postgres function (not a direct INSERT) which is
// the only way to write to `bids`. Surfaces all result `reason` codes so
// the bidder gets a clear error message.
//
// Identity gate: when a max bid lands above
// IDENTITY_VERIFICATION_THRESHOLD_CENTS and the bidder isn't yet verified,
// we route them to /identity/verify before the RPC fires. After verification
// they can come back and resubmit.

import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { track } from '@auction-platform/supabase-client';
import { BrandedButton, colors, type } from '@auction-platform/design-system';
import {
  formatCents,
  nextMinimumBidCents,
  dollarsToCents,
  IDENTITY_VERIFICATION_THRESHOLD_CENTS,
  type PlaceBidResult,
  type BidIncrementTier,
} from '@auction-platform/shared';

const REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Please sign in to bid.',
  not_a_bidder: 'Your bidder account is missing. Try signing out and back in.',
  lot_not_found: 'This lot no longer exists.',
  lot_not_biddable: 'Bidding has ended or is paused on this lot.',
  lot_closed: 'This lot has closed.',
  below_starting_bid: 'Your bid is below the starting bid.',
  below_min_increment: 'Your bid is below the minimum increment.',
  ok: '',
};

// 2026-05-20: migration 0084 added server-side security guards that
// throw via `RAISE EXCEPTION ... USING ERRCODE = 'P0001'` instead of
// returning a `place_bid_result.reason`. Map the prefix of those
// exceptions to friendly UI strings + optional follow-up actions.
const SQL_EXCEPTION_PATTERNS: Array<{
  prefix: string;
  message: string;
  action?: 'verify_identity';
}> = [
  {
    prefix: 'shill_bidding_forbidden',
    message:
      'You are staff for this auction operator and cannot bid on their lots. Try a different operator.',
  },
  {
    prefix: 'identity_verification_required',
    message:
      'Bids over $500 require a quick ID check. Tap Verify identity below to continue.',
    action: 'verify_identity',
  },
  {
    prefix: 'bidder_suspended',
    message: 'Your account is suspended. Contact support@clovrbid.com to appeal.',
  },
];

function mapSqlException(err: Error): {
  text: string;
  action?: 'verify_identity';
} {
  const msg = err.message ?? '';
  for (const p of SQL_EXCEPTION_PATTERNS) {
    if (msg.includes(p.prefix)) {
      return { text: p.message, action: p.action };
    }
  }
  return { text: 'Bid failed. Please try again or contact support.' };
}

export type PlaceBidSheetProps = {
  lotId: string;
  currentBidCents: number | null;
  startingBidCents: number;
  msrpCents?: number | null;
  closeAt: string;
  onPlaced?: (result: PlaceBidResult) => void;
  // Optional pre-flight gate. Returns true to proceed with the RPC, false
  // to cancel silently (caller is expected to have surfaced UI such as
  // an operator-policy acceptance modal). When omitted, the sheet
  // behaves identically to v1.
  beforeBid?: () => Promise<boolean>;
  // BID-3: effective increment schedule for this lot (auction override ??
  // operator default), threaded from the lot screen. Passed to
  // nextMinimumBidCents so the displayed minimum + quick-pick chips match
  // what place_bid enforces. undefined/null → legacy ladder.
  incrementSchedule?: BidIncrementTier[] | null;
};

export function PlaceBidSheet(props: PlaceBidSheetProps) {
  const minNextCents = useMemo(
    () =>
      nextMinimumBidCents(
        props.currentBidCents,
        props.startingBidCents,
        props.incrementSchedule,
      ),
    [props.currentBidCents, props.startingBidCents, props.incrementSchedule],
  );

  // Empty initial state — the placeholder shows the suggested minimum.
  // Bidders can either tap a quick-pick chip or type a fresh number.
  // Pre-filling the field would make typing "2" turn into "1.102"
  // (RN's selectTextOnFocus is unreliable on iOS for controlled inputs).
  const [maxBid, setMaxBid] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<
    { type: 'error' | 'success' | 'warning'; text: string } | null
  >(null);

  // Cache the auth user id once so the post-RPC leader comparison can
  // tell "you lead" from "someone else leads" without an extra round trip
  // on every bid. Pulled at sheet mount.
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null));
  }, []);

  // No auto-fill on min change — when current bid moves up, the
  // status line below the input flips to "Need $X more" so the bidder
  // sees they need to raise. Keeps the input fully user-driven.

  async function placeBid() {
    setFeedback(null);

    let cents: number;
    try {
      cents = dollarsToCents(maxBid);
    } catch {
      setFeedback({ type: 'error', text: 'Enter a valid amount' });
      return;
    }
    if (cents < minNextCents) {
      setFeedback({
        type: 'error',
        text: `Minimum bid is ${formatCents(minNextCents)}`,
      });
      return;
    }

    // Per-operator policy gate. Caller (lot detail screen) checks whether
    // the bidder has accepted this operator's current policy version; if
    // not, it opens an acceptance modal and resolves true once accepted,
    // false on cancel. Runs before the identity gate so the user sees
    // the more localised "accept these terms" prompt before being routed
    // to Stripe Identity (which interrupts the bid flow harder).
    if (props.beforeBid) {
      const proceed = await props.beforeBid();
      if (!proceed) {
        // No feedback — the caller's modal owns its own messaging. We
        // exit cleanly so the bidder doesn't see a misleading red error
        // banner on what's actually a "you cancelled" path.
        return;
      }
    }

    // Identity gate — at-or-above threshold without verification → bounce.
    if (cents >= IDENTITY_VERIFICATION_THRESHOLD_CENTS) {
      const { data: u } = await supabase.auth.getUser();
      if (u.user) {
        const { data: bidder } = await supabase
          .from('bidders')
          .select('identity_verified_at')
          .eq('id', u.user.id)
          .single();
        if (!bidder?.identity_verified_at) {
          Alert.alert(
            'Verify your identity',
            `Bids over ${formatCents(IDENTITY_VERIFICATION_THRESHOLD_CENTS)} require a quick ID check. We use Stripe Identity — takes about 60 seconds.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Verify now', onPress: () => router.push('/identity/verify') },
            ],
          );
          return;
        }
      }
    }

    setSubmitting(true);
    const { data, error } = await supabase.rpc('place_bid', {
      p_lot_id: props.lotId,
      p_max_amount_cents: cents,
    });
    setSubmitting(false);

    if (error) {
      // 2026-05-20: migration 0084's RAISE EXCEPTION patterns (shill,
      // identity, suspended) come back as raw .message strings. Map
      // them to friendly copy + optional follow-up action.
      const mapped = mapSqlException(error as Error);
      setFeedback({ type: 'error', text: mapped.text });
      if (mapped.action === 'verify_identity') {
        Alert.alert(
          'Verify your identity',
          'Bids above $500 require a quick ID check via Stripe Identity (about 60 seconds).',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Verify now',
              onPress: () => router.push('/identity/verify'),
            },
          ],
        );
      }
      return;
    }

    const result = data as unknown as PlaceBidResult;

    if (!result.ok) {
      setFeedback({
        type: 'error',
        text: REASON_MESSAGES[result.reason] ?? `Bid rejected: ${result.reason}`,
      });
      track('bid_rejected', { lot_id: props.lotId, reason: result.reason, max_cents: cents });
      return;
    }

    track('bid_placed', {
      lot_id: props.lotId,
      max_cents: cents,
      current_bid_cents: result.current_bid_cents,
      was_extended: result.was_extended,
    });

    // Compare leader to *me*, not just "leader != null". The earlier
    // `result.current_leader_id != null` check was always true on a
    // successful place_bid (someone always leads), so a proxy-outbid
    // path was rendered as a green success — actively misleading.
    const youLead = meId != null && result.current_leader_id === meId;
    setFeedback({
      // Proxy-outbid is a *defeat*, not a success — render in warning
      // (red-orange) so it doesn't read as celebratory.
      type: youLead ? 'success' : 'warning',
      text: youLead
        ? `Bid placed at ${formatCents(result.current_bid_cents ?? 0)}${
            result.was_extended ? ' (close extended)' : ''
          }`
        : 'You were outbid by an existing max bid — raise your max to take the lead.',
    });
    if (youLead) {
      // Local haptic so the bidder feels the win even before the
      // Realtime UPDATE for the lot row arrives at the parent screen.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Clear the input so the next bid (after a counter from another
      // bidder) starts from the placeholder = new minimum, not the now-
      // stale max amount.
      setMaxBid('');
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    props.onPlaced?.(result);
  }

  const closed = new Date(props.closeAt).getTime() <= Date.now();

  // Live derived state from the typed amount. Re-renders on every
  // keystroke so the bidder sees what their bid means before they tap.
  const parsedCents = useMemo(() => {
    try {
      return dollarsToCents(maxBid);
    } catch {
      return 0;
    }
  }, [maxBid]);
  const isValid = parsedCents >= minNextCents && !closed;
  const overCurrent = parsedCents - (props.currentBidCents ?? 0);
  const startingFresh = props.currentBidCents == null;
  const needMoreCents = Math.max(0, minNextCents - parsedCents);
  const msrpPercent =
    props.msrpCents && props.msrpCents > 0
      ? Math.round((1 - parsedCents / props.msrpCents) * 100)
      : null;
  const overMsrp = props.msrpCents != null && parsedCents > props.msrpCents;

  // Quick-bid chips — set the input to a tiered amount above the min.
  // For lots with current bid >= $50, replace the +$25 fixed chip with a
  // +10%-of-current chip rounded to the nearest dollar. On a $200 lot a
  // +$25 chip is a rounding error; +10% (= $20) plus +$50 makes the
  // jumps feel proportional. Below $50 the small fixed chips stay.
  const baseCents = props.currentBidCents ?? props.startingBidCents;
  const quickBids: Array<{ label: string; cents: number }> = (() => {
    if (baseCents >= 5000) {
      const pctCents = Math.max(
        minNextCents + 100,
        Math.round((baseCents * 1.1) / 100) * 100,
      );
      return [
        { label: `Min ${formatCents(minNextCents)}`, cents: minNextCents },
        { label: '+$5', cents: minNextCents + 500 },
        { label: '+$10', cents: minNextCents + 1000 },
        { label: '+10%', cents: pctCents },
      ];
    }
    return [
      { label: `Min ${formatCents(minNextCents)}`, cents: minNextCents },
      { label: '+$1', cents: minNextCents + 100 },
      { label: '+$5', cents: minNextCents + 500 },
      { label: '+$10', cents: minNextCents + 1000 },
    ];
  })();

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
      <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>Your max bid</Text>
      <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6, lineHeight: 18 }}>
        We&apos;ll auto-bid up to this amount. You only pay the minimum needed to win.
      </Text>

      {/* Big amount input. Border shifts to brand orange when valid, red
          when below minimum — visceral feedback that doesn't require
          reading the helper text below. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginTop: 14,
          paddingHorizontal: 14,
          paddingVertical: 6,
          backgroundColor: colors.bg,
          borderRadius: 12,
          borderWidth: 2,
          borderColor: closed
            ? colors.border
            : !isValid && parsedCents > 0
              ? colors.danger
              : isValid
                ? colors.primary
                : colors.border,
        }}
      >
        <Text style={{ color: colors.textMuted, fontSize: 28, ...type.displayHero, marginRight: 4 }}>
          $
        </Text>
        <TextInput
          testID="bid-amount-input"
          value={maxBid}
          onChangeText={setMaxBid}
          keyboardType="decimal-pad"
          editable={!closed}
          placeholder={(minNextCents / 100).toFixed(2)}
          placeholderTextColor={colors.textDim}
          style={{
            flex: 1,
            color: colors.text,
            fontSize: 36,
            fontWeight: '900',
            letterSpacing: -1,
            paddingVertical: 12,
          }}
        />
      </View>

      {/* Quick-pick chips. Each sets the input to a fixed amount over
          the current minimum. Active chip (matching the typed value)
          highlights orange so the bidder can see at a glance what
          tier they're at. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {quickBids.map((q) => {
          const active = parsedCents === q.cents;
          return (
            <Pressable
              key={q.label}
              onPress={() => setMaxBid((q.cents / 100).toFixed(2))}
              disabled={closed}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: active ? colors.primary : colors.border,
                backgroundColor: active ? colors.primaryDim : 'transparent',
                opacity: closed ? 0.4 : 1,
              }}
            >
              <Text
                style={{
                  color: active ? colors.primary : colors.text,
                  fontSize: 12,
                  fontWeight: '800',
                  letterSpacing: 0.3,
                }}
              >
                {q.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Live status line — the customer should *always* see what their
          current input means. Color and copy mirror the validation:
            invalid → red, "Need $X more"
            valid   → green, "Leading by $X" / "Starts the bidding"
            over MSRP → orange caution */}
      <View style={{ marginTop: 14, gap: 4 }}>
        {!isValid && parsedCents > 0 ? (
          <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
            Need {formatCents(needMoreCents)} more · minimum {formatCents(minNextCents)}
          </Text>
        ) : isValid ? (
          <Text style={{ color: colors.success, fontSize: 13, fontWeight: '700' }}>
            ✓{' '}
            {startingFresh
              ? 'You start the bidding'
              : `You'd lead by ${formatCents(overCurrent)}`}
          </Text>
        ) : (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Minimum {formatCents(minNextCents)}
          </Text>
        )}
        {props.msrpCents != null && msrpPercent != null && parsedCents > 0 && (
          <Text
            style={{
              color: overMsrp ? colors.danger : colors.textMuted,
              fontSize: 12,
            }}
          >
            {overMsrp
              ? `${formatCents(parsedCents - props.msrpCents)} over MSRP`
              : `${msrpPercent}% off MSRP (${formatCents(props.msrpCents)})`}
          </Text>
        )}
      </View>

      {feedback && (
        <View
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            backgroundColor:
              feedback.type === 'error'
                ? colors.dangerDim
                : feedback.type === 'warning'
                  ? colors.dangerDim
                  : colors.successDim,
          }}
        >
          <Text
            style={{
              color:
                feedback.type === 'error'
                  ? colors.danger
                  : feedback.type === 'warning'
                    ? colors.danger
                    : colors.success,
              fontSize: 13,
              fontWeight: '700',
            }}
          >
            {feedback.text}
          </Text>
        </View>
      )}

      <BrandedButton
        testID="place-bid-button"
        variant="primary"
        size="lg"
        onPress={placeBid}
        loading={submitting}
        disabled={!isValid}
        style={{ marginTop: 16 }}
      >
        {closed
          ? 'Bidding closed'
          : !isValid
            ? `Bid at least ${formatCents(minNextCents)}`
            : `Bid ${formatCents(parsedCents)}`}
      </BrandedButton>
    </View>
  );
}
