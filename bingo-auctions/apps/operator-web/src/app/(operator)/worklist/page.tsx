// /worklist — operator-web desktop mirror of the field-mobile staff Worklist tab.
//
// Surfaces the three lot-side action buckets that need staff attention but are
// currently scattered (`/ops` shows a tiny "Unsold lots" rail; mobile has the
// full picture). Sections are switched via a `section` search param.
//
//   - needs_relot  → lots.status='unsold', deleted_at IS NULL. These didn't
//                    sell on their last auction and need a relist decision.
//   - flagged      → lots.flagged_for_disposal=TRUE, deleted_at IS NULL. Set
//                    by the auto_relist_unsold_lots cron after exhausting
//                    auto-relist strikes (mig 0146 W5-DB), or by manual staff
//                    action via mark_lot_disposed.
//   - forfeited    → lots whose bidder no-showed pickup. Predicate:
//                      lots.status IN ('unsold','relisted')
//                      AND deleted_at IS NULL
//                      AND EXISTS (pickup via invoice_lots → invoices → pickups
//                                  with pickups.status IN ('no_show','forfeited'))
//                    The status range covers BOTH the legacy stranded-'relisted'
//                    rows (pre-mig 0155 / PR #109) AND future no_show flips
//                    which set lots.status='unsold'. Some overlap with the
//                    Needs-re-lot section is acceptable; the Forfeited view
//                    is the actionable surface for those rows.
//
// Template / idioms borrowed from:
//   - apps/operator-web/src/app/(operator)/lotting/inventory/page.tsx
//       → server-component shape, bucket tabs with HEAD counts, warehouse
//         filter, search, distinct-source dropdown, server-rendered table.
//   - apps/operator-web/src/app/(operator)/dashboard/workers/page.tsx
//       → `!inner(child!inner(...))` embed idiom for filtering parent rows by
//         a deep child predicate (here: lots filtered by pickup status).
//   - apps/field-mobile/features/lotting/useInventoryList.ts (PR #110)
//       → same forfeited-section join path; this page is the desktop mirror.
//
// Discoverability: a "View Worklist" Link is added on /ops near the existing
// "Unsold lots" rail. The (operator) sidebar nav (layout.tsx) is owned by
// another in-flight session — deliberately NOT touched here.
//
// Schema deferral: the brief asked for a `disposal_reason` column on the
// Flagged section. None exists; mig 0146 stores the staff/auto-generated
// reason in lots.flagged_reason. That column is surfaced instead — same
// semantic answer to "why was this flagged?".
//
// 500-row safety limit: matches the inventory page. A separate HEAD count
// drives the badge / banner so the operator sees the true total even when
// the table is capped. CSV export deliberately out of scope here — this
// is a triage view, not a reporting view.
//
// Permissions: anyone with an operator_users row can see /worklist; RLS
// scopes the queries. The header copy nudges admins/managers to act
// (relist / mark disposed) but the page itself is read-only.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { lotDisplayCode } from '@auction-platform/shared';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { FilterSelect } from '@/components/FilterSelect';
import { WorklistRowActions, type WorklistAuctionOption } from './WorklistRowActions';

type Section = 'needs_relot' | 'flagged' | 'forfeited';
const DEFAULT_SECTION: Section = 'needs_relot';
const SECTION_ORDER: Section[] = ['needs_relot', 'flagged', 'forfeited'];
const SECTION_LABELS: Record<Section, string> = {
  needs_relot: 'Needs re-lot',
  flagged: 'Flagged for disposal',
  forfeited: 'Forfeited returns',
};
const SECTION_EMPTY_COPY: Record<Section, string> = {
  needs_relot:
    'No unsold lots awaiting a relist decision. Auto-relist drains this queue every 10 minutes.',
  flagged:
    'Nothing flagged for disposal. The cron flags lots after auto_flag_disposal_at_strikes (operator setting).',
  forfeited:
    'No forfeited returns. Lots land here when a bidder no-shows pickup (markPickup → no_show).',
};
const SECTION_DESCRIPTIONS: Record<Section, string> = {
  needs_relot:
    'Lots whose auction closed without a winning bid. Auto-relist will keep cycling them until the operator-configured strike limit; staff can also relist or pull manually.',
  flagged:
    'Lots that hit the auto-relist strike limit (auto_flag_disposal_at_strikes — operator setting). Staff should dispose (mark_lot_disposed), donate, or re-photo + manually relist.',
  forfeited:
    "Lots whose bidder no-showed or forfeited pickup. They've returned to operator hands and need a re-list / pull / dispose call. Some overlap with Needs re-lot is expected — this view is the more actionable surface for those rows.",
};

