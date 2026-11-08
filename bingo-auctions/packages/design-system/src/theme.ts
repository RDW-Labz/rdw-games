// Theme tokens for BinGo Auctions. Brand palette taken from the company
// logo (matches the web: apps/operator-web/src/app/globals.css :root):
// deep NAVY base (the logo field), ORANGE for live/active state + the "bid"
// CTA (the logo's up-right arrow), CYAN for links/secondary (the "AUCTIONS"
// wordmark), amber for "you're winning", red for closing-soon urgency,
// green only for confirmation moments.
//
// Auctions are an attention-economy product. Color is doing real work
// here: it tells the bidder *at a glance* whether to look — orange says
// "act now," cyan says "explore," on a calm navy ground.
//
// This module is React-Native-free — it only exports primitive values,
// types, and pure helpers. Apps and packages on either side of the
// monorepo (bidder-mobile, field-mobile, eventually operator-web mobile
// surfaces) can consume it with no runtime cost.

export const colors = {
  // Surfaces — deep NAVY ground (the logo field) so orange + cyan pop.
  // Mirrors the web brand tokens in apps/operator-web/src/app/globals.css :root.
  bg: '#15233a',
  surface: '#1c2e49',
  surfaceAlt: '#18283f',
  surfaceHi: '#243a5c',
  border: '#2b3f5e',
  borderHot: '#3a527d',

  // Text — near-white on navy.
  text: '#e9eff7',
  textMuted: '#9fb1c8',
  textDim: '#6f829c',

  // Brand / state
  primary: '#f6911e', // BinGo ORANGE — live, action, the "bid" CTA (logo arrow)
  primaryHi: '#ffa53a',
  primaryDim: 'rgba(246, 145, 30, 0.15)',

  // Cyan — the "AUCTIONS" wordmark color; links + secondary accents.
  cyan: '#2ba9cb',
  cyanHi: '#45c2e2',
  cyanDim: 'rgba(43, 169, 203, 0.16)',

  winning: '#f0b429', // amber — you're the high bidder
  winningHi: '#f7c948',
  winningDim: 'rgba(240, 180, 41, 0.18)',

  danger: '#ff5a5f', // red — closing-soon, outbid, lost (pops on navy)
  dangerHi: '#ff7a7e',
  dangerDim: 'rgba(255, 90, 95, 0.18)',

  success: '#2ecc71', // green — paid, picked-up, confirmed
  successDim: 'rgba(46, 204, 113, 0.18)',
} as const;

// Typography helpers. Display/label faces use the brand font Plus Jakarta Sans
// (matches the web), embedded natively per app via the expo-font config plugin
// (apps/*/app.config.ts → ./assets/fonts/PlusJakartaSans_*.ttf). fontWeight is
// kept as a graceful fallback: if a face is somehow unregistered, iOS falls
// back to the system font at that weight rather than rendering wrong. Body text
// (plain Text without these tokens) stays on the system stack on purpose —
// applying a single fontFamily globally would flatten per-Text fontWeight,
// since RN custom fonts don't synthesize weights.
export const type = {
  display: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontWeight: '900' as const,
    letterSpacing: -0.5,
  },
  displayHero: {
    fontFamily: 'PlusJakartaSans_800ExtraBold',
    fontWeight: '900' as const,
    letterSpacing: -1,
  },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontWeight: '700' as const,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  },
} as const;

// Heat / urgency from time-to-close. Closing-soon is the single highest
// engagement lever in any auction app — drives the last-minute bidding
// frenzy. We tier into three states and let the UI flash on the urgent
// tier (handled by callers via a useFlash hook or RN Animated).
export type Heat = 'urgent' | 'closing' | 'live' | 'scheduled' | 'closed';

export function heatFromCloseAt(closeAtIso: string, status: string): Heat {
  // Terminal states. The lots table emits 'won' / 'unsold' (not 'closed')
  // when an auction completes; the older 'closed' literal is kept so
  // callers passing a generic string still resolve correctly.
  if (status === 'won' || status === 'unsold' || status === 'closed') return 'closed';
  const remaining = new Date(closeAtIso).getTime() - Date.now();
  if (remaining <= 0) return 'closed';
  if (remaining < 2 * 60_000) return 'urgent'; // < 2 min — red flash
  if (remaining < 30 * 60_000) return 'closing'; // < 30 min — orange
  if (status === 'live') return 'live'; // open but not closing soon
  return 'scheduled';
}

export function heatColor(heat: Heat): string {
  switch (heat) {
    case 'urgent':
      return colors.danger;
    case 'closing':
      return colors.primary;
    case 'live':
      return colors.success;
    case 'scheduled':
      return colors.textMuted;
    case 'closed':
      return colors.textDim;
  }
}

// Human countdown — "1:42" mm:ss when < 1h, "2h 14m" when < 1d, "3d 4h"
// otherwise. Tight to fit on a card label.
export function formatCountdown(closeAtIso: string): string {
  const remaining = new Date(closeAtIso).getTime() - Date.now();
  if (remaining <= 0) return 'Closed';
  const totalSec = Math.floor(remaining / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `0:${String(seconds).padStart(2, '0')}`;
}
