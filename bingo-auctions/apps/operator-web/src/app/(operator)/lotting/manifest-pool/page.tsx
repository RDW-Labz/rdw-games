// Manifest pool — the GLOBAL "expected items" surface.
//
// Architectural note (migration 0059):
//   This is the canonical pre-intake surface. CSV imports populate
//   import_rows (status='pending'); items live here until either:
//     • A picker scans the item's UPC/ASIN/FNSKU/LPN/external_code
//       against a bin QR via the field-mobile picker → intake_lot_to_bin
//       mints a fully-populated lot directly into in_inventory and the
//       row flips to 'lotted'.
//     • The operator drops rows below as not-sellable → status='dropped'.
//
//   No "Lot N" button anywhere. Lot creation is a physical-intake-only
//   event after this migration — see `packages/db/migrations/0059`.
//
// Filters: search across title/UPC/ASIN/FNSKU/external_code, plus a
// per-import dropdown so operators can focus on one truck at a time.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { ManifestPoolClient, type PoolRow } from './ManifestPoolClient';

export default async function GlobalManifestPoolPage(props: {
  searchParams: Promise<{
    q?: string;
    import?: string;
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

  const sp = await props.searchParams;
  const q = (sp.q ?? '').trim();
  const importFilter = (sp.import ?? '').trim();

  // Build query: pending rows for this operator only. RLS would scope
  // automatically, but we add the operator filter explicitly as a
  // belt-and-braces guard.
  let rowsQuery = supabase
    .from('import_rows')
    .select(
      'id, import_id, title, brand, model, upc, asin, fnsku, lpn, external_code, msrp_cents, photo_url, condition, category_raw, created_at, imports(filename, source_label)',
    )
    .eq('operator_id', me.operator_id as string)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(500);

  if (importFilter) {
    rowsQuery = rowsQuery.eq('import_id', importFilter);
  }

  if (q) {
    // ilike on the most useful identity columns. trigram index on title
    // makes the LIKE %% case fast; UPC/ASIN/etc. are smaller indexes.
    rowsQuery = rowsQuery.or(
      [
        `title.ilike.%${q}%`,
        `upc.ilike.${q}%`,
        `asin.ilike.${q}%`,
        `fnsku.ilike.${q}%`,
        `lpn.ilike.${q}%`,
        `external_code.ilike.${q}%`,
        `brand.ilike.%${q}%`,
        `model.ilike.${q}%`,
      ].join(','),
    );
  }

  const { data: rowsData } = await rowsQuery;
  const rows = (rowsData ?? []) as unknown as PoolRow[];

  // Distinct imports for the filter dropdown (only ones with pending rows).
  const { data: importsData } = await supabase
    .from('imports')
    .select('id, filename, source_label, created_at')
    .eq('operator_id', me.operator_id as string)
    .order('created_at', { ascending: false })
    .limit(200);
  const imports = (importsData ?? []) as Array<{
    id: string;
    filename: string;
    source_label: string | null;
    created_at: string;
  }>;

  // Counts for the header strip — total pending across all imports.
  const { count: totalPending } = await supabase
    .from('import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('operator_id', me.operator_id as string)
    .eq('status', 'pending');

  return (
    <div>
      <PageHeader
        title="Manifest pool"
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            {rows.length > 0 && (
              <a
                href={(() => {
                  const p = new URLSearchParams();
                  if (q) p.set('q', q);
                  if (importFilter) p.set('import', importFilter);
                  const qs = p.toString();
                  return `/lotting/manifest-pool/export${qs ? '?' + qs : ''}`;
                })()}
                style={{
                  padding: '6px 12px',
                  background: 'transparent',
                  color: 'var(--accent)',
                  border: '1px solid var(--accent)',
                  borderRadius: 4,
                  textDecoration: 'none',
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                Export CSV
              </a>
            )}
            <Link
              href="/imports/new"
              style={{
                padding: '6px 14px',
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
          </div>
        }
      />
      <p
        style={{
          color: 'var(--fg-muted)',
          maxWidth: 760,
          lineHeight: 1.5,
          marginBottom: 16,
        }}
      >
        Items expected from CSV manifests, across <strong>every import</strong>.
        These are <em>intent</em>, not inventory — no lot codes are minted
        here. When a truck arrives, the picker scans each item&apos;s
        UPC/ASIN/FNSKU/LPN/external_code plus a bin QR in the field-mobile
        app; the platform mints a fully-populated lot directly into{' '}
        <Link href="/lotting/inventory" style={{ color: 'var(--accent)' }}>
          Inventory
        </Link>{' '}
        at that moment, with the import&apos;s <code>source_label</code>{' '}
        propagated as <code>lots.source</code>. Drop rows that turn out
        unsellable; their history stays here as audit.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
          marginBottom: 16,
          maxWidth: 720,
        }}
      >
        <KpiCard label="Total pending" value={String(totalPending ?? 0)} tone="accent" />
        <KpiCard label="In current view" value={String(rows.length)} />
      </div>

      {/* Filters: search + per-import dropdown */}
      <form
        method="GET"
        style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', maxWidth: 760 }}
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Title, UPC, ASIN, FNSKU, LPN, brand…"
          style={{
            flex: 1,
            minWidth: 240,
            padding: '6px 10px',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        {imports.length > 0 && (
          <select
            name="import"
            defaultValue={importFilter}
            style={{
              padding: '6px 10px',
              background: 'var(--bg-elev)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
              minWidth: 220,
            }}
          >
            <option value="">All imports</option>
            {imports.map((imp) => (
              <option key={imp.id} value={imp.id}>
                {imp.source_label ? `${imp.source_label} — ` : ''}
                {imp.filename}
              </option>
            ))}
          </select>
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
        {(q || importFilter) && (
          <Link
            href="/lotting/manifest-pool"
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
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
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
          {q || importFilter
            ? 'No pending manifest rows match those filters.'
            : (
              <>
                No pending manifest rows.{' '}
                <Link href="/imports/new" style={{ color: 'var(--accent)' }}>
                  Import a manifest
                </Link>{' '}
                to add expected items.
              </>
            )}
        </div>
      ) : (
        <ManifestPoolClient
          canDrop={me.role === 'admin' || me.role === 'manager'}
          rows={rows}
        />
      )}
    </div>
  );
}