function parseSection(raw: string | undefined): Section {
  return raw === 'needs_relot' || raw === 'flagged' || raw === 'forfeited'
    ? raw
    : DEFAULT_SECTION;
}

// Columns selected on every section. Includes section-specific fields
// (flagged_at, flagged_reason, last_relisted_at, relist_count) regardless
// of which section is active — keeps the SELECT shape stable and a future
// "view all" union trivial.
const LOT_COLUMNS =
  'id, lot_code, sticker_code, display_code, title, status, source, vendor, warehouse_id, relist_count, last_relisted_at, closed_at, flagged_for_disposal, flagged_at, flagged_reason';

type LotRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  status: 'pending_intake' | 'in_inventory' | 'unsold' | 'relisted' | 'disposed' | 'scheduled' | 'live';
  source: string | null;
  vendor: string | null;
  warehouse_id: string | null;
  relist_count: number | null;
  last_relisted_at: string | null;
  closed_at: string | null;
  flagged_for_disposal: boolean | null;
  flagged_at: string | null;
  flagged_reason: string | null;
};
type WarehouseLite = { id: string; name: string };
type EnrichedLotRow = LotRow & { warehouseName: string | null };

export default async function WorklistPage(props: {
  searchParams: Promise<{
    section?: string;
    q?: string;
    warehouse?: string;
  }>;
}) {
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
  // M9: inline row actions (relist / pull / dispose) are admin/manager only,
  // matching relistLot + mark_lot_disposed. Other staff see a read-only list.
  const canAct =
    (me as { role: string }).role === 'admin' || (me as { role: string }).role === 'manager';

  const sp = await props.searchParams;
  const section = parseSection(sp.section);
  const searchQ = (sp.q ?? '').trim();
  const warehouseFilter = (sp.warehouse ?? '').trim();

  // Operator's warehouses for the filter dropdown. RLS already scopes; the
  // explicit operator_id keeps the query plan obvious.
  const { data: warehousesData } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('operator_id', operatorId)
    .order('name', { ascending: true });
  const warehouses = (warehousesData ?? []) as unknown as WarehouseLite[];
  const activeWarehouseId =
    warehouseFilter && warehouses.some((w) => w.id === warehouseFilter)
      ? warehouseFilter
      : '';
  const activeWarehouseName = activeWarehouseId
    ? warehouses.find((w) => w.id === activeWarehouseId)?.name ?? null
    : null;

  // ---- List query for the active section. -----------------------------------
  // Per-section predicate inlined (NOT extracted into a helper — same TS2589
  // reason called out in inventory/page.tsx: returning a Supabase builder from
  // a helper trips "type instantiation is excessively deep").
  let listQuery;
  if (section === 'forfeited') {
    // Forfeited returns: lots whose pickup is no_show / forfeited. The
    // `!inner` embed filters the lot rows by the child pickup status (idiom
    // from dashboard/workers/page.tsx). status range is the UNION of the
    // legacy stranded-'relisted' rows (pre-mig 0155) AND the future
    // no_show-flipped 'unsold' rows (mig 0155 + PR #109).
    listQuery = supabase
      .from('lots')
      .select(
        `${LOT_COLUMNS}, invoice_lots!inner(invoices!inner(pickups!inner(status)))`,
      )
      .eq('operator_id', operatorId)
      .is('deleted_at', null)
      .in('status', ['unsold', 'relisted'])
      .in('invoice_lots.invoices.pickups.status', ['no_show', 'forfeited']);
  } else if (section === 'flagged') {
    listQuery = supabase
      .from('lots')
      .select(LOT_COLUMNS)
      .eq('operator_id', operatorId)
      .is('deleted_at', null)
      .eq('flagged_for_disposal', true);
  } else {
    // needs_relot
    listQuery = supabase
      .from('lots')
      .select(LOT_COLUMNS)
      .eq('operator_id', operatorId)
      .is('deleted_at', null)
      .eq('status', 'unsold');
  }

  if (activeWarehouseId) {
    listQuery = listQuery.eq('warehouse_id', activeWarehouseId);
  }
  if (searchQ) {
    // Prefix match on lot_code, ilike on title, plus the sticker label — the
    // worklist is where relot lives, and a lot queued for relot is exactly the
    // kind whose box shows a sticker rather than its BIN-###### lot_code.
    listQuery = listQuery.or(
      `lot_code.ilike.${searchQ}%,title.ilike.%${searchQ}%,sticker_code.ilike.%${searchQ}%`,
    );
  }

  // Sort: most recent stamp for the section's lifecycle event.
  //   needs_relot → closed_at DESC (most recently closed unsold on top)
  //   flagged     → flagged_at DESC (most recently flagged on top)
  //   forfeited   → created_at DESC (we don't have a pickup-side timestamp
  //                  surfaced on lots; created_at is the stable fallback and
  //                  matches the inventory page default)
  if (section === 'needs_relot') {
    listQuery = listQuery.order('closed_at', { ascending: false, nullsFirst: false });
  } else if (section === 'flagged') {
    listQuery = listQuery.order('flagged_at', { ascending: false, nullsFirst: false });
  } else {
    listQuery = listQuery.order('created_at', { ascending: false });
  }
  listQuery = listQuery.limit(500);

  const { data: lotsData } = await listQuery;
  const lots = (lotsData ?? []) as unknown as LotRow[];

  // Resolve warehouse_id → human name (RLS scopes the lookup). Lots in the
  // worklist often have a warehouse_id (they were intaked); the forfeited
  // section's status='unsold' rows that were never intaked won't, and fall
  // through to "—" in the table.
  const lotWarehouseIds = Array.from(
    new Set(lots.map((l) => l.warehouse_id).filter((v): v is string => Boolean(v))),
  );
  const whData = lotWarehouseIds.length
    ? ((await supabase
        .from('warehouses')
        .select('id, name')
        .in('id', lotWarehouseIds)).data ?? [])
    : [];
  const warehouseMap = new Map(
    (whData as WarehouseLite[]).map((w) => [w.id, w.name]),
  );
  const enrichedLots: EnrichedLotRow[] = lots.map((l) => ({
    ...l,
    warehouseName: l.warehouse_id ? warehouseMap.get(l.warehouse_id) ?? null : null,
  }));

  // M9: open auctions (draft/scheduled, not yet ended) for the inline
  // "Relist into [auction ▾]" dropdown. The client component filters these to
  // each row's warehouse (relist_lot_into_auction enforces same-warehouse).
  // Only fetched when the caller can act. Mirrors the inventory page's
  // openAuctions query shape.
  const { data: openAuctionsData } = canAct
    ? await supabase
        .from('auctions')
        .select('id, title, warehouse_id, ends_at')
        .eq('operator_id', operatorId)
        .in('status', ['draft', 'scheduled'])
        .gt('ends_at', new Date().toISOString())
        .order('ends_at', { ascending: true })
    : { data: [] };
  const openAuctions = (openAuctionsData ?? []) as unknown as WorklistAuctionOption[];

  // ---- Per-section counts (HEAD, count:'exact'). ---------------------------
  // One small query per section drives the tab badges. Each mirrors the list
  // scope EXCEPT it ignores the text search (the tab counts should be stable
  // "how many in this bucket" numbers). They DO honor the warehouse filter
  // so the badges stay consistent with the active scope, same as inventory.
  const sectionCount = async (s: Section): Promise<number> => {
    let q;
    if (s === 'forfeited') {
      q = supabase
        .from('lots')
        .select('id, invoice_lots!inner(invoices!inner(pickups!inner(status)))', {
          count: 'exact',
          head: true,
        })
        .eq('operator_id', operatorId)
        .is('deleted_at', null)
        .in('status', ['unsold', 'relisted'])
        .in('invoice_lots.invoices.pickups.status', ['no_show', 'forfeited']);
    } else if (s === 'flagged') {
      q = supabase
        .from('lots')
        .select('id', { count: 'exact', head: true })
        .eq('operator_id', operatorId)
        .is('deleted_at', null)
        .eq('flagged_for_disposal', true);
    } else {
      q = supabase
        .from('lots')
        .select('id', { count: 'exact', head: true })
        .eq('operator_id', operatorId)
        .is('deleted_at', null)
        .eq('status', 'unsold');
    }
    if (activeWarehouseId) q = q.eq('warehouse_id', activeWarehouseId);
    const { count } = await q;
    return count ?? 0;
  };
  const [needsRelotCount, flaggedCount, forfeitedCount] = await Promise.all([
    sectionCount('needs_relot'),
    sectionCount('flagged'),
    sectionCount('forfeited'),
  ]);
  const sectionCounts: Record<Section, number> = {
    needs_relot: needsRelotCount,
    flagged: flaggedCount,
    forfeited: forfeitedCount,
  };
  const activeSectionCount = sectionCounts[section];

  // Build hrefs preserving filters when toggling section / clearing.
  const buildHref = (overrides: Record<string, string | null>): string => {
    const qs = new URLSearchParams();
    if (section !== DEFAULT_SECTION) qs.set('section', section);
    if (searchQ) qs.set('q', searchQ);
    if (activeWarehouseId) qs.set('warehouse', activeWarehouseId);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    return `/worklist${qs.toString() ? '?' + qs.toString() : ''}`;
  };

  const hasActiveFilter = Boolean(searchQ || activeWarehouseId);

  return (
    <div>
      <PageHeader title="Worklist" />
      <p
        style={{
          color: 'var(--fg-muted)',
          maxWidth: 760,
          lineHeight: 1.55,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        Lots that need a staff decision. <strong>Needs re-lot</strong> are
        unsold from their last auction; <strong>Flagged for disposal</strong>
        {' '}exhausted auto-relist attempts; <strong>Forfeited returns</strong>
        {' '}are lots whose bidder no-showed pickup. Mirrors the field-mobile
        staff Worklist tab.
      </p>

      {/* Section tabs — each shows a HEAD count badge. */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {SECTION_ORDER.map((s) => (
          <SectionTab
            key={s}
            href={buildHref({ section: s === DEFAULT_SECTION ? null : s })}
            label={SECTION_LABELS[s]}
            count={sectionCounts[s]}
            active={section === s}
          />
        ))}
      </div>

      {/* Active-filter scope banner (same visual as inventory). */}
      {hasActiveFilter && (
        <div
          style={{
            padding: '10px 14px',
            marginBottom: 16,
            borderRadius: 6,
            border: '1px solid var(--accent)',
            background: 'var(--accent-dim)',
            fontSize: 13,
            maxWidth: 760,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--accent)', fontWeight: 800, letterSpacing: 0.4 }}>
            VIEWING:
          </span>
          <span style={{ color: 'var(--fg)' }}>
            Section{' '}
            <strong style={{ color: 'var(--accent)' }}>{SECTION_LABELS[section]}</strong>
          </span>
          {activeWarehouseName && (
            <span style={{ color: 'var(--fg)' }}>
              Warehouse{' '}
              <strong style={{ color: 'var(--accent)' }}>{activeWarehouseName}</strong>
            </span>
          )}
          {searchQ && (
            <span style={{ color: 'var(--fg)' }}>
              Search{' '}
              <strong style={{ color: 'var(--accent)' }}>&quot;{searchQ}&quot;</strong>
            </span>
          )}
          <span style={{ color: 'var(--fg-muted)' }}>
            ({lots.length} lot{lots.length === 1 ? '' : 's'} shown)
          </span>
        </div>
      )}

      {/* Section description — explains why this bucket exists. */}
      <p
        style={{
          color: 'var(--fg-muted)',
          maxWidth: 760,
          lineHeight: 1.5,
          marginBottom: 16,
          fontSize: 12,
          padding: '10px 14px',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        {SECTION_DESCRIPTIONS[section]}
      </p>

      {/* 500-row cap banner — same pattern as inventory. */}
      {lots.length === 500 && activeSectionCount > 500 && (
        <div
          style={{
            padding: 12,
            background: 'var(--bg-elev)',
            border: '1px solid var(--warning, #fbbf24)',
            color: 'var(--warning, #fbbf24)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
            maxWidth: 760,
          }}
        >
          Showing the most recent 500 of {activeSectionCount} lots in this
          section. Narrow with the warehouse / search filters above.
        </div>
      )}

      {/* Search + warehouse filter. GET so the URL captures state. */}
      <form
        method="GET"
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
          maxWidth: 760,
        }}
      >
        {section !== DEFAULT_SECTION && (
          <input type="hidden" name="section" value={section} />
        )}
        <input
          type="search"
          name="q"
          defaultValue={searchQ}
          placeholder="Lot code or title…"
          style={{
            flex: 1,
            minWidth: 200,
            padding: '6px 10px',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        {/* FilterSelect: applies on change. Was a bare <select>, so picking a
            warehouse did nothing until you also clicked the submit button —
            same dead-until-you-click bug reported on /lotting/inventory. */}
        {warehouses.length > 0 && (
          <FilterSelect
            name="warehouse"
            defaultValue={activeWarehouseId}
            ariaLabel="Filter by warehouse"
          >
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </FilterSelect>
        )}
        <button
          type="submit"
          style={{
            padding: '6px 12px',
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Apply
        </button>
        {hasActiveFilter && (
          <a
            href={buildHref({ q: null, warehouse: null })}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            Clear
          </a>
        )}
      </form>

      {/* List. Empty state and table share the same outer wrapper. */}
      {lots.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
            maxWidth: 760,
          }}
        >
          {hasActiveFilter
            ? 'No lots match the current filters in this section.'
            : SECTION_EMPTY_COPY[section]}
        </div>
      ) : (
        <WorklistTable
          section={section}
          lots={enrichedLots}
          canAct={canAct}
          openAuctions={openAuctions}
        />
      )}
    </div>
  );
}

// Section tab pill — same visual as inventory's BucketTab.
function SectionTab({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
        border: '1px solid',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.4,
        textDecoration: 'none',
      }}
      aria-current={active ? 'page' : undefined}
    >
      <span>{label}</span>
      <span
        style={{
          minWidth: 20,
          textAlign: 'center',
          padding: '1px 7px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 800,
          background: active ? 'var(--accent)' : 'var(--bg-elev)',
          color: active ? 'var(--bg)' : 'var(--fg-muted)',
        }}
      >
        {count}
      </span>
    </Link>
  );
}

// ---- Table ----------------------------------------------------------------
// Server-rendered. Each section gets a slightly different rightmost column:
//   needs_relot → "Last relisted" (last_relisted_at + relist_count badge)
//   flagged     → "Flagged" (flagged_at + flagged_reason)
//   forfeited   → "Status / closed" (status badge + closed_at)
//
// Source / VRID header label matches the recent inventory rename ("Source /
// VRID" rather than just "Source") so the two pages share vocabulary.

function WorklistTable({
  section,
  lots,
  canAct,
  openAuctions,
}: {
  section: Section;
  lots: EnrichedLotRow[];
  canAct: boolean;
  openAuctions: WorklistAuctionOption[];
}) {
  const thStyle: React.CSSProperties = {
    padding: '0.6rem 0.75rem',
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: 'var(--fg-muted)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  };
  const tdStyle: React.CSSProperties = {
    padding: '0.55rem 0.75rem',
    fontSize: 13,
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
  };

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <thead>
          <tr>
            <th style={thStyle}>Lot</th>
            <th style={thStyle}>Title</th>
            <th style={thStyle}>Source / VRID</th>
            <th style={thStyle}>Vendor</th>
            <th style={thStyle}>Warehouse</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>
              {section === 'flagged'
                ? 'Flagged'
                : section === 'forfeited'
                  ? 'Status / closed'
                  : 'Last relisted'}
            </th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((l) => (
            <tr key={l.id}>
              <td style={tdStyle}>
                <Link
                  href={`/lots/${l.id}`}
                  style={{
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    fontFamily: 'monospace',
                    fontWeight: 700,
                  }}
                >
                  {lotDisplayCode(l) ?? l.lot_code}
                </Link>
              </td>
              <td style={tdStyle}>
                <span
                  style={{
                    display: 'inline-block',
                    maxWidth: 340,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'bottom',
                  }}
                  title={l.title}
                >
                  {l.title}
                </span>
              </td>
              <td style={{ ...tdStyle, color: 'var(--fg-muted)' }}>
                {l.source ?? '—'}
              </td>
              <td style={{ ...tdStyle, color: 'var(--fg-muted)' }}>
                {l.vendor ?? '—'}
              </td>
              <td style={{ ...tdStyle, color: 'var(--fg-muted)' }}>
                {l.warehouseName ?? '—'}
              </td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>
                {section === 'flagged' ? (
                  <FlaggedCell
                    flaggedAt={l.flagged_at}
                    flaggedReason={l.flagged_reason}
                  />
                ) : section === 'forfeited' ? (
                  <ForfeitedCell status={l.status} closedAt={l.closed_at} />
                ) : (
                  <NeedsRelotCell
                    lastRelistedAt={l.last_relisted_at}
                    closedAt={l.closed_at}
                    relistCount={l.relist_count}
                  />
                )}
              </td>
              <td style={{ ...tdStyle, verticalAlign: 'top' }}>
                <WorklistRowActions
                  lotId={l.id}
                  lotCode={lotDisplayCode(l) ?? l.lot_code}
                  warehouseId={l.warehouse_id}
                  auctions={openAuctions}
                  canAct={canAct}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NeedsRelotCell({
  lastRelistedAt,
  closedAt,
  relistCount,
}: {
  lastRelistedAt: string | null;
  closedAt: string | null;
  relistCount: number | null;
}) {
  const ts = lastRelistedAt ?? closedAt;
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
        fontSize: 12,
        color: 'var(--fg-muted)',
      }}
    >
      <span>{ts ? `${relativeTime(ts)} ago` : '—'}</span>
      {(relistCount ?? 0) > 0 && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            padding: '1px 6px',
            borderRadius: 999,
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
          title="Number of times this lot has been auto-relisted"
        >
          ×{relistCount}
        </span>
      )}
    </div>
  );
}

function FlaggedCell({
  flaggedAt,
  flaggedReason,
}: {
  flaggedAt: string | null;
  flaggedReason: string | null;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 2,
        fontSize: 12,
        color: 'var(--fg-muted)',
      }}
    >
      <span>{flaggedAt ? `${relativeTime(flaggedAt)} ago` : '—'}</span>
      {flaggedReason && (
        <span
          style={{
            fontSize: 11,
            color: 'var(--fg-muted)',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={flaggedReason}
        >
          {flaggedReason}
        </span>
      )}
    </div>
  );
}

function ForfeitedCell({
  status,
  closedAt,
}: {
  status: LotRow['status'];
  closedAt: string | null;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
        fontSize: 12,
        color: 'var(--fg-muted)',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          padding: '1px 6px',
          borderRadius: 999,
          background: 'var(--bg-elev)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          letterSpacing: 0.4,
          textTransform: 'uppercase',
        }}
      >
        {status}
      </span>
      <span>{closedAt ? `${relativeTime(closedAt)} ago` : '—'}</span>
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d`;
}
