// #825 — `?next=` must be validated at every consumption boundary, not only
// when the gate builds its redirect. A direct onboarding URL, a stale query
// string or a crafted signup link otherwise reaches `redirect()`,
// `router.push()` or `new URL(next, req.url)` unchecked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  onboardingEntryHref,
  paymentMethodHref,
  postOnboardingHref,
  safeInternalPath,
  safePostAuthPath,
} from '@/lib/bidder-onboarding-gate';

const state = vi.hoisted(() => ({
  user: { id: 'bidder-1' } as { id: string } | null,
  bidder: null as Record<string, unknown> | null,
  paymentsDisabled: false,
  exchangeError: null as { message: string } | null,
  operator: null as { operator_id: string } | null,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw { redirectTo: url };
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.bidder }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/payments-mode', () => ({
  isPaymentsDisabled: async () => state.paymentsDisabled,
}));
vi.mock('@/lib/posthog-events', () => ({
  captureBidderOnboarded: vi.fn(),
  captureCardSaved: vi.fn(),
}));
vi.mock('@/lib/supabase-browser', () => ({ getSupabaseBrowser: () => ({}) }));
vi.mock('next/server', () => ({
  NextResponse: {
    redirect: (url: URL) => ({ redirectUrl: url.toString() }),
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: state.exchangeError }),
      getUser: async () => ({ data: { user: state.user } }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === 'operator_users' ? state.operator : state.bidder,
          }),
        }),
      }),
    }),
  }),
}));

import BidderOnboardingPage from '../page';
import BidderPaymentMethodPage from '../payment-method/page';
import { GET as authCallback } from '../../../auth/callback/route';

async function redirectTarget(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (err) {
    return (err as { redirectTo?: string }).redirectTo ?? null;
  }
  return null;
}

function onboarding(next: string) {
  return redirectTarget(BidderOnboardingPage({ searchParams: Promise.resolve({ next }) }));
}

/** Run the real callback handler with the given decoded `next` value. */
async function callback(next: string | null): Promise<string> {
  const url = new URL('https://bingoauctions.com/auth/callback');
  url.searchParams.set('code', 'test-code');
  if (next !== null) url.searchParams.set('next', next);
  const res = (await authCallback({ url: url.toString() } as never)) as unknown as {
    redirectUrl: string;
  };
  return res.redirectUrl;
}

/** The `next` signup/Google/Apple put on the callback URL (encoded once). */
function signupCallbackNext(destination: string): string {
  return onboardingEntryHref(destination);
}

afterEach(() => {
  state.user = { id: 'bidder-1' };
  state.bidder = null;
  state.paymentsDisabled = false;
  state.exchangeError = null;
  state.operator = null;
});

describe('safeInternalPath escapes', () => {
  it('rejects external, protocol-relative and scheme destinations', () => {
    for (const raw of [
      'https://evil.example/x',
      '//evil.example/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'browse',
    ]) {
      expect(safeInternalPath(raw), raw).toBeNull();
    }
  });

  it('rejects raw, single- and double-encoded backslash/host tricks', () => {
    for (const raw of [
      '/\\evil.example',
      '/%5Cevil.example',
      '/%255Cevil.example',
      '/%2F%2Fevil.example',
      '/%252F%252Fevil.example',
    ]) {
      expect(safeInternalPath(raw), raw).toBeNull();
    }
  });

  it('rejects malformed escapes and control characters', () => {
    for (const raw of ['/%E0%A4%A', '/path\nHX: 1', '/path\rX', '/x\u0000']) {
      expect(safeInternalPath(raw), raw).toBeNull();
    }
  });

  it('never bounces back into onboarding or auth, encoded or not', () => {
    for (const raw of [
      '/bidder/onboarding',
      '/bidder/onboarding?next=/lot/x',
      '/bidder/onboarding/payment-method',
      '/%62idder/onboarding',
      '/auth',
      '/auth/callback',
      '/%61uth/handoff',
    ]) {
      expect(safeInternalPath(raw), raw).toBeNull();
    }
  });

  it('keeps safe encoded query state unchanged', () => {
    expect(safeInternalPath('/lot/TEA-123?from=email&q=box%20of%20mugs')).toBe(
      '/lot/TEA-123?from=email&q=box%20of%20mugs',
    );
    expect(safeInternalPath('/browse?next=%2Flot%2FTEA-1')).toBe('/browse?next=%2Flot%2FTEA-1');
  });
});

