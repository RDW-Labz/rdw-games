// Recipient parsing for ops alerts.
//
// Until 2026-09-20 sendOpsAlert sent to exactly one address (`to: [to]`), so
// adding a second person to the pager meant editing code. These cases pin the
// two properties that matter: more than one person can be reached, and no
// configuration results in an alert reaching nobody.

import { describe, expect, it } from 'vitest';
import { parseAlertRecipients } from '../ops-alert';

const FALLBACK = 'jmacluer@gmail.com';

describe('parseAlertRecipients', () => {
  it('reaches more than one person', () => {
    expect(parseAlertRecipients('jmacluer@gmail.com,Jared.demeyer@thediscountbins.com')).toEqual([
      'jmacluer@gmail.com',
      'Jared.demeyer@thediscountbins.com',
    ]);
  });

  it('preserves the case a person typed', () => {
    // Local-parts are case-sensitive per RFC 5321, and Jared's address is
    // mixed-case. Lower-casing it for delivery would be a guess.
    expect(parseAlertRecipients('Jared.DeMeyer@thediscountbins.com')).toEqual([
      'Jared.DeMeyer@thediscountbins.com',
    ]);
  });

  it('survives the separators a person actually types', () => {
    const expected = ['a@x.com', 'b@x.com', 'c@x.com'];
    expect(parseAlertRecipients('a@x.com,b@x.com,c@x.com')).toEqual(expected);
    expect(parseAlertRecipients('a@x.com, b@x.com, c@x.com')).toEqual(expected);
    expect(parseAlertRecipients('a@x.com; b@x.com; c@x.com')).toEqual(expected);
    expect(parseAlertRecipients('a@x.com b@x.com c@x.com')).toEqual(expected);
    expect(parseAlertRecipients('  a@x.com ,,  b@x.com ,\n c@x.com  ')).toEqual(expected);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(parseAlertRecipients('Ops@x.com, ops@x.com, OPS@X.COM')).toEqual(['Ops@x.com']);
  });

  it('drops entries Resend would reject rather than losing the whole send', () => {
    // Resend rejects the entire request on one bad address, which would take
    // the good recipients down with it — the alert silently reaches nobody.
    expect(parseAlertRecipients('good@x.com, not-an-email, also-good@x.com')).toEqual([
      'good@x.com',
      'also-good@x.com',
    ]);
  });

  it('never returns an empty list', () => {
    for (const input of [undefined, '', '   ', ',,,', 'garbage', ';  ;']) {
      expect(parseAlertRecipients(input)).toEqual([FALLBACK]);
    }
  });
});
