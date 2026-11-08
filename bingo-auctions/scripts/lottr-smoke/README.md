# LotTR AI Smoke Test

A repeatable harness for testing the LotTR photo-identification pipeline
against a curated image set, across multiple OpenRouter models, on three
axes: **quality, latency, cost**.

Use it when:
- You're tweaking the vision prompt and want to know if v2 actually
  beats v1 (or just shuffles the failure modes)
- You're evaluating a new model and want to compare it head-to-head
  against the current production tier
- You're tracking quality regressions after upstream model updates
  (Gemini's monthly silent revisions, etc.)

## Quick start

```bash
# 1. Drop test photos into fixtures/ and describe them in fixtures/manifest.json
#    (copy fixtures/manifest.example.json as a template)
cp scripts/lottr-smoke/fixtures/manifest.example.json \
   scripts/lottr-smoke/fixtures/manifest.json

# 2. Set your OpenRouter API key (same one the production worker uses)
export OPENROUTER_API_KEY=sk-or-...

# 3. Run the default suite (current prompt vs default model set)
node scripts/lottr-smoke/run.mjs

# 4. Read the report
open scripts/lottr-smoke/results/<latest>.md
```

The default run hits ~5 models × N images. With ~10 photos that's typically
$0.02-0.05 per full sweep depending on which models you've enabled.

## CLI flags

```
--prompt <path>      Prompt file (default: prompts/photo-identify.v1.txt)
--manifest <path>    Image manifest (default: fixtures/manifest.json)
--models <path>      Models to test (default: models.json)
--budget-cents <n>   Refuse to start if estimated total > this. Default: 50.
--out <path>         Output report path. Default: results/<timestamp>.md
--only <regex>       Only run cases whose id matches regex
--max-images <n>     Stop after N images (smoke test mode)
```

## Folder layout

```
scripts/lottr-smoke/
├── README.md               # this file
├── run.mjs                 # the CLI runner
├── models.json             # which OpenRouter models to test
├── prompts/
│   └── photo-identify.v1.txt   # extracted from production VISION_PROMPT
├── fixtures/                   # ← you drop test images here (gitignored)
│   ├── manifest.example.json   # schema template
│   └── manifest.json           # your real manifest (gitignored)
└── results/                    # gitignored
```

## Manifest schema

`fixtures/manifest.json` describes the test set:

```json
{
  "name": "default-smoke",
  "description": "Mix of qualities encountered in real lotting flows",
  "cases": [
    {
      "id": "001-dewalt-clear",
      "image": "001-dewalt-clear.jpg",
      "notes": "Good light, clear DeWalt model sticker — happy path",
      "expected": {
        "brand": "DeWalt",
        "model": "DCD771C2",
        "title_contains": ["DeWalt", "DCD771C2", "Drill"],
        "category_contains": ["Tool"]
      }
    },
    {
      "id": "002-feed-bag-blurry",
      "image": "002-feed-bag-blurry.jpg",
      "notes": "Stylized 'DuMOR' brand, OCR often reads 'Idumor'",
      "expected": {
        "brand": "DuMOR",
        "title_contains": ["DuMOR", "Feed"]
      }
    }
  ]
}
```

Expected fields supported in the matcher:
- `brand`, `model`, `upc`, `asin`, `fnsku`, `category` — case-insensitive equality
- `<field>_contains` (`title_contains`, `category_contains`, etc.) — every term must appear (case-insensitive)
- Omit a field to skip checking it for that image

## Models config

`models.json` lists which models to compare:

```json
{
  "models": [
    "google/gemini-2.5-flash-lite",
    "google/gemini-2.5-flash",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-4o-mini",
    "meta-llama/llama-3.2-90b-vision-instruct"
  ]
}
```

Cost data is fetched live from OpenRouter's `/api/v1/models` endpoint at
run start — no hardcoded prices to go stale.

## Output

Each run writes two files:

- `results/<timestamp>-<prompt-name>.md` — human-readable comparison report
- `results/<timestamp>-<prompt-name>.json` — raw results for programmatic re-use

The markdown report has three sections:

1. **Per-model summary** — total cost, avg latency, aggregate quality score
2. **Per-image breakdown** — which models got each image right, where they
   diverged on brand / model / category
3. **Cost ledger** — exact spend per model, useful for setting budgets

## Comparing prompt versions

```bash
# Test current prompt
node scripts/lottr-smoke/run.mjs \
  --prompt scripts/lottr-smoke/prompts/photo-identify.v1.txt \
  --out scripts/lottr-smoke/results/v1.md

# Edit a new variant
cp scripts/lottr-smoke/prompts/photo-identify.v1.txt \
   scripts/lottr-smoke/prompts/photo-identify.v2-tighter-no-text.txt
# ...edit the prompt...

# Test the variant
node scripts/lottr-smoke/run.mjs \
  --prompt scripts/lottr-smoke/prompts/photo-identify.v2-tighter-no-text.txt \
  --out scripts/lottr-smoke/results/v2.md

# Compare the two reports side by side
```

## Keep the production prompt in sync

`prompts/photo-identify.v1.txt` is a snapshot of `VISION_PROMPT` in
`packages/domain-lotting/src/ai/identification.ts`. When you change the
prompt in production, copy the new version into this folder with a
bumped version suffix so the test harness reflects what's actually
deployed.

(Eventually we'll automate this — import the prompt directly from the
domain-lotting package at runtime — but for now manual sync keeps the
test harness decoupled from the build graph.)
