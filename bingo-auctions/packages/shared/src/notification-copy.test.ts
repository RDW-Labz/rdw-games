// Guards for the 2026-09-16 outbid-copy report (BIN-016617).
//
// Per WORKING_AGREEMENT §7c the negative case is the one that matters here,
// and it is unusually easy to state: the old sentence said "Someone bid
// $3.00" to a customer who had just bid $3.00. Any copy that puts a bare
// amount next to "someone bid" reintroduces it.

import { describe, expect, it } from 'vitest';
import {
  OUTBID_HEADLINE,
  OUTBID_TIE_RULE,
  outbidBody,
  outbidSms,
} from './notification-copy';

const LOT = { lotTitle: 'Mid-Century Lamp', lotCode: 'BRN4347297' };

describe('outbid copy — the reported defect', () => {
  it('never says "someone bid <amount>"', () => {
    // THE NEGATIVE CASE. At a tie the price equals the customer's own bid, so
    // this phrasing is indistinguishable from an echo of what they just did.
    const body = outbidBody({ ...LOT, price: '$3.00' });
    expect(body.toLowerCase()).not.toContain('someone bid');
    expect(body.toLowerCase()).not.toContain('someone outbid');
  });

  it('tells the customer their max is not enough', () => {
    // The one sentence that is true at a tie AND on an ordinary outbid, and
    // the reason no tie detection is needed anywhere.
    expect(outbidBody({ ...LOT, price: '$3.00' })).toContain(
      "your max isn't enough to lead",
    );
  });

  it('leads with the customer\'s position, not the price', () => {
    expect(OUTBID_HEADLINE).toBe("You're no longer the top bidder");
    // The old headline was "Outbid at $3.00" — the amount in the one line
    // most people read on a lock screen.
    expect(OUTBID_HEADLINE).not.toMatch(/\$|\d/);
  });

  it('renders the tie case without ever mentioning a tie', () => {
    // The exact BIN-016617 shape: max $3.00, price settled at $3.00.
    const body = outbidBody({ ...LOT, price: '$3.00' });
    expect(body).toBe(
      "Mid-Century Lamp (BRN4347297) is at $3.00 and your max isn't enough to lead. Raise it to stay in.",
    );
  });
});

describe('outbidBody — degradation', () => {
  it('drops the amount rather than printing a null one', () => {
    const body = outbidBody({ ...LOT, price: null });
    expect(body).not.toContain('null');
    expect(body).not.toContain('undefined');
    expect(body).toContain("your max isn't enough to lead");
  });

  it('falls back through title, code, then a generic phrase', () => {
    expect(outbidBody({ lotTitle: 'Lamp', price: '$3.00' })).toContain('Lamp is at $3.00');
    expect(outbidBody({ lotCode: 'BRN1', price: '$3.00' })).toContain('BRN1 is at $3.00');
    expect(outbidBody({ price: '$3.00' })).toContain('this lot is at $3.00');
  });

  it('treats blank strings as missing', () => {
    expect(outbidBody({ lotTitle: '  ', lotCode: '  ', price: '  ' })).toBe(
      "this lot has a higher bid and your max isn't enough to lead. Raise it to stay in.",
    );
  });
});

describe('outbidSms — GSM-7 and length', () => {
  const link = 'https://bng.to/abc123';

  it('produces only GSM-7-safe characters for ASCII input', () => {
    // A single non-GSM-7 character downgrades the whole message to UCS-2 and
    // cuts the single-segment limit from 160 to 70. That is the constraint
    // this variant exists for, so it is asserted rather than assumed.
    const sms = outbidSms({ ...LOT, price: '$3.00', link });
    const nonAscii = [...sms].filter((c) => c.charCodeAt(0) > 127);
    expect(nonAscii).toEqual([]);
    expect(sms).not.toContain('—');
    expect(sms).not.toContain('…');
    expect(sms).not.toContain('’'); // curly apostrophe
  });

  it('fits one segment', () => {
    expect(outbidSms({ ...LOT, price: '$3.00', link }).length).toBeLessThanOrEqual(160);
  });

  it('never truncates the link, even with an absurd title', () => {
    const sms = outbidSms({
      lotTitle: 'X'.repeat(400),
      lotCode: 'BRN4347297',
      price: '$3.00',
      link,
    });
    expect(sms).toContain(link);
    expect(sms.endsWith(link)).toBe(true);
    expect(sms.length).toBeLessThanOrEqual(160);
    // ASCII even on the truncation path — "..." not the single-char ellipsis.
    expect([...sms].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
  });

  it('drops the title entirely rather than overflow when the link is huge', () => {
    const huge = `https://example.com/${'p'.repeat(140)}`;
    const sms = outbidSms({ ...LOT, price: '$3.00', link: huge });
    expect(sms).toContain(huge);
    expect(sms).not.toContain('Mid-Century');
  });

  it('says the same three things the other channels say', () => {
    const sms = outbidSms({ ...LOT, price: '$3.00', link });
    expect(sms).toContain(OUTBID_HEADLINE); // not leading
    expect(sms).toContain("your max isn't enough"); // max insufficient
    expect(sms).toContain('Raise it'); // what to do
    expect(sms.toLowerCase()).not.toContain('someone bid');
  });
});

describe('OUTBID_TIE_RULE — email only', () => {
  it('states the rule the customer could not have known', () => {
    expect(OUTBID_TIE_RULE).toContain('the one set first wins');
  });

  it('is never reachable from the SMS builder', () => {
    // It contains an em dash; putting it in an SMS would force UCS-2.
    const sms = outbidSms({ ...LOT, price: '$3.00', link: 'https://bng.to/a' });
    expect(sms).not.toContain('the one set first wins');
  });
});
