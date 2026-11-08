export const CONSOLE_UI_COOKIE = 'console_ui';

/** Routes where v2 is on by default. Add one only when Braden and Jared both approve that screen. */
export const V2_DEFAULT_ON_ROUTES: readonly string[] = [];

export function parseUiParam(search: string): 'v2' | 'v1' | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return null;
  const ui = new URLSearchParams(raw).get('ui');
  if (ui === 'v2') return 'v2';
  if (ui === 'v1') return 'v1';
  return null;
}

export function isConsoleV2(
  cookieValue: string | undefined | null,
  pathname?: string,
): boolean {
  if (cookieValue === 'v1') return false;
  if (cookieValue === 'v2') return true;
  if (pathname) {
    const onDefault =
      V2_DEFAULT_ON_ROUTES.some(
        (p) => pathname === p || pathname.startsWith(`${p}/`),
      );
    if (onDefault) return true;
  }
  return false;
}

export function cookieHeaderFor(choice: 'v2' | 'v1', secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  // v1 is stored, not cleared: once a screen is default-on, "Switch back" must
  // still keep that browser on v1.
  return `${CONSOLE_UI_COOKIE}=${choice}; Path=/; Max-Age=31536000; SameSite=Lax${securePart}`;
}

export function stripUiParam(href: string): string {
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(href);
  const base = 'http://local.invalid';
  const url = hasProtocol ? new URL(href) : new URL(href, base);
  const emptyHash = href.includes('#') && url.hash === '';
  url.searchParams.delete('ui');
  const qs = url.searchParams.toString();
  const search = qs ? `?${qs}` : '';
  const hash = emptyHash ? '#' : url.hash;
  const pathAndRest = `${url.pathname}${search}${hash}`;
  if (hasProtocol) {
    return `${url.origin}${pathAndRest}`;
  }
  return pathAndRest;
}
