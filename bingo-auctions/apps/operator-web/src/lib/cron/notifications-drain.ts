// Drains notifications_outbox via the Expo Push API. Port of the polling
// tick() previously in packages/auction-engine/src/notifications.ts.
//
// Idempotency lives in the outbox row (processed_at NULL = unsent, UNIQUE
// idempotency_key prevents duplicate enqueues). The push API is itself
// idempotent at the token level; Expo dedupes by ticket id, so a retry
// after a network blip won't double-push.
//
// PR-D (2026-05-29) — three changes from the original tick:
//   1. OutboxRow.kind widens from a narrow discriminated union to `string`,
//      and the dispatch switch gains a `default` arm. This is what fixes
//      the "silently dropped push" failure mode the original union had —
//      kinds added in migrations 0077, 0124, 0158, 0159 (payment_failed,
//      payment_retry_reminder, dispute_opened, dispute_evidence_due,
//      lot_relisted_no_show, payment_requires_action, relot_fee_applied,
//      pickup_no_show_forfeit, pickup_no_show_refund_pending,
//      refund_completed, refund_failed) all have explicit cases now.
//   2. Multi-lot rollup: for ROLLUP_KINDS the drain holds rows back
//      ROLLUP_GRACE_MS so multiple rows enqueued in the same close-auction
//      RPC have time to land, then groups by (target_user_id, kind,
//      group_key) and emits ONE push per group. Today a bidder who wins
//      5 lots in a single BinGo Saturday auction gets 5 separate "Won"
//      pushes — desensitizing and the user misses the pickup window.
//   3. "Tap to pay and lock in pickup." removed from the `won` body.
//      Post-PR-A2 auto-charge fires automatically; the bidder's next
//      real action is checking the pickup window.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { OUTBID_HEADLINE, outbidBody } from '@auction-platform/shared';
import type { OffsiteNotificationCopy } from '@/lib/offsite-notification-copy';
import {
  invoiceIdsForOffsiteLoad,
  loadOffsiteNotificationCopyByInvoiceId,
  offsiteCopyForRow,
} from '@/lib/notification-offsite-load';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

// PR-D: hold-back window before sending a rollup-eligible kind so multiple
// rows enqueued together (close-auction RPC, no_show batch flip, dunning
// abandon batch) have time to land in the DB. 15s is well below the
// "I missed it" threshold for any kind in the allow-list — none are
// time-critical (those stay singleton).
const ROLLUP_GRACE_MS = 15_000;

const ROLLUP_KINDS = new Set<string>([
  'won',
  'pickup_ready',
  'saved_search_hit',
  'relot_fee_applied',
  'pickup_no_show_forfeit',
  'pickup_no_show_refund_pending',
  'lot_relisted_no_show',
]);

// Wide type — drain has a `default` switch arm and never relies on a closed
// union. `ai_budget_*` rows are filtered at query time (operator-targeted,
// no Expo token), so they never reach this dispatch.
type OutboxRow = {
  id: string;
  kind: string;
  target_user_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  created_at: string;
};

type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  priority?: 'default' | 'high';
};

