/**
 * sitemap.xml — generated from this Next.js metadata route.
 *
 * Static surface pages plus dynamic entries for each active auction and
 * lot (status IN ('scheduled', 'live')), and one entry per category
 * landing page (/category/[slug]). We cap at 5k auctions / 50k lots to
 * stay inside Google's 50k-URL-per-sitemap limit; if we ever exceed that
 * we'll shard into an index.
 *
 * Operator-pitch URLs live on operators.bingoauctions.com and have their own
 * sitemap — they intentionally aren't included here.
 *
 * Cache for 10 minutes. Lot status changes quickly, but a 600s lag is
 * fine for SEO and protects Supabase from a crawler stampede.
 */

import type { MetadataRoute } from 'next';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const revalidate = 600;

const BASE = 'https://bingoauctions.com';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const sb = getSupabaseAdmin();

  const [auctions, lots, categories] = await Promise.all([
    sb
      .from('auctions')
      .select('id, updated_at')
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false)
      .limit(5000),
    sb
      .from('lots')
      // 0242: !inner join so lots in unlisted (link-only) auctions never
      // reach the sitemap.
      .select('lot_code, updated_at, auctions!inner(unlisted)')
      .in('status', ['scheduled', 'live'])
      .eq('auctions.unlisted', false)
      .limit(50000),
    // Category landing pages (/category/[slug]). The categories table has no
    // updated_at column (only created_at), so these entries omit lastModified.
    // Ordered by sort_order to keep the sitemap stable across rebuilds.
    sb
      .from('categories')
      .select('slug')
      .order('sort_order')
      .limit(500),
  ]);

  const staticPaths: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, changeFrequency: 'daily', priority: 1.0 },
    { url: `${BASE}/browse`, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${BASE}/how-it-works`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/final-call`, changeFrequency: 'hourly', priority: 0.7 },
    { url: `${BASE}/download`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/support`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE}/legal/terms`, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE}/legal/privacy`, changeFrequency: 'monthly', priority: 0.3 },
  ];

  const auctionRows = (auctions.data ?? []) as Array<{
    id: string;
    updated_at: string | null;
  }>;
  const auctionPaths: MetadataRoute.Sitemap = auctionRows.map((a) => ({
    url: `${BASE}/auction/${a.id}`,
    lastModified: a.updated_at ?? undefined,
    changeFrequency: 'hourly' as const,
    priority: 0.8,
  }));

  const lotRows = (lots.data ?? []) as Array<{
    lot_code: string;
    updated_at: string | null;
  }>;
  const lotPaths: MetadataRoute.Sitemap = lotRows.map((l) => ({
    url: `${BASE}/lot/${l.lot_code}`,
    lastModified: l.updated_at ?? undefined,
    changeFrequency: 'hourly' as const,
    priority: 0.6,
  }));

  const categoryRows = (categories.data ?? []) as Array<{
    slug: string | null;
  }>;
  const categoryPaths: MetadataRoute.Sitemap = categoryRows
    .filter((c): c is { slug: string } => typeof c.slug === 'string' && c.slug.length > 0)
    .map((c) => ({
      url: `${BASE}/category/${c.slug}`,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    }));

  return [...staticPaths, ...auctionPaths, ...lotPaths, ...categoryPaths];
}
