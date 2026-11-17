# Judging Rubric — cloned-free-games

Every game in this repo is **actually cloned, actually built, and actually launched** on real
hardware before it gets a score. No score without evidence. If it never booted, it says so and
scores `UNVERIFIED`.

## Hardware / environment of record
- Host: CachyOS Linux, 32-core, 121 GB RAM, Mesa (llvmpipe software GL under Xvfb)
- Client games run under Xvfb `:99` (1280x720); screenshots captured with ImageMagick `import`
- Headless/dedicated servers run natively; logs kept in `evidence/`

## Score = 10 points total

| Category | Max | What it measures |
|---|---|---|
| Gameplay depth | 3 | Hours of content, systems interaction, replayability |
| Presentation & feel | 2 | Art direction, juice, audio, polish of the actual running game |
| Platform optimization | 2 | Touch/mobile builds, controller, low-spec viability, cross-platform |
| Build & run health | 2 | Built clean from source here, launched, stable = 2. Warnings/partial = 1. Failed = 0 |
| Code & architecture | 1 | Readability, moddability, CI health, license clarity |

## Tiers
- **S (9–10)** — genuinely AAA-adjacent; competes with shipped commercial titles
- **A (7.5–8.9)** — excellent; better than most paid indie games
- **B (6–7.4)** — solid, recommended
- **C (4–5.9)** — playable, has real gaps
- **D (<4)** — toy / montage material (flappy-bird tier)

## Tags
Each game gets: `genre`, `platforms tested` (Linux / Android-capable / HTML5 / controller /
touch), `license`, and a one-line verdict. Android capability is judged from actual build
targets in the tree (gradle android modules, SDL for Android, etc.), not vibes.
