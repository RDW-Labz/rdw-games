import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isGrowthHubEnabled, presentGrowthPage, type GrowthPageModel } from '@/lib/growth-hub';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { DataTable, FilterPills, KpiCard, SectionDivider } from '@/components/console';

export const dynamic = 'force-dynamic';

export default async function GrowthHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  if (!isGrowthHubEnabled()) notFound();
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase.from('operator_users').select('role').eq('user_id', user.id).maybeSingle();
  if (!me) redirect('/onboarding');
  const { slug } = await params;
  const q = await searchParams;
  const view = presentGrowthPage({
    enabled: isGrowthHubEnabled(),
    role: (me as { role: string }).role,
    slug: slug?.[0],
    extraSegments: Math.max((slug?.length ?? 0) - 1, 0),
    filter: q.filter,
  });
  if (view.outcome === 'not_found') notFound();
  if (view.outcome !== 'page') {
    return (
      <div>
        <PageHeader title={view.title} />
        <p style={{ color: 'var(--fg-muted)' }}>
          {view.outcome === 'denied' ? 'This view is restricted to administrators.' : view.message}
        </p>
        {view.outcome === 'retry' ? (
          <p>
            <Link href={view.retryHref} style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
              Retry
            </Link>
          </p>
        ) : null}
      </div>
    );
  }
  return <GrowthPageShell model={view.model} csv={view.csv} dependencyMissing={view.dependencyMissing} />;
}

function GrowthPageShell({
  model,
  csv,
  dependencyMissing,
}: {
  model: GrowthPageModel;
  csv: string;
  dependencyMissing: boolean;
}) {
  return (
    <div>
      <PageHeader
        title={model.title}
        action={
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
            download={`growth-${model.id}.csv`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            Export CSV
          </a>
        }
      />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 780 }}>
        {model.note}
        {dependencyMissing
          ? ' This page is a shell until its feature slice ships. Numbers stay blank; nothing here is a live metric.'
          : null}
      </p>
      <section style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        {model.kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} sub={k.sub} muted style={{ flex: '1 1 150px' }} />
        ))}
      </section>
      <FilterPills
        aria-label="Period"
        active={model.filter}
        options={model.filters.map((f) => ({
          value: f.value,
          label: f.label,
          href: `${model.href}?filter=${f.value}`,
        }))}
        style={{ marginBottom: '1rem' }}
      />
      <DataTable
        columns={model.columns.map((key) => ({ key, header: key, cell: (row: Record<string, string>) => row[key] ?? '—' }))}
        rows={model.rows}
        rowKey={(row, i) => model.columns.map((c) => row[c] ?? '').join('|') || String(i)}
        empty="No rows until this feature slice ships."
      />
      <SectionDivider title="Settings" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', maxWidth: 780 }}>
        Prices, timers and spacing for this feature are set here when its slice ships. Nothing is hard-coded.
      </p>
      <SectionDivider title="Change log" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', maxWidth: 780 }}>
        Each feature slice appends to this page log. The searchable cross-feature log is a later ticket.
      </p>
    </div>
  );
}
