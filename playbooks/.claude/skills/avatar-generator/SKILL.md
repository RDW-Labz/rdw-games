---
name: avatar-generator
description: Build original OASIS avatar candidates and fixed-grid pixel packs, with a human selection gate and an advisory score table. For orchestrators and workers, not employees.
---

Use the playbooks repository root and `uv sync --locked --extra avatars`.
This is a build-time Claude Code skill, not an OASIS `skill.yaml`.

1. Write `avatars/<theme>/brief.yaml`: `theme` (text), `mood` (text or a list of
   words), optional `palette_hint` (text). Use original art only: never a
   recognizable character, name, logo or catchphrase (decisions #75, #76).
   No company data in any prompt or file; no API key in code or config.
2. Run `uv run avatars/tools/prompts.py avatars/<theme>/brief.yaml` for exactly
   six prompts. A banned name refusal means revise the brief, not bypass the check.
3. Generate each prompt with the Higgsfield connector the agent already has:
   model `gpt_image_2_5`, aspect ratio `1:1`, quality `high`, transparent background.
   Save six images as `avatars/<theme>/candidates/candidate-1.png` through
   `candidate-6.png`. If the connector is missing, stop and report the missing
   capability; do not invent credentials or substitute another provider.
   Record actions in the orchestrator's append-only run log: actor, action,
   public input paths, model, timestamp, credits and elapsed minutes. Never guess
   missing costs. An optional `RUN.json` for scoring has `credits` and `minutes`.
4. Run `uv run avatars/tools/contact_sheet.py avatars/<theme>/candidates`.
   Show both light and dark contact sheets to Braden.
5. **Stop and ask Braden to pick a candidate.** Do not proceed to a character
   implementation before his selection. A score cannot replace this human gate.
6. Have a worker write `avatars/<theme>/<name>/character.py` against
   `garage.avatars.pack.Character`, exporting `CHARACTER = YourCharacter()`.
   Declare `name`, `artist`, `palette` (token-to-hex mapping), `anchors`
   (`status_light: {x,y,w,h}`, `chat_button: {x,y}`, `baseline`) and implement
   `draw_frame(state, frame)` returning a 128x128 RGBA image. Use primitives in
   `garage.avatars.pixel`; `avatars/beacon/character.py` is the worked example.
   Match `garage.avatars.grid` row order and four frames per state at 6 fps.
   Keep body and anchors fixed; animate face, arms and props. Use binary alpha,
   top-left depth shading, inner glow, a dark outline and light rim; no external
   glow halo or ground shadow (#79). Palette must fit the transparent GIF limit
   of 255 opaque colours. Never import the read-only reference scripts.
7. Build with `uv run avatars/tools/build_pack.py
   avatars/<theme>/<name>/character.py avatars/<theme>/<name>/pack`.
   Module loading executes local code: inspect the worker's source first.
8. Run `uv run avatars/tools/validate_pack.py avatars/<theme>/<name>/pack`.
   Fix reported errors and rerun. Stop and ask after the same step fails three times.
9. Run `uv run avatars/tools/score_pack.py avatars/<theme>/<name>/pack
   [--run RUN.json]`. Show its Markdown table next to the sheet, GIFs and light,
   dark and 64px previews. Scores are advisory (#89), never auto-rejection.
   The body drift and outline/rim contrast are proxies, not aesthetic judgments;
   credits and minutes are unscored and absent records must remain unrecorded.
   Braden approves the final pack and any merge.