function fmtCents(cents: unknown): string | null {
  if (typeof cents !== 'number') return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function trimTitle(t: unknown, max = 40): string {
  const s = typeof t === 'string' ? t : 'a lot';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Compose the Expo push for a single outbox row. The dispatch has a
 * `default` arm so unknown kinds still emit a generic push — we never
 * silently drop a queued notification.
 */
function appendOffsitePushBody(body: string, offsite: OffsiteNotificationCopy | null): string {
  if (!offsite?.pushLine) return body;
  const combined = `${body} ${offsite.pushLine}`;
  return combined.length <= 178 ? combined : body;
}

function buildMessage(
  row: OutboxRow,
  expoToken: string,
  offsite: OffsiteNotificationCopy | null = null,
): ExpoMessage {
  const data = { kind: row.kind, ...row.payload };
  const title = trimTitle(row.payload['lot_title']);
  const lotCode =
    typeof row.payload['lot_code'] === 'string' ? row.payload['lot_code'] : null;
  const codeSuffix = lotCode ? ` (${lotCode})` : '';
  switch (row.kind) {
    case 'outbid': {
      // Copy lives in @auction-platform/shared/notification-copy, shared with
      // the email drain, the SMS drain and both notification lists. See that
      // module for why "Someone bid $X" was removed: at a tie the price IS the
      // customer's own bid, so the old sentence read as an echo of what they
      // had just done rather than as a loss.
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: OUTBID_HEADLINE,
        body: outbidBody({
          lotTitle: title,
          lotCode,
          price: fmtCents(row.payload['current_bid_cents']),
        }),
        data,
      };
    }
    case 'won': {
      // PR-D (2026-05-29): replaced "Tap to pay and lock in pickup." copy —
      // PR-A2's auto-charge fires automatically at lot close, so the bidder
      // never taps to pay. The next real action is checking the pickup window.
      const win = fmtCents(row.payload['winning_bid_cents']);
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: win ? `🏆 Won for ${win}` : '🏆 You won!',
        body: appendOffsitePushBody(
          `You won "${title}"${codeSuffix}. We auto-charged your card. Tap to view your pickup window.`,
          offsite,
        ),
        data,
      };
    }
    case 'pickup_ready':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: '📦 Ready for pickup',
        body: appendOffsitePushBody(
          'All your items are staged. Open the map to see your route.',
          offsite,
        ),
        data,
      };
    case 'pickup_confirmed':
      return {
        to: expoToken,
        sound: 'default',
        title: 'Pickup confirmed',
        body: 'Thanks — your items are checked out.',
        data,
      };
    case 'dispute_update':
      return {
        to: expoToken,
        sound: 'default',
        title: 'Dispute update',
        body:
          typeof row.payload['message'] === 'string'
            ? (row.payload['message'] as string)
            : 'Your dispute was updated.',
        data,
      };
    case 'dispute_opened':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Dispute opened',
        body: 'A dispute was opened on one of your charges. Tap to view.',
        data,
      };
    case 'dispute_evidence_due':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Dispute evidence due',
        body: 'Submit evidence for an open dispute before the deadline.',
        data,
      };
    case 'closing_soon': {
      const minutes = row.payload['close_at']
        ? Math.max(
            0,
            Math.round(
              (new Date(row.payload['close_at'] as string).getTime() - Date.now()) / 60_000,
            ),
          )
        : 10;
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: minutes <= 2 ? `🔥 Last call — ${minutes}m` : `⏰ Closing in ${minutes}m`,
        body: `"${title}" closes soon. Bid now or lose it.`,
        data,
      };
    }
    case 'saved_search_hit': {
      const searchName = trimTitle(row.payload['saved_search_name'], 40);
      return {
        to: expoToken,
        sound: 'default',
        title: `🔔 New match: ${searchName}`,
        body: `"${title}" just listed. Tap to view.`,
        data,
      };
    }
    case 'payment_failed': {
      // Title + body pre-baked by producer (auto-charge-drain.ts). Fall back to safe defaults if the producer omitted them.
      const t =
        typeof row.payload['title'] === 'string'
          ? (row.payload['title'] as string)
          : 'Card declined';
      const b =
        typeof row.payload['body'] === 'string'
          ? (row.payload['body'] as string)
          : 'Update your payment method to keep your lot.';
      return { to: expoToken, sound: 'default', priority: 'high', title: t, body: b, data };
    }
    case 'payment_retry_reminder':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Card not yet updated',
        body: "We'll auto-retry once you fix your card.",
        data,
      };
    case 'payment_requires_action': {
      // Migration 0124: off-session PI returned requires_action (SCA / 3DS).
      // Title + body come pre-baked from the cron's enqueue call so we
      // can include the lot code when known. Fall back to safe defaults.
      const payloadTitle =
        typeof row.payload['title'] === 'string'
          ? (row.payload['title'] as string)
          : 'Action needed: verify your card';
      const payloadBody =
        typeof row.payload['body'] === 'string'
          ? (row.payload['body'] as string)
          : 'Your card needs an extra verification step to complete a charge. Tap to finish.';
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: payloadTitle,
        body: payloadBody,
        data,
      };
    }
    // Mig 0471: staff withdrew / put back a lot the bidder bid on. Push and
    // in-app only -- the email drain has no template for these kinds and the
    // SMS drain's allow-list leaves them out (Resend cap, owner 2026-10-27).
    case 'lot_withdrawn':
      return {
        to: expoToken,
        sound: 'default',
        title: 'Lot withdrawn',
        body: `"${title}"${codeSuffix} was withdrawn from the auction. Your bid is void and you won't be charged.`,
        data,
      };
    case 'lot_reinstated':
      return {
        to: expoToken,
        sound: 'default',
        title: 'Lot back in the auction',
        body: `"${title}"${codeSuffix} is back in the auction with your bid.`,
        data,
      };
    case 'lot_relisted_no_show': {
      const operatorName =
        typeof row.payload['operator_name'] === 'string'
          ? (row.payload['operator_name'] as string)
          : 'the operator';
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Lot relisted',
        body: `Pickup window expired. Lot has been relisted by ${operatorName}.`,
        data,
      };
    }
    case 'relot_fee_applied': {
      // grace-expiry.ts bakes the fee dollar string into payload.body so
      // operator-specific fees show the correct amount. Fall back to a
      // generic body if a producer ever omits it.
      const b =
        typeof row.payload['body'] === 'string'
          ? (row.payload['body'] as string)
          : 'A relot fee was added to your account. Update your card and pay your balance to bid again.';
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title:
          typeof row.payload['title'] === 'string'
            ? (row.payload['title'] as string)
            : 'Your lot was relisted',
        body: b,
        data,
      };
    }
    case 'pickup_no_show_forfeit': {
      const operatorName =
        typeof row.payload['operator_name'] === 'string'
          ? (row.payload['operator_name'] as string)
          : 'the operator';
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Pickup window closed',
        body: `Items forfeited per ${operatorName} policy. Tap to view details.`,
        data,
      };
    }
    case 'pickup_no_show_refund_pending': {
      const refundCents =
        typeof row.payload['refund_cents'] === 'number'
          ? (row.payload['refund_cents'] as number)
          : null;
      const refundStr = refundCents != null ? fmtCents(refundCents) : null;
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Pickup window closed',
        body: refundStr
          ? `Refund of ${refundStr} is being processed. Tap to view invoice.`
          : 'A refund is being processed. Tap to view invoice.',
        data,
      };
    }
    case 'refund_completed': {
      const amount =
        typeof row.payload['amount_cents'] === 'number'
          ? fmtCents(row.payload['amount_cents'])
          : null;
      return {
        to: expoToken,
        sound: 'default',
        title: 'Refund issued',
        body: amount
          ? `Your ${amount} refund was issued. It may take 5–10 days to appear on your statement.`
          : 'Your refund was issued. It may take 5–10 days to appear on your statement.',
        data,
      };
    }
    case 'refund_failed':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Refund needs attention',
        body: 'A refund could not be processed automatically. The operator has been notified.',
        data,
      };
    // E1 (mig 0167): payment succeeded — receipt push to bidder.
    case 'payment_succeeded': {
      const amount = fmtCents(row.payload['amount_cents']);
      return {
        to: expoToken,
        sound: 'default',
        title: amount ? `Payment received: ${amount}` : 'Payment received',
        body: appendOffsitePushBody('Your payment was processed. Tap to view your invoice.', offsite),
        data,
      };
    }
    // Mig 0229: referral credit granted — both sides get the same push shape.
    case 'referral_credited': {
      const amount = fmtCents(row.payload['amount_cents']);
      return {
        to: expoToken,
        sound: 'default',
        title: amount ? `You earned ${amount} in BinGo credit` : 'You earned BinGo credit',
        body:
          typeof row.payload['body'] === 'string'
            ? (row.payload['body'] as string)
            : 'It comes off your next invoice automatically.',
        data,
      };
    }
    // Mig 0228: one-time onboarding nudge — registered >24h ago, no card.
    case 'add_card_nudge':
      return {
        to: expoToken,
        sound: 'default',
        title: 'Add a card to start bidding',
        body: "Your account is ready — add a card and you can bid. You're only charged if you win.",
        data,
      };
    // E3 (mig 0167): pickup window closing reminder — nudge bidder 24h before.
    case 'pickup_reminder': {
      const deadlineRaw = row.payload['pickup_deadline'];
      const deadline =
        typeof deadlineRaw === 'string'
          ? new Date(deadlineRaw).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : null;
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Pickup reminder',
        body: appendOffsitePushBody(
          deadline
            ? `Your pickup window closes ${deadline}. Tap to schedule or check in.`
            : 'Your pickup window is closing soon. Tap to check your schedule.',
          offsite,
        ),
        data,
      };
    }
    default: {
      // PR-D safety net: any unrecognized kind still emits a generic push
      // so the operator's enqueue isn't silently dropped on the floor.
      // The runtime warning surfaces this in CF Worker logs.

      console.warn(
        '[notifications-drain] unrecognized notification_kind:',
        row.kind,
        '— emitting generic body.',
      );
      const t =
        typeof row.payload['title'] === 'string'
          ? (row.payload['title'] as string)
          : 'BinGo Auctions notification';
      const b =
        typeof row.payload['body'] === 'string'
          ? (row.payload['body'] as string)
          : 'Tap to open BinGo Auctions.';
      return { to: expoToken, sound: 'default', title: t, body: b, data };
    }
  }
}

