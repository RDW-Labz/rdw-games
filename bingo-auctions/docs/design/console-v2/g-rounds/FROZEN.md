# Mockup G "Nightshift" — FROZEN after round 7 (2026-10-12)

Frozen file: `docs/design/console-v2/directions/g-nightshift.html` — sha256 `a861ed81ad7b41c2…`, 176639 bytes. Do not edit; slices implement from it.
Final captures: `g-rounds/round-7/` (dashboard / lot / pickups at 1440 and 1024, 6-frame entry strip, reduced-motion capture, report.json).
Before: `g-rounds/round-0/baseline/` (today's live console) and `g-rounds/round-0/` (mockup at round 0).

## Locked decisions
- Fonts: Syne (display: headings, stage titles, brand, metric numbers) + Atkinson Hyperlegible (body and ALL operational codes, 700). OFL 1.1.
- Palette: navy base (Braden 2026-10-13, option A; replaced the violet base — values in `globals.css` `[data-console-v2]` token block); stage hues Intake teal, Lotting amber, Auction coral, Paid green, Pickup lime; ONE primary colour (lime); status pills by meaning — Paid green, Checked in teal, Unpaid amber, Refunded grey.
- Surfaces: page darkest → rail lifted → cards lifted with a top-edge gradient; section header bands navy one step up, titles in the stage hue.
- Floor story: dashboard = "Needs attention", urgent-first, first card carries count + one lime action; lot/pickups = numbered, connected "Floor story" in workflow order Intake → Pickup.
- Pickups: counter queue first; amber one-line strip "N missing items awaiting refund →" jumps to Missing items below the queues; header "Find customer" search.
- Motion: tokens 150/200/300 ms, springy lift/press, calm reveals; dashboard rows 40 ms apart (0–280 ms); one 600 ms urgent pulse; nothing loops; reduced motion fully static.

## Scores
| Round | Reviewer | Avg | DONE |
|---|---|---|---|
| 0 | Opus / sol | 6.0 / 5.9 | 8/10 |
| 1 | sol | 6.9 | 10/10 |
| 2 | sol | 7.6 | 10/10 |
| 3 | Opus | 7.1 | 10/10 |
| 4 | sol | 7.5 | 10/10 |
| 5 | sol | 7.8 | 10/10 |
| 6 | Opus | 7.1 | 10/10 |
| 7 | sol | 8.0 | 10/10 |
Round 7 sol: geometry 9 · depth 8 · type 9 · motion 5 · workflow 8 · colour 9 · hygiene 8 · product 8.

## Round 7 — reviewer PARTIALs checked in a browser (Claude, Playwright)
- #3 title offset and #6 amber-strip jump: VERIFIED. Clicking the strip lands "Missing items awaiting refund" at 128 px; sticky header ends at 112 px (top 16 + 96).
- #10 motion: VERIFIED. Next-to-close rows animate g-row-in with delays 0, 40 … 280 ms (200 ms each); urgent card ::after g-urgent-pulse 600 ms × 1 (delay 100 ms). The 6-frame strip doesn't show it; the motion score (5) reflects the capture, not the CSS. g-shimmer runs once.
- #1 header titles: REAL GAP — "The last seven days" and "Missing items" titles are Paid green; Braden's rule says sections without a stage use off-white.

## Carried into the slices (not fixed in the mockup)
- Neutral section titles → off-white ("The last seven days", "Missing items") — slice 2 / 4.
- dashboard-1024: Next to close before Decisions waiting — slice 2.
- pickups-1024: spacing between Mark complete / No-show / Forfeit without wrapping — slice 4.
- Motion must be judged by playing it in the real app (strip stills miss row stagger) — every slice's motion check.
