// Supabase client for Expo apps. AsyncStorage persists the session
// across app restarts. The url-polyfill import is required for fetch()
// to work reliably on React Native.
//
// Mobile-only: this module imports React-Native + Expo APIs. Web (SSR)
// consumers in operator-web/ have their own browser/server-aware
// supabase client and should NOT import from here.

import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

// Expo loads EXPO_PUBLIC_* env vars at build time; both bidder-mobile
// and field-mobile point at the same Supabase project, so the same
// env-var names work for both.
const supabaseUrl = process.env['EXPO_PUBLIC_SUPABASE_URL'];
const supabaseAnonKey = process.env['EXPO_PUBLIC_SUPABASE_ANON_KEY'];

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.',
  );
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: {
    fetch: (...args) => ((globalThis as { __bingoFetch?: typeof fetch }).__bingoFetch ?? fetch)(...args),
  },
});

// React Native requires manually gating the auth auto-refresh timer on app
// foreground/background (per supabase-js RN guidance). `autoRefreshToken: true`
// alone is NOT enough on RN: while the app is backgrounded the timer is
// suspended, so on resume the first query / realtime socket can ride a stale
// (expiring/expired) access token. That was a root cause of "bidding needs a
// force-close after the app was backgrounded" — the lot screen's realtime
// UPDATE subscription + bid mutations failed RLS against a dead token and never
// recovered until a full remount. Start on 'active', stop otherwise.
// Registered once at module load — the client is a singleton shared by both
// mobile apps; operator-web has its own browser/server client and does not
// import this module.
/** Refresh only when the access token is actually spent, and never twice at
 *  once.
 *
 *  2026-08-05 (intermittent "app randomly shows Sign In"): the resume handler
 *  below used to call `supabase.auth.refreshSession()` unconditionally on every
 *  foreground. Two problems compounded:
 *
 *   1. Supabase ROTATES the refresh token on every refresh. Staff foreground
 *      this app dozens of times a shift (camera, scanner, app-switch), so an
 *      unconditional call burned a rotation each time for no benefit — the
 *      token is usually nowhere near expiry and `startAutoRefresh()` already
 *      refreshes the ones that are.
 *   2. Nothing serialized refreshes. This resume call, `getFreshAccessToken()`
 *      (field-mobile/lib/fresh-token.ts) and the SIGNED_OUT recovery in
 *      session.ts could all be in flight together. Whichever lands second
 *      presents an already-rotated token and gets 400 "Invalid Refresh Token:
 *      Already Used" — which is a DEFINITIVE (not transient) error, so
 *      session.ts nulls the session and the user lands on Sign In having done
 *      nothing wrong. Then they sign in, it works, and it happens again on some
 *      later resume: exactly the reported intermittent pattern.
 *
 *  So: skip the refresh when the token still has real life left, and collapse
 *  concurrent callers onto ONE in-flight request. Both make rotation rarer,
 *  which is what removes the race. Callers still get a usable token back. */
/** The signed-in user's id, read from the LOCAL persisted session.
 *
 *  Use this instead of `supabase.auth.getUser()` anywhere the id is only being
 *  used to scope a query ("which rows are mine"). getUser() is a network call
 *  to /auth/v1/user; in a warehouse dead-spot it returns {user: null} and the
 *  screen renders an empty list. 2026-08-06: a customer who had won, been
 *  auto-charged, and had a paid invoice in the database was shown no invoice
 *  and no pickup, because the pickup tab's getUser() blipped and it did
 *  `setRows([])`. getSession() reads AsyncStorage and cannot fail that way. */
export async function getCurrentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.user?.id ?? null;
}

const REFRESH_MARGIN_MS = 120_000;

export type RefreshOutcome = {
  /** The live session after the call, or null if there is genuinely none. */
  session: Session | null;
  /** Whatever supabase-js returned. Callers that must distinguish a revoked
   *  refresh token from a network blip (session.ts) read this. */
  error: unknown;
};

let inFlightRefresh: Promise<RefreshOutcome> | null = null;

export function refreshSessionIfNeeded(force = false): Promise<RefreshOutcome> {
  // Collapse concurrent callers. A second caller joining an in-flight refresh
  // gets that refresh's result rather than starting a rotation of its own.
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async (): Promise<RefreshOutcome> => {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return { session: null, error: null };
    const expiresAtMs = (session.expires_at ?? 0) * 1000;
    if (!force && expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return { session, error: null };
    }
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    return { session: refreshed.session ?? session, error: error ?? null };
  })()
    .catch((error: unknown) => ({ session: null, error }))
    .finally(() => {
      inFlightRefresh = null;
    }) as Promise<RefreshOutcome>;
  return inFlightRefresh;
}

AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh();
    // Top the token up BEFORE the first query / realtime socket uses it —
    // autoRefresh is suspended while backgrounded, so on resume the access
    // token can already be stale and a stale token hitting RLS was what
    // bounced people to /login. Guarded + deduped per the note above.
    void refreshSessionIfNeeded();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
});
