// Tests for the OTA auto-reload decision (WORKING_AGREEMENT §7c).
//
// The hook itself needs AppState and a native module, so it cannot be unit
// tested. Everything that DECIDES lives in ota-auto-reload.ts precisely so the
// policy is covered here.
//
// The negative cases matter more than the positive one: this feature restarts
// the app under a live user, and the two blocked routes are the cases where a
// reload corrupts an in-flight mechanism rather than interrupting a screen.

import { describe, it, expect } from 'vitest';
import {
  shouldReload,
  isRouteBlocked,
  RELOAD_BLOCKED_ROUTES,
  type ReloadDecisionInput,
} from './ota-auto-reload';

/** All five conditions satisfied; each test negates exactly one. */
const GO: ReloadDecisionInput = {
  isUpdatePending: true,
  route: '(tabs)/index',
  returningToForeground: true,
  alreadyReloaded: false,
};

describe('shouldReload — the happy path', () => {
  it('reloads on return to foreground when an update is pending', () => {
    expect(shouldReload(GO)).toBe(true);
  });

  it('reloads on the bidding surfaces — owner call 2026-09-16, no allowlist', () => {
    // place_bid is server-side atomic: a reload mid-bid costs the confirmation
    // UI, not the bid. If this ever starts failing, someone has reintroduced an
    // allowlist without the product decision that removed it.
    for (const route of ['(tabs)/index', '(tabs)/my-bids', '(tabs)/watchlist', 'lot/[id]']) {
      expect(shouldReload({ ...GO, route })).toBe(true);
    }
  });

  it('reloads on the AppState-refetch screens that are NOT blocked', () => {
    // (tabs)/pickup and lot/[id] listen to AppState to refetch. A reload
    // remounts them and they refetch anyway — same outcome, so they stay in.
    for (const route of ['(tabs)/pickup', 'pickup/[id]', 'lot/[id]']) {
      expect(shouldReload({ ...GO, route })).toBe(true);
    }
  });
});

describe('shouldReload — each condition blocks on its own', () => {
  it('does not reload when no update is pending', () => {
    expect(shouldReload({ ...GO, isUpdatePending: false })).toBe(false);
  });

  it('does not reload while the app stays in the foreground', () => {
    // Mid-session reloads are the thing this design exists to avoid: the user
    // is looking at the screen.
    expect(shouldReload({ ...GO, returningToForeground: false })).toBe(false);
  });

  it('does not reload twice in one process (loop guard)', () => {
    expect(shouldReload({ ...GO, alreadyReloaded: true })).toBe(false);
  });
});

describe('shouldReload — the two hard exclusions', () => {
  it('never reloads on pickup-pass: the QR is being scanned at the counter', () => {
    expect(shouldReload({ ...GO, route: 'pickup-pass' })).toBe(false);
  });

  it('never reloads on the Square card-save resume screens', () => {
    // These use the SAME AppState 'active' edge we trigger on, to reconcile a
    // WebBrowser handoff. Reloading kills the pending state they came back for.
    expect(shouldReload({ ...GO, route: 'profile/payment-method' })).toBe(false);
    expect(shouldReload({ ...GO, route: 'verify-card' })).toBe(false);
  });

  it('blocks every route in the exclusion list, whatever it is set to', () => {
    for (const route of RELOAD_BLOCKED_ROUTES) {
      expect(shouldReload({ ...GO, route })).toBe(false);
    }
  });

  it('blocks nested routes under a blocked screen', () => {
    // A future verify-card/confirm must inherit the exclusion, not escape it.
    expect(isRouteBlocked('verify-card/confirm')).toBe(true);
    expect(isRouteBlocked('profile/payment-method/add')).toBe(true);
  });

  it('does not block a route that merely shares a prefix string', () => {
    // 'verify-card-help' is a different screen; prefix matching must be on the
    // path separator, not raw string startsWith.
    expect(isRouteBlocked('verify-card-help')).toBe(false);
    expect(isRouteBlocked('profile/payment-methods-faq')).toBe(false);
  });
});
