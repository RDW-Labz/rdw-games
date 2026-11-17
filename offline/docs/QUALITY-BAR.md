# Quality bar — how a title earns a slot

The collection's rule is "no filler to hit ten". This file turns that into something a reviewer
can actually apply, so a future session doesn't relitigate it by vibes.

## The gate

A title ships only if it clears **all four**:

1. **Depth.** Either 20+ hours of meaningful progression, or a skill ceiling a player can spend
   months approaching (speedrun times, build optimisation, ladder play). A game you finish in
   one sitting is not a slot.
2. **Phone-native controls.** Playable one-handed or two-thumbed on a 390×844 screen without a
   keyboard. If it needs a mouse cursor or a 12-button gamepad, it is not ready.
3. **Offline by construction.** Every feature works in airplane mode. Multiplayer is optional,
   never required. No account, no login, no first-run download.
4. **It runs.** Verified by real execution, not by reading the code: the title launches, renders,
   accepts input, and its state changes. For web titles that means `tests/browser.mjs` passing;
   for native ports it means a built artifact on disk with a hash and a recorded run.

## The score, and what each band means

Scores are this collection's own judgement (1–10), not store ratings. They exist so the ten
slots can be ranked and so a new candidate can be compared honestly.

| Band | Meaning |
|---|---|
| 9.0–10 | A genre-defining title with years of content. Mindustry, Shattered Pixel Dungeon, Luanti, Endless Sky, DarkPlaces. |
| 8.0–8.9 | Excellent, deep, but narrower than the top band — or an original that stands on its own. DDNet 8.5; the four originals 8.2–8.6. |
| 7.0–7.9 | Good game, not enough depth for a slot. Kept as lineage. |
| 5.0–6.9 | Fine for five minutes. Rejected. Hextris 6.5, 2048 6.0, Clumsy Bird 5.0. |
| < 5.0 | Rejected. FlappyBird 3.5. |

The source repo's own scoring produced the same ordering; this collection carried it forward
rather than inventing a new one. See `docs/INVENTORY.md` for the original leaderboard.

## What the AAA reference list is for

`AAA_MOBILE_GAMES.md` in the source repo scored twelve commercial free-to-play titles (Genshin
Impact, Honkai: Star Rail, CoD Mobile, Wuthering Waves, Where Winds Meet, Asphalt 9, Wild Rift,
Marvel Snap, Brawl Stars, Monument Valley 2, Alto's Odyssey, Once Human). They cannot be cloned
— closed source — and six of the twelve fail this collection's offline or no-account rules
outright. They are kept as a **bar for craft**, not as candidates. The things worth copying
from them are design choices, not content:

- **A first minute that teaches by playing.** No tutorial modal. The first tap does something.
- **Legible state at a glance.** HP, ammo, score readable in a half-second look at a phone held
  at arm's length — which is why every original draws a compact HUD and keeps text above ~11px
  at a 390px viewport width.
- **Moment-to-moment feedback.** Screen shake, hit flashes, particles and sound on every
  consequential action. Silence reads as a bug.
- **A reason to come back that isn't a notification.** Best times, unlock ladders, or a build
  that plays differently — never a daily-login timer.
- **Respect for the pause.** A game that punishes leaving the app loses the phone audience. All
  four originals pause on `visibilitychange` via the shared loop.

## The four originals, measured against the bar

| Title | Depth | Controls | Offline | Verified |
|---|---|---|---|---|
| Vaultbreak | 6-sector run with crafting curve, permadeath, boss | tap-to-path + 4 buttons | yes | `tests/browser.mjs` PASS, http + file:// |
| Tessera | 80-turn 4X with tech tree and rival AI | tap + 5 buttons | yes | `tests/browser.mjs` PASS, http + file:// |
| Ember Drift | open galaxy, trading, bounties, upgrades | thumb-stick + fire/dock | yes | `tests/browser.mjs` PASS, http + file:// |
| Rift Nine | 9 rooms, grapple physics, ghost replays | drag left / tap right / hook | yes | `tests/browser.mjs` PASS, http + file:// |

## The six cross-hybrids, measured against the bar

| Title | Depth | Controls | Offline | Verified |
|---|---|---|---|---|
| Siegehaus | SPD turn economy × Mindustry belts; ore veins, drills, fabricators, turrets, boss | tap-to-step + BUILD + 1-4 | yes | `tests/browser.mjs` PASS http + file:// · `plates > 0`, ≥3 structures standing, belts/drill sprites decoded |
| Charterline | 74-tech 4X × ES commodity market; chartered routes pay the live spread | tap hex + TRADE + end turn | yes | `tests/browser.mjs` PASS http + file:// · `charters ≥ 1`, `tradeGold > 0`, 6 Luanti materials loaded |
| Nulltrace | 9 grapple rooms under Quake PM_* movement; medals, splits, ghost | left/right, jump, hook | yes | `tests/browser.mjs` PASS http + file:// · run clock advancing, par table present |
| Lanternfall | ES hulls and market in a 10-frag arena with item timers | drag-thrust + aim/fire | yes | `tests/browser.mjs` PASS http + file:// · armour pickup starts its 25 s timer, weapon node live at start |
| Cinderhold | 420 real DCSS vault layouts by depth band, Flare item loot with upstream damage/armour numbers, three skills on cooldowns, boss every fifth floor | tap-to-step + hold attack + swipe dodge | yes | `tests/browser.mjs` PASS http + file:// · `vaultsLoaded ≥ 300`, floor id from the DCSS corpus, `kills ≥ 1`, two floors differ, `itemsInTable ≥ 60` |
| Wardenmarch | Wesnoth unit rules (hp/movement/attacks per range) on DCSS arenas, squad of 4 vs 3-5, turn-based AI | tap unit / tap tile / tap enemy / end turn | yes | `tests/browser.mjs` PASS http + file:// · `unitsWithRules ≥ 12`, arena id from the DCSS corpus, `terrainTiles ≥ 8`, turn advances, `fights ≥ 1` |

Each hybrid's score (8.4–8.6) sits inside the same 8.0–8.9 band as the originals: a second
system that genuinely changes how you play, not a reskin. The tests assert the second system
worked, not just that the page booted.

## Adding an eleventh title

It has to clear the same four gates and score 8.0 or better. If it scores lower, it does not
ship — the count stays at ten. That is the whole point of the rule.
