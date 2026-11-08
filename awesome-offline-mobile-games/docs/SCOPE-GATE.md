# SCOPE GATE — read before adding anything to this repo

This file exists because scope was ruled on, once, and has to hold across every future session,
including ones that never saw the conversation.

## The rule

**Nothing is absorbed from another system into this collection without Michael's explicit
heads-up and opt-in.** If you are about to import a feature, dependency, asset, service,
account model, telemetry hook, or "helpful" integration from another project — stop. Write it
in `docs/PROPOSED.md` under *Awaiting opt-in*, one line each, and ask. Do not ship first and
disclose later.

## What this collection IS

- An **8-title offline games collection** — four originals authored here and four
  **cross-hybrids** (see standing decisions 8 and 9) that take one clone's systems and mesh them
  with another's, under their own names. No upstream build ships as a title.
- **Offline by construction.** Every game plays with the network off, permanently.
- **A shell** (launcher/PWA) and a **local library server** that only ever talks to `localhost`.
- **A research artifact**: it records what was reused from
  `cloned-free-games` and why (see `docs/HYBRIDIZATION.md`).

## What this collection is NOT (hard exclusions)

| Excluded | Why |
|---|---|
| Ads, IAP, gacha, any monetization | The entire point is that it costs nothing and asks nothing |
| Accounts, logins, cloud saves | Saves are local; export is a file the user mails to themselves if they want |
| Analytics, telemetry, crash reporting | No outbound requests at runtime, no exceptions |
| Always-on permission: `INTERNET` in the manifest of a bundled game | A bundled game must run in airplane mode |
| Remote asset streaming / "download on demand" | Assets ship in the bundle or the game does not ship |
| Third-party SDKs in forge titles | Zero dependencies is a feature (see `docs/HYBRIDIZATION.md` § Dependency policy) |
| Copying proprietary assets out of any game | Engine code is reused under its license; art/audio is **not** lifted from closed games |
| Moving `cloned-free-games` content *back* into this repo wholesale | Ports are referenced by commit, not vendored — 18 GB stays out of this history |

## Standing decisions (do not relitigate without Michael)

1. **No filler.** A slot is never filled with a smaller game to hit a number. The count was ten
   (6 ports + 4 originals); decision 8 added four cross-hybrids; decision 9 then dropped the six
   clones, so the shipped count became **eight**; decision 10 adds two more hybrids for **ten**, each
   clearing the same bar — a slot is never padded to reach a count.
2. **Lane labels are mandatory.** Every title is `port` or `forge` in `catalog/games.json`, and
   the UI shows which. No forged game may be presented as an upstream port, or vice versa.
3. **Provenance is not optional.** Any reused file carries upstream repo + commit + license in
   `ports/<id>/PROVENANCE.md`.
4. **No vendoring 18 GB.** The six ports' engines and assets stay out: they are referenced by
   commit and built artifact. What *is* vendored is a bounded, per-file-audited payload —
   currently 578 files / 21.9 MB under `vendor/` — of upstream art, audio and game data that the
   four originals actually load at runtime. Every file is listed in `vendor/MANIFEST.json` with
   source path, upstream commit, licence, size and SHA-256, and `tests/vendor.mjs` fails the
   suite if any of it drifts.
5. **Shareware data only.** Quake (`darkplaces`) ships with instructions to fetch `pak0.pak`
   from the freely redistributable shareware release — never a full retail pak.
6. **Michael confirms the push target** before any `git push`. Ask; don't infer the org.
7. **Upstream content may be vendored (Michael, 2026-10-29, explicit opt-in).** Referencing the
   clones by commit was ruled insufficient: "use clone repo and the games backend/assets to make
   cool shit". Standing consequence: the originals are expected to run on real upstream sprites,
   audio and data, imported by `tools/vendor.py`, attributed in-game, and licensed per
   `docs/LICENSING.md`. That opt-in covers the five open-source donors listed there and nothing
   else — a new donor source still needs a fresh heads-up before it lands.
8. **Cross-hybrids, two new donors, and their names (Michael, 2026-10-29, explicit opt-in).**
   Ruling, near-verbatim: the point was "use original game clones assets and backend to cross
   with other ones that mesh well and mix up and collab, then rename" — borrowing art was not the
   ask. Standing consequences:
   - The four originals stay as the **lineage** set; each gets a **hybrid sibling** whose rules
     come from two different clones, not one: **Siegehaus** (SPD turn economy × Mindustry
     production/waves), **Nulltrace** (DDNet speedrun timing × Quake air physics), **Charterline**
     (Unciv tech tree × open trade links and Endless Sky commodity prices), **Lanternfall**
     (Endless Sky hulls/market × Quake-era arena movement). Names are approved as written.
   - **New donors opted in:** Mindustry (GPL-3.0) item icons, conveyor, drill and turret sprites;
     Luanti (LGPL-2.1+ / CC-BY-SA-3.0) node material textures. Both join the donor list in
     `docs/LICENSING.md` and are imported by `tools/vendor.py` like the first five.
   - **Quake content is not pulled.** The physics that Nulltrace and Lanternfall borrow are
     constants and code written here; no shareware `pak0.pak` is vendored.
   - A hybrid may not present itself as a port, and its catalog entry names both parents in
     `hybrid_note` — the lane label stays `hybrid`, distinct from `port` and `forge`.
   - **Status 2026-10-29: all four shipped.** `games/{siegehaus,charterline,nulltrace,lanternfall}/`
     exist beside the four lineage titles, each hybrid carries a
     test that asserts its *second* system ran (`tests/browser.mjs` HYBRID_CHECKS) rather than
     only that the page booted.
