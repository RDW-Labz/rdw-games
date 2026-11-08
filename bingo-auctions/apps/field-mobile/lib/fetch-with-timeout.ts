// Staff-app fetch wrapper: every outbound HTTP call gets a bounded wait so
// dead wifi ends in a clear error instead of a frozen screen. Wired into
// Supabase via globalThis.__bingoFetch (see app/_layout.tsx) and used for
// direct operator-web /api/* calls.

export const TIMEOUT_SUPABASE_MS = 12_000;
export const TIMEOUT_LOTTR_MS = 20_000;
export const TIMEOUT_SLOW_MS = 60_000;

const LOTTR_AI_PATH =
  /\/api\/lottr\/(?:scan-photo|identify-photo|shelf-scan|scrape-url|search-keyword)(?:\/|$|\?)/i;

function supabaseHost(): string | null {
  const raw = process.env['EXPO_PUBLIC_SUPABASE_URL'];
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

/** Pick a timeout from the request URL (exported for unit tests). */
export function timeoutMsForUrl(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return TIMEOUT_SUPABASE_MS;
  }

  const path = parsed.pathname;

  if (LOTTR_AI_PATH.test(`${path}${parsed.search}`) || LOTTR_AI_PATH.test(url)) {
    return TIMEOUT_SLOW_MS;
  }
  if (path.includes('/api/lottr/') || url.includes('/api/lottr/')) {
    return TIMEOUT_LOTTR_MS;
  }

  const sbHost = supabaseHost();
  const isSupabase =
    (sbHost && parsed.host === sbHost) ||
    path.startsWith('/rest/v1/') ||
    path.startsWith('/auth/v1/') ||
    path.startsWith('/storage/v1/');

  if (isSupabase) {
    if (path.includes('/storage/v1/object')) {
      return TIMEOUT_SLOW_MS;
    }
    return TIMEOUT_SUPABASE_MS;
  }

  if (path.startsWith('/api/') || url.includes('/api/')) {
    return TIMEOUT_LOTTR_MS;
  }

  return TIMEOUT_SUPABASE_MS;
}

function timeoutErrorMessage(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  return `network timeout after ${seconds} s`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Drop-in fetch() replacement: AbortController timeout by URL class, plus
 * optional caller AbortSignal (whichever fires first wins).
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input);
  const timeoutMs = timeoutMsForUrl(url);
  const controller = new AbortController();
  const external = init?.signal;

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onExternalAbort);
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const underlying = fetch;
    return await underlying(input, { ...init, signal: controller.signal });
  } catch (err) {
    const timedOut = controller.signal.aborted && !(external?.aborted ?? false);
    if (timedOut) {
      throw new Error(timeoutErrorMessage(timeoutMs));
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) {
      external.removeEventListener('abort', onExternalAbort);
    }
  }
}