describe('safePostAuthPath (callback next)', () => {
  it('accepts the onboarding wrapper and keeps its nested destination', () => {
    const destination = '/lot/TEA-1?from=email&q=box%20of%20mugs';
    const wrapper = signupCallbackNext(destination);
    expect(safePostAuthPath(wrapper)).toBe(wrapper);
    expect(new URL(safePostAuthPath(wrapper)!, 'https://x.local').searchParams.get('next')).toBe(
      destination,
    );
  });

  it('keeps a direct safe destination and encoded literal percent', () => {
    expect(safePostAuthPath('/lot/TEA-1?from=email')).toBe('/lot/TEA-1?from=email');
    expect(safePostAuthPath('/browse?q=100%25')).toBe('/browse?q=100%25');
  });

  it('rejects an unsafe nested destination in the wrapper', () => {
    for (const nested of [
      'https://evil.example/x',
      '//evil.example/x',
      'javascript:alert(1)',
      '/\\evil.example',
      '/%5Cevil.example',
      '/%255Cevil.example',
      '/%2F%2Fevil.example',
    ]) {
      expect(
        safePostAuthPath(`/bidder/onboarding?next=${encodeURIComponent(nested)}`),
        nested,
      ).toBeNull();
    }
  });

  it('rejects a nested onboarding/auth loop', () => {
    for (const nested of [
      '/bidder/onboarding',
      '/bidder/onboarding?next=/lot/TEA-1',
      '/bidder/onboarding/payment-method?next=/lot/TEA-1',
      '/auth/callback?next=/lot/TEA-1',
    ]) {
      expect(
        safePostAuthPath(`/bidder/onboarding?next=${encodeURIComponent(nested)}`),
        nested,
      ).toBeNull();
    }
  });

  it('rejects a duplicated next, other onboarding routes and loose input', () => {
    expect(safePostAuthPath('/bidder/onboarding?next=/lot/A&next=/lot/B')).toBeNull();
    expect(safePostAuthPath('/bidder/onboarding/payment-method?next=/lot/A')).toBeNull();
    expect(safePostAuthPath('bidder/onboarding?next=/lot/A')).toBeNull();
    expect(safePostAuthPath('/bidder/onboarding')).toBeNull();
    expect(safePostAuthPath(null)).toBeNull();
  });
});

describe('completion href helpers', () => {
  it('builds the signup → onboarding entry from a safe value only', () => {
    expect(onboardingEntryHref('/lot/TEA-1?from=email')).toBe(
      `/bidder/onboarding?next=${encodeURIComponent('/lot/TEA-1?from=email')}`,
    );
    expect(onboardingEntryHref('https://evil.example')).toBe('/bidder/onboarding');
    expect(onboardingEntryHref('//evil.example')).toBe('/bidder/onboarding');
  });

  it('builds the card-step href from a safe value only', () => {
    expect(paymentMethodHref('/lot/TEA-1')).toBe(
      `/bidder/onboarding/payment-method?next=${encodeURIComponent('/lot/TEA-1')}`,
    );
    expect(paymentMethodHref('https://evil.example')).toBe('/bidder/onboarding/payment-method');
  });

  it('completes to the safe deep link, /browse, or the card step', () => {
    expect(postOnboardingHref('/lot/TEA-1', true)).toBe('/lot/TEA-1');
    expect(postOnboardingHref('https://evil.example', true)).toBe('/browse');
    expect(postOnboardingHref(null, true)).toBe('/browse');
    expect(postOnboardingHref('/lot/TEA-1', false)).toBe(
      `/bidder/onboarding/payment-method?next=${encodeURIComponent('/lot/TEA-1')}`,
    );
    expect(postOnboardingHref('//evil.example', false)).toBe('/bidder/onboarding/payment-method');
  });
});

