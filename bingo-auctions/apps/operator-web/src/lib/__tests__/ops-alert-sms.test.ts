// The SMS half of the pager.
//
// Tonight's burst (2026-09-20) lasted four minutes: 19:05 to 19:09. The check
// fired correctly at 19:06:05 and the email was read at 19:31. Every one of
// those minutes was downstream of Resend accepting the message, so nothing
// about the check or its threshold would have helped. These cases pin the
// three properties that make SMS a pager rather than a second inbox.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseAlertPhones, sendOpsAlert } from '../ops-alert';

function fakeSupabase() {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
  } as never;
}

/** Split a fetch mock's calls into the Resend one and the Twilio ones. */
function split(fetchMock: ReturnType<typeof vi.fn>) {
  const urls = fetchMock.mock.calls.map((c) => String(c[0]));
  return {
    resend: urls.filter((u) => u.includes('api.resend.com')),
    twilio: urls.filter((u) => u.includes('api.twilio.com')),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('OPS_ALERT_EMAIL', 'a@x.com');
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC123');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok');
  vi.stubEnv('TWILIO_FROM_PHONE', '+15015550100');
  vi.stubEnv('OPS_ALERT_SMS', '+15015550123,+15015550124');
});

describe('parseAlertPhones', () => {
  it('has no fallback — a guessed number pages a stranger', () => {
    // parseAlertRecipients falls back to the super-admin inbox because a
    // misdirected email is harmless. There is no safe default phone number.
    expect(parseAlertPhones(undefined)).toEqual([]);
    expect(parseAlertPhones('')).toEqual([]);
  });

  it('keeps E.164 and drops everything else', () => {
    // Twilio rejects non-E.164 outright, so a number typed as (501) 555-0123
    // would be a send that fails at 19:06 on a Saturday.
    expect(parseAlertPhones('+15015550123, 501-555-0124, +15015550125')).toEqual([
      '+15015550123',
      '+15015550125',
    ]);
  });

  it('de-duplicates and accepts the separators a person types', () => {
    expect(parseAlertPhones('+15015550123; +15015550123\n+15015550124')).toEqual([
      '+15015550123',
      '+15015550124',
    ]);
  });
});

describe('sendOpsAlert SMS', () => {
  it('stays email-only unless a check opts in', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpsAlert(fakeSupabase(), 'some_check', 'subject', 'detail');

    const { resend, twilio } = split(fetchMock);
    expect(resend).toHaveLength(1);
    // Most ops alerts describe a backlog that can wait for an inbox. Paging a
    // phone for all six would train everyone to ignore the phone.
    expect(twilio).toHaveLength(0);
  });

  it('sends one message per number when a check opts in', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpsAlert(fakeSupabase(), 'pg_cron_failure_spike', 'subject', 'detail', {
      sms: true,
    });

    const { resend, twilio } = split(fetchMock);
    expect(resend).toHaveLength(1);
    expect(twilio).toHaveLength(2);
  });

  it('still pages by SMS when Resend is down', async () => {
    // The regression this guards: sendOpsAlert used to `return false` the
    // moment Resend refused, so the flakier channel could suppress the one
    // that actually reaches someone in four minutes.
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('resend')
        ? { ok: false, status: 500, text: async () => 'resend exploded' }
        : { ok: true, status: 200, text: async () => '{}' },
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await sendOpsAlert(fakeSupabase(), 'pg_cron_failure_spike', 's', 'd', {
      sms: true,
    });

    expect(split(fetchMock).twilio).toHaveLength(2);
    expect(ok).toBe(true);
  });

  it('reports failure only when both channels fail', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'no' }));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await sendOpsAlert(fakeSupabase(), 'pg_cron_failure_spike', 's', 'd', {
      sms: true,
    });

    expect(ok).toBe(false);
  });

  it('skips SMS rather than guessing when Twilio credentials are absent', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await sendOpsAlert(fakeSupabase(), 'pg_cron_failure_spike', 's', 'd', {
      sms: true,
    });

    expect(split(fetchMock).twilio).toHaveLength(0);
    // Email landed, so the alert is not a failure — just degraded.
    expect(ok).toBe(true);
  });
});
