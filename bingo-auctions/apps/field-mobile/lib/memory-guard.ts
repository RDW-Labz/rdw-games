// Shed memory the moment we lose the foreground.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// The watchdog (lib/session-watchdog.ts) answered the question that six weeks
// of guessing could not. Sixteen silent exits on 2026-08-20, and every single
// one says the same thing:
//
//   "process died while in the background (user had switched away)"
//
// Not one died in the foreground. Deaths land 0–40s after backgrounding, the
// relaunch is 1–5s later (the picker immediately reopening), and roughly half
// carry "unsaved lot draft present". Screens are spread across /lotting,
// /lotting/web, /lotting/photo, /worklist and even / — which rules out any one
// screen's code and points at the process's resident size instead.
//
// That is iOS jetsam: the OS reclaims the largest background process first.
// The app is only a candidate because of what it is still holding while
// nobody is looking at it.
//
// ── WHAT THIS RELEASES, AND WHY IT IS THE RIGHT THING ────────────────────────
// expo-image keeps DECODED bitmaps in a memory cache. A lotting session scrolls
// photo grids and holds hero shots and condition photos, so that cache is the
// single largest thing we control — and it is worth exactly nothing while the
// app is in the background.
//
// Clearing it on background trades a re-decode on return for a smaller
// footprint at the moment iOS is choosing what to kill. The disk cache is left
// alone, so nothing is re-downloaded: images come back from local storage,
// which costs milliseconds, against a kill that costs the picker their item.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// Not a guarantee. Jetsam is the OS's call, and a big enough app dies anyway.
// It reduces the odds; draft persistence (features/lotting/useDraftPersistence)
// is what makes the remaining kills survivable. The watchdog keeps counting, so
// the effect of this change is measurable rather than assumed: if the silent
// exits do not fall, the footprint is somewhere else and we look again.

import { AppState, type AppStateStatus } from 'react-native';
import { Image } from 'expo-image';

let installed = false;

export function installMemoryGuard(): void {
  if (installed) return;
  installed = true;

  AppState.addEventListener('change', (state: AppStateStatus) => {
    // 'inactive' is a transient state (control centre, incoming call, app
    // switcher) that usually returns to active within a second. Clearing there
    // would throw away the cache dozens of times a shift for nothing, so only
    // a real background transition triggers it.
    if (state !== 'background') return;
    try {
      // Fire-and-forget: this runs during the OS's backgrounding window, which
      // is short and must not be spent awaiting anything.
      void Image.clearMemoryCache();
    } catch {
      // Never let a memory optimisation become a crash. If the module changes
      // shape under us, the app simply keeps its cache.
    }
  });
}
