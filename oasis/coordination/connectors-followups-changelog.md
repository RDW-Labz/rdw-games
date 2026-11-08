# Changelog — connectors

Newest first.

## Unreleased

- T16b follow-ups from the live Mac run — three fixes. (1) `gates.connect` no
  longer crashes with a traceback when installed from a wheel: the catalog is
  now also shipped inside the wheel (`pyproject.toml`'s
  `force-include`, `catalog/` → `gates/_catalog`), `default_catalog_dir()`
  prefers a source checkout's `catalog/` and falls back to the packaged copy,
  a new `CatalogNotFoundError` prints one plain line
  (`connector catalog not found: <path>`) and exits 2 with no traceback, and
  both `gates.connect` and `gates.status` gained `--catalog-dir`. (2)
  `docs/registrations.md` — the Microsoft Entra "Mobile and desktop
  applications" platform also needs the redirect URI
  `http://localhost/callback`, not only `http://localhost`; Braden had to add
  it by hand on the live run because the loopback listener's callback path
  didn't match the registered redirect. (3) `python -m gates.connect ...`
  prints a `RuntimeWarning` because `gates/__init__.py` already imports
  `gates.connect`; added `src/gates/__main__.py` and the `gates` console
  script so `python -m gates connect <name>` / `python -m gates status` work
  with no warning, keeping `python -m gates.connect` and `python -m
  gates.status` for compatibility. `docs/connect.md` updated to the new
  spelling. Bump to 0.3.1.

- T16b (J2) — add `gates.graph_read`: async, injectable-`httpx.AsyncClient` reads of
  `outlook-calendar`'s today window (`calendarView`, cancelled and declined events
  dropped, `@odata.nextLink` reported as `truncated`) and `outlook`'s unread count plus
  up to 10 newest unread headers (subject/sender/received time only — never a body or