describe('onboarding page redirects', () => {
  it('ignores an external next for an already-onboarded bidder', async () => {
    state.bidder = {
      id: 'bidder-1',
      birth_date: '1990-01-01',
      default_payment_method_id: 'pm-1',
    };
    expect(await onboarding('https://evil.example/x')).toBe('/browse');
    expect(await onboarding('//evil.example/x')).toBe('/browse');
    expect(await onboarding('/bidder/onboarding')).toBe('/browse');
  });

  it('keeps a safe deep link for an already-onboarded bidder', async () => {
    state.bidder = {
      id: 'bidder-1',
      birth_date: '1990-01-01',
      default_payment_method_id: 'pm-1',
    };
    expect(await onboarding('/lot/TEA-1?from=email')).toBe('/lot/TEA-1?from=email');
  });

  it('never forwards an external next into the card step', async () => {
    state.bidder = {
      id: 'bidder-1',
      birth_date: '1990-01-01',
      default_payment_method_id: null,
    };
    expect(await onboarding('https://evil.example/x')).toBe('/bidder/onboarding/payment-method');
  });

  it('does not carry an external next back to signup when signed out', async () => {
    state.user = null;
    expect(await onboarding('https://evil.example/x')).toBe('/signup');
  });
});

describe('card step link resolves the deep link safely', () => {
  it('renders /browse for an external next', async () => {
    const previous = {
      app: process.env.SQUARE_APPLICATION_ID,
      loc: process.env.SQUARE_LOCATION_ID,
    };
    process.env.SQUARE_APPLICATION_ID = 'sandbox-app';
    process.env.SQUARE_LOCATION_ID = 'sandbox-location';
    state.bidder = {
      id: 'bidder-1',
      birth_date: '1990-01-01',
      default_payment_method_id: 'pm-1',
      card_brand: 'VISA',
      card_last4: '4242',
    };
    try {
      const el = await BidderPaymentMethodPage({
        searchParams: Promise.resolve({ next: 'https://evil.example/x' }),
      });
      const html = renderToString(el);
      expect(html).toContain('href="/browse"');
      expect(html).not.toContain('evil.example');
    } finally {
      if (previous.app === undefined) delete process.env.SQUARE_APPLICATION_ID;
      else process.env.SQUARE_APPLICATION_ID = previous.app;
      if (previous.loc === undefined) delete process.env.SQUARE_LOCATION_ID;
      else process.env.SQUARE_LOCATION_ID = previous.loc;
    }
  });
});

