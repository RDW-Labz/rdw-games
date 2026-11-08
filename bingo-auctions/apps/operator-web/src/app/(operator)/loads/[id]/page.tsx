import type { CSSProperties } from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { formatCents } from '@auction-platform/shared';
import { getSupabaseServer } from '@/lib/supabase-server';
import { summaryStateFrom, type SummaryState } from '@/lib/load-summary';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { LoadCostEditor } from '../LoadCostEditor';

type LoadType = 'auto-import' | 'manual';

type LoadRow = {
  id: string;
  type: LoadType;
  source_name: string;
  purchase_cost_cents: number | null;
  purchase_date: string | null;
  notes: string | null;
  import_id: string | null;
  created_at: string;
  archived_at: string | null;
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const typeBadgeStyle = (type: LoadType): CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  background: type === 'auto-import' ? 'var(--cyan-dim)' : 'var(--bg-elev-2)',
  color: type === 'auto-import' ? 'var(--cyan-hi)' : 'var(--fg-dim)',
});

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: '0.75rem',
  marginBottom: '1rem',
};

export default async function LoadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const role = (me as { role: string }).role;
  const operatorId = (me as { operator_id: string }).operator_id;
  const canView = role === 'admin' || role === 'manager';

  const { data: loadData } = await supabase
    .from('loads')
    .select(
      'id, type, source_name, purchase_cost_cents, purchase_date, notes, import_id, created_at, archived_at',
    )
    .eq('id', id)
    .eq('operator_id', operatorId)
    .maybeSingle();

  if (!loadData) notFound();
  const load = loadData as LoadRow;

  let state: SummaryState;
  if (canView) {
    const { data, error } = await supabase.rpc('load_summary', { p_load_id: id });
    state = summaryStateFrom(data, error);
  } else {
    state = { kind: 'forbidden' };
  }

  return (
    <div style={{ maxWidth: 960 }}>
      <PageHeader
        title={load.source_name}
        action={
          <Link href="/loads" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            ← Loads
          </Link>
        }
      />

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: 8,
          color: 'var(--fg-muted)',
          fontSize: 13,
        }}
      >
        <span style={typeBadgeStyle(load.type)}>
          {load.type === 'auto-import' ? 'auto-import' : 'manual'}
        </span>
        <span>Purchased {formatDate(load.purchase_date)}</span>
        {load.archived_at && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              padding: '2px 8px',
              borderRadius: 4,
              background: 'var(--bg-elev-2)',
              color: 'var(--fg-dim)',
            }}
          >
            Archived
          </span>
        )}
        {load.import_id && (
          <Link
            href={`/imports/${load.import_id}`}
            style={{ color: 'var(--accent)', textDecoration: 'none' }}
          >
            Source import →
          </Link>
        )}
      </div>

      {load.notes && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          {load.notes}
        </p>
      )}

      <div
        style={{
          marginBottom: 24,
          padding: '14px 16px',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius, 10px)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            marginBottom: 8,
          }}
        >
          Purchase cost
        </div>
        <LoadCostEditor
          loadId={load.id}
          costCents={load.purchase_cost_cents}
          canEdit={canView}
        />
      </div>

      {state.kind === 'forbidden' && (
        <p style={{ color: 'var(--fg-muted)' }}>
          Only admins and managers can see a load&apos;s numbers.
        </p>
      )}

      {state.kind === 'unavailable' && (
        <p style={{ color: 'var(--fg-muted)' }}>
          Load numbers are not available yet (migration 0429 not applied).
        </p>
      )}

      {state.kind === 'error' && (
        <p style={{ color: 'var(--danger)' }}>
          Couldn&apos;t load the numbers: {state.message}
        </p>
      )}

      {state.kind === 'ok' && (
        <>
          {state.summary.lots === 0 && (
            <p
              style={{
                color: 'var(--fg-muted)',
                fontSize: 13,
                marginBottom: 16,
                lineHeight: 1.5,
              }}
            >
              No lots are linked to this load yet. New lots link automatically once migration
              0428 is live; older lots need the backfill.
            </p>
          )}

          <div style={gridStyle}>
            <KpiCard label="Lots" value={String(state.summary.lots)} />
            <KpiCard label="Sold" value={String(state.summary.sold)} />
            <KpiCard label="Unsold" value={String(state.summary.unsold)} />
            <KpiCard label="Relisted copies" value={String(state.summary.relistCopies)} />
          </div>

          <div style={gridStyle}>
            <KpiCard
              label="Gross (hammer + premium)"
              value={formatCents(state.summary.grossCents)}
            />
            <KpiCard label="Refunds" value={formatCents(state.summary.refundsCents)} />
            <KpiCard
              label="Net revenue (tax excluded)"
              value={formatCents(state.summary.netRevenueCents)}
              hero
            />
            <KpiCard
              label="Cost"
              value={
                state.summary.costCents != null
                  ? formatCents(state.summary.costCents)
                  : '—'
              }
              muted={state.summary.costCents == null}
            />
            <KpiCard
              label="Profit"
              value={
                state.summary.profitCents != null
                  ? formatCents(state.summary.profitCents)
                  : '—'
              }
              tone={
                state.summary.profitCents == null
                  ? 'default'
                  : state.summary.profitCents >= 0
                    ? 'success'
                    : 'danger'
              }
              muted={state.summary.profitCents == null}
              sub={
                state.summary.profitCents == null ? 'Add a cost to see profit' : undefined
              }
            />
          </div>

          <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            Hammer {formatCents(state.summary.hammerCents)} · Premium{' '}
            {formatCents(state.summary.premiumCents)} · {state.summary.invoiceLines} sold lines,{' '}
            {state.summary.refundedLines} refunded, {state.summary.forfeitedLines} forfeited
            (payment kept)
          </p>

          <p style={{ fontSize: 12, color: 'var(--fg-dim)', lineHeight: 1.5, maxWidth: 720 }}>
            Net revenue = winning bids + buyer&apos;s premium on paid invoices, minus refunds. Tax
            is never included. Relisted copies count through their original lot.
          </p>
        </>
      )}
    </div>
  );
}
