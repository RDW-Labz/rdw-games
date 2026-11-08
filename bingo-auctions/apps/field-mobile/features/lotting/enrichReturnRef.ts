// enrichReturnRef.ts
//
// One-shot handoff for the QuickLot "web lookup for missing data" ENRICH flow.
//
// During QuickLot the item being reviewed isn't a saved lot yet (create-on-
// Save). Tapping "web lookup for missing data" navigates to /lotting/web in
// `mode=enrich`; instead of creating a NEW lot, that screen stashes the
// scraped/edited fields here and pops back. QuickLot reads + clears this on
// re-focus and merges the data into the review candidate — so the operator
// saves exactly ONE lot (no duplicate, no extra sticker prompt).
//
// A bare module-level ref (not React state / context) is deliberate: only one
// web-lookup round-trip is ever in flight, the value must survive the screen
// pop without re-render coupling, and it must never serialise to AsyncStorage.
// The consumer (quick.tsx) read-and-clears it in a useFocusEffect so a stale
// payload can never be applied twice.

import type { DefaultCondition } from './SessionContext';

export type EnrichPayload = {
  title: string;
  msrpDollars: string;
  /** Primary hero image from the scrape (may be empty). */
  photoUrl: string;
  /** Additional scraped images beyond the hero. */
  extraPhotoUrls: string[];
  description: string;
  condition: DefaultCondition;
};

export const enrichReturnRef: { current: EnrichPayload | null } = { current: null };
