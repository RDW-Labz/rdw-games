// Marketing — console control panel for the closing-soon email digest
// (mig 0230). Owner wanted digest sends under dashboard control with
// automation gentler than nightly: the auto toggle only fires on mornings
// an auction closes, at most every 72h. This page shows exactly what a
// send would contain (lot preview), who gets it (opted-in count), the
// toggle, the send-now button, and the send history.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { formatInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { KpiCard, DataTable, MoneyText, type Column } from '@/components/console';
import {
  selectDigestLots,
  countDigestRecipients,
  getDigestLotCount,
  MANUAL_WINDOW_HOURS,
} from '@/lib/marketing-digest';
import { MarketingControls } from './MarketingControls';
import { CampaignPanel, type CampaignCardRow } from './CampaignPanel';
import { SocialPanel, type SocialPostRow } from './SocialPanel';

export const dynamic = 'force-dynamic';

export default async function MarketingPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');
  const operatorId = (me as { operator_id: string }).operator_id;

  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;

  const admin = getSupabaseAdmin();
  const lotCount = await getDigestLotCount(admin);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [lots, recipientCount, settingsQ, historyQ, referredQ, creditsQ, nudgesSentQ, nudgeConvQ, clicksQ, clicks7dQ] =
    await Promise.all([
      selectDigestLots(admin, MANUAL_WINDOW_HOURS, lotCount),
      countDigestRecipients(admin),
      admin.from('platform_settings').select('digest_auto_enabled, square_sync_enabled, square_loyalty_enabled, social_posting_enabled').eq('id', true).maybeSingle(),
      admin
        .from('marketing_digest_sends')
        .select('sent_by, recipient_count, lot_count, subject, created_at')
        .order('created_at', { ascending: false })
        .limit(10),
      // Scoreboard (mig 0232 batch)
      admin.from('bidders').select('id', { count: 'exact', head: true }).not('referred_by', 'is', null),
      admin.from('bidder_credits').select('amount_cents, reason'),
      admin
        .from('notifications_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('kind', 'add_card_nudge')
        .not('emailed_at', 'is', null),
      admin
        .from('bidders')
        .select('id', { count: 'exact', head: true })
        .not('card_nudged_at', 'is', null)
        .not('default_payment_method_id', 'is', null),
      admin.from('share_clicks').select('id', { count: 'exact', head: true }),
      admin.from('share_clicks').select('id', { count: 'exact', head: true }).gt('created_at', weekAgo),
    ]);

  // Campaign definitions (mig 0292) — copy/cadence live in the row, and
  // campaign_performance() returns metrics only, so the panel needs both.
  const { data: campaignDefs } = await admin
    .from('marketing_campaigns')
    .select('slug, description, lot_strategy, min_hours_between_runs, cooldown_hours, max_sends_per_bidder');
  const defs = new Map(
    ((campaignDefs ?? []) as Array<{
      slug: string;
      description: string;
      lot_strategy: string;
      min_hours_between_runs: number;
      cooldown_hours: number;
      max_sends_per_bidder: number;
    }>).map((d) => [d.slug, d]),
  );

  const creditRows = (creditsQ.data ?? []) as Array<{ amount_cents: number; reason: string }>;
  const creditsEarnedCents = creditRows
    .filter((r) => r.reason === 'referral_earn' || r.reason === 'referral_welcome')
    .reduce((s, r) => s + r.amount_cents, 0);
  const creditsSpentCents = -creditRows
    .filter((r) => r.reason === 'spend' || r.reason === 'spend_reversal')
    .reduce((s, r) => s + r.amount_cents, 0);
  const scoreboard = {
    referredSignups: referredQ.count ?? 0,
    creditsEarnedCents,
    creditsSpentCents,
    nudgesSent: nudgesSentQ.count ?? 0,
    nudgeConversions: nudgeConvQ.count ?? 0,
    shareClicksTotal: clicksQ.count ?? 0,
    shareClicks7d: clicks7dQ.count ?? 0,
  };
  const settingsRow = settingsQ.data as {
    digest_auto_enabled: boolean;
    social_posting_enabled: boolean | null;
    square_sync_enabled?: boolean;
    square_loyalty_enabled?: boolean;
  } | null;
  const autoEnabled = settingsRow?.digest_auto_enabled ?? false;

  // 0323/0324 social posting. Read here rather than in the client component so
  // the panel renders with real state on first paint instead of flashing OFF.
  const socialEnabled = settingsRow?.social_posting_enabled === true;
  // Presence check only — the token itself is never read into the page, and
  // never leaves the server.
  const socialCredsConfigured = Boolean(
    process.env.META_PAGE_ACCESS_TOKEN && process.env.META_PAGE_ID,
  );
  const { data: socialRecentRaw } = await admin
    .from('social_posts')
    .select('id, platform, status, message, permalink, error, created_at')
    .order('created_at', { ascending: false })
    .limit(15);
  const socialRecent = (socialRecentRaw ?? []) as unknown as SocialPostRow[];
  const { count: socialPosted7d } = await admin
    .from('social_posts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'posted')
    .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString());
  const squareSyncEnabled = settingsRow?.square_sync_enabled ?? false;
  const squareLoyaltyEnabled = settingsRow?.square_loyalty_enabled ?? false;
  const history = (historyQ.data ?? []) as Array<{
    sent_by: string;
    recipient_count: number;
    lot_count: number;
    subject: string;
    created_at: string;
  }>;

  // Campaign cards (mig 0292). campaign_performance() carries both the current
  // audience size and the after-email activity, so one RPC drives the panel.
  const { data: perfData, error: perfError } = await admin.rpc('campaign_performance');
  const campaignError = perfError?.message ?? null;
  const campaignRows: CampaignCardRow[] = (
    (perfData as Array<Record<string, unknown>> | null) ?? []
  ).map((p) => ({
    slug: p['slug'] as string,
    name: p['name'] as string,
    description: (defs.get(p['slug'] as string)?.description ?? '') as string,
    audience: p['audience'] as string,
    enabled: Boolean(p['enabled']),
    lotStrategy: (defs.get(p['slug'] as string)?.lot_strategy ?? 'closing_soon') as string,
    cadenceHours: (defs.get(p['slug'] as string)?.min_hours_between_runs ?? 72) as number,
    cooldownHours: (defs.get(p['slug'] as string)?.cooldown_hours ?? 336) as number,
    maxPerBidder: (defs.get(p['slug'] as string)?.max_sends_per_bidder ?? 3) as number,
    audienceNow: Number(p['audience_now'] ?? 0),
    emailsSent: Number(p['emails_sent'] ?? 0),
    biddersReached: Number(p['bidders_reached'] ?? 0),
    bidAfter: Number(p['bid_after'] ?? 0),
    boughtAfter: Number(p['bought_after'] ?? 0),
    revenueAfterCents: Number(p['revenue_after_cents'] ?? 0),
    lastRunAt: (p['last_run_at'] as string | null) ?? null,
    lastRunLabel: p['last_run_at'] ? formatInTimeZone(p['last_run_at'] as string, tz) : null,
  }));

  // The headline number: biggest segment we are not yet reaching. Surfacing it
  // in prose beats making the owner scan six cards to find the opportunity.
  const biggestGap = campaignRows
    .filter((c) => c.audienceNow > 0)
    .sort((a, b) => b.audienceNow - a.audienceNow)[0];

  type HistoryRow = (typeof history)[number];
  const historyColumns: Column<HistoryRow>[] = [
    { key: 'when', header: 'When', cell: (h) => formatInTimeZone(h.created_at, tz) },
    { key: 'trigger', header: 'Trigger', cell: (h) => (h.sent_by === 'auto' ? 'Automatic' : 'Manual') },
    { key: 'subject', header: 'Subject', cell: (h) => h.subject },
    { key: 'lots', header: 'Lots', numeric: true, cell: (h) => h.lot_count },
    { key: 'recipients', header: 'Recipients', numeric: true, cell: (h) => h.recipient_count },
  ];

  return (
    <div>
      <PageHeader title="Marketing" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1.25rem' }}>
        The closing-soon digest emails opted-in bidders a grid of the liveliest lots ending soon.
        Every email carries a one-click unsubscribe (transactional email is unaffected).
      </p>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={sectionH}>Scoreboard</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.75rem' }}>
          <KpiCard label="Referred signups" value={scoreboard.referredSignups} />
          <KpiCard label="Credits earned" value={<MoneyText cents={scoreboard.creditsEarnedCents} />} />
          <KpiCard label="Credits redeemed" value={<MoneyText cents={scoreboard.creditsSpentCents} />} />
          <KpiCard label="Card nudges sent" value={scoreboard.nudgesSent} />
          <KpiCard label="Nudged → added card" value={scoreboard.nudgeConversions} />
          <KpiCard label="Share clicks · 7d" value={scoreboard.shareClicks7d} />
          <KpiCard label="Share clicks · all" value={scoreboard.shareClicksTotal} />
        </div>
      </section>

      <MarketingControls
        autoEnabled={autoEnabled}
        previewCount={lots.length}
        recipientCount={recipientCount}
        lotCount={lotCount}
        squareSyncEnabled={squareSyncEnabled}
        squareLoyaltyEnabled={squareLoyaltyEnabled}
      />

      <section style={{ marginTop: '2rem' }}>
        <h2 style={sectionH}>What a send right now would include · next {MANUAL_WINDOW_HOURS}h</h2>
        {lots.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--fg-muted)' }}>No live lots close in the next {MANUAL_WINDOW_HOURS} hours.</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '0.75rem',
            }}
          >
            {lots.map((l) => (
              <Link
                key={l.lot_code}
                href={`/lot/${l.lot_code}`}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '0.6rem',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <img
                  src={l.photo_url ?? '/art/photo/no-photo.webp'}
                  alt=""
                  width={56}
                  height={56}
                  style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.title}
                  </div>
                  <MoneyText
                    cents={l.current_bid_cents ?? l.starting_bid_cents ?? 0}
                    style={{ display: 'block', fontSize: 12, color: 'var(--accent)', fontWeight: 700 }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                    {l.close_at
                      ? `Closes ${formatInTimeZone(l.close_at, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
                      : ''}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={sectionH}>Segmented campaigns</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 0.9rem', maxWidth: 880, lineHeight: 1.55 }}>
          The digest above talks to everyone at once. These talk to specific
          groups. All five ship <strong>off</strong> — turning one on lets it run
          on the daily cron, capped by its own cadence and a per-bidder
          frequency limit that a manual send cannot bypass.{' '}
          {biggestGap ? (
            <>
              Right now the largest untapped segment is{' '}
              <strong>{biggestGap.name.toLowerCase()}</strong> at{' '}
              <strong>{biggestGap.audienceNow} eligible bidders</strong> and{' '}
              {biggestGap.emailsSent === 0 ? 'nothing sent yet' : `${biggestGap.emailsSent} sent`}.
            </>
          ) : null}
        </p>
        {campaignError ? (
          <p style={{ fontSize: 13, color: 'var(--danger)' }}>
            Couldn&apos;t load campaigns: {campaignError}
          </p>
        ) : (
          <CampaignPanel campaigns={campaignRows} />
        )}

        <SocialPanel
          enabled={socialEnabled}
          credentialsConfigured={socialCredsConfigured}
          recent={socialRecent}
          postedLast7d={socialPosted7d ?? 0}
        />
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={sectionH}>Meta ad audiences</h2>
        {/* Downloads are SHA-256 hashed and exclude anyone who opted out of ad
            tracking, so the file is safe to keep and safe to upload. Meta
            detects the hashes and matches on them exactly as on raw values. */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            alignItems: 'center',
            padding: '1rem',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-elev)',
          }}
        >
          <a href="/marketing/audience/export?segment=buyers" style={audienceBtn}>
            Download buyers (exclude these)
          </a>
          <a href="/marketing/audience/export?segment=dormant" style={audienceBtn}>
            Download registered non-bidders
          </a>
          <span style={{ fontSize: 13, color: 'var(--fg-muted)', flexBasis: '100%' }}>
            Upload &ldquo;buyers&rdquo; to Meta as a Custom Audience and set it as an
            <strong> exclusion</strong> on cold prospecting — otherwise the budget goes on people
            who already bid here. Hashed, so no readable addresses leave this page.
          </span>
        </div>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={sectionH}>Send history</h2>
        <DataTable
          columns={historyColumns}
          rows={history}
          rowKey={(h) => h.created_at}
          empty="No digests sent yet."
        />
      </section>
    </div>
  );
}

const audienceBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.5rem 0.9rem',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  textDecoration: 'none',
  fontSize: 14,
  fontWeight: 600,
};

const sectionH: React.CSSProperties = {
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: 'var(--fg-muted)',
  margin: '0 0 0.6rem',
};
