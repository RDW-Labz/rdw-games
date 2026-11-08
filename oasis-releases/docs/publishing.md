# Publishing a release

For maintainers only. Read the README first.

The manifest address the app reads is:

`https://github.com/RDW-Labz/oasis-releases/releases/latest/download/latest.json`

## Before you start

- The nightly workflow in the service repository is green. If it is not, stop. Do not publish.
- You have the minisign key. It is held outside this repository. Never commit it, paste it into an issue, or attach it to a release.
- The version is higher than the last published version. The app refuses downgrades and same-version updates.

## Steps

1. **Tag the commit.** Pick the commit to ship and tag it `v<version>`, for example `v9.0.1`.
2. **Build the Windows installer** from that tagged commit. Do not build from a working copy with extra changes.
3. **Compute the sha256** of the Windows installer file. Write down the 64 hex characters, lowercase.
4. **Sign** with the minisign key held outside this repository. Take the signature over the installer file, so it matches the public key set in the app. Keep the signature string for the manifest.
5. **Write `latest.json`** using the schema below. See `latest.json.example`.
6. **Create the GitHub Release** named `v<version>` in this repository. Attach `latest.json` and the installer.
7. **Verify the manifest address.** Fetch `https://github.com/RDW-Labz/oasis-releases/releases/latest/download/latest.json` and check that:
   - it serves the new file,
   - `version` is the new version,
   - `platforms.windows-x86_64.url` points at the installer you attached,
   - the installer at that url has the same sha256 as the manifest.

   If any check fails, fix it with a new release (see Rollback). Do not edit or delete the old one.

## Manifest schema

```
{
  "version": "<major.minor.patch>",
  "notes": "<plain words about what changed>",
  "pub_date": "<UTC date and time, RFC 3339>",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/RDW-Labz/oasis-releases/releases/download/v<version>/<installer file name>",
      "signature": "<minisign signature string>",
      "sha256": "<64 hex characters>"
    }
  }
}
```

Rules the app applies when it reads the file:

- `version` must be a valid semantic version.
- `url` must be under `https://github.com/RDW-Labz/oasis-releases/releases/download/`.
- `sha256` must be exactly 64 hex characters.
- Any missing field makes the manifest invalid, and the app ignores it.

Write `notes` in plain words that a person could read in the update ask.

## Rollback

If a release is bad, go back by publishing forward:

1. Take the manifest from the last good release.
2. Because the app refuses downgrades, a rollback needs a new, higher version. Rebuild the last good commit as a new version if needed, then run the steps above for it. If the last good installer is reused, its manifest keeps its original version and the app will not offer it to anyone already on a newer one.
3. Create it as a new GitHub Release so it becomes the latest.
4. Verify the manifest address again (step 7).

Never delete release artifacts, and never replace the files on an existing release. Old releases stay as a record, and anyone who already has a manifest URL keeps getting the same bytes.
