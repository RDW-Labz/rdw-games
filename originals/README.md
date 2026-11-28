# RDW Games originals

`releases.json` selects one tested release per title for the studio portal.
Record the full source commit and the version that was tested. Run the game's tests and
verify launch, gameplay input, Back, and relaunch at desktop and phone sizes before switching a row.

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
