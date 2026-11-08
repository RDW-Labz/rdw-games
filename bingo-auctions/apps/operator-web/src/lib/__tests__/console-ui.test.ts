import { describe, it, expect } from 'vitest';
import {
  CONSOLE_UI_COOKIE,
  V2_DEFAULT_ON_ROUTES,
  parseUiParam,
  isConsoleV2,
  cookieHeaderFor,
  stripUiParam,
} from '@/lib/console-ui';

describe('parseUiParam', () => {
  it('returns v2 when ui=v2', () => {
    expect(parseUiParam('?ui=v2')).toBe('v2');
    expect(parseUiParam('ui=v2')).toBe('v2');
  });

  it('returns v1 when ui=v1', () => {
    expect(parseUiParam('?ui=v1')).toBe('v1');
  });

  it('returns null for garbage ui values', () => {
    expect(parseUiParam('?ui=v3')).toBeNull();
    expect(parseUiParam('?ui=')).toBeNull();
  });

  it('returns null when ui is absent', () => {
    expect(parseUiParam('')).toBeNull();
    expect(parseUiParam('?')).toBeNull();
    expect(parseUiParam('?foo=bar')).toBeNull();
  });

  it('reads ui among mixed params', () => {
    expect(parseUiParam('?foo=1&ui=v2&bar=2')).toBe('v2');
    expect(parseUiParam('?foo=1&ui=v1')).toBe('v1');
  });
});

describe('isConsoleV2', () => {
  it('is true when cookie is v2', () => {
    expect(isConsoleV2('v2')).toBe(true);
    expect(isConsoleV2('v2', '/dashboard')).toBe(true);
  });

  it('is false when cookie is absent and no default routes', () => {
    expect(isConsoleV2(undefined)).toBe(false);
    expect(isConsoleV2(null)).toBe(false);
    expect(isConsoleV2('')).toBe(false);
  });

  it('v1 cookie beats a default-on route', () => {
    const routes = V2_DEFAULT_ON_ROUTES as string[];
    routes.push('/design-system');
    expect(isConsoleV2('v1', '/design-system')).toBe(false);
    routes.pop();
  });

  it('is false for unrelated cookie values without default routes', () => {
    expect(isConsoleV2('legacy')).toBe(false);
  });
});

describe('cookieHeaderFor', () => {
  it('sets v2 cookie with one-year max-age', () => {
    expect(cookieHeaderFor('v2', false)).toBe(
      `${CONSOLE_UI_COOKIE}=v2; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
  });

  it('appends Secure when requested', () => {
    expect(cookieHeaderFor('v2', true)).toBe(
      `${CONSOLE_UI_COOKIE}=v2; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(cookieHeaderFor('v1', true)).toBe(
      `${CONSOLE_UI_COOKIE}=v1; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
  });

  it('stores v1 for a year so it beats future default-on routes', () => {
    expect(cookieHeaderFor('v1', false)).toBe(
      `${CONSOLE_UI_COOKIE}=v1; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
  });
});

describe('stripUiParam', () => {
  it('removes only ui and keeps other params', () => {
    expect(stripUiParam('/lots?ui=v2&foo=bar')).toBe('/lots?foo=bar');
  });

  it('keeps hash', () => {
    expect(stripUiParam('/x?ui=v2&a=1#section')).toBe('/x?a=1#section');
  });

  it('drops trailing ? when no params remain', () => {
    expect(stripUiParam('/dashboard?ui=v2')).toBe('/dashboard');
    expect(stripUiParam('/dashboard?ui=v2#')).toBe('/dashboard#');
  });

  it('handles absolute URLs', () => {
    expect(stripUiParam('https://ops.example.com/foo?ui=v1&x=1')).toBe(
      'https://ops.example.com/foo?x=1',
    );
  });
});

describe('V2_DEFAULT_ON_ROUTES', () => {
  it('is empty for launch (opt-in via cookie only)', () => {
    expect(V2_DEFAULT_ON_ROUTES).toEqual([]);
  });
});
