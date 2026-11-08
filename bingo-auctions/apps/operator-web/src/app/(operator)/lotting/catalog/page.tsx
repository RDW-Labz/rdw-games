// /lotting/catalog — read-only browser of product_lookups.
//
// The catalog drives Quick Lot's UPC/ASIN-to-product resolution and
// scanPhoto's price enrichment. After the 0% → 99.6% image backfill
// from the scraper DB it has 128k+ rows; this page lets operators
// audit what's in there: how many have images, which titles look
// suspicious, what's the price coverage, etc.
//
// MVP: search by UPC/title prefix, filter by has-images, paginated
// 50 per page. Operators get a feel for catalog quality without
// having to drop into psql.
//
// Read-only intentionally. Edit / delete tooling is a future commit
// and would need separate auth-checks since the catalog is shared
// across all operators (unlike lots which are operator-scoped).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { KpiCard, MoneyText, MonoText } from '@/components/console';

type CatalogRow = {
  upc: string;
  title: string | null;
  brand: string | null;
  msrp_cents: number | null;
  image_urls: string[] | null;
  confidence: 'high' | 'medium' | 'low' | 'none' | null;
  category_raw: string | null;
};

const PAGE_SIZE = 50;

export default async function CatalogPage(props: {
  searchParams: Promise<{
    q?: string;
    has_images?: string;
    page?: string;
  }>;
}) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const sp = await props.searchParams;
  const q = (sp.q ?? '').trim();
  const hasImagesFilter = sp.has_images === '1';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Build the query. We don't paginate via .count('exact') here — at
  // 128k rows the count is expensive. Use head:exact only when the
  // operator filters down to something narrow (search active).
  let query = supabase
    .from('product_lookups')
    .select('upc, title, brand, msrp_cents, image_urls, confidence, category_raw')
    .order('updated_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (q) {
    // Prefix match on UPC + ilike on title. The trigram index from
    // 0027/0042 makes the title scan fast for ≥3 chars; UPC eq is
    // cheap via the unique index.
    if (/^\d{6,}$/.test(q)) {
      query = query.or(`upc.eq.${q},title.ilike.%${q}%`);
    } else {
      query = query.ilike('title', `%${q}%`);
    }
  }
  if (hasImagesFilter) {
    query = query.not('image_urls', 'is', null).not('image_urls', 'eq', '{}');
  }

  const { data: rows } = await query;
  const list = (rows ?? []) as CatalogRow[];

  // Compute coverage stats — cheap because they're partial indexes.
  const { count: total } = await supabase
    .from('product_lookups')
    .select('upc', { count: 'exact', head: true });
  const { count: withImages } = await supabase
    .from('product_lookups')
    .select('upc', { count: 'exact', head: true })
    .not('image_urls', 'is', null)
    .not('image_urls', 'eq', '{}');

  return (
    <div>
      <PageHeader title="Catalog" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5, marginBottom: 16 }}>
        Read-only browser of <code>product_lookups</code> — the shared catalog driving
        Quick Lot resolution + scanPhoto price enrichment. Imports and AI lookups
        write here automatically.
      </p>

      {/* Coverage stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          marginBottom: 16,
          maxWidth: 720,
        }}
      >
        <KpiCard label="Total rows" value={(total ?? 0).toLocaleString()} />
        <KpiCard
          label="With images"
          value={`${(withImages ?? 0).toLocaleString()} (${
            total ? Math.round((100 * (withImages ?? 0)) / total) : 0
          }%)`}
        />
      </div>

      {/* Search + filter form */}
      <form
        method="GET"
        style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', maxWidth: 720 }}
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="UPC or title…"
          style={{
            flex: 1,
            minWidth: 220,
            padding: '8px 12px',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <label
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            padding: '6px 12px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--fg)',
          }}
        >
          <input type="checkbox" name="has_images" value="1" defaultChecked={hasImagesFilter} />
          With images only
        </label>
        <button
          type="submit"
          style={{
            padding: '8px 16px',
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Search
        </button>
      </form>

      {list.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
            maxWidth: 720,
          }}
        >
          {q ? 'No matches.' : 'No catalog rows yet.'}
        </div>
      ) : (
        <>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              overflow: 'hidden',
              maxWidth: 1200,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '60px 160px minmax(0, 2fr) 120px 100px 80px',
                gap: 12,
                padding: '10px 14px',
                background: 'var(--bg-elev)',
                borderBottom: '1px solid var(--border)',
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
                alignItems: 'center',
              }}
            >
              <span aria-label="Image" />
              <span>UPC / ASIN</span>
              <span>Title</span>
              <span>Brand</span>
              <span>MSRP</span>
              <span>Conf</span>
            </div>
            {list.map((r) => {
              const firstImg = r.image_urls && r.image_urls.length > 0 ? r.image_urls[0] : null;
              return (
                <div
                  key={r.upc}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '60px 160px minmax(0, 2fr) 120px 100px 80px',
                    gap: 12,
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    alignItems: 'center',
                  }}
                >
                  {firstImg ? (
                    // plain <img> — opennextjs has known edge cases with <Image> over CF resizing
                    <img
                      src={firstImg}
                      alt=""
                      loading="lazy"
                      style={{
                        width: 48,
                        height: 48,
                        objectFit: 'cover',
                        borderRadius: 4,
                        background: 'var(--bg-elev)',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        background: 'var(--bg-elev)',
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--fg-dim)',
                        fontSize: 18,
                      }}
                    >
                      📦
                    </div>
                  )}
                  <MonoText style={{ fontSize: 12, color: 'var(--accent)' }}>
                    {r.upc.length > 18 ? r.upc.slice(0, 18) + '…' : r.upc}
                  </MonoText>
                  <span
                    style={{
                      fontSize: 13,
                      color: 'var(--fg)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.title ?? ''}
                  >
                    {r.title ?? '(no title)'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{r.brand ?? '—'}</span>
                  {r.msrp_cents != null ? (
                    <MoneyText cents={r.msrp_cents} style={{ fontSize: 13 }} />
                  ) : (
                    <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>—</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                    {r.confidence ?? '—'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginTop: 16,
              maxWidth: 1200,
            }}
          >
            {page > 1 && (
              <Link
                href={buildHref({ q, has_images: hasImagesFilter, page: page - 1 })}
                style={{ ...linkBtn }}
              >
                ← Previous
              </Link>
            )}
            <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
              Page {page} · showing {list.length}
            </span>
            {list.length === PAGE_SIZE && (
              <Link
                href={buildHref({ q, has_images: hasImagesFilter, page: page + 1 })}
                style={{ ...linkBtn }}
              >
                Next →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function buildHref(params: { q: string; has_images: boolean; page: number }): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.has_images) qs.set('has_images', '1');
  if (params.page > 1) qs.set('page', String(params.page));
  const tail = qs.toString();
  return tail ? `/lotting/catalog?${tail}` : '/lotting/catalog';
}

const linkBtn: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--bg-elev)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  textDecoration: 'none',
  fontSize: 13,
};