9. **No clones in the shipped collection (Michael, 2026-10-29, explicit ruling).** Ruling,
   near-verbatim: "on the originals and the 4 you built, I dont want cloned orginals on ours only
   hybrids and orginal builds, I prefer all hybrids due to them probably being better games."
   Standing consequences:
   - The shipped grid is **four originals + six cross-hybrids = 10 titles**; decision 10 raised it
     from the eight this ruling first described. The six upstream
     builds (`mindustry`, `shattered-pixel-dungeon`, `luanti`, `endless-sky`, `darkplaces`,
     `ddnet`) are **not** titles: they are lineage and asset donors only.
   - `tests/smoke.mjs` fails if any `lane: port` entry reappears in `catalog/games.json`, and
     requires every shipped title to be `delivery: bundled-web` — so re-adding a clone needs a new
     ruling, not an edit.
   - When asked whether the four originals should also become hybrids, Michael chose to **keep
     them as originals** and drop only the clones. That is the current lineup; converting one is a
     new decision.
   - `ports/<id>/PROVENANCE.md` stays in the repo as lineage paperwork (upstream repo, pinned
     commit, licence, artifact hash) — keeping it is not shipping it.
   - The launcher dropped its PORTS filter and the GET/install sheet, because nothing in the grid
     needs an install step anymore.
10. **Both new hybrids, and three more donors (Michael, 2026-10-30, explicit opt-in).** The ruling,
    near-verbatim: *"both and drop title list"* — approving both proposed hybrids rather than one,
    and deleting the 260-title `games.db.json` that had appeared on the donor repo's `main`. Standing
    consequences:
    - **Cinderhold** and **Wardenmarch** are approved as titles, each crossing two donors' systems:
      Cinderhold (DCSS vault geometry × Flare art and item records), Wardenmarch (Wesnoth unit rules
      × DCSS arena geometry). Both names are approved as written; both lanes are `hybrid`.
    - **New donors opted in:** Flare (`flare-game`, GPL-3.0 code / CC-BY-SA-3.0 art), Dungeon Crawl
      Stone Soup (`crawl`, GPL-2.0 code / **CC0** tiles), Battle for Wesnoth (`wesnoth`, GPL-2.0+ /
      CC-BY-SA-4.0 art). All three are imported by `tools/vendor.py` from pinned commits and listed
      in `docs/LICENSING.md`; decision 7's "a new donor still needs a fresh heads-up" is satisfied
      by this entry, and the same rule applies to the *next* donor.
    - **The 260-title list is gone**, not merely hidden: `games.db.json` was removed from the donor
      repo's `main` by force-pushing the measured `donor-sweep` branch over it. It listed commercial
      titles (Genshin, CODM, GTA, Cyberpunk) with invented scores, which is the opposite of what this
      collection's rubric does — nothing is scored here that was not built and run.
    - **Shipped count is ten:** four originals + six cross-hybrids. Decision 1's "no filler" rule
      still governs; these two slots were filled because the donors exist and the builds cleared the
      bar (8.6 and 8.5 on `docs/QUALITY-BAR.md`), not to reach a round number.
11. **Stormforge, and Suroi as an eleventh donor (Michael, 2026-10-30, explicit opt-in).** The ask,
    near-verbatim: *"Lets make one new bad ass one, look for aaa clones to do it, fortnight style
    with throwing some sweet hybrids in there for me"* — answered with the donor and name proposed
    and both approved verbatim: **Suroi as an 11th donor, title = Stormforge**, and **"Full hybrid —
    mine ore, belt it, fabricate, turrets hold your zone (Mindustry economy)"**. Standing
    consequences:
    - **Stormforge** ships as the eleventh title, lane `hybrid`, crossing **Suroi** (battle-royale
      loop, real ballistics, loot tiers, storm circle) with **Mindustry** (drills, conveyors,
      fabricators and turrets). Fortnite's instant build becomes an economy you actually run.
    - **New donor opted in:** Suroi (GPL-3.0, `HasangerGames/suroi`), pinned at the commit recorded
      in `vendor/MANIFEST.json`. What is taken: weapon art, structure and prop art, loot icons, the
      gun/armour/healing tables **parsed out of its own definition files** (damage, spread, fire
      delay, tier, reload, damage reduction, heal amounts), and its sound effects. What is not:
      no engine code, no server, no Suroi map data, nothing from a closed game.
    - Adding another donor still needs its own heads-up under decision 7; this entry covers Suroi
      and nothing else.
12. **three.js as the renderer for Stormforge (Michael, 2026-10-30).** Stormforge is a 3D title,
    so it needs a WebGL renderer. Added as a **library dependency, not a donor**: three.js r156
    from the published npm tarball, MIT, pinned with the tarball hash in `vendor/MANIFEST.json`.
    r156 is the last UMD build, which is the only shape that loads as a classic script from
    `file://` — the collection's core promise is that a folder of files plays with no server and
    no bundler. If Michael objects to shipping a third-party renderer, this is the decision to
    revisit; the alternative is a hand-written WebGL renderer, which is a much larger surface.
