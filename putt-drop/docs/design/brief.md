# Putt Drop — Product Design Brief

Putt Drop by RDW Labz: premium portrait mini golf for phones. One thumb, touch only, works fully offline. Phaser 4 + TypeScript, wrapped with Capacitor, Android first, iPhone later (TestFlight). Logical canvas 360x640 rendered at device pixel ratio. All art and sound generated in code. Free download; holes 1-12 free; one in-app purchase, "Unlock full game" (about $2.99), opens the rest. No ads, no analytics, no accounts, no data collected.

## 1. Player

Casual phone players, 13+, short sessions of 1-5 minutes. They want a satisfying, fair, beautiful game with no ads, and buy once if the free holes feel premium. Success test: within 3 seconds of first launch the player thinks "this is a real, polished game", understands how to putt without reading, and wants to keep playing into the paid holes.

## 2. Core loop

1. Aim: drag back from the ball; aim line and power meter.
2. Putt.
3. Ball rolls: walls, bumpers, sand, water, slopes, moving gates.
4. Drop in the cup.
5. Result card: strokes vs par, stars.
6. Next hole.

Progress saved on device. Stars per hole: 3 = under par, 2 = par, 1 = finished. Optional assist after repeated struggles shows a longer aim preview.

## 3. The free -> paid moment

After hole 12: an honest unlock screen with what you get, the price from the store, Restore purchases, and a clear way to keep replaying free holes. No dark patterns, no countdowns, no fake discounts.

## 4. Screens and states in scope

| Screen/state | Purpose | Primary action |
|---|---|---|
| Boot/loading | First render before play | Auto-advance to menu |
| Menu (first run, with progress) | Home; show saved progress | Start or continue |
| Hole select | Unlocked, locked, completed with stars, full-game panel | Pick a hole |
| Settings | Sound, music, vibration, reduced motion, colorblind-safe aim colors | Toggle options |
| Reset-confirm sheet | Guard destructive reset | Confirm or cancel |
| Pause sheet | Stop mid-hole | Resume |
| First-time hint (ghost hand) | Teach drag-back aim without reading | Play to dismiss |
| In-game HUD | Hole number, par, strokes | Read state |
| Aim line + power | Show aim direction and strength | Drag back, release to putt |
| Course rendering | Turf, walls, hazards, cup, ball | Play the hole |
| Hole-complete result card + celebration | Strokes vs par, stars | Continue to next hole |
| Last free hole -> unlock screen | Honest offer after hole 12 | Buy, or keep replaying free holes |
| Unlock success | Confirm full game | Start paid holes |
| Restore purchases result | Recover a prior purchase | Acknowledge |
| Empty/first run | No progress yet | Start hole 1 |
| Offline | Normal state; the game never needs a network | Play |
| Error states | Purchase failed or cancelled, save failed | Retry or continue |

## 5. Signature moments

The putt: the player must feel in control and the game must feel real — drag back, read the aim line and power meter, release, and the course answers honestly through walls, bumpers, sand, water, slopes, and moving gates.

The hole-complete celebration: the player must feel the reward — result card with strokes vs par and stars, fast, never blocking input, then straight to the next hole.

## 6. Design principles

- Flow beats flair.
- Main action in the bottom-third thumb zone.
- Tap targets 48 px or more.
- Rounded shapes, pill buttons, gradients separating panels from background, one characterful display font.
- Motion is fast (under 300 ms for screen changes), never blocks input, and has a reduced-motion version.

---
Draft by Hermes (dev2), reviewed by the orchestrator 2026-10-12. Settings items "reduced motion" and "colorblind-safe aim colors" and the unlock/hint/error states are targets of the 2026-10-12 UI upgrade, not yet built.
