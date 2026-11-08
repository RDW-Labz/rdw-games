import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runFeedbackDigest, runFeedbackNotify, recipientsFrom } from '../feedback-notify';

type Rec = Record<string, unknown>;

// Tiny in-memory stand-in for the PostgREST calls the runner makes.
function fakeDb(opts: { ready?: boolean; feedback: Rec[]; digestDays?: string[] }) {
  const digest = new Set(opts.digestDays ?? []);
  const feedback = opts.feedback;
  function query(table: string) {
    const filters: ((r: Rec) => boolean)[] = [];
    let mode: 'select' | 'update' | 'upsert' | 'delete' = 'select';
    let patch: Rec = {};
    let upsertRow: Rec = {};
    let wantCount = false;
    let lim = Infinity;
    const q = {
      select(_cols?: string, o?: { count?: string }) {
        if (o?.count) wantCount = true;
        return q;
      },
      update(p: Rec) { mode = 'update'; patch = p; return q; },
      upsert(r: Rec) { mode = 'upsert'; upsertRow = r; return q; },
      delete() { mode = 'delete'; return q; },
      is(c: string, v: null) { filters.push((r) => (r[c] ?? null) === v); return q; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q; },
      gte(c: string, v: string) { filters.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v); return q; },
      lt(c: string, v: string) { filters.push((r) => (r[c] as string) < v); return q; },
      order() { return q; },
      limit(n: number) { lim = n; return q; },
      then(res: (v: unknown) => void) {
        if (table === 'app_feedback' && opts.ready === false) return res({ data: null, error: { code: '42703' }, count: null });
        if (table === 'feedback_digest_runs') {
          if (mode === 'upsert') {
            const d = upsertRow.day as string;
            if (digest.has(d)) return res({ data: [], error: null });
            digest.add(d);
            return res({ data: [{ day: d }], error: null });
          }
          if (mode === 'delete') { digest.clear(); return res({ data: null, error: null }); }
          return res({ data: null, error: null });
        }
        const rows = feedback.filter((r) => filters.every((f) => f(r)));
        if (mode === 'update') { rows.forEach((r) => Object.assign(r, patch)); return res({ data: null, error: null }); }
        return res({ data: rows.slice(0, lim), error: null, count: wantCount ? rows.length : null });
      },
    };
    return q;
  }
  const sb = {
    from: query,
    storage: { from: () => ({ createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })) }) }) },
  } as unknown as SupabaseClient;
  return { sb, digest };
}

const fb = (id: string, over: Rec = {}): Rec => ({
  id, created_at: '2026-10-30T15:00:00Z', app: 'staff', kind: 'bug', message: `report ${id} text`,
  reporter_label: 'Pat', screen: '/x', app_version: '1.0.1', update_id: null, platform: 'android',
  os_version: '14', device_model: 'SM', status: 'new', contact_email: null, author_id: 'u', attachments: [], notified_at: null, ...over,
});
const ENV = { FEEDBACK_NOTIFY_EMAIL: 'owner@x.test, floor@x.test', NEXT_PUBLIC_SITE_URL: 'https://c.test' };

describe('runFeedbackNotify', () => {
  it('emails each new item, then marks it notified', async () => {
    const { sb } = fakeDb({ feedback: [fb('a', { attachments: [{ path: 'u/a.png' }] }), fb('b')] });
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const r = await runFeedbackNotify({ supabase: sb, env: ENV, now: new Date('2026-10-30T15:03:00Z'), send: async (to, subject, text) => { sent.push({ to, subject, text }); return true; } });
    expect(r).toEqual({ pending: 2, single: 2, batched: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.to).toEqual(['owner@x.test', 'floor@x.test']);
    expect(sent[0]!.text).toContain('https://signed/u/a.png');
    const again = await runFeedbackNotify({ supabase: sb, env: ENV, send: async () => true });
    expect(again).toEqual({ pending: 0, single: 0, batched: 0 });
  });

  it('throttles a burst: 5 single emails, the rest in one combined email', async () => {
    const { sb } = fakeDb({ feedback: ['1', '2', '3', '4', '5', '6', '7', '8'].map((i) => fb(i)) });
    const subjects: string[] = [];
    const r = await runFeedbackNotify({ supabase: sb, env: ENV, send: async (_t, s) => { subjects.push(s); return true; } });
    expect(r).toEqual({ pending: 8, single: 5, batched: 3 });
    expect(subjects).toHaveLength(6);
    expect(subjects[5]).toBe('[BinGo feedback] 3 more new items');
  });

  it('leaves an item pending when the send fails, so the next tick retries', async () => {
    const rows = [fb('a')];
    const { sb } = fakeDb({ feedback: rows });
    const r = await runFeedbackNotify({ supabase: sb, env: ENV, send: async () => false });
    expect(r).toMatchObject({ single: 0, failed: 'a' });
    expect(rows[0]!.notified_at).toBeNull();
  });

  it('does nothing before migration 0477 exists', async () => {
    const { sb } = fakeDb({ ready: false, feedback: [fb('a')] });
    expect(await runFeedbackNotify({ supabase: sb, env: ENV, send: async () => true })).toEqual({ skipped: 'migration_0477_not_applied' });
  });

  it('falls back to OPS_ALERT_EMAIL for recipients', () => {
    expect(recipientsFrom({ OPS_ALERT_EMAIL: 'ops@x.test' })).toEqual(['ops@x.test']);
  });
});

describe('runFeedbackDigest', () => {
  const at7 = new Date('2026-10-31T12:05:00Z'); // 07:05 CDT
  const rows = () => [fb('old', { created_at: '2026-10-28T10:00:00Z' }), fb('fresh', { created_at: '2026-10-31T10:00:00Z' }), fb('done', { created_at: '2026-10-01T10:00:00Z', status: 'fixed' })];

  it('sends once per Chicago day at 07:00 with only items New > 24h', async () => {
    const { sb } = fakeDb({ feedback: rows() });
    const texts: string[] = [];
    const send = async (_t: string[], _s: string, text: string) => { texts.push(text); return true; };
    expect(await runFeedbackDigest({ supabase: sb, env: ENV, now: at7, send })).toEqual({ sent: true, items: 1 });
    expect(texts[0]).toContain('#fb-old');
    expect(texts[0]).not.toContain('#fb-fresh');
    expect(await runFeedbackDigest({ supabase: sb, env: ENV, now: new Date('2026-10-31T12:35:00Z'), send })).toEqual({ skipped: 'already_sent_today' });
  });

  it('skips outside the 07:00 hour', async () => {
    const { sb } = fakeDb({ feedback: rows() });
    expect(await runFeedbackDigest({ supabase: sb, env: ENV, now: new Date('2026-10-31T13:05:00Z'), send: async () => true })).toEqual({ skipped: 'not_digest_hour' });
  });

  it('releases the day after a failed send so 07:30 retries', async () => {
    const { sb, digest } = fakeDb({ feedback: rows() });
    expect(await runFeedbackDigest({ supabase: sb, env: ENV, now: at7, send: async () => false })).toMatchObject({ sent: false, retry: true });
    expect(digest.size).toBe(0);
  });
});
