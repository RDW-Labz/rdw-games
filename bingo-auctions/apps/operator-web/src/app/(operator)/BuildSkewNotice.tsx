'use client';

/**
 * Tells the user the console has been redeployed under them, and offers a
 * reload. It never reloads on its own.
 *
 * THE PROBLEM (2026-09-15)
 * ────────────────────────
 * `wrangler deploy` replaces the Worker's `_next/static` assets wholesale.
 * A tab open from before the deploy keeps working until it needs a chunk it
 * has not already loaded — i.e. the next client-side navigation. Then the
 * chunk 404s, the route transition fails, and the console goes inert: the page
 * is still there, clicks do nothing. Staff run this as a standalone PWA on
 * warehouse tablets and leave it open for a whole shift, so every deploy
 * strands every open tablet. It was reported as "the auction builder glitches
 * out, we can't select any items" and read as a broken feature, not a stale
 * tab, which is what made it expensive to diagnose.
 *
 * WHY PROMPT AND NOT RELOAD
 * ─────────────────────────
 * The Auction Builder holds its selection in client state (a Set of lot ids,
 * see AuctionBuilder.tsx) and the import wizard holds more. A reload at the
 * wrong moment throws away work a person is in the middle of. The deploy is
 * never so urgent that it outranks that, so this asks. "Not now" is a real
 * option and comes back later rather than never.
 *
 * TWO SIGNALS
 * ───────────
 *   1. Poll /api/version. Pre-emptive: catches the skew before the user walks
 *      into it. Runs on an interval AND on wake/focus, because a shift tablet
 *      spends most of its time asleep — the moment someone picks it up is
 *      when the check is worth most, and an interval alone would not fire
 *      while the tab is hidden.
 *   2. Listen for chunk-load failures. The poll can still be beaten by a
 *      navigation seconds after a deploy, so when the failure actually
 *      happens, say so immediately instead of waiting for the next tick.
 *
 * Errors here are swallowed on purpose. A failed poll is a network blip, not
 * news; surfacing it would put a warning in front of staff for nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { isChunkLoadError, shouldPromptReload } from '@/lib/build-id';

/** How often to ask, while the tab is actually visible. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** How long "Not now" holds the notice back before it returns. */
const SNOOZE_MS = 30 * 60 * 1000;

/** A poll must not hang around for a wedged connection. */
const FETCH_TIMEOUT_MS = 10_000;

export function BuildSkewNotice({ pageBuild }: { pageBuild: string }) {
  // Set once we know this tab is stale. One-way: a deploy cannot un-happen,
  // and the only cure is a reload, which unmounts this anyway.
  const [stale, setStale] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Read inside effects without making them re-subscribe on every change.
  const staleRef = useRef(false);
  staleRef.current = stale;

  useEffect(() => {
    let cancelled = false;

    function markStale(): void {
      if (cancelled || staleRef.current) return;
      staleRef.current = true;
      setStale(true);
    }

    // ── Signal 1: poll ───────────────────────────────────────────────────
    async function check(): Promise<void> {
      if (cancelled || staleRef.current) return;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch('/api/version', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body: unknown = await res.json();
        const served =
          typeof body === 'object' && body !== null && 'build' in body
            ? (body as { build?: unknown }).build
            : null;
        if (typeof served !== 'string') return;
        if (shouldPromptReload(pageBuild, served)) markStale();
      } catch {
        // Offline, aborted, a 502 mid-deploy, malformed JSON — all of these
        // are "ask again later", none of them are worth telling anyone.
      } finally {
        clearTimeout(timer);
      }
    }

    // ── Signal 2: the failure itself ─────────────────────────────────────
    function onError(event: ErrorEvent): void {
      if (isChunkLoadError(event.error ?? event.message)) markStale();
    }
    function onRejection(event: PromiseRejectionEvent): void {
      if (isChunkLoadError(event.reason)) markStale();
    }

    // Checking on wake matters more than the interval: browsers throttle
    // timers in hidden tabs, so a tablet asleep since before the deploy may
    // not have ticked at all. This fires the moment someone picks it up.
    function onVisible(): void {
      if (document.visibilityState === 'visible') void check();
    }

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    void check();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [pageBuild]);

  // While snoozed, tick often enough to bring the notice back on time without
  // spinning a timer for the rest of the shift.
  useEffect(() => {
    if (!stale || snoozedUntil === 0) return;
    const remaining = snoozedUntil - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [stale, snoozedUntil]);

  if (!stale) return null;
  if (snoozedUntil > now) return null;

  return (
    <div
      role="status"
      // Deliberately NOT role="alert" and NOT focus-stealing. This can appear
      // while someone is taking payment at the counter; it must be readable
      // and ignorable, never something that interrupts a keystroke.
      aria-live="polite"
      style={{
        margin: '0 -2rem 1.5rem -2rem',
        padding: '0.85rem 2rem',
        background: 'rgba(80, 160, 255, 0.10)',
        borderBottom: '1px solid rgba(80, 160, 255, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
        fontSize: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
        <strong>The console has been updated</strong>
        {' — '}
        reload to pick up the new version. Until you do, parts of the app may
        stop responding when you move between pages.
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
        <button
          type="button"
          className="btn-primary"
          style={{ padding: '0.45rem 1rem', fontSize: 13, cursor: 'pointer' }}
          onClick={() => window.location.reload()}
        >
          Reload now
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '0.45rem 1rem', fontSize: 13, cursor: 'pointer' }}
          onClick={() => {
            const until = Date.now() + SNOOZE_MS;
            setSnoozedUntil(until);
            setNow(Date.now());
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
