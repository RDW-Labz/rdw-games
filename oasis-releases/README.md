# oasis-releases

The public release feed for the OASIS desktop app (T75).

## What this repository holds

- The release manifest, `latest.json`, attached to each GitHub Release.
- The installer files, attached to the same GitHub Releases.
- Publishing notes in `docs/publishing.md`.

It holds no source code and no secrets. The signing key is kept outside this repository and is never committed.

## Who may publish

Only maintainers may publish a release. A release may be published only after the release gate is met: the nightly workflow in the service repository must be green. The gate is the publisher's job. The app does not check it.

The steps are in [docs/publishing.md](docs/publishing.md).

## The one rule the app enforces

The app installs only the exact version and sha256 that the manifest names.

- If the installer's sha256 does not match the manifest, the app does not install it.
- If the manifest names an older version than the one installed, the app refuses it (no downgrades). The same applies to the same version.
- The person is asked once per version. A new version is asked about again.

## Manifest address

The app reads the manifest from:

`https://github.com/RDW-Labz/oasis-releases/releases/latest/download/latest.json`

See `latest.json.example` for the shape of the file.
