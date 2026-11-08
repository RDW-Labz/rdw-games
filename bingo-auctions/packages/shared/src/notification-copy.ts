// Customer-facing notification copy, in one place.
//
// ── Why this module exists ───────────────────────────────────────────────────
//
// Reported 2026-09-16 (BIN-016617). A bidder's maximum was $3.00. Another
// bidder's maximum was also $3.00, set 28 hours earlier. An equal maximum
// loses to whoever got there first — place_bid takes the challenger only on
// `p_max_amount_cents > v_current_max_bid.max_amount_cents`, strictly greater —
// so the incumbent kept the lead and the price settled at exactly $3.00.
//
// Both notification channels then told the customer:
//
//     "Outbid at $3.00 — Someone bid $3.00 on BIN-016617. Bid again before it
//      closes."
//
// They had just bid $3.00. They were told someone bid $3.00. That is
// indistinguishable from an echo of their own bid, and because the tie meant
// the price never moved, nothing in the message signalled that anything had
// changed. They said they never knew they had been outbid. Both the push and
// the email were created, accepted and delivered without error — the delivery
// was fine, the sentence was not.
//
// ── The rule these strings follow ────────────────────────────────────────────
//
// Never state a bare amount as "someone bid X". At a tie, X is the customer's
// own number. State the customer's POSITION instead, and say plainly that
// their maximum is not enough. That sentence is true whether they lost by a
// tie or by a genuinely higher bid, which is why no tie detection is needed —
// and why place_bid does not have to change to carry a tie flag.
//
// ── Why one module ───────────────────────────────────────────────────────────
//
// Five surfaces render this: the push drain, the email drain, the SMS drain,
// /profile/notifications on the web, and the notifications tab in the app. The
// two lists carried comments saying they "mirror" each other, which is another
// way of saying two people maintained the same sentence by hand. A customer
// who reads the push, opens the app and sees a differently-worded row has been
// told two things about one event. Approved by Jared 2026-09-17.

/** Headline for every outbid notification, on every channel. */
export const OUTBID_HEADLINE = "You're no longer the top bidder";

/**
 * The standing explanation of the tie rule. EMAIL ONLY — it is the one channel
 * with room for it, and it goes on every outbid email rather than only on
 * ties, because a bidder who understands the rule before they tie is better
 * off than one who has it explained afterwards.
 *
 * Deliberately not on push or SMS: it would blow the lock-screen line budget,
 * and on SMS the em dash alone would force UCS-2 (see outbidSms).
 */
export const OUTBID_TIE_RULE =
  'When two maximums are equal, the one set first wins — so matching the ' +
  "current bid won't put you in front.";

export interface OutbidCopyInput {
  lotTitle?: string | null;
  lotCode?: string | null;
  /**
   * Preformatted money, e.g. "$3.00". Preformatted rather than cents so this
   * module stays free of money and locale concerns, and so a caller can never
   * accidentally render raw cents into a customer's inbox. Null when the
   * payload carried no price — the copy degrades rather than printing "null".
   */
  price?: string | null;
}

/** `Lamp (BRN4347297)` / `Lamp` / `BRN4347297` / `this lot`, whichever we have. */
function describeLot(lotTitle?: string | null, lotCode?: string | null): string {
  const title = lotTitle?.trim() || null;
  const code = lotCode?.trim() || null;
  if (title && code) return `${title} (${code})`;
  return title ?? code ?? 'this lot';
}

/**
 * Body for push, email and the in-app/web notification lists.
 *
 *   Mid-Century Lamp (BRN4347297) is at $3.00 and your max isn't enough to
 *   lead. Raise it to stay in.
 *
 * With no price we drop the amount rather than guessing one — "is at null" is
 * worse than a slightly vaguer sentence, and the second half carries the
 * actionable part regardless.
 */
export function outbidBody(input: OutbidCopyInput): string {
  const lot = describeLot(input.lotTitle, input.lotCode);
  const price = input.price?.trim() || null;
  return price
    ? `${lot} is at ${price} and your max isn't enough to lead. Raise it to stay in.`
    : `${lot} has a higher bid and your max isn't enough to lead. Raise it to stay in.`;
}

/**
 * SMS variant. Same three things the other channels say — you are not leading,
 * your maximum is not enough, raise it — compressed, and ASCII-only.
 *
 * The ASCII constraint is load-bearing, not tidiness. A single non-GSM-7
 * character (an em dash, a curly apostrophe) switches the whole message to
 * UCS-2 and cuts the single-segment limit from 160 characters to 70, which
 * silently doubles the cost and can split the link across segments. So: a
 * straight apostrophe in "You're", no dashes, and the tie-rule sentence is
 * omitted entirely.
 *
 * The lot title is trimmed last, after the fixed parts and the link are
 * accounted for, so the link is never what gets cut.
 */
export function outbidSms(
  input: OutbidCopyInput & { link: string; limit?: number },
): string {
  const limit = input.limit ?? 160;
  const code = input.lotCode?.trim() || null;
  const price = input.price?.trim() || null;
  const head = OUTBID_HEADLINE;
  // The code sits after the title in parentheses, as it does on every other
  // channel, rather than after the verb the way this drain's other kinds
  // ("Won BRN123 …") place it. Cross-channel consistency for ONE event beats
  // in-file consistency across different ones: a customer comparing the text
  // and the push is comparing these two, not this and the win notice.
  const codePart = code ? ` (${code})` : '';
  const tail = price
    ? `${codePart}. Now at ${price}, your max isn't enough. Raise it: ${input.link}`
    : `${codePart}. Your max isn't enough. Raise it: ${input.link}`;

  const title = input.lotTitle?.trim() || null;
  if (!title) return `${head}${tail}`;

  // Room left for ` on "<title>"` once everything mandatory is placed.
  const room = limit - head.length - tail.length - ' on ""'.length;
  if (room < 8) return `${head}${tail}`;
  // "..." not "…" — the single-character ellipsis is outside GSM-7 and would
  // trip the very UCS-2 downgrade this function exists to avoid.
  const shown =
    title.length <= room ? title : `${title.slice(0, Math.max(1, room - 3))}...`;
  return `${head} on "${shown}"${tail}`;
}
