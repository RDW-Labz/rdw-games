// Daily summary email. Fake data only: no real bidders, cards or addresses.
// Run: node --test scripts/__tests__/daily-summary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERIES,
  assertReadOnly,
  buildEmail,
  failedRuns,
  parseRecipients,
  redactNumbers,
  shortText,
  shouldSendScheduled,
} from '../daily-summary/lib.mjs';
import { run } from '../daily-summary.mjs';

const SITE = 'https://admin.example.invalid';
const NOW = new Date('2026-09-30T12:00:00Z'); // 07:00 CDT

const quiet = () => ({
  feedback: { new_count: 0, open_count: 3, oldest_open: '2026-09-20T12:00:00Z', items: [] },
  auctions: {
    auctions: { auctions: 3, closed: 300, sold: 277, unsold: 23 },
    failedCharges: { failed_invoices: 0, still_unpaid: 0, items: [] },
  },
  stuckDrafts: { stuck: 0, items: [] },
  refundLimbo: { now_count: 5, day_ago_count: 5, items: [] },
  failures: { cron: [], runs: [] },
});

const fb = (i) => ({
  created_at: '2026-09-29T20:00:00Z',
  app: 'staff',
  kind: 'bug',
  message: `Test report number ${i} from a fake tester`,
});

test('assertReadOnly allows one SELECT/WITH and refuses writes and stacked statements', () => {
  assert.doesNotThrow(() => assertReadOnly('SELECT 1'));
  assert.doesNotThrow(() => assertReadOnly('  with x as (select 1) select * from x'));
  for (const bad of ['INSERT INTO lots VALUES (1)', 'UPDATE lots SET title = 1', 'DELETE FROM lots', 'SELECT 1; DELETE FROM lots', 'BEGIN']) {
    assert.throws(() => assertReadOnly(bad), /only SELECT|one statement/, bad);
  }
});

test('every shipped query is read-only and uses no double-quoted identifiers', () => {
  for (const [name, sql] of Object.entries(QUERIES)) {
    assert.doesNotThrow(() => assertReadOnly(sql), name);
    assert.ok(!sql.includes('"'), `${name} has a double quote`);
  }
  assert.ok(!/contact_email|ip_hash|reporter_label|author_id/.test(QUERIES.feedback));
  assert.ok(!/amount_cents|card_|square_/.test(QUERIES.failedCharges));
});

test('long digit runs are blanked, short ones kept', () => {
  assert.equal(redactNumbers('card 4111 1111 1111 1111 declined'), 'card [number removed] declined');
  assert.equal(redactNumbers('acct 123456789012'), 'acct [number removed]');
  assert.equal(redactNumbers('lot BIN-000355 and 12345678901'), 'lot BIN-000355 and 12345678901');
  assert.equal(shortText('a\n\nb   c'), 'a b c');
  assert.equal(shortText('x'.repeat(200)).length, 140);
});

test('quiet day still sends, says so, and counts zero', () => {
  const e = buildEmail(quiet(), { site: SITE, now: NOW });
  assert.equal(e.subject, 'BinGo Daily - Sep 30 - 0 need attention');
  assert.match(e.text, /^BinGo Daily · Sep 30\n\nNothing new today\.\n/);
  assert.match(e.text, /1\. CUSTOMER FEEDBACK\nNew since yesterday: 0 · Open: 3 · Oldest open: 10 days/);
  assert.match(e.text, /3 auctions · 300 lots closed · 277 sold · 23 unsold/);
  assert.match(e.text, /5\. FAILURES \(last 24h\)\nNone\./);
});