describe('every next consumption boundary validates', () => {
  const root = join(__dirname, '..', '..', '..', '..', '..');
  const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

  it('onboarding page and form validate at use', () => {
    const page = read('src', 'app', 'bidder', 'onboarding', 'page.tsx');
    expect(page).toContain('safeInternalPath(rawNext)');
    expect(page).toContain('completedOnboardingHref(next)');
    expect(page).toContain('paymentMethodHref(next)');

    const form = read('src', 'app', 'bidder', 'onboarding', 'OnboardingForm.tsx');
    expect(form).toContain('postOnboardingHref(nextHref, paymentsDisabled)');
    expect(form).not.toMatch(/router\.push\(nextHref/);
  });

  it('card step validates at page and at submit', () => {
    const page = read('src', 'app', 'bidder', 'onboarding', 'payment-method', 'page.tsx');
    expect(page).toContain('safeInternalPath(rawNext)');

    const form = read('src', 'app', 'bidder', 'onboarding', 'payment-method', 'SquareCardForm.tsx');
    expect(form).toContain('completedOnboardingHref(nextHref)');
    expect(form).not.toMatch(/router\.push\(nextHref/);
  });

  it('signup, auth callback and handoff validate before forwarding', () => {
    const signup = read('src', 'app', 'signup', 'SignupFormClient.tsx');
    expect(signup).toContain('onboardingEntryHref(queryNext)');

    const callback = read('src', 'app', 'auth', 'callback', 'route.ts');
    expect(callback).toContain("safePostAuthPath(url.searchParams.get('next'))");
    expect(callback).not.toMatch(/new URL\(url\.searchParams\.get\('next'\)/);

    const handoff = read('src', 'app', 'auth', 'handoff', 'page.tsx');
    expect(handoff).toContain("safeInternalPath(params.get('next')) ?? DEFAULT_NEXT");

    const login = read('src', 'app', '(auth)', 'login', 'LoginFormClient.tsx');
    expect(login).toContain("safePostAuthPath(params.get('next'))");
    expect(login).toContain('router.push(safeNext)');
    expect(login).not.toMatch(/params\.get\('next'\)[^\n]*router\.push/);
  });
});

describe('signup callback lands on the intended destination', () => {
  const destination = '/lot/TEA-1?from=email&q=box%20of%20mugs';
  const wrapper = signupCallbackNext(destination);

  function callbackPath(location: string): string {
    const url = new URL(location);
    return `${url.pathname}${url.search}`;
  }

  it('email, Google and Apple callback URLs carry the same validated wrapper', () => {
    // Email signup builds the URL as a string; Google/Apple use URLSearchParams.
    const emailInput = new URL(
      `https://bingoauctions.com/auth/callback?next=${encodeURIComponent(wrapper)}`,
    ).searchParams.get('next');
    const oauthUrl = new URL('/auth/callback', 'https://bingoauctions.com');
    oauthUrl.searchParams.set('next', wrapper);
    const oauthInput = oauthUrl.searchParams.get('next');

    expect(emailInput).toBe(wrapper);
    expect(oauthInput).toBe(wrapper);
    for (const input of [emailInput, oauthInput]) {
      expect(safePostAuthPath(input)).toBe(wrapper);
      expect(new URL(safePostAuthPath(input)!, 'https://x.local').searchParams.get('next')).toBe(
        destination,
      );
    }
  });

  it('new bidder reaches the wrapper and keeps the destination on both paths', async () => {
    state.bidder = null;
    expect(callbackPath(await callback(wrapper))).toBe(wrapper);

    state.paymentsDisabled = true;
    expect(await onboarding(destination)).toBeNull(); // form, not a redirect
    expect(postOnboardingHref(destination, true)).toBe(destination);

    state.paymentsDisabled = false;
    expect(await onboarding(destination)).toBeNull(); // form, not a redirect
    expect(postOnboardingHref(destination, false)).toBe(paymentMethodHref(destination));
  });

  it('partial bidder (DOB, no card) keeps the destination on both paths', async () => {
    state.bidder = { id: 'bidder-1', birth_date: '1990-01-01', default_payment_method_id: null };
    expect(callbackPath(await callback(wrapper))).toBe(wrapper);

    state.paymentsDisabled = false;
    expect(await onboarding(destination)).toBe(paymentMethodHref(destination));

    state.paymentsDisabled = true;
    expect(await onboarding(destination)).toBe(destination);
  });

  it('completed bidder keeps the destination', async () => {
    state.bidder = {
      id: 'bidder-1',
      birth_date: '1990-01-01',
      default_payment_method_id: 'pm-1',
    };
    expect(callbackPath(await callback(wrapper))).toBe(wrapper);
    expect(await onboarding(destination)).toBe(destination);
  });

  it('drops an unsafe or looping wrapper and routes by role', async () => {
    state.bidder = null;
    for (const unsafe of [
      '/bidder/onboarding?next=%2F%2Fevil.example',
      '/bidder/onboarding?next=%2Fbidder%2Fonboarding',
      '/bidder/onboarding?next=/lot/A&next=/lot/B',
    ]) {
      expect(callbackPath(await callback(unsafe)), unsafe).toBe('/bidder/onboarding');
    }

    state.operator = { operator_id: 'op-1' };
    expect(callbackPath(await callback('/bidder/onboarding?next=https%3A%2F%2Fevil.example'))).toBe(
      '/dashboard',
    );
  });

  it('keeps encoded literal percent exactly once through the callback', async () => {
    const literal = '/browse?q=100%25';
    const landed = callbackPath(await callback(signupCallbackNext(literal)));
    expect(landed).toBe(signupCallbackNext(literal));
    expect(new URL(landed, 'https://x.local').searchParams.get('next')).toBe(literal);
  });
});