/**
 * Compose a single Expo push representing a rolled-up GROUP of outbox rows.
 * Called only when there are 2+ rows in the group; single-row groups fall
 * through to buildMessage.
 *
 * The group is guaranteed to share (target_user_id, kind, group_key).
 */
function buildRollupMessage(
  rows: OutboxRow[],
  expoToken: string,
  offsite: OffsiteNotificationCopy | null = null,
): ExpoMessage {
  // Caller guarantees rows.length > 1 (the only place this is invoked).
  // We still narrow defensively to keep noUncheckedIndexedAccess happy and
  // produce a safe fallback if the invariant is ever violated.
  const first = rows[0];
  if (!first) {
    return {
      to: expoToken,
      sound: 'default',
      title: 'BinGo Auctions notification',
      body: 'Tap to open BinGo Auctions.',
      data: { rolled_up: true, count: 0 },
    };
  }
  const kind = first.kind;
  const count = rows.length;
  // Pass the first row's payload as the deep-link source; all rows in a
  // group share the same group_key (= invoice_id / auction_id /
  // saved_search_id), so any row's deep_link works. Mark the data with
  // rolled_up so the bidder app can hide per-row UI affordances if it wants.
  const data = { kind, rolled_up: true, count, ...first.payload };
  switch (kind) {
    case 'won': {
      // Sum winning_bid_cents across the group (when payload supplies it).
      let totalCents = 0;
      let allHaveBid = true;
      for (const r of rows) {
        const c = r.payload['winning_bid_cents'];
        if (typeof c === 'number') totalCents += c;
        else allHaveBid = false;
      }
      const totalStr = allHaveBid && totalCents > 0 ? fmtCents(totalCents) : null;
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: `🏆 You won ${count} lots`,
        body: appendOffsitePushBody(
          totalStr
            ? `Total ${totalStr} auto-charged. Tap to view your pickup window.`
            : 'Tap to view your pickup window.',
          offsite,
        ),
        data,
      };
    }
    case 'pickup_ready':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: '📦 Ready for pickup',
        body: appendOffsitePushBody(
          `All ${count} of your lots are staged. Open the map to see your route.`,
          offsite,
        ),
        data,
      };
    case 'saved_search_hit': {
      const searchName =
        typeof first.payload['saved_search_name'] === 'string'
          ? trimTitle(first.payload['saved_search_name'] as string, 40)
          : 'your saved search';
      return {
        to: expoToken,
        sound: 'default',
        title: `🔔 ${count} new matches: ${searchName}`,
        body: `${count} new lots just listed. Tap to view.`,
        data,
      };
    }
    case 'lot_relisted_no_show':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Lots relisted',
        body: `${count} of your lots were relisted after the pickup window expired.`,
        data,
      };
    case 'relot_fee_applied': {
      // Sum fees if all payloads carry them — grace-expiry now bakes
      // relist_fee_cents into payload.
      let totalCents = 0;
      let allHaveFee = true;
      for (const r of rows) {
        const c = r.payload['relist_fee_cents'];
        if (typeof c === 'number') totalCents += c;
        else allHaveFee = false;
      }
      const totalStr = allHaveFee && totalCents > 0 ? fmtCents(totalCents) : null;
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Lots relisted',
        body: totalStr
          ? `${count} relot fees totaling ${totalStr} were added. Update your card and pay your balance to bid again.`
          : `${count} relot fees were added to your account. Update your card and pay your balance to bid again.`,
        data,
      };
    }
    case 'pickup_no_show_forfeit':
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Pickup window closed',
        body: `${count} items forfeited. Tap to view details.`,
        data,
      };
    case 'pickup_no_show_refund_pending': {
      let totalCents = 0;
      let allHaveAmount = true;
      for (const r of rows) {
        const c = r.payload['refund_cents'];
        if (typeof c === 'number') totalCents += c;
        else allHaveAmount = false;
      }
      const totalStr = allHaveAmount && totalCents > 0 ? fmtCents(totalCents) : null;
      return {
        to: expoToken,
        sound: 'default',
        priority: 'high',
        title: 'Pickup window closed',
        body: totalStr
          ? `Refunds totaling ${totalStr} are being processed. Tap to view.`
          : `Refunds for ${count} items are being processed. Tap to view.`,
        data,
      };
    }
    default:
      // No rollup composer for this kind — emit the first row as a solo
      // message. The caller still marks every row in the group processed,
      // so the others won't ship as duplicates next tick.
      return buildMessage(first, expoToken, offsite);
  }
}