test('sections come in order with feedback first, and each lists up to 10 then "and N more"', () => {
  const d = quiet();
  d.feedback = { new_count: 12, open_count: 20, oldest_open: '2026-08-20T12:00:00Z', items: Array.from({ length: 10 }, (_, i) => fb(i)) };
  d.stuckDrafts = {
    stuck: 216,
    items: Array.from({ length: 10 }, (_, i) => ({ id: `lot-${i}`, lot_code: `BIN-00${i}`, title: `Fake chair ${i}` })),
  };
  const e = buildEmail(d, { site: SITE, now: NOW });
  const order = ['CUSTOMER FEEDBACK', "LAST NIGHT'S AUCTIONS", 'STUCK ITEMS', 'REFUNDED ITEMS', 'FAILURES'].map((t) => e.text.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((e.text.match(/^- Sep 29 · staff bug/gm) ?? []).length, 10);
  assert.match(e.text, /and 2 more: https:\/\/admin\.example\.invalid\/feedback/);
  assert.match(e.text, /- BIN-000 · Fake chair 0 · https:\/\/admin\.example\.invalid\/lots\/lot-0/);
  assert.match(e.text, /and 206 more: no admin page lists these yet/);
  assert.equal(e.attention, 12 + 216);
  assert.equal(e.subject, 'BinGo Daily - Sep 30 - 228 need attention');
  assert.ok(!e.text.includes('Nothing new today'));
});

test('failed charges show invoice, auction and status only, and count the still-unpaid ones', () => {
  const d = quiet();
  d.auctions.failedCharges = {
    failed_invoices: 2,
    still_unpaid: 1,
    items: [
      { invoice_id: 'aaaaaaaa-0000-0000-0000-000000000001', last_failed: '2026-09-30T02:00:00Z', status: 'payment_failed_grace', auction: 'Fake Tuesday sale' },
      { invoice_id: 'bbbbbbbb-0000-0000-0000-000000000002', last_failed: '2026-09-30T01:00:00Z', status: 'paid', auction: 'Fake Tuesday sale' },
    ],
  };
  const e = buildEmail(d, { site: SITE, now: NOW });
  assert.match(e.text, /Failed card charges: 2 invoices \(1 still unpaid\)/);
  assert.match(e.text, /- Sep 29 · invoice aaaaaaaa · Fake Tuesday sale · payment_failed_grace · https:\/\/admin\.example\.invalid\/invoices\/aaaaaaaa-0000-0000-0000-000000000001/);
  assert.equal(e.attention, 1);
  assert.ok(!/\$|\bcents\b|last4|visa/i.test(e.text));
});

test('refund limbo shows the change since yesterday; only an increase needs attention', () => {
  const d = quiet();
  d.refundLimbo = { now_count: 641, day_ago_count: 629, items: [{ id: 'lot-x', lot_code: 'BIN-9', title: 'Fake table', refunded_at: '2026-07-09T12:00:00Z' }] };
  let e = buildEmail(d, { site: SITE, now: NOW });
  assert.match(e.text, /641 \(\+12 since yesterday\)/);
  assert.match(e.text, /- BIN-9 · Fake table · refunded 83 days ago/);
  assert.equal(e.attention, 12);
  d.refundLimbo = { now_count: 600, day_ago_count: 641, items: [] };
  e = buildEmail(d, { site: SITE, now: NOW });
  assert.match(e.text, /600 \(-41 since yesterday\)/);
  assert.equal(e.attention, 0);
});

test('failures list database jobs and GitHub runs', () => {
  const d = quiet();
  d.failures = {
    cron: [{ jobname: 'fake-job', failed: 3, last_failed: '2026-09-30T11:12:00Z' }],
    runs: [{ name: 'Post-deploy check', conclusion: 'failure', html_url: 'https://github.example.invalid/run/1' }],
  };
  const e = buildEmail(d, { site: SITE, now: NOW });
  assert.match(e.text, /- database job fake-job: 3 failed, last 6:12 AM/);
  assert.match(e.text, /- Post-deploy check: failure · https:\/\/github\.example\.invalid\/run\/1/);
  assert.equal(e.attention, 2);
});

test('a section that failed to load says "couldn\'t load" and the rest still render', () => {
  const d = quiet();
  d.feedback = new Error('sql 500');
  d.auctions.failedCharges = new Error('sql 500');
  d.failures.runs = new Error('github 403');
  const e = buildEmail(d, { site: SITE, now: NOW });
  assert.match(e.text, /1\. CUSTOMER FEEDBACK\ncouldn't load/);
  assert.match(e.text, /Failed card charges: couldn't load/);
  assert.match(e.text, /GitHub jobs: couldn't load/);
  assert.match(e.text, /3 auctions · 300 lots closed/);
  assert.equal(e.counts.feedback, 'failed');
});

test('schedule gate: exactly one of the two UTC slots sends, in summer and in winter', () => {
  const cdt = new Date('2026-09-30T11:50:00Z');
  assert.equal(shouldSendScheduled('45 11 * * *', cdt), true);
  assert.equal(shouldSendScheduled('45 12 * * *', cdt), false);
  const cst = new Date('2026-12-15T12:55:00Z');
  assert.equal(shouldSendScheduled('45 11 * * *', cst), false);
  assert.equal(shouldSendScheduled('45 12 * * *', cst), true);
  // A run GitHub starts late still judges by its slot, not the clock.
  assert.equal(shouldSendScheduled('45 11 * * *', new Date('2026-09-30T12:05:00Z')), true);
  assert.equal(shouldSendScheduled(undefined, cdt), false);
});

test('recipients parse from a comma list', () => {
  assert.deepEqual(parseRecipients(' a@example.invalid, ,b@example.invalid '), ['a@example.invalid', 'b@example.invalid']);
  assert.deepEqual(parseRecipients(undefined), []);
});

test('failedRuns keeps failed post-deploy checks and failed scheduled runs, not this run', () => {
  const since = Date.parse('2026-09-29T12:00:00Z');
  const runs = [
    { id: 1, name: 'Post-deploy check', path: '.github/workflows/post-deploy-check.yml', event: 'workflow_dispatch', conclusion: 'failure', created_at: '2026-09-30T01:00:00Z' },
    { id: 2, name: 'Nightly import', path: '.github/workflows/import-d2l-folder.yml', event: 'schedule', conclusion: 'timed_out', created_at: '2026-09-30T08:10:00Z' },
    { id: 3, name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request', conclusion: 'failure', created_at: '2026-09-30T02:00:00Z' },
    { id: 4, name: 'Nightly import', path: '.github/workflows/import-d2l-folder.yml', event: 'schedule', conclusion: 'success', created_at: '2026-09-30T08:10:00Z' },
    { id: 5, name: 'Daily summary', path: '.github/workflows/daily-summary.yml', event: 'schedule', conclusion: 'failure', created_at: '2026-09-30T11:50:00Z' },
    { id: 6, name: 'Post-deploy check', path: '.github/workflows/post-deploy-check.yml', event: 'workflow_dispatch', conclusion: 'failure', created_at: '2026-09-28T01:00:00Z' },
  ];
  assert.deepEqual(failedRuns(runs, { sinceMs: since, selfRunId: 5 }).map((r) => r.id), [1, 2]);
});

// ── End to end with fetch faked ──────────────────────────────────────────────

function fakeFetch({ failSql = () => false, resendOk = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (String(url).includes('/database/query')) {
      const { query } = JSON.parse(init.body);
      if (failSql(query)) return json({ message: 'boom' }, 500);
      if (query.includes('app_feedback')) return json([{ new_count: 1, open_count: 2, oldest_open: '2026-09-01T00:00:00Z', items: [fb(1)] }]);
      if (query.includes('charge_attempts')) return json([{ failed_invoices: 0, still_unpaid: 0, items: [] }]);
      if (query.includes('refunded_at')) return json([{ now_count: 7, day_ago_count: 7, items: [] }]);
      if (query.includes('cron.job')) return json([]);
      if (query.includes("status = 'draft'")) return json([{ stuck: 0, items: [] }]);
      return json([{ auctions: 1, closed: 10, sold: 9, unsold: 1 }]);
    }
    if (String(url).includes('api.github.com')) return json({ workflow_runs: [] });
    if (String(url).includes('api.resend.com')) return json({ id: 'fake-message-id' }, resendOk ? 200 : 500);
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const ENV = {
  SUPABASE_ACCESS_TOKEN: 'fake-token',
  SUPABASE_PROJECT_REF: 'fakeref',
  RESEND_API_KEY: 'fake-key',
  DAILY_SUMMARY_TO: 'owner@example.invalid',
  GITHUB_TOKEN: 'fake-gh',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_RUN_ID: '99',
  EVENT_NAME: 'workflow_dispatch',
  SITE: SITE,
};

test('send now: loads every section read-only, sends plain text, and logs no body or recipients', async () => {
  const fetch = fakeFetch();
  const logs = [];
  const res = await run(ENV, { fetch, log: (m) => logs.push(m), now: NOW });
  assert.equal(res.sent, true);
  const sent = fetch.calls.find((c) => c.url.includes('resend'));
  const body = JSON.parse(sent.init.body);
  assert.deepEqual(body.to, ['owner@example.invalid']);
  assert.equal(body.subject, 'BinGo Daily - Sep 30 - 1 need attention');
  assert.ok(body.text.includes('Test report number 1'));
  assert.equal(body.html, undefined);
  for (const c of fetch.calls.filter((x) => x.url.includes('/database/query'))) {
    assert.doesNotThrow(() => assertReadOnly(JSON.parse(c.init.body).query));
  }
  const logged = logs.join('\n');
  assert.ok(!logged.includes('owner@example.invalid'));
  assert.ok(!logged.includes('Test report number'));
  assert.match(logged, /resend id fake-message-id/);
});

test("a failed query still sends, with that section marked couldn't load", async () => {
  const fetch = fakeFetch({ failSql: (q) => q.includes('app_feedback') });
  const res = await run(ENV, { fetch, log: () => {}, now: NOW });
  assert.equal(res.sent, true);
  assert.match(res.email.text, /1\. CUSTOMER FEEDBACK\ncouldn't load/);
});

test('dry run builds but sends nothing', async () => {
  const fetch = fakeFetch();
  const res = await run({ ...ENV, MODE: 'dry' }, { fetch, log: () => {}, now: NOW });
  assert.equal(res.sent, false);
  assert.ok(!fetch.calls.some((c) => c.url.includes('resend')));
});

test('the off-slot scheduled run exits without querying or sending', async () => {
  const fetch = fakeFetch();
  const res = await run({ ...ENV, EVENT_NAME: 'schedule', SCHEDULE: '45 12 * * *' }, { fetch, log: () => {}, now: new Date('2026-09-30T12:55:00Z') });
  assert.equal(res.skipped, true);
  assert.equal(fetch.calls.length, 0);
});

test('missing recipients fails loudly instead of sending nowhere', async () => {
  await assert.rejects(run({ ...ENV, DAILY_SUMMARY_TO: '' }, { fetch: fakeFetch(), log: () => {}, now: NOW }), /DAILY_SUMMARY_TO/);
});

test('a Resend failure makes the run fail, so tomorrow reports it', async () => {
  await assert.rejects(run(ENV, { fetch: fakeFetch({ resendOk: false }), log: () => {}, now: NOW }), /resend 500/);
});
