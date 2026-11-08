// Web bid widget — bingoauctions.com/lot/[code] biddable CTA.
//
// 2026-05-22: replaces the "Open in the app" fallback. Bidders bid
// directly from the web; the bidder app stays available for power
// users who want push notifications + warehouse pickup maps.
//
// Behavior mirrors apps/bidder-app/app/lot/[id].tsx counterBid():
//   - Calls supabase.rpc('place_bid', { p_lot_id, p_max_amount_cents })
//   - Maps result.reason → friendly UX
//     * 'no_payment_method' → bounce to /bidder/onboarding/payment-method
//     * 'unpaid_fees' → bounce to /profile/pay-fees
//     * 'not_a_bidder' → bounce to /signup (treat as not-onboarded)
//     * 'lot_closed' / 'lot_not_biddable' → toast + refresh
//     * 'below_min_increment' / 'below_starting_bid' → inline error
//     * else → raw reason
//   - Realtime subscription to the lots table id=lot.id; on UPDATE we
//     re-render current_bid_cents + bid_count + close_at. The bidder-app
//     uses the same channel pattern.
//
// The widget shows three modes:
//   1. ENDED (status in 'sold','closed','unsold'): read-only banner.
//   2. NEEDS_CARD: CTA to /bidder/onboarding/payment-method.
//   3. UNPAID_FEES: CTA to /profile/pay-fees.
//   4. BID: max-bid input + place-bid button.
//
// Seller-policy gate (2026-09-29): before place_bid, the bidder must have
// accepted the operator's latest published policy version — same rule as the
// bidder app's requireAcceptance(). If not, SellerPolicyModal opens; accept
// records consent and then places the bid that was requested, cancel places
// nothing. Decision logic: @/lib/seller-policy-gate.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatInTimeZone } from '@/lib/datetime';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import {
  nextMinimumBidCents,
  describeAutoRaise,
  autoRaiseMessage,
  type BidIncrementTier,
  type AutoRaiseStatus,
} from '@auction-platform/shared';
import { captureBidPlaced } from '@/lib/posthog-events';
import { lotPatchFromBidResult, mergeLotRow } from '@/lib/bid-display';
import { quickBidClick } from '@/lib/quick-bid-confirm';
import { decideSellerPolicyGate, type SellerPolicyGate } from '@/lib/seller-policy-gate';
import {
  lookupOffsiteNoticeGateForLot,
  markOffsiteNoticeAckedInCache,
  type OffsiteNoticeGateLookup,
} from '@/lib/offsite-notice-gate';
import type { WarehousePickupDescribed } from '@/lib/warehouse-pickup';
import { SellerPolicyModal, type SellerPolicyForModal } from './SellerPolicyModal';
import { OffsiteNoticeModal } from './OffsiteNoticeModal';
import { bidderHasZip } from '@/lib/zip-gate-browser';
import { ZipGateModal } from '@/components/bidder/ZipGateModal';

interface BidLot {
  id: string;
  lot_code: string;
  status: string;
  starting_bid_cents: number;
  current_bid_cents: number | null;
  bid_count: number;
  close_at: string | null;
  /** Authoritative current leader (lots.winner_bidder_id). Drives the
   *  "You're winning" / "Outbid" badge. The realtime UPDATE handler keeps
   *  this fresh from payload.new.winner_bidder_id; an ABSENT field in a CDC
   *  payload means "no change" (do NOT null it). May be undefined when the
   *  server-rendered snapshot omits it (older pages / no winner yet). */
  winner_bidder_id?: string | null;
}

interface BidWidgetProps {
  lot: BidLot;
  /** Bidder gating fields. If hasCard is false, the widget shows the
   *  "Add a card" CTA instead of the bid input. If unpaidFeesCents > 0,
   *  it shows the "Pay fees" CTA. Both fields are read server-side once
   *  per page load; the realtime channel only refreshes the lot. */
  hasCard: boolean;
  /** Platform test mode (no live card processor — payments_disabled). When
   *  true the card + fees gates are skipped; place_bid (DB) already bypasses
   *  them server-side, so the widget shows the bid input directly. */
  paymentsDisabled?: boolean;
  unpaidFeesCents: number;
  /** The signed-in viewer's bidder id (== auth.uid()). Threaded from the
   *  server page (which already fetches the user). Used ONLY to compare
   *  against the lot's current leader for the "You're winning" / "Outbid"
   *  badge — the raw id is never rendered. Null for anon / SEO visitors,
   *  which hides the badge entirely. */
  viewerBidderId?: string | null;
  /** BID-3 effective increment schedule for this lot (auction override ??
   *  operator default, computed server-side). Threaded into every
   *  nextMinimumBidCents() call so the displayed "next bid" / quick-bid amount
   *  matches what place_bid enforces. null/undefined → legacy ladder. */
  incrementSchedule?: BidIncrementTier[] | null;
  /** IANA timezone for the auction's warehouse. Used to format lot.close_at
   *  in warehouse local time so bidders see the same wall-clock time
   *  regardless of their device locale. Falls back to 'America/Chicago'. */
  warehouseTz?: string | null;
  /** 0221: preview pre-bidding — scheduled lots become fully biddable. */
  prebidEnabled?: boolean;
  /** Auction start (ISO) for the pre-bid banner copy. */
  auctionStartsAt?: string | null;
  /** The lot's operator — whose published policy gates the bid. */
  operatorId: string;
  /** Operator display name for the policy dialog. */
  operatorName?: string | null;
}

