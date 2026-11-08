// Feedback inbox — in-app bug reports and suggestions from both apps.
//
// Owner ask 2026-08-13. The apps write to app_feedback (migration 0317); this
// is where they get read and triaged.
//
// Ordering is deliberately not newest-first across the board. Untriaged rows
// float to the top regardless of age, because the failure mode for an inbox
// like this is not "we read it late" — it is "it scrolled off and nobody ever
// read it." Once a row has been given a status it drops into the history
// below and stops competing for attention.
//
// Rows are read through the caller's session client. RLS (0317) lets any
// operator staff read; triage is admin/manager only and enforced in the
// database, so this page renders the controls for everyone and lets a
// non-manager's submit fail rather than duplicating the role rule here.

import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { PageHeader } from '@/components/Form';
import { FeedbackRow } from './FeedbackRow';
import { SilentExits, type CrashRecord } from './SilentExits';

export const dynamic = 'force-dynamic';

export type FeedbackRecord = {
  id: string;
  created_at: string;
  app: 'bidder' | 'staff' | 'web';
  kind: 'bug' | 'idea';
  message: string;
  reporter_label: string | null;
  screen: string | null;
  app_version: string | null;
  update_id: string | null;
  platform: string | null;
  os_version: string | null;
  device_model: string | null;
  status: string;
  triage_note: string | null;
  /** 0327: reply path for a web report filed without an account. */
  contact_email: string | null;
  /** Signed, short-lived URLs for the screenshots/recordings on this report. */
  attachment_urls: { url: string; content_type: string }[];
  resolved_at: string | null;
  author_id: string;
  /** 0477: when the reply was emailed to the customer; undefined before 0477. */
  reply_emailed_at?: string | null;
  /** 0477 applied AND a customer item we can email (reply-to or account). */
  can_email_reply?: boolean;
};

const SELECT_COLUMNS =
  'id, created_at, app, kind, message, reporter_label, screen, app_version, ' +
  'update_id, platform, os_version, device_model, status, triage_note, ' +
  'resolved_at, author_id, attachments, contact_email';

/** Long enough to watch a recording and come back to it; short enough that a
 *  copied URL is not a durable leak of a screen that may show bidder data. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

type StoredAttachment = { path: string; content_type: string; bytes: number };

export default async function FeedbackPage() {
  const supabase = await getSupabaseServer();

  const { data, error } = await supabase
    .from('app_feedback')
    .select(SELECT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(200);

  const rawRows = (data ?? []) as unknown as (FeedbackRecord & {
    attachments: StoredAttachment[] | null;
  })[];

  // feedback-attachments is a PRIVATE bucket (0325) — a screen recording of the
  // staff app can show bidder names and invoice totals, so it is never linked
  // directly. One batch call signs every path on the page; per-row signing
  // would be a request per attachment.
  const signedRows = await withSignedAttachments(rawRows);

  // 0477 deploy-order safety: reply emails need app_feedback.reply_emailed_at.
  // Probe with a GET (a HEAD on a missing column reads as success, see #624);
  // before 0477 the button simply does not render.
  const { data: replyProbe, error: replyProbeErr } = await supabase
    .from('app_feedback')
    .select('id, reply_emailed_at')
    .in('id', signedRows.length ? signedRows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']);
  const replyReady = !replyProbeErr && Array.isArray(replyProbe);
  const emailedAt = new Map(
    ((replyProbe ?? []) as { id: string; reply_emailed_at: string | null }[]).map((p) => [p.id, p.reply_emailed_at]),
  );
  const rows: FeedbackRecord[] = signedRows.map((r) => ({
    ...r,
    reply_emailed_at: replyReady ? emailedAt.get(r.id) ?? null : undefined,
    can_email_reply: replyReady && r.app !== 'staff' && (Boolean(r.contact_email) || Boolean(r.author_id)),
  }));

  // client_crash_reports (0215) is service-role only — RLS is on with no
  // policies, deliberately, because the write path is an unauthenticated
  // telemetry endpoint. Reading it therefore needs the admin client. That is
  // safe here and only here: the (operator) layout has already established an
  // operator session before this page renders, and the rows carry no customer
  // data — a screen name, a build number and an error string.
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: crashData } = await getSupabaseAdmin()
    .from('client_crash_reports')
    .select('id, created_at, app, platform, app_version, ota_update, message, screen, is_fatal')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);
  const crashes = (crashData ?? []) as unknown as CrashRecord[];

  // Bidders have no bidders-row join here on purpose: app_feedback.author_id
  // points at auth.users, which spans bidders and operator_users, so there is
  // no single table to embed. The reporter is identified by reporter_label
  // (staff) or by looking the author up in Bidders when it matters.
  const untriaged = rows.filter((r) => r.status === 'new');
  const history = rows.filter((r) => r.status !== 'new');

  const openBugs = untriaged.filter((r) => r.kind === 'bug').length;

  return (
    <div>
      <PageHeader title="Feedback" />

      {error ? (
        <p
          style={{
            padding: '0.75rem 1rem',
            border: '1px solid var(--danger)',
            borderRadius: 6,
            color: 'var(--danger)',
            fontSize: 14,
          }}
        >
          Couldn&apos;t load feedback: {error.message}
        </p>
      ) : null}

      <div
        style={{
          padding: '0.75rem 1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          marginBottom: '1.25rem',
          fontSize: 14,
          color: 'var(--fg-muted)',
        }}
      >
        {untriaged.length === 0
          ? 'Nothing new. Every report has been triaged.'
          : `${untriaged.length} new · ${openBugs} ${openBugs === 1 ? 'bug' : 'bugs'}`}
      </div>

      <SilentExits rows={crashes} />

      <Section title={`New (${untriaged.length})`} rows={untriaged} highlight />
      <Section title={`Triaged (${history.length})`} rows={history} muted />
    </div>
  );
}

/** Attach short-lived signed URLs to each row, leaving the rest untouched. */
async function withSignedAttachments(
  rawRows: (FeedbackRecord & { attachments: StoredAttachment[] | null })[],
): Promise<FeedbackRecord[]> {
  const paths = rawRows.flatMap((r) => (r.attachments ?? []).map((a) => a.path));
  const signed = new Map<string, string>();

  if (paths.length > 0) {
    const { data } = await getSupabaseAdmin()
      .storage.from('feedback-attachments')
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    for (const entry of data ?? []) {
      // A failed entry carries an error and a null url — skip it rather than
      // rendering a broken <img>; the report itself is still worth showing.
      if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
    }
  }

  return rawRows.map((r) => ({
    ...r,
    attachment_urls: (r.attachments ?? [])
      .map((a) => ({ url: signed.get(a.path) ?? '', content_type: a.content_type }))
      .filter((a) => a.url !== ''),
  }));
}

function Section({
  title,
  rows,
  highlight,
  muted,
}: {
  title: string;
  rows: FeedbackRecord[];
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2
        style={{
          fontSize: '1rem',
          color: muted ? 'var(--fg-muted)' : highlight ? 'var(--accent)' : 'var(--fg)',
          marginBottom: '0.5rem',
        }}
      >
        {title}
      </h2>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>—</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
          {rows.map((r) => (
            <FeedbackRow key={r.id} record={r} />
          ))}
        </ul>
      )}
    </section>
  );
}
