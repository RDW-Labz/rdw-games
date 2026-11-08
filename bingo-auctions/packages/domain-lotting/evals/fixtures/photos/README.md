# Photo fixtures

Each labeled photo has two files in this directory:

- `<id>.json` — the `LabeledPhoto` sidecar (in version control)
- `<id>.{jpg,png,webp}` — the actual image file (NOT in version control by default)

## Why no images checked in?

Real product photos may carry retailer-specific labels, our test warehouse
backdrop, or otherwise be material we don't want in the public repo (or our
private repo if we ever fork it). Add real images locally; the runner skips
fixtures whose image file is missing and logs the count.

## Adding a fixture

1. Copy `example-001-dewalt-drill.json` and edit the fields.
2. Drop the matching JPG/PNG into this directory with the same `id`-prefixed
   filename.
3. Re-run the harness. The runner reads every `*.json` here.

## Image guidelines

- 1024-2048px on the long edge — large enough to read model numbers, not so
  large you blow out a context window.
- Keep `photo_quality_label` honest. The whole point of the field is to slice
  metrics by image difficulty so we can see which model degrades gracefully.
