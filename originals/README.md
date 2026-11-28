# RDW Games originals

`releases.json` selects one tested release per title for the studio portal.
Record the full source commit and the version that was tested. Run the game's tests and
verify launch, gameplay input, Back, and relaunch at desktop and phone sizes before switching a row.
Capture a screenshot during that release's actual gameplay and save it as
`previews/<slug>/<version>.webp`. Include brief `preview_alt` text describing the scene.
If a playtest release uses prototype art, identify it as such in its description.

- For an existing game service, set `url` to its direct HTTPS play page. The portal opens it in the
  same tab, so Browser Back returns to the catalog. Claybound uses this route because its
  multiplayer relay and share links use the game's own origin. Its recorded commit identifies
  the tested release. The game service controls which build its public URL serves.
- For a static game, omit `url` and place the distribution-only files under
  `$ORIGINALS_BUILDS/<slug>/<version>/`, with `index.html` at the top and relative asset paths.
  The default input is `~/.cache/rdw-games-publish/originals`. The publisher adds the bundle
  under `/play/<slug>/<version>/` and aborts before upload if the entry point is missing.
  Keep each input version intact on the publisher so it can be selected again.

The existing `cloned-free-games/scripts/publish-site.sh` combines the library, game bundles,
mirrors, and private shelf. Preview with `DRY_RUN=1` on the normal publisher with its complete
inputs. Pages direct upload replaces the full deployment, so use the publisher that has the
current play mirrors and shelf inputs for production.

On the publish host, run the publisher from the RDW Games checkout and point `SRC` at the
existing clone-farm checkout (normally `~/cloned-free-games`). That keeps the clone-farm caches
and reads the originals manifest and renderer from RDW Games. The clone-farm timer currently
runs its own copy of the publisher. Update that publish step along with the first release so
later runs pick up the same manifest. Its daily Git mirror also copies the tracked clone-farm
scripts back into `cloned-free-games/`; keep the publisher, library renderer, and originals
module in sync there before enabling the mirror.

## Catalog-wide play audit

Use a separate SQLite file for each scope. After signing in, save that deployment's `games.json`
and the shelf launch list as a JSON object with a `games` array. Shelf rows need a `title` and
either `url` or `path`. Import the same files again to resume after a restart. Removed entries
leave the current list and retain their history. A changed original-game launch URL returns to
pending so the new version is exercised.

```sh
python3 originals/catalog-audit.py --db portal.sqlite --scope production load games.json --shelf shelf.json
python3 originals/catalog-audit.py --db portal.sqlite --scope production next --limit 5
python3 originals/catalog-audit.py --db portal.sqlite --scope production summary
```

Use `record ID STATUS --evidence PATH` after checking each game. A playable receipt should cover
launch, responsive gameplay input, Browser Back or the in-page exit control, and a second launch
on desktop and phone. Keep before and after gameplay screenshots and add each generation result
with `--job-id ID`. Use the STOP file to pause selection of new batches. Start with a small
batch and visually review the changes before handling more titles.
