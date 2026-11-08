// Bridges domain-lotting's optional fetchHtml hook to the operator-web
// egress chain (Bright Data Web Unlocker → self-hosted Playwright relay).
//
// 2026-07-10 stock-image audit: domain-lotting's url-fetcher was doing raw
// Worker fetch()es that retailer WAFs bot-block (datacenter IP), capping
// scraped stock images at ~1.6% of lots — while this repo already had a
// working unblocked egress used by scrape-url and the ASIN resolver. Passing
// this function as LottingConfig.fetchHtml routes the stock-image and price
// page-fetches through the same chain. Null on miss/blocked/unconfigured so
// url-fetcher falls back to its direct fetch.

import { mirrorImageToStorage } from '@auction-platform/domain-lotting';
import { egressConfigured, fetchViaEgress } from '@/lib/scrape-egress';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export async function lottingFetchHtml(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  if (!egressConfigured()) return null;
  try {
    const r = await fetchViaEgress(url);
    if (r.kind !== 'ok' || !r.html) return null;
    return { html: r.html, finalUrl: r.finalUrl };
  } catch {
    return null;
  }
}

// LottingConfig.mirrorImage — lets image-enrich attach page-vouched images
// from hosts OUTSIDE the CDN allowlist by downloading them into the
// stock-images bucket (service-role client bypasses Storage RLS; the
// bucket is shared, content-addressed by SHA-256). allowAnyHttpsHost mode
// swaps the allowlist check for an SSRF guard + magic-byte sniff — see
// mirror-images.ts. Null on any failure so the candidate is just skipped.
export async function lottingMirrorImage(url: string): Promise<string | null> {
  try {
    return await mirrorImageToStorage(getSupabaseAdmin(), url, {
      allowAnyHttpsHost: true,
    });
  } catch {
    return null;
  }
}