/**
 * Stable group key for rollup-eligible kinds. Returns null when the payload
 * doesn't expose a group identity — caller treats null-keyed rows as solo
 * (no rollup, no silent drop).
 */
function groupKeyFor(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === 'won' || kind === 'pickup_ready') {
    const auctionId = payload['auction_id'];
    return typeof auctionId === 'string' ? auctionId : null;
  }
  if (kind === 'saved_search_hit') {
    const id = payload['saved_search_id'];
    return typeof id === 'string' ? id : null;
  }
  // invoice-scoped rollup kinds
  const id = payload['invoice_id'];
  return typeof id === 'string' ? id : null;
}

async function sendBatch(messages: ExpoMessage[]): Promise<{ ok: boolean }> {
  if (messages.length === 0) return { ok: true };
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  return { ok: res.ok };
}

export type DrainResult = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
};

export async function runNotificationsDrain(): Promise<DrainResult> {
  const supabase = getSupabaseAdmin();

  const { data: rows } = await supabase
    .from('notifications_outbox')
    .select('id, kind, target_user_id, payload, attempt_count, created_at')
    .is('processed_at', null)
    .lt('attempt_count', MAX_ATTEMPTS)
    // Audit C5 (2026-05-18): the outbox carries operator-targeted rows
    // (ai_budget_50/80/100). Those should never go via Expo push — operator
    // admins don't have the bidder app installed, and the operator-console
    // doesn't subscribe to push tokens. Filter them out so the push drain
    // doesn't churn through them.
    .not('kind', 'in', '(ai_budget_50,ai_budget_80,ai_budget_100)')
    .order('created_at')
    .limit(BATCH_SIZE)
    .returns<OutboxRow[]>();

  if (!rows || rows.length === 0) {
    return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const targetIds = Array.from(new Set(rows.map((r) => r.target_user_id)));
  const { data: bidders } = await supabase
    .from('bidders')
    .select('id, expo_push_token, push_enabled')
    .in('id', targetIds);
  const bidderById = new Map<string, { token: string | null; enabled: boolean }>(
    (bidders ?? []).map((b) => [
      b.id as string,
      {
        token: (b.expo_push_token as string | null) ?? null,
        enabled: (b.push_enabled as boolean | null) ?? true,
      },
    ]),
  );

  // Decorate payloads with lot_code for the push body.
  const lotIds = Array.from(
    new Set(rows.map((r) => r.payload['lot_id']).filter((v): v is string => typeof v === 'string')),
  );
  if (lotIds.length > 0) {
    // display_code (mig 0315) is the label physically on the box — see the same
    // hydration in email-drain.ts.
    const { data: lotRows } = await supabase
      .from('lots')
      .select('id, lot_code, display_code')
      .in('id', lotIds);
    const lotCodeById = new Map<string, string>();
    for (const l of (lotRows ?? []) as Array<{
      id: string;
      lot_code: string;
      display_code: string | null;
    }>) {
      lotCodeById.set(l.id, l.display_code ?? l.lot_code);
    }
    for (const row of rows) {
      const lid = row.payload['lot_id'];
      if (typeof lid === 'string') {
        const code = lotCodeById.get(lid);
        if (code) row.payload['lot_code'] = code;
      }
    }
  }

  const offsiteByInvoiceId = await loadOffsiteNotificationCopyByInvoiceId(
    supabase,
    invoiceIdsForOffsiteLoad(rows),
  );

  // ── PR-D: multi-lot rollup grouping ────────────────────────────────────
  // For ROLLUP_KINDS we hold rows back ROLLUP_GRACE_MS so multiple rows
  // enqueued in the same producer batch (close-auction RPC, no_show flip,
  // dunning abandon) have time to land. Rows younger than the grace are
  // deferred to the next tick. Non-rollup kinds bypass the grace entirely
  // — they're either per-invoice (1:1) or time-sensitive (closing_soon,
  // outbid).
  const now = Date.now();
  type Group = { rows: OutboxRow[]; key: string };
  const groups: Group[] = [];
  const groupMap = new Map<string, Group>();
  for (const row of rows) {
    if (!ROLLUP_KINDS.has(row.kind)) {
      groups.push({ rows: [row], key: `solo:${row.id}` });
      continue;
    }
    const ageMs = now - Date.parse(row.created_at);
    if (ageMs < ROLLUP_GRACE_MS) {
      // Defer — next tick will pick it up. Don't mark anything; the row
      // just stays unprocessed and below MAX_ATTEMPTS.
      continue;
    }
    const gk = groupKeyFor(row.kind, row.payload);
    if (!gk) {
      // No group identity — emit as solo so we never silently drop.
      groups.push({ rows: [row], key: `solo:${row.id}` });
      continue;
    }
    const key = `${row.target_user_id}:${row.kind}:${gk}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      const g: Group = { rows: [row], key };
      groupMap.set(key, g);
      groups.push(g);
    }
  }

  const messages: ExpoMessage[] = [];
  const sentRowIds: string[] = [];
  const skippedRowIds: Array<{ id: string; reason: string }> = [];

  for (const group of groups) {
    // Every group is constructed with at least one row; narrow for
    // noUncheckedIndexedAccess.
    const firstRow = group.rows[0];
    if (!firstRow) continue;
    // Email-only kinds (migs 0230/0231): marketing must never push —
    // owner wants it low-pressure. Mark processed so it leaves the queue.
    if (
      firstRow.kind === 'marketing_digest' ||
      // Segmented campaigns (mig 0292) — same rule as the digest.
      firstRow.kind === 'marketing_campaign' ||
      firstRow.kind === 'referral_announcement' ||
      firstRow.kind === 'loyalty_announcement' ||
      firstRow.kind === 'onboarding_nudge' ||
      firstRow.kind === 'card_fix_notice'
    ) {
      for (const r of group.rows) skippedRowIds.push({ id: r.id, reason: 'email_only_kind' });
      continue;
    }
    // All rows in a group share target_user_id.
    const target = firstRow.target_user_id;
    const b = bidderById.get(target);
    if (!b || !b.token) {
      for (const r of group.rows) skippedRowIds.push({ id: r.id, reason: 'no_push_token' });
      continue;
    }
    if (!b.enabled) {
      for (const r of group.rows) skippedRowIds.push({ id: r.id, reason: 'push_disabled' });
      continue;
    }
    const offsite = offsiteCopyForRow(firstRow, offsiteByInvoiceId);
    const msg =
      group.rows.length > 1
        ? buildRollupMessage(group.rows, b.token, offsite)
        : buildMessage(firstRow, b.token, offsite);
    messages.push(msg);
    for (const r of group.rows) sentRowIds.push(r.id);
  }

  let sent = 0;
  let failed = 0;
  if (messages.length > 0) {
    const result = await sendBatch(messages);
    if (result.ok) {
      await supabase
        .from('notifications_outbox')
        .update({ processed_at: new Date().toISOString() })
        .in('id', sentRowIds);
      sent = sentRowIds.length;
    } else {
      // Bulk-bump attempt_count.
      for (const id of sentRowIds) {
        const row = rows.find((r) => r.id === id);
        await supabase
          .from('notifications_outbox')
          .update({
            attempt_count: (row?.attempt_count ?? 0) + 1,
            last_error: 'expo_push_failed',
          })
          .eq('id', id);
      }
      failed = sentRowIds.length;
    }
  }

  for (const s of skippedRowIds) {
    await supabase
      .from('notifications_outbox')
      .update({ processed_at: new Date().toISOString(), last_error: s.reason })
      .eq('id', s.id);
  }

  return {
    scanned: rows.length,
    sent,
    skipped: skippedRowIds.length,
    failed,
  };
}
