// /lotting — pipeline overview.
//
// Replaces the previous redirect-only landing with a one-glance view of
// every stage in the lot lifecycle, plus quick CSV exports + jump links
// to each sub-page. Addresses the audit finding that the 5 separate
// pipeline pages (manifest-pool, drafts, inventory, in-auction, sold)
// made it hard to see the big picture.
//
// Stages (with their canonical pages):
//   1. Manifest pool   import_rows status='pending'   → /lotting/manifest-pool
//   2. Drafts          lots status='pending_intake'   → /lotting/drafts
//   3. Inventory       lots status='in_inventory'    → /lotting/inventory
//   4. In auction      lots in draft/scheduled/live   → /auctions
//   5. Sold            lots status='won' (last 30 d)  → /auctions (closed)
//   6. Unsold          lots status='unsold'           → relist queue
//
// All counts are scoped to the caller's operator via operator_users.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';

export default async function LottingOverviewPage() {
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

  const operatorId = (me as { operator_id: string }).operator_id;
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Pipeline counts — six HEAD queries run in parallel. Each is keyed
  // off operator_id so RLS + the explicit filter give belt-and-braces
  // tenant isolation.
  const [
    poolPending,
    draftCount,
    inventoryCount,
    inAuctionCount,
    soldRecent,
    unsoldCount,
    intakeLast24h,
  ] = await Promise.all([
    supabase
      .from('import_rows')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .eq('status', 'pending'),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .eq('status', 'pending_intake')
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .eq('status', 'in_inventory')
      .is('auction_id', null)
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .in('status', ['draft', 'scheduled', 'live'])
      .not('auction_id', 'is', null)
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .eq('status', 'won')
      .gte('closed_at', since30d),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .eq('status', 'unsold'),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .eq('status', 'in_inventory')
      .gte('intake_at', since24h),
  ]);

  // Top 5 most-recent sources, with counts. Useful for "what truck is
  // landing today" at a glance.
  const { data: bySourceData } = await supabase
    .from('lots')
    .select('source')
    .eq('operator_id', operatorId)
    .in('status', ['pending_intake', 'in_inventory'])
    .is('deleted_at', null)
    .not('source', 'is', null)
    .order('created_at', { ascending: false })
    .limit(2000);
  const sourceCounts = new Map<string, number>();
  for (const r of (bySourceData ?? []) as Array<{ source: string | null }>) {
    if (!r.source) continue;
    sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
  }
  const topSources = [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  return (
    <div>
      <PageHeader title="Lotting" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 760, lineHeight: 1.5, marginBottom: 24 }}>
        Overview of every stage from manifest to sold. Tap a card to drill in,
        or grab a CSV from the export buttons. The pipeline flows left-to-right:
        items come in via manifest → get labeled at intake → go in a bin →
        get listed in an auction → win or unsold.
      </p>

      {/* Pipeline strip — six stages laid out horizontally with arrows */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          marginBottom: 24,
        }}
      >
        <StageCard
          label="1. Manifest pool"
          count={poolPending.count ?? 0}
          subtitle="expected items"
          href="/lotting/manifest-pool"
          exportHref="/lotting/manifest-pool/export"
          accent="muted"
        />
        <StageCard
          label="2. Drafts"
          count={draftCount.count ?? 0}
          subtitle="labeled, awaiting bin"
          href="/lotting/drafts"
          exportHref="/lotting/drafts/export"
          accent={(draftCount.count ?? 0) > 0 ? 'warning' : 'muted'}
        />
        <StageCard
          label="3. Inventory"
          count={inventoryCount.count ?? 0}
          subtitle="binned, ready for auction"
          href="/lotting/inventory"
          exportHref="/lotting/inventory/export"
          accent="accent"
        />
        <StageCard
          label="4. In auction"
          count={inAuctionCount.count ?? 0}
          subtitle="draft / scheduled / live"
          href="/auctions"
          accent="accent"
        />
        <StageCard
          label="5. Sold (30d)"
          count={soldRecent.count ?? 0}
          subtitle="closed, won"
          href="/auctions"
          accent="success"
        />
        <StageCard
          label="6. Unsold"
          count={unsoldCount.count ?? 0}
          subtitle="ready to relist"
          href="/lotting/inventory?status=unsold"
          accent={(unsoldCount.count ?? 0) > 0 ? 'warning' : 'muted'}
        />
      </div>

      {/* Activity strip */}
      <h2 style={{ fontSize: 14, color: 'var(--fg-muted)', fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
        Activity
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          marginBottom: 24,
          maxWidth: 760,
        }}
      >
        <Stat label="Intake last 24 h" value={String(intakeLast24h.count ?? 0)} hint="lots binned by pickers" />
        <Stat
          label="Active inventory"
          value={String(inventoryCount.count ?? 0)}
          hint="not yet assigned to auction"
        />
        <Stat
          label="In-flight auction lots"
          value={String(inAuctionCount.count ?? 0)}
          hint="draft / scheduled / live"
        />
      </div>

      {/* Top sources strip — gives a feel for "what truck is the floor working" */}
      {topSources.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, color: 'var(--fg-muted)', fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
            Top sources in pipeline
          </h2>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 24,
              maxWidth: 760,
            }}
          >
            {topSources.map(([source, count]) => (
              <Link
                key={source}
                href={`/lotting/inventory?source=${encodeURIComponent(source)}`}
                style={{
                  padding: '6px 12px',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  textDecoration: 'none',
                  color: 'var(--fg)',
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span style={{ fontWeight: 700 }}>{source}</span>
                <span style={{ color: 'var(--fg-muted)' }}>· {count}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Quick exports */}
      <h2 style={{ fontSize: 14, color: 'var(--fg-muted)', fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
        Bulk export
      </h2>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0, maxWidth: 760 }}>
        Each export honors the filters on its native page. Up to 5000 rows per file. Use these for accounting, insurance manifests, or to hand a list to floor staff.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
        <ExportLink href="/lotting/manifest-pool/export" label="Manifest pool" />
        <ExportLink href="/lotting/drafts/export" label="Drafts (pending intake)" />
        <ExportLink href="/lotting/inventory/export" label="In-inventory" />
        <ExportLink href="/lotting/inventory/export?missing=photos" label="In-inventory without photos" />
        <ExportLink href="/lotting/inventory/export?missing=msrp" label="In-inventory without MSRP" />
        <ExportLink href="/lotting/inventory/export?missing=category" label="In-inventory without category" />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Link
          href="/imports/new"
          style={{
            padding: '8px 14px',
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          + Import manifest
        </Link>
        <Link
          href="/lots/new"
          style={{
            padding: '8px 14px',
            background: 'transparent',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          + Add lot manually
        </Link>
      </div>
    </div>
  );
}

function StageCard({
  label,
  count,
  subtitle,
  href,
  exportHref,
  accent,
}: {
  label: string;
  count: number;
  subtitle: string;
  href: string;
  exportHref?: string;
  accent: 'accent' | 'warning' | 'success' | 'muted';
}) {
  const accentColor =
    accent === 'accent'
      ? 'var(--accent)'
      : accent === 'warning'
        ? 'var(--warning, #fbbf24)'
        : accent === 'success'
          ? 'var(--success, #4ade80)'
          : 'var(--fg-muted)';
  return (
    <div
      style={{
        position: 'relative',
        padding: 14,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 6,
      }}
    >
      <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            marginBottom: 6,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 28, fontWeight: 900, color: accentColor, lineHeight: 1 }}>
          {count.toLocaleString()}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>{subtitle}</div>
      </Link>
      {exportHref && count > 0 && (
        <a
          href={exportHref}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            fontSize: 11,
            color: 'var(--fg-muted)',
            textDecoration: 'none',
            padding: '2px 6px',
            border: '1px solid var(--border)',
            borderRadius: 3,
          }}
          title="Export CSV"
        >
          CSV
        </a>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--fg)' }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      style={{
        padding: '6px 12px',
        background: 'var(--bg-elev)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        textDecoration: 'none',
        fontSize: 13,
      }}
    >
      ↓ {label}
    </a>
  );
}