type PolicyGateLookup = { gate: SellerPolicyGate; policy: SellerPolicyForModal | null };

type PlaceBidResult = {
  ok: boolean | null;
  reason: string | null;
  lot_id: string | null;
  current_bid_cents: number | null;
  current_leader_id: string | null;
  close_at: string | null;
  was_extended: boolean | null;
  outbid_bidder_id: string | null;
};

const REASON_LABELS: Record<string, string> = {
  not_authenticated: 'Please sign in to bid.',
  not_a_bidder: 'Finish onboarding to bid.',
  lot_not_found: 'This lot no longer exists.',
  lot_not_biddable: 'Bidding has ended or is paused on this lot.',
  lot_closed: 'This auction has ended.',
  below_starting_bid: 'Your bid is below the starting bid.',
  below_min_increment: 'The minimum just changed — try again.',
  no_payment_method: 'Add a card to bid.',
  unpaid_fees: 'Pay outstanding fees to bid.',
};

function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function BidWidget({
  lot: initialLot,
  hasCard,
  paymentsDisabled = false,
  unpaidFeesCents,
  viewerBidderId = null,
  incrementSchedule = null,
  warehouseTz = null,
  prebidEnabled = false,
  auctionStartsAt = null,
  operatorId,
  operatorName = null,
}: BidWidgetProps) {
  // Test mode (payments_disabled): card + fees gates don't apply — place_bid
  // bypasses them server-side, so show the bid input directly.
  const cardOk = hasCard || paymentsDisabled;
  const feesBlock = !paymentsDisabled && unpaidFeesCents > 0;
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowser(), []);

  // Lot state — mirrors the bidder-app pattern: server-rendered snapshot
  // plus realtime UPDATE events.
  const [lot, setLot] = useState<BidLot>(initialLot);

  // Bid input state. Default to the next minimum bid. The number lives
  // in dollars (string) for the input value, then we coerce to cents
  // on submit.
  const initialMin = nextMinimumBidCents(
    initialLot.current_bid_cents,
    initialLot.starting_bid_cents,
    incrementSchedule,
  );
  const [bidDollars, setBidDollars] = useState<string>((initialMin / 100).toFixed(2));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-bid toast. `kind` drives the color: 'winning' → green (you took the
  // lead), 'outbid' → amber/red (accepted but immediately out-proxied). The
  // #226 toast used the green success container for both; the outbid case now
  // gets a distinct non-success style.
  const [toast, setToast] = useState<{ kind: 'winning' | 'outbid'; message: string } | null>(null);
  // BID-CONFIRM (2026-10): customer report — "Quick bid $X" placed a bid on
  // ONE click, no confirmation (the typed "Place bid" flow is already
  // two-step: type an amount, then click). This gates the quick-bid click on
  // a second click of the SAME amount, inline — not window.confirm. Reset
  // below whenever quickBidCents changes so a bidder can never confirm a
  // stale amount after the price moves under them.
  const [confirmingQuickBid, setConfirmingQuickBid] = useState(false);
  // When the quick-bid confirmation was armed: a second click sooner than
  // QUICK_BID_CONFIRM_MIN_MS is a double-click and does not bid.
  const quickBidArmedAt = useRef<number | null>(null);

  // The bid input is only "fresh" when the user hasn't typed in it OR
  // they explicitly cleared it. Once they type, we don't auto-bump the
  // input as new bids arrive (that would yank the value out from under
  // the cursor). We track this with a ref.
  const userEdited = useRef(false);

  // The viewer's own bidder id (== auth.uid(); bidders.id is the auth
  // user id). Needed to gate the "you're the highest bidder" copy on the
  // ACTUAL current leader being the viewer — under proxy bidding,
  // place_bid can return ok:true while another bidder's higher hidden max
  // still leads (result.current_leader_id !== me, result.outbid_bidder_id
  // === me). Comparing the viewer's bid amount to current_bid_cents is
  // NOT a valid winning check. Mirrors apps/bidder-app/app/lot/[id].tsx
  // which trusts result.current_leader_id verbatim.
  // Seeded synchronously from the server-provided viewerBidderId so the
  // "You're winning" / "Outbid" badge can render correctly on first paint
  // (the getUser() round-trip below still runs and reconciles for the rare
  // case the client session differs). The badge re-renders off state, so we
  // also keep a piece of state in sync — see leaderTick below.
  const myBidderId = useRef<string | null>(viewerBidderId);
  // Cached seller-policy lookup for (operator, viewer) — see the gate section.
  const policyGateRef = useRef<Promise<PolicyGateLookup> | null>(null);
  const offsiteGateCacheRef = useRef<Map<string, Promise<OffsiteNoticeGateLookup>>>(new Map());
  // Bump on every winner change so the badge (computed from refs) re-renders.
  // Also used below (BID-CONFIRM) as an auto-raise refetch trigger once the
  // viewer's real id resolves.
  const [leaderTick, setLeaderTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const id = data.user?.id ?? viewerBidderId ?? null;
      if (id !== myBidderId.current) {
        myBidderId.current = id;
        policyGateRef.current = null;
        offsiteGateCacheRef.current.clear();
        setLeaderTick((t) => t + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, viewerBidderId]);

  // Authoritative current leader for this lot (lots.winner_bidder_id),
  // seeded from the server snapshot and updated by the realtime handler.
  // Kept as state so the badge re-renders when the winner flips.
  const [winnerBidderId, setWinnerBidderId] = useState<string | null>(
    initialLot.winner_bidder_id ?? null,
  );

  // BID-CONFIRM (2026-10): whether the viewer's newest row on this lot is a
  // server-placed proxy defense (is_auto), not something she clicked —
  // "bids happened on their own" customer report. Refetched whenever the
  // price moves (lot.current_bid_cents) — covers both a new leader AND the
  // engine defending HER existing lead against a rival (winner_bidder_id
  // unchanged, but a fresh is_auto row of hers landed) — or once her real id
  // resolves (leaderTick). Pure decision lives in @auction-platform/shared.
  const [autoRaise, setAutoRaise] = useState<AutoRaiseStatus | null>(null);
  useEffect(() => {
    const uid = myBidderId.current;
    if (!uid) {
      setAutoRaise(null);
      return;
    }
    let cancelled = false;
    supabase
      .from('bids')
      .select('amount_cents, max_amount_cents, is_auto, placed_at')
      .eq('lot_id', lot.id)
      .eq('bidder_id', uid)
      .then(({ data, error: aErr }) => {
        if (cancelled || aErr) return; // fail-safe: leave the prior value
        const rows = (data ?? []) as Array<{
          amount_cents: number;
          max_amount_cents: number;
          is_auto: boolean;
          placed_at: string;
        }>;
        setAutoRaise(rows.length ? describeAutoRaise(rows) : null);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, lot.id, lot.current_bid_cents, leaderTick]);

  // ── Applying a fresh lot row ─────────────────────────────────────────
  //
  // One merge used by all three sources of truth — the realtime echo, the
  // post-bid refresh, and the recovery refetch — so a price can never arrive
  // by one route and be rendered differently from another.
  //
  // `partial` semantics matter: Postgres CDC only carries columns that
  // changed, so an ABSENT key means "no change" and must not overwrite. An
  // explicit null is a real value (a retract clearing the leader). Hence the
  // `in`/`!== undefined` checks rather than `??` on the nullable fields.
  const applyLotRow = useCallback(
    (next: Partial<BidLot>) => {
      if ('winner_bidder_id' in next) {
        setWinnerBidderId((next.winner_bidder_id as string | null) ?? null);
      }
      setLot((prev) => {
        // The merge itself lives in @/lib/bid-display so it can be tested —
        // vitest here is node-env, pure-logic only, by config. Same code path
        // the tests exercise, not a second copy of it.
        const merged = mergeLotRow(prev, next);
        // If the user hasn't typed, bump the input to the new minimum.
        if (!userEdited.current) {
          const newMin = nextMinimumBidCents(
            merged.current_bid_cents,
            merged.starting_bid_cents,
            incrementSchedule,
          );
          setBidDollars((newMin / 100).toFixed(2));
        }
        return merged;
      });
    },
    [incrementSchedule],
  );

  // Ask the server what this lot looks like right now.
  //
  // Exists because the realtime echo is not a guarantee. It is the recovery
  // path for a dropped socket (see the subscription below), and it is also
  // how `bid_count` gets updated after a bid: place_bid_result carries
  // current_bid_cents, current_leader_id and close_at, but NOT bid_count, so
  // the count can only come from asking. It is deliberately NOT inferred by
  // adding one — a bid can insert two rows (the bidder's, plus the leader's
  // proxy counter), and guessing a number shown to a customer is the exact
  // class of bug this file is being repaired for.
  const refreshLot = useCallback(async () => {
    const { data, error: refetchError } = await supabase
      .from('lots')
      .select('status, starting_bid_cents, current_bid_cents, bid_count, close_at, winner_bidder_id')
      .eq('id', lot.id)
      .maybeSingle();
    // A failed refresh leaves the last known state alone. It must never clear
    // the widget — stale-but-labelled beats blank, and the realtime echo or
    // the next refresh will correct it.
    if (refetchError || !data) return;
    applyLotRow(data as Partial<BidLot>);
  }, [supabase, lot.id, applyLotRow]);

  // ── Realtime subscription ────────────────────────────────────────────
  // The Supabase Realtime channel pushes UPDATE events on the lots row.
  // We're a public page; RLS on lots already restricts to public-safe
  // rows (auctions.status IN ('scheduled', 'live')), so anon callers
  // can subscribe.
  //
  // 2026-09-17: this subscription used to be the ONLY thing that updated the
  // displayed price, and it had no failure handling whatsoever — a bare
  // .subscribe() with no status callback, no reconnect, no refetch on wake.
  // Safari suspends WebSockets on backgrounded tabs and on device sleep, so
  // an iPad left on a lot page went stale permanently and silently. Reported
  // 2026-09-17: the page showed $11 / 4 bids / next $12 while the lot was at
  // $15. The bidder app has handled this since it shipped; the web never did.
  useEffect(() => {
    const channel = supabase
      .channel(`lot:${lot.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'lots',
          filter: `id=eq.${lot.id}`,
        },
        (payload) => {
          applyLotRow(payload.new as Partial<BidLot>);
        },
      )
      .subscribe((status) => {
        // A dropped or errored socket is the normal consequence of
        // backgrounding a tab, not an exception. Refetch on the way back so
        // UPDATEs that landed while it was dead are not lost. supabase-js
        // rejoins the socket itself; this only recovers the missed window.
        // CLOSED is the ordinary teardown path and is deliberately ignored.
        // Mirrors apps/bidder-app/app/lot/[id].tsx.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          void refreshLot();
        }
      });

    // Safari does not always surface a socket error when it suspends a
    // backgrounded tab — the channel can come back "subscribed" having
    // silently missed everything. So recover on the events the browser DOES
    // promise: the tab becoming visible again, and the window regaining
    // focus. Both are cheap (one indexed single-row select) and idempotent.
    const onWake = () => {
      if (document.visibilityState === 'visible') void refreshLot();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      supabase.removeChannel(channel);
    };
  }, [lot.id, supabase, applyLotRow, refreshLot]);

  // ── Seller-policy gate ───────────────────────────────────────────────
  // Same lookup as the bidder app: the operator's latest published policy,
  // then an acceptance row for exactly that version. Looked up once per
  // (operator, viewer) and reused so the first tap doesn't wait on it; the
  // cache is dropped on tab wake so a page left open across a new policy
  // publish asks again. A failed lookup is never cached — the next tap retries.
  const lookupPolicyGate = useCallback((): Promise<PolicyGateLookup> => {
    if (policyGateRef.current) return policyGateRef.current;
    const userId = myBidderId.current;
    const pending = (async (): Promise<PolicyGateLookup> => {
      const { data: pol, error: polErr } = await supabase
        .from('operator_policies')
        .select('operator_id, version, terms_md, refund_md, shipping_md')
        .eq('operator_id', operatorId)
        .eq('published', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      const policy = (pol as SellerPolicyForModal | null) ?? null;
      let acceptanceCount: number | null = null;
      if (!polErr && policy && userId) {
        const { count } = await supabase
          .from('operator_policy_acceptances')
          .select('id', { head: true, count: 'exact' })
          .eq('user_id', userId)
          .eq('operator_id', policy.operator_id)
          .eq('version', policy.version)
          .limit(1);
        acceptanceCount = count;
      }
      const gate = decideSellerPolicyGate({ policy, policyLookupFailed: !!polErr, acceptanceCount });
      return { gate, policy };
    })();
    policyGateRef.current = pending;
    const forget = () => {
      if (policyGateRef.current === pending) policyGateRef.current = null;
    };
    pending.then((r) => r.gate === 'lookup_failed' && forget(), forget);
    return pending;
  }, [supabase, operatorId]);

  useEffect(() => {
    policyGateRef.current = null;
    offsiteGateCacheRef.current.clear();
    hasZipRef.current = null;
    const prefetch = () => {
      if (myBidderId.current) lookupPolicyGate().catch(() => {});
    };
    prefetch();
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      policyGateRef.current = null;
      offsiteGateCacheRef.current.clear();
      hasZipRef.current = null;
      prefetch();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [lookupPolicyGate]);

  // The policy awaiting acceptance (dialog open) and the bid it will release.
  const [policyPrompt, setPolicyPrompt] = useState<SellerPolicyForModal | null>(null);
  const [offsitePrompt, setOffsitePrompt] = useState<{
    pickup: WarehousePickupDescribed;
    warehouseId: string;
  } | null>(null);
  // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
  // null = not checked yet this page load, true/false cached once known.
  // Reset alongside the other gates above on bidder change / tab wake.
  const hasZipRef = useRef<boolean | null>(null);
  const [zipPrompt, setZipPrompt] = useState(false);
  const pendingBidCents = useRef<number | null>(null);

  // ── Placing the bid ──────────────────────────────────────────────────
  // The place_bid call and its result handling, for an amount that has
  // already been validated and cleared the seller-policy gate. Called from
  // onPlaceBid, or from the policy dialog's accept once consent is recorded.
  const sendBid = useCallback(async (cents: number) => {
    setSubmitting(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('place_bid', {
        p_lot_id: lot.id,
        p_max_amount_cents: cents,
      });

      if (rpcError) {
        // mig 0084/0105/0111 security guards throw RAISE EXCEPTION P0001 with
        // a prefix in the message string (not a result.reason). Handle
        // identity_verification_required specifically — route to the verify
        // flow with the current lot as the ?next= target so the bidder can
        // return and re-bid after completing verification.
        // Mirrors the SQL_EXCEPTION_PATTERNS handler in
        // packages/domain-bidding/src/components/PlaceBidSheet.tsx:52-56.
        const errMsg = rpcError.message ?? '';
        if (errMsg.includes('identity_verification_required')) {
          router.push(
            `/identity/verify?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`,
          );
          setSubmitting(false);
          return;
        }
        setError(errMsg || 'Bid failed. Please try again.');
        setSubmitting(false);
        return;
      }

      const result = data as unknown as PlaceBidResult;
      if (!result.ok) {
        const reason = result.reason ?? 'unknown';
        // Routed reasons — bounce the user to the fix-it screen.
        if (reason === 'no_payment_method') {
          router.push(
            `/bidder/onboarding/payment-method?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`,
          );
          return;
        }
        if (reason === 'unpaid_fees') {
          router.push('/profile/pay-fees');
          return;
        }
        if (reason === 'not_a_bidder') {
          router.push(`/signup?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`);
          return;
        }
        if (reason === 'not_authenticated') {
          router.push(`/login?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`);
          return;
        }
        if (reason === 'lot_closed' || reason === 'lot_not_biddable') {
          setError(REASON_LABELS[reason] ?? reason);
          // Refresh to pick up the new server-rendered status.
          router.refresh();
          setSubmitting(false);
          return;
        }
        if (reason === 'below_min_increment' || reason === 'below_starting_bid') {
          // Bump the input to the new minimum so the next try succeeds.
          const newMin = nextMinimumBidCents(
            (result.current_bid_cents ?? lot.current_bid_cents) as number | null,
            lot.starting_bid_cents,
            incrementSchedule,
          );
          setBidDollars((newMin / 100).toFixed(2));
          userEdited.current = false;
          setError(`Minimum bid is ${formatMoney(newMin)}.`);
          setSubmitting(false);
          return;
        }
        setError(REASON_LABELS[reason] ?? reason);
        setSubmitting(false);
        return;
      }

      // Success (bid accepted). But ok:true does NOT mean you're winning —
      // under proxy bidding the server may have immediately out-proxied you
      // with another bidder's higher hidden max. Gate the "highest bidder"
      // copy on the AUTHORITATIVE leader identity (result.current_leader_id),
      // never on comparing your bid to current_bid_cents.
      const iAmLeader =
        result.current_leader_id != null &&
        result.current_leader_id === myBidderId.current;
      // Consume the RPC result. place_bid has already decided the outcome and
      // returned it; the page must show THAT, not wait to be told the same
      // thing again by the realtime echo.
      //
      // 2026-09-17: this previously set only the leader id, so the badge
      // flipped to "Outbid" while the price beside it kept the pre-bid value.
      // The toast below reads result.current_bid_cents and said $15; the page
      // body read stale lot.current_bid_cents and said $11, with "next bid
      // $12" derived from the stale number. One response, two prices, and the
      // true one in a toast that disappears. A customer reading the page then
      // bids against a number that no longer exists.
      //
      // close_at comes along because a soft-close extension is part of the
      // same result and the countdown is read the same way.
      applyLotRow(lotPatchFromBidResult(result, lot.current_bid_cents));
      // bid_count is NOT in place_bid_result, so it cannot be applied above
      // and is not guessed — a single bid can insert two rows (this bidder's,
      // plus the leader's proxy counter). Ask the server instead. Fire and
      // forget: the price is already correct on screen, this only trues up
      // the count.
      void refreshLot();
      if (iAmLeader) {
        setToast({
          kind: 'winning',
          message: `You're the highest bidder at ${formatMoney(result.current_bid_cents)}.`,
        });
      } else {
        // Accepted but immediately outbid by a higher proxy max. Show the
        // current price and prompt a higher bid rather than a false win.
        setToast({
          kind: 'outbid',
          message: `Bid placed, but you've been outbid. The current bid is now ${formatMoney(
            result.current_bid_cents,
          )} — raise your max to take the lead.`,
        });
      }
      // Reset the userEdited flag so the next outbid event bumps the input.
      userEdited.current = false;
      // Funnel: bid placed via web. Server-side won/paid events come
      // from the daily Supabase → PostHog export (post-launch).
      captureBidPlaced({
        lot_code: lot.lot_code,
        max_amount_cents: cents,
        was_extended: result.was_extended === true,
      });
    } catch (err) {
      setError((err as Error).message ?? 'Bid failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
    // applyLotRow and refreshLot belong here: both close over lot.id, and a
    // stale copy would apply a bid result to the wrong lot or refetch one the
    // page has navigated away from. Omitting them is the same class of bug
    // this change exists to fix — rendering something the server did not say.
  }, [
    lot.current_bid_cents,
    lot.id,
    lot.lot_code,
    lot.starting_bid_cents,
    incrementSchedule,
    router,
    supabase,
    applyLotRow,
    refreshLot,
  ]);

  const proceedToPlaceBid = useCallback(
    async (cents: number) => {
      if (myBidderId.current) {
        let lookup: OffsiteNoticeGateLookup;
        try {
          lookup = await lookupOffsiteNoticeGateForLot(
            supabase,
            lot.id,
            offsiteGateCacheRef.current,
          );
        } catch {
          lookup = { gate: 'lookup_failed', pickup: null, warehouseId: null };
        }
        if (lookup.gate === 'lookup_failed') {
          console.warn(
            '[BidWidget] off-site notice lookup failed; placing the bid without the gate',
          );
        } else if (lookup.gate === 'needs_ack' && lookup.pickup && lookup.warehouseId) {
          pendingBidCents.current = cents;
          setOffsitePrompt({ pickup: lookup.pickup, warehouseId: lookup.warehouseId });
          setSubmitting(false);
          return;
        }
      }
      await sendBid(cents);
    },
    [supabase, lot.id, sendBid],
  );

  // Seller-policy gate, then the bid. Runs once the ZIP gate (below) has
  // cleared. Signed-out viewers skip the policy gate: place_bid answers
  // not_authenticated and the existing sign-in redirect takes over.
  const afterZipGate = useCallback(
    async (cents: number) => {
      if (myBidderId.current) {
        let lookup: PolicyGateLookup;
        try {
          lookup = await lookupPolicyGate();
        } catch {
          lookup = { gate: 'lookup_failed', policy: null };
        }
        if (lookup.gate === 'lookup_failed') {
          // Same as the app: a failed lookup never blocks a bid. Before this
          // gate the website never blocked, and a database blip at close
          // time must not cost a bidder the lot. The next tap looks up again.
          console.warn('[BidWidget] seller policy lookup failed; placing the bid without the gate');
        }
        if (lookup.gate === 'needs_acceptance' && lookup.policy) {
          pendingBidCents.current = cents;
          setPolicyPrompt(lookup.policy);
          setSubmitting(false);
          return;
        }
      }
      await proceedToPlaceBid(cents);
    },
    [lookupPolicyGate, proceedToPlaceBid],
  );

  // ── Submit handler ───────────────────────────────────────────────────
  // `explicitCents` (one-tap quick-bid) bypasses the typed input entirely:
  // the caller passes a pre-computed nextMinimumBidCents() amount. When it's
  // omitted (the regular "Place bid" button) we parse + validate the input.
  const onPlaceBid = useCallback(async (explicitCents?: number) => {
    setError(null);
    setToast(null);

    let cents: number;
    if (explicitCents != null) {
      // Quick-bid path — trust the caller's increment math (it's the same
      // nextMinimumBidCents the server enforces). Skip the input parsing.
      cents = explicitCents;
    } else {
      const dollars = Number.parseFloat(bidDollars);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setError('Please enter a valid bid amount.');
        return;
      }
      cents = Math.round(dollars * 100);

      // Defense-in-depth: client check. Server is authoritative.
      const minCents = nextMinimumBidCents(
        lot.current_bid_cents,
        lot.starting_bid_cents,
        incrementSchedule,
      );
      if (cents < minCents) {
        setError(`Minimum bid is ${formatMoney(minCents)}.`);
        return;
      }
    }

    setSubmitting(true);

    // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan).
    // Signed-out viewers skip it too — same reasoning as the policy gate
    // below, place_bid's not_authenticated answer handles them.
    if (myBidderId.current) {
      if (hasZipRef.current === null) {
        try {
          hasZipRef.current = await bidderHasZip(supabase, myBidderId.current);
        } catch {
          hasZipRef.current = true; // fail open — never block a bid on this lookup
        }
      }
      if (!hasZipRef.current) {
        pendingBidCents.current = cents;
        setZipPrompt(true);
        setSubmitting(false);
        return;
      }
    }

    await afterZipGate(cents);
  }, [
    bidDollars,
    lot.current_bid_cents,
    lot.starting_bid_cents,
    incrementSchedule,
    supabase,
    afterZipGate,
  ]);

  const onZipSaved = useCallback(() => {
    hasZipRef.current = true;
    setZipPrompt(false);
    const cents = pendingBidCents.current;
    pendingBidCents.current = null;
    if (cents != null) void afterZipGate(cents);
  }, [afterZipGate]);

  const onZipCancel = useCallback(() => {
    pendingBidCents.current = null;
    setZipPrompt(false);
  }, []);

  const onPolicyAccepted = useCallback(() => {
    if (policyPrompt) {
      policyGateRef.current = Promise.resolve({ gate: 'accepted', policy: policyPrompt });
    }
    setPolicyPrompt(null);
    const cents = pendingBidCents.current;
    if (cents != null) void proceedToPlaceBid(cents);
  }, [policyPrompt, proceedToPlaceBid]);

  const onPolicyCancel = useCallback(() => {
    pendingBidCents.current = null;
    setPolicyPrompt(null);
  }, []);

  const onOffsiteAccepted = useCallback(() => {
    if (offsitePrompt) {
      markOffsiteNoticeAckedInCache(offsiteGateCacheRef.current, offsitePrompt.warehouseId);
    }
    setOffsitePrompt(null);
    const cents = pendingBidCents.current;
    pendingBidCents.current = null;
    if (cents != null) void sendBid(cents);
  }, [offsitePrompt, sendBid]);

  const onOffsiteCancel = useCallback(() => {
    pendingBidCents.current = null;
    setOffsitePrompt(null);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  const currentBid = lot.current_bid_cents ?? lot.starting_bid_cents;
  const bidCountCopy =
    lot.bid_count === 0
      ? 'No bids yet'
      : `${lot.bid_count} bid${lot.bid_count === 1 ? '' : 's'}`;

  const ended = ['sold', 'closed', 'unsold'].includes(lot.status);
  // 0221: preview pre-bidding — a scheduled lot in an opted-in auction is
  // fully biddable (proxy bidding included); the engine keeps it 'scheduled'
  // until the auction opens.
  const prebidOpen = lot.status === 'scheduled' && prebidEnabled;
  const biddable = lot.status === 'live' || prebidOpen;

  // Quick-bid increment — the exact amount the server would enforce as the
  // next minimum. The one-tap button submits this verbatim. Threads the
  // effective schedule so it matches place_bid's floor.
  const quickBidCents = nextMinimumBidCents(
    lot.current_bid_cents,
    lot.starting_bid_cents,
    incrementSchedule,
  );
  // BID-CONFIRM: drop a pending quick-bid confirmation the instant the
  // amount it would confirm changes — another bid landed, or this one's own
  // bid updated the lot — so the second click is always confirming the
  // number currently on screen, never a stale one.
  useEffect(() => {
    setConfirmingQuickBid(false);
  }, [quickBidCents]);

  // Winning / Outbid badge. Show ONLY once there's an actual leader on the
  // lot AND we know the viewer's id. iAmLeader compares the authoritative
  // lots.winner_bidder_id against the viewer (never renders the raw id).
  // Anon / SEO visitors have viewerBidderId === null → myBidderId.current
  // null → badge hidden. No leader yet (winnerBidderId null) → hidden.
  const hasLeader = winnerBidderId != null;
  const iAmLeader = hasLeader && winnerBidderId === myBidderId.current;
  const showLeaderBadge = hasLeader && myBidderId.current != null;
  // BID-CONFIRM: only while she is actually the leader — an auto-raise on a
  // lot she's since been outbid on isn't "her bid status" any more.
  const leaderAutoRaiseMessage =
    iAmLeader && autoRaise ? autoRaiseMessage(autoRaise, formatMoney) : null;

  return (
    <div style={panelStyle}>
      <div
        style={{
          fontSize: 12,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: 1.5,
        }}
      >
        {biddable ? 'Current bid' : 'Starting bid'}
      </div>
      <div
        style={{
          fontSize: '2.25rem',
          fontWeight: 900,
          marginTop: 4,
          marginBottom: 6,
          letterSpacing: -1,
        }}
      >
        {formatMoney(currentBid)}
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '1.25rem' }}>
        {bidCountCopy}
        {lot.close_at && biddable && (
          <>
            {' · '}Closes {formatInTimeZone(lot.close_at, warehouseTz)}
          </>
        )}
      </div>

      {/* Winning / Outbid badge. Green when the viewer is the authoritative
          leader, amber/red when someone else leads. Hidden for anon visitors
          and when no bid has established a leader yet. The raw winner id is
          never rendered. */}
      {showLeaderBadge && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            padding: '4px 10px',
            borderRadius: 999,
            marginBottom: '1.25rem',
            ...(iAmLeader
              ? {
                  color: 'var(--accent)',
                  background: 'rgba(34, 197, 94, 0.12)',
                  border: '1px solid rgba(34, 197, 94, 0.4)',
                }
              : {
                  color: 'var(--urgent-red)',
                  background: 'var(--urgent-red-dim)',
                  border: '1px solid rgba(255, 59, 59, 0.45)',
                }),
          }}
        >
          {iAmLeader ? "✓ You're winning" : '⚡ Outbid'}
        </div>
      )}

      {/* BID-CONFIRM: her current lead came from a server-placed proxy
          defense, not a click of her own — name it, so a price move she
          didn't make never reads as a mystery. */}
      {leaderAutoRaiseMessage && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--accent)',
            marginTop: '-1rem',
            marginBottom: '1.25rem',
          }}
        >
          {leaderAutoRaiseMessage}
        </div>
      )}

      {ended && (
        <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
          Bidding has ended. Browse the next auction for similar lots.
        </div>
      )}

      {!ended && lot.status === 'scheduled' && !prebidOpen && (
        <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
          This auction hasn&apos;t opened yet. Check back when bidding goes live.
        </div>
      )}

      {prebidOpen && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 8,
            padding: '0.6rem 0.8rem',
            marginBottom: '0.75rem',
            lineHeight: 1.5,
          }}
        >
          Pre-bidding is open — place your max bid now and proxy bidding will
          defend it when the auction goes live
          {auctionStartsAt ? ` (${new Date(auctionStartsAt).toLocaleString()})` : ''}.
        </div>
      )}

      {biddable && !cardOk && (
        <Link
          href={`/bidder/onboarding/payment-method?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`}
          className="btn-primary"
          style={{ display: 'inline-block', padding: '0.85rem 1.5rem' }}
        >
          Add a card to bid
        </Link>
      )}

      {biddable && cardOk && feesBlock && (
        <Link
          href="/profile/pay-fees"
          className="btn-primary"
          style={{ display: 'inline-block', padding: '0.85rem 1.5rem' }}
        >
          Pay {formatMoney(unpaidFeesCents)} in fees to bid
        </Link>
      )}

      {biddable && cardOk && !feesBlock && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Your max bid{' '}
              <span
                style={{ color: 'var(--fg-dim)', cursor: 'help' }}
                title="BinGo Auctions uses proxy bidding. We bid for you in the minimum increment up to your max — you only pay what's needed to win."
              >
                (?)
              </span>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRight: 'none',
                  borderRadius: '6px 0 0 6px',
                  padding: '0.7rem 0.85rem',
                  color: 'var(--fg-muted)',
                  fontSize: 15,
                }}
              >
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min={(nextMinimumBidCents(lot.current_bid_cents, lot.starting_bid_cents, incrementSchedule) / 100).toFixed(
                  2,
                )}
                value={bidDollars}
                onChange={(e) => {
                  userEdited.current = true;
                  setBidDollars(e.target.value);
                }}
                style={{
                  flex: 1,
                  padding: '0.7rem 0.85rem',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: '0 6px 6px 0',
                  color: 'var(--fg)',
                  fontSize: 15,
                  fontFamily: 'inherit',
                  minWidth: 0,
                }}
              />
            </div>
            <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              Next bid:{' '}
              {formatMoney(nextMinimumBidCents(lot.current_bid_cents, lot.starting_bid_cents, incrementSchedule))}
            </span>
          </label>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              // Wrap so the click event isn't forwarded as the explicitCents
              // arg — the typed-input path must receive undefined.
              onClick={() => onPlaceBid()}
              disabled={submitting}
              className="btn-primary"
              style={{
                flex: 1,
                padding: '0.95rem',
                fontSize: '1rem',
                opacity: submitting ? 0.7 : 1,
                cursor: submitting ? 'wait' : 'pointer',
              }}
            >
              {submitting ? 'Placing bid…' : 'Place bid'}
            </button>
            {/* One-tap quick-bid — submits the next minimum increment,
                bypassing the typed input. Same nextMinimumBidCents the
                server enforces, so it never round-trips a rejection for a
                stale amount unless another bid lands in the same instant.
                BID-CONFIRM: no longer actually one-tap — the first click only
                arms a same-amount confirmation (confirmingQuickBid); only the
                SECOND click calls onPlaceBid. Resets on blur (onBlur) and
                whenever quickBidCents itself changes (the effect above), so a
                bidder can't walk away mid-confirm and have a later unrelated
                click submit a bid. */}
            <button
              type="button"
              onClick={() => {
                const now = Date.now();
                const { nextConfirming, shouldPlaceBid } = quickBidClick(
                  confirmingQuickBid,
                  confirmingQuickBid && quickBidArmedAt.current !== null ? now - quickBidArmedAt.current : null,
                );
                if (!confirmingQuickBid && nextConfirming) quickBidArmedAt.current = now;
                if (!nextConfirming) quickBidArmedAt.current = null;
                setConfirmingQuickBid(nextConfirming);
                if (shouldPlaceBid) onPlaceBid(quickBidCents);
              }}
              onBlur={() => setConfirmingQuickBid(false)}
              disabled={submitting}
              className="btn-secondary"
              style={{
                flex: 1,
                padding: '0.95rem',
                fontSize: '1rem',
                opacity: submitting ? 0.7 : 1,
                cursor: submitting ? 'wait' : 'pointer',
                whiteSpace: 'nowrap',
                ...(confirmingQuickBid
                  ? { outline: '2px solid var(--accent)', outlineOffset: 2 }
                  : {}),
              }}
            >
              {confirmingQuickBid
                ? `Tap again to bid ${formatMoney(quickBidCents)}`
                : `Quick bid ${formatMoney(quickBidCents)}`}
            </button>
            {confirmingQuickBid && (
              <button
                type="button"
                // onMouseDown (not onClick) so this fires before the quick-bid
                // button's onBlur, which would otherwise already have reset
                // confirmingQuickBid by the time a click handler ran.
                onMouseDown={() => setConfirmingQuickBid(false)}
                className="btn-secondary"
                style={{ padding: '0.95rem 1rem', fontSize: '1rem' }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: '0.85rem',
            color: 'var(--danger)',
            fontSize: 14,
            background: 'rgba(255, 59, 59, 0.08)',
            border: '1px solid rgba(255, 59, 59, 0.4)',
            padding: '0.6rem 0.85rem',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      {toast && (
        <div
          style={{
            marginTop: '0.85rem',
            fontSize: 14,
            padding: '0.6rem 0.85rem',
            borderRadius: 6,
            // Winning → green success container (unchanged from #226).
            // Outbid → amber so it reads as a warning, not a celebration.
            ...(toast.kind === 'winning'
              ? {
                  color: 'var(--accent)',
                  background: 'rgba(34, 197, 94, 0.08)',
                  border: '1px solid rgba(34, 197, 94, 0.4)',
                }
              : {
                  color: 'var(--warn-yellow)',
                  background: 'var(--warn-yellow-dim)',
                  border: '1px solid rgba(255, 214, 10, 0.4)',
                }),
          }}
        >
          {toast.message}
        </div>
      )}

      {zipPrompt && <ZipGateModal onSaved={onZipSaved} onCancel={onZipCancel} />}

      {policyPrompt && (
        <SellerPolicyModal
          policy={policyPrompt}
          operatorName={operatorName ?? 'this seller'}
          onAccepted={onPolicyAccepted}
          onCancel={onPolicyCancel}
        />
      )}

      {offsitePrompt && (
        <OffsiteNoticeModal
          pickup={offsitePrompt.pickup}
          warehouseId={offsitePrompt.warehouseId}
          onAccepted={onOffsiteAccepted}
          onCancel={onOffsiteCancel}
        />
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elev-2)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '1.5rem',
  marginBottom: '1.5rem',
};
