// Producer side of the queue infrastructure.
//
// We used to enqueue BullMQ jobs against an external Redis. That's gone --
// auction close is now driven by a pg_cron job that scans lots WHERE
// close_at <= now() every 5 seconds, and cache warming is a Postgres
// table that a Cloudflare Worker drains on a schedule. The old
// enqueueAuctionCloseJobs no-op stub has been removed along with its
// callers; setting lots.close_at is now the entire scheduling action.

import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

// Insert UPCs into the product_cache_warm_jobs table. Primary key on upc
// collapses duplicate enqueues from the same import. Failures are
// swallowed -- cache warming is best-effort.
export async function enqueueCacheWarm(
  upcs: string[],
  source = 'import',
): Promise<{ enqueued: number }> {
  if (upcs.length === 0) return { enqueued: 0 };

  const seen = new Set<string>();
  const rows: Array<{ upc: string; source: string }> = [];
  for (const raw of upcs) {
    const upc = String(raw).replace(/[^0-9]/g, '');
    if (!upc || seen.has(upc)) continue;
    seen.add(upc);
    rows.push({ upc, source });
  }
  if (rows.length === 0) return { enqueued: 0 };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('product_cache_warm_jobs')
    .upsert(rows, { onConflict: 'upc', ignoreDuplicates: true });
  if (error) {
    console.warn('[cache-warm] enqueue failed:', error.message);
    return { enqueued: 0 };
  }
  return { enqueued: rows.length };
}
