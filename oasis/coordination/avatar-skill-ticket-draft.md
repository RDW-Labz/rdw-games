# Avatar generator skill — ticket draft (Braden's idea, 2026-09-24)

Proposal only. Not built yet — do not build ahead of Braden's yes.

## T26 — Avatar generator skill (playbooks, skills, desktop-app)

**Repo:** `playbooks` (the tool itself, next to the `avatars/` pack sources it feeds, decision #78), `skills` (docs/formats.md, only if it needs its own `skill.yaml`), `desktop-app` (consumes the existing validator; no new UI). It is a build-time tool the orchestrator and workers run while making packs — employees never see it or run it themselves.

**When:** After T17 ships on Braden's Mac. Feeds T22 (six themed sets, six candidates each, Braden picks) and T23. Guess: could start alongside T22 instead of strictly before it — see Questions below.

**Build:** Takes in one theme brief (mood words, optional palette or reference hints; no employee or company data). Produces, in two stages:
1. **Candidates (model call + script).** Six Higgsfield images (`gpt_image_2_5`, 1:1, high, transparent background — the settings used for Beacon, from `coordination/TASK-session9-log.md`) resized to 512 px, plus one labelled contact sheet in light and dark (script, same shape as `higgsfield/make_sheet.py`). Braden picks one candidate — a human gate, never automatic.
2. **Full pack (model call + scripts).** Original hand-placed pixel art for the pick, across all 8 states x 4 frames x 3 looks, on the fixed T17 grid (128 px frames, 8 rows in decision #75's fixed order, 4 frames, 6 fps), reusing `beacon_v2.py`'s grid/palette/anchor/glow-key helpers as a shared library rather than a one-off script. Writes `sheet.png`, `manifest.yaml`, per-state GIFs, light/dark previews, and the 64 px downscale check (`preview-64-dark.png`) — all scripts, no model call once the drawing code for that theme is stable.

Then the pack validator runs (the `avatarPack.ts` checks, or `beacon_v2.py`'s own self-checks: grid, anchors, alpha only 0/255, band solid, baseline row) — plain code, never a model. Rule, every stage: original art only, never a recognizable character, name, logo or catchphrase (#75, #76); no company data in any prompt or file.

**Tests:** A fixture theme brief produces exactly six candidates and one contact sheet, no extra model calls; the validator refuses an off-grid sheet, a missing manifest field, and an anchor outside the frame, the same mutation checks T17 uses (swap two states, drop one, map a needs-you state to calm, glow on paused); a chosen candidate turns into a pack that passes the validator and the 64 px check; the scoring table below computes for a generated pack and flags anything below its bar.

**Done when:** Given a theme brief, the tool produces six candidates plus a contact sheet for Braden to pick from, and turns his pick into a full pack on the T17 grid that passes the validator, with the scoring numbers below attached; it reruns on a second, different theme brief with no code change.

## Success scoring

Each check is scored against Beacon's real numbers where the logs have them; where they don't, the bar is "measure on Beacon first" (run the same check on the shipped Beacon pack to set the number, since it hasn't been measured yet).

| Check | Pass bar | Beacon baseline (source) |
|---|---|---|
| Validator pass | 0 errors (grid, anchor, palette, alpha, colour) | Beacon's sheet + manifest pass today (`repos/desktop-app/src/orb/avatarPack.ts`; `beacon-v2/manifest.yaml`) |
| 64 px readability | A reviewer names the state and mood with no zoom on the dark preview | Beacon: face and band read at 64 px; the light rim softens slightly (`TASK-session8-log.md`, dispatch 8 result) — allowed only if the silhouette still reads |
| Palette size | At or below Beacon's ~77 colors, well under the validator's 256 cap | `beacon-v2/manifest.yaml` lists 77 hex colors |
| Anchor consistency | 0 failures across all 32 frames (status band solid, baseline row matches the manifest) | Beacon: 0 failures (`beacon_v2.py`'s `check_frame` self-check) |
| Frame-to-frame drift | Only arms, props, handle and face move; body/feet/band pixels identical across a state's 4 frames | Beacon: drift found in the first draw (square handle, small face) fixed by rev 3 (`TASK-session8-log.md`, dispatch 7 review) |
| Generation time | Measure on Beacon first | Candidate step not logged; pixel-pass first draw took ~9 min (dispatch 7) |
| Higgsfield credits / candidate | ≤1.5 credits | ~1 credit each (6 credits for 6 candidates, `TASK-session8-log.md`) |
| Braden's pick rate | Measure on Beacon first | One theme so far: 1 of 6 candidates picked, 0 full-pack redos after two fix rounds |

## Cost

Rough, from the logs, per theme (six candidates + one full pack):
- Candidates: ~6 Higgsfield credits (session 8's actual run), a small fraction of the ~1856-credit team plan (`TASK-session9-log.md`).
- Full pack: Beacon's pixel pass took three model rounds to get right — draw ($1.47, ~9 min, dispatch 7), fix ($0.51, dispatch 8), depth pass (cost and time not logged, dispatch 9). Guess: ~$2-3 and 15-20 minutes of model time per theme until the drawing code is stable; re-running the finished script after that is free and takes seconds (Pillow only, no network — `beacon_v2.py`'s own docstring).
- Six themes (T22): guess ~36 Higgsfield credits plus ~$12-18 in model calls for the pixel passes, before any rework rounds.

## Questions for Braden

1. Which repo owns the tool's code: `playbooks` next to `avatars/`, or somewhere else?
2. Is this a Claude Code skill (a `SKILL.md` that drives the scripts) or plain scripts the orchestrator runs directly? (It is not an OASIS `skill.yaml`: employees never run it.)
3. Does T22 wait for T26 to exist, or does T22 keep going by hand while T26 gets built?
4. Should the pixel-pass step always use an Opus-class model (Beacon's history), or try a cheaper model first per theme to save cost?
5. Does the scoring table gate a pick (auto-reject a low-scoring pack) or just report numbers for Braden to read?
