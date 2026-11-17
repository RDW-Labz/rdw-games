# `ports/` — lineage records, not shipped titles

Nothing in this folder is a game you can play from this collection. Since SCOPE-GATE
decision 9 (2026-10-29) no upstream build ships as a title: the grid is four originals plus
four cross-hybrids, all of them browser pages under `games/`.

What these files are:

| File | What it records |
|---|---|
| `manifest.json` | machine-readable map of the six upstream projects, their licences and pinned commits |
| `<id>/PROVENANCE.md` | upstream repo, pinned commit, licence, build commands, artifact size and SHA-256 |

Why they stay:

- **Licence compliance.** The hybrids borrow sprites, audio and data tables from these
  projects. `vendor/MANIFEST.json` carries per-file attribution, and these pages carry the
  upstream terms those files travel under.
- **Provenance for anything reused.** `npm run provenance:check` regenerates them from disk so
  a hash cannot drift, and `tests/vendor.mjs` fails the suite if a vendored file stops matching
  its recorded source.
- **Re-adding one needs a ruling, not an edit.** `tests/smoke.mjs` fails if any `lane: port`
  entry appears in `catalog/games.json`, which is deliberate.

To play any of these upstream projects, go to its own repository under its own terms; nothing
here redistributes them.
