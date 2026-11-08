// Pure async helper that drives the iOS Share Extension flow.
//
// Split from (staff)/_layout.tsx so the scrape-and-route logic is
// testable in Jest without a running React Native runtime. The layout's
// useShareIntent hook reads the result and pattern-matches on `action`.
//
// Flow:
//   1. Get the supabase access token via params.getToken
//      (the layout passes a closure that reads from the supabase client)
//   2. POST the URL to /api/lottr/scrape-url with Bearer auth
//   3. Return a discriminated result the layout uses to navigate

import { fetchWithTimeout } from '@/lib/fetch-with-timeout';

export type ShareIntentResult =
  | {
      action: 'navigate';
      pathname: string;
      params: Record<string, string>;
    }
  | {
      action: 'fallback';
      pathname: string;
      params: Record<string, string>;
    }
  | { action: 'unauthenticated' }
  | { action: 'invalid_url' };

export type ShareIntentParams = {
  url: string;
  /** Returns the current Supabase access token, or null when signed out. */
  getToken: () => Promise<string | null>;
  /** Operator-web API base URL. Defaults to https://bingoauctions.com when
   *  EXPO_PUBLIC_API_BASE_URL isn't set. */
  apiBase: string;
};

export async function handleShareIntent(
  params: ShareIntentParams,
): Promise<ShareIntentResult> {
  const { url, getToken, apiBase } = params;

  if (!url || !/^https?:\/\//i.test(url)) {
    return { action: 'invalid_url' };
  }

  const token = await getToken();
  if (!token) {
    return { action: 'unauthenticated' };
  }

  let json:
    | {
        ok: true;
        // The scrape-url API returns `host` (apps/operator-web/.../scrape-url/
        // route.ts:56), NOT `source`. Reading json.source left the param
        // undefined and dropped the host label on the review screen.
        host: string;
        data: Record<string, unknown>;
        warnings: string[];
      }
    | { ok: false; error: string };

  try {
    const res = await fetchWithTimeout(`${apiBase}/api/lottr/scrape-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url }),
    });
    json = (await res.json()) as typeof json;
  } catch (err) {
    return {
      action: 'fallback',
      pathname: '/lotting/web',
      params: {
        prefilledUrl: url,
        scrapeError: (err as Error).message?.slice(0, 200) ?? 'network_error',
      },
    };
  }

  if (!json.ok) {
    return {
      action: 'fallback',
      pathname: '/lotting/web',
      params: {
        prefilledUrl: url,
        scrapeError: json.error,
      },
    };
  }

  // W2-rest: import-review.tsx was deleted. All share-extension traffic
  // (including successful scrapes) now lands at /lotting/web so the
  // operator can review and create from there. Pass scraped data as
  // query params so web.tsx can pre-fill the form.
  return {
    action: 'navigate',
    pathname: '/lotting/web',
    params: {
      // B3: pass the host through under the key web.tsx reads (`host`).
      host: json.host,
      prefilledData: JSON.stringify(json.data),
      warnings: json.warnings.join(','),
      prefilledUrl: url,
    },
  };
}
