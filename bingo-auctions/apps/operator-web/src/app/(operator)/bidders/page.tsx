// Bidders — operator-scoped list of every bidder who has transacted with
// this operator (joined through paid invoices). Allows lookup, notes, and
// suspension without affecting the bidder's access to other operators.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { formatInTimeZone, DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { BiddersTable, type DirectoryRow } from './BiddersTable';

export default async function BiddersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: filterParam } = await searchParams;
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

  // Timestamps are UTC timestamptz; the SSR runtime (Cloudflare Worker) is
  // UTC, so a bare toLocaleString() prints ~5-6h off. Render every label in
  // the operator's warehouse zone via formatInTimeZone (see lib/datetime).
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;

  // 0235: the full customer directory — EVERY bidder (not just paid ones)
  // with contact info + activity/money aggregates, one staff-gated RPC.
  const { data: dirData } = await supabase.rpc('operator_bidder_directory');
  const directory = ((dirData ?? []) as DirectoryRow[]);

  // 0222: signup stats via SECURITY DEFINER RPC. The table below only lists
  // bidders with PAID invoices, so without this header fresh signups were
  // invisible to the operator ("how can I see how many bidders sign up").
  const { data: statsRows } = await supabase.rpc('bidder_signup_stats');
  const stats = ((statsRows ?? []) as Array<{
    total_bidders: number;
    last_7_days: number;
    last_24_hours: number;
    with_card: number;
  }>)[0] ?? null;

  // 0223: failed signup attempts (rate limits, provider errors). These never
  // create an account, so this table is the only place the operator can see
  // customers who tried to register and bounced — with the email they used,
  // so staff can follow up.
  const { data: failureRows } = await supabase
    .from('signup_failures')
    .select('id, created_at, email, message, source')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(25);
  const failures = (failureRows ?? []) as Array<{
    id: string;
    created_at: string;
    email: string | null;
    message: string;
    source: string;
  }>;

  const th: React.CSSProperties = {
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left',
    color: 'var(--fg-muted)',
    fontSize: 13,
  };
  const td: React.CSSProperties = {
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
  };

  return (
    <div>
      <PageHeader title="Bidders" />

      {stats && (
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '0.75rem',
            marginBottom: '1.25rem',
          }}
        >
          {[
            { label: 'Registered bidders', value: stats.total_bidders },
            { label: 'Signed up · 7 days', value: stats.last_7_days },
            { label: 'Signed up · 24 hours', value: stats.last_24_hours },
            { label: 'Card on file', value: stats.with_card },
          ].map((c) => (
            <div
              key={c.label}
              style={{
                padding: '0.75rem 1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 800 }}>{c.value}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{c.label}</div>
            </div>
          ))}
        </section>
      )}

      {failures.length > 0 && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '0.75rem 1rem 0.5rem',
            background: 'rgba(255, 84, 112, 0.06)',
            border: '1px solid rgba(255, 84, 112, 0.35)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
            Failed signups · last 7 days ({failures.length}
            {failures.length === 25 ? '+' : ''})
          </div>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 0.5rem' }}>
            These customers tried to create an account and were turned away — no
            account exists for them yet. Reach out or ask them to use
            &ldquo;Continue with Google&rdquo;.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Email</th>
                <th style={th}>Error</th>
                <th style={th}>From</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id}>
                  <td style={td}>
                    {formatInTimeZone(f.created_at, tz, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td style={td}>{f.email ?? '—'}</td>
                  <td style={{ ...td, color: 'var(--fg-muted)' }}>{f.message}</td>
                  <td style={td}>{f.source === 'bidder-app' ? 'App' : 'Web'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <BiddersTable
        rows={directory}
        tz={tz ?? DEFAULT_TIME_ZONE}
        initialFilter={filterParam === 'resale_pending' ? 'resale_pending' : 'all'}
      />
    </div>
  );
}
