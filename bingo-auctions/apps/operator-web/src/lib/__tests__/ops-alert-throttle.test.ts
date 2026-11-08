// The throttle bypass that /api/debug/alert-check relies on.
//
// Two properties, opposite directions, both load-bearing:
//   * Real alerts stay throttled to one per hour per check. Without that, a
//     30-minute incident is six identical emails and the next one gets ignored.
//   * The test lever is NOT throttled, so a person fixing a typo in the notify
//     list can retry immediately instead of waiting an hour to find out.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { sendOpsAlert } from '../ops-alert';

type Row = { last_emailed_at: string } | null;

/** Minimal Supabase stub: records which tables were touched, returns one row. */
function fakeSupabase(throttleRow: Row) {
  const touched: string[] = [];
  const client = {
    from(table: string) {
      touched.push(table);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: throttleRow }) }) }),
        upsert: async () => ({ error: null }),
      };
    },
  };
  return { client: client as never, touched };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('OPS_ALERT_EMAIL', 'a@x.com,b@x.com');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })),
  );
});

describe('sendOpsAlert throttling', () => {
  it('suppresses a real alert inside the hour', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { client } = fakeSupabase({ last_emailed_at: recent });
    expect(await sendOpsAlert(client, 'invoice_dlq', 's', 'd')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a real alert once the hour has passed', async () => {
    const old = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    const { client } = fakeSupabase({ last_emailed_at: old });
    expect(await sendOpsAlert(client, 'invoice_dlq', 's', 'd')).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sends a real alert when nothing has been sent before', async () => {
    const { client } = fakeSupabase(null);
    expect(await sendOpsAlert(client, 'invoice_dlq', 's', 'd')).toBe(true);
  });

  it('skipThrottle sends even with a send seconds ago', async () => {
    // The test lever's whole value is a fast retry loop.
    const justNow = new Date(Date.now() - 1000).toISOString();
    const { client } = fakeSupabase({ last_emailed_at: justNow });
    expect(await sendOpsAlert(client, 'ops_alert_test', 's', 'd', { skipThrottle: true })).toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('skipThrottle does not even read the throttle table', async () => {
    const justNow = new Date(Date.now() - 1000).toISOString();
    const { client, touched } = fakeSupabase({ last_emailed_at: justNow });
    await sendOpsAlert(client, 'ops_alert_test', 's', 'd', { skipThrottle: true });
    // One touch, the upsert that records the send — not a read before it.
    expect(touched).toEqual(['ops_alert_throttle']);
  });

  it('defaults to throttled when no options are passed', async () => {
    // Every existing caller omits the argument; none of them may become
    // un-throttled by adding it.
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const { client } = fakeSupabase({ last_emailed_at: recent });
    expect(await sendOpsAlert(client, 'client_crashes', 's', 'd')).toBe(false);
  });

  it('reports failure when RESEND_API_KEY is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const { client } = fakeSupabase(null);
    expect(await sendOpsAlert(client, 'ops_alert_test', 's', 'd', { skipThrottle: true })).toBe(
      false,
    );
  });
});
