## 1.26.1

- Local config now lives outside the install checkout: default path is `$XDG_CONFIG_HOME/project-swarm/config.json` (when set and absolute) else `~/.config/project-swarm/config.json`; `SWARM_CONFIG` still wins. A leftover file at the old `~/.project-swarm/config.json` (inside the install clone) refuses with `config-inside-install` instead of being read, and any resolved config file found inside a git work tree refuses with `config-inside-repo`.
- `ship`'s private-names list now falls through to the local config's `privateNames` path when neither `--private-names` nor `<root>/coordination/private-names.txt` is present (refusing `private-names-missing` when that configured file does not exist). A `path:` prefixed line is a path glob (`*` within a segment, `**` across segments), never a text term: it refuses `private-path-in-diff` when a matching file enters `git diff --name-only <base>...HEAD` or the staged diff, public or private repo alike.
- Scrubbed private product names from docs, tests and comments that a prior release's own new tests had reintroduced (field lesson 112); a test asserting such a name's absence now reads its terms from local config or skips, never spelling the term itself.
- The test suite never reads the developer's own local config: a `--import` setup file points `SWARM_CONFIG` at a missing file; the private-term scan reads the real one only through `SWARM_REAL_CONFIG`.

## 1.26.0
