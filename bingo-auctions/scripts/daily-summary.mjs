#!/usr/bin/env node
// Daily summary email: feedback, last night's auctions, stuck lots, refunded
// items with no next step, and anything that failed. Plain text, via Resend.
//
// Run by .github/workflows/daily-summary.yml (06:45 CT daily, plus "send now").
// Read-only: SELECTs through the Supabase Management API (assertReadOnly guards
// every statement) and GETs from the GitHub API. It writes nothing anywhere.
//
// It never logs the email body, feedback text or recipients — only the
// subject, per-section counts and Resend's message id.
//
// Env:
//   SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF   read-only SQL
//   RESEND_API_KEY, RESEND_FROM_EMAIL (optional)  sending
//   DAILY_SUMMARY_TO                               comma-separated recipients
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID failed-run lookup
//   EVENT_NAME, SCHEDULE                           schedule gate (see lib)
//   MODE = send | dry                              dry builds, prints counts, sends nothing
//   SITE (optional)                                admin base URL

import { pathToFileURL } from 'node:url';
import { QUERIES, assertReadOnly, buildEmail, failedRuns, parseRecipients, shouldSendScheduled } from './daily-summary/lib.mjs';

export async function run(env = process.env, { fetch = globalThis.fetch, log = console.log, now = new Date() } = {}) {
  const site = (env.SITE || 'https://bingoauctions.com').replace(/\/$/, '');
  const mode = env.MODE === 'dry' ? 'dry' : 'send';

  if (env.EVENT_NAME === 'schedule' && !shouldSendScheduled(env.SCHEDULE, now)) {
    log(`daily-summary: slot ${env.SCHEDULE} is not 06:45 Central today; the other slot sends`);
    return { sent: false, skipped: true };
  }
  const to = parseRecipients(env.DAILY_SUMMARY_TO);
  if (mode === 'send' && (!to.length || !env.RESEND_API_KEY)) {
    throw new Error('daily-summary: DAILY_SUMMARY_TO and RESEND_API_KEY must both be set');
  }
  if (!env.SUPABASE_ACCESS_TOKEN || !env.SUPABASE_PROJECT_REF) {
    throw new Error('daily-summary: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF must be set');
  }

  const sql = async (query) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: assertReadOnly(query) }),
    });
    if (!res.ok) throw new Error(`sql ${res.status}`);
    return res.json();
  };
  const one = async (query) => (await sql(query))[0] ?? {};
  // A failed load becomes an Error value, which the section renders as
  // "couldn't load". Only the error's first line is logged: it never holds rows.
  const settle = (p, name) =>
    p.catch((err) => {
      log(`daily-summary: ${name} couldn't load (${String(err?.message ?? err).split('\n')[0].slice(0, 120)})`);
      return err instanceof Error ? err : new Error(String(err));
    });

  const ghRuns = async () => {
    const since = new Date(now.getTime() - 86_400_000);
    const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs?per_page=100&created=%3E%3D${since.toISOString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const body = await res.json();
    return failedRuns(body.workflow_runs, { sinceMs: since.getTime(), selfRunId: env.GITHUB_RUN_ID });
  };

  const [feedback, auctions, failedCharges, stuckDrafts, refundLimbo, cron, runs] = await Promise.all([
    settle(one(QUERIES.feedback), 'feedback'),
    settle(one(QUERIES.auctions), 'auctions'),
    settle(one(QUERIES.failedCharges), 'failed charges'),
    settle(one(QUERIES.stuckDrafts), 'stuck drafts'),
    settle(one(QUERIES.refundLimbo), 'refund limbo'),
    settle(sql(QUERIES.cronFailures), 'database jobs'),
    settle(ghRuns(), 'github runs'),
  ]);

  const email = buildEmail(
    { feedback, auctions: { auctions, failedCharges }, stuckDrafts, refundLimbo, failures: { cron, runs } },
    { site, now },
  );
  log(`daily-summary: ${email.subject}`);
  log(`daily-summary: sections ${JSON.stringify(email.counts)}`);

  if (mode === 'dry') {
    log('daily-summary: dry run, nothing sent');
    return { sent: false, email };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'BinGo Auctions <no-reply@bingoauctions.com>',
      to,
      subject: email.subject,
      text: email.text,
    }),
  });
  if (!res.ok) throw new Error(`daily-summary: resend ${res.status}`);
  const { id } = await res.json().catch(() => ({}));
  log(`daily-summary: sent to ${to.length} recipient(s), resend id ${id ?? 'unknown'}`);
  return { sent: true, email, id };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().catch((err) => {
    console.error(String(err?.message ?? err).split('\n')[0]);
    process.exit(1);
  });
}
