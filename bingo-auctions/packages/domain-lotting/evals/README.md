# `@auction-platform/domain-lotting` evals

A thin, in-tree evaluation harness for the LLM-backed product identification
functions in `src/ai/`. Built to answer one question with numbers:

> Is the cheap model (Gemini Flash, Haiku) good enough, or do we need to
> pay for the bigger one for this task?

## Philosophy

**Don't change a prompt or swap a model without an eval pass.**

Prompts and model choices are configuration, not code: a one-character edit
to `identifyPhoto`'s prompt can flip recall on a whole class of inputs.
This harness exists so any change to the AI layer is followed by a number,
not a vibe.

If you're tempted to ship a prompt change without running the suite — don't.
Add a fixture that demonstrates the case you're trying to fix, run the suite
on the old prompt, run it on the new prompt, and put the diff in the PR.

## Status

> [!NOTE]
> 30 manifest-row + 30 photo-sidecar + 30 UPC-lookup fixtures land with
> this scaffold. They span all 16 platform top-level categories and
> include adversarial cases (ambiguous descriptions, missing UPCs, bad
> codes). Photo fixtures are JSON sidecars only — drop matching
> `<id>.{jpg,png,webp}` files in `fixtures/photos/` before running the
> photo suite. See `fixtures/photos/README.md`.

## Layout

```
evals/
  fixtures/
    manifest_rows/                 # 30 labeled retailer-manifest rows
    photos/                        # 30 sidecars; images live next to them locally
    upc_lookups/                   # 30 UPC/ASIN test cases (incl. negatives)
    generate-from-cache.ts         # bootstrap fixtures from product_lookups
  runners/                         # one runner per suite
    shared.ts                      # fixture loader + telemetry sink wiring
    run-photo-id.ts
    run-manifest-classify.ts
    run-upc-lookup.ts
  metrics/                         # similarity / category-match / price-band
  reports/                         # gitignored; each run writes here
  pricing.ts                       # $/1M-token table + cost estimator
  types.ts                         # fixture + report types
  index.ts                         # CLI entry
```

## Suites

- **`photo-id`** — `scanPhoto` (default) or `identifyPhoto` (`--fast`).
  Scores: title similarity, brand/model exact, category, condition, price band.
- **`manifest-classify`** — feeds raw retailer manifest rows through
  `lookupCode` (when a UPC is present) or `fetchPrices` (otherwise).
  Scores: title similarity, brand/model exact, category, price band.
- **`upc-lookup`** — `lookupCode(code)` against a labeled UPC/ASIN.
  Scores: same as manifest, plus a "no hallucination on bad codes" check.

## Metrics

| metric | what it measures | why this implementation |
| --- | --- | --- |
| `titleSimilarity` | token-set Jaccard on a normalized tokenization | embeddings would couple the harness to a second model and add cost we can't attribute. Jaccard captures the "did the right brand+model+product-type words show up?" signal that auction titles are actually built from. |
| `descriptionSimilarity` | same Jaccard | descriptions are short auction blurbs; semantic match isn't worth the dependency. |
| `exactStringMatch` (brand, model, condition) | normalized-equality (lowercase, strip whitespace + dashes) | model numbers are codes; partial credit is misleading. |
| `categoryMatchScore` | 1.0 exact slug, 0.5 sibling under same parent, 0.0 miss | the platform taxonomy has structure (see migration `0018_categories.sql`) and we want to reward "in the right neighborhood" without conflating it with a hit. |
| `priceBand` | 1 if predicted MSRP within +/-25% of label, else 0; also reports MAE in cents | retailer prices disagree by 5-10% routinely; 25% catches "wrong product" without firing on "Amazon vs Walmart". |

## Running

From the package root (`packages/domain-lotting/`):

```bash
# All suites:
npm run eval -- --suite=all

# One suite, capped to 5 fixtures, against a specific model:
npm run eval -- --suite=photo-id --limit=5 --model=anthropic/claude-haiku-4-5

# Vision-only (no web search, no price band):
npm run eval -- --suite=photo-id --fast
```

If no API key is set, the CLI prints a help message and exits 0 — safe to
wire into CI without exposing secrets.

## Fixture format

All fixtures conform to types in `types.ts`:

| type | shape |
| --- | --- |
| manifest rows | `LabeledManifestRow` — `raw` block (retailer fields) + `expected` (ground truth) |
| photos       | `LabeledPhoto` — sidecar JSON pointing at a local image file |
| UPC lookups  | `LabeledUpcLookup` — UPC/EAN/ASIN code + ground truth |

Common fields under `expected` (`GroundTruth`):
- `title` — canonical short title for the lot listing
- `brand`, `model` — exact-match scoring; preserve case
- `category_slug` — platform taxonomy slug (see `db/migrations/0018_categories.sql`)
- `category_legacy` — runtime AI output enum (`Category` from `src/constants.ts`)
- `condition` — one of `Condition` enum values, or `''` if unknown (UPC lookups)
- `msrp_cents` — integer cents; `0` for negatives / unknown

## Adding fixtures manually

### Manifest rows

Drop a JSON file in `fixtures/manifest_rows/`. Use real-looking retailer
descriptions; preserve weird capitalization and verbose marketing copy —
that's what production data looks like. Cover at least one fixture per
top-level platform category so a new model isn't blind to a whole
top-level branch.

```jsonc
{
  "id": "manifest-XXX",
  "source": "lowes",            // or amazon|wayfair|home-depot|target|other
  "raw": {
    "description": "...",
    "retailer_category": "...",
    "upc": "0123456789012",
    "model_number": "...",
    "quantity": 1,
    "retail_price": 49.99
  },
  "expected": { /* GroundTruth */ "expected_confidence": "high" },
  "notes": "what makes this fixture interesting"
}
```

### Photos

Two files per fixture in `fixtures/photos/`:

1. `<id>.json` — the `LabeledPhoto` sidecar (commit this).
2. `<id>.{jpg,png,webp}` — the actual image (do **not** commit).

The runner skips fixtures whose image file is missing and logs the count.
See `fixtures/photos/README.md` for image guidelines.

### UPC lookups

JSON file in `fixtures/upc_lookups/`. Include at least one **negative**
fixture (fake UPC, malformed code, or close-but-wrong checksum) — the
harness has a special case that fails any model that confidently invents
a product for it.

## Bootstrapping fixtures from `product_lookups`

The platform's `product_lookups` cache accumulates clean labeled data as
operators process real lots. We can mine it for additional fixtures:

```bash
# Pull 50 high-confidence rows into upc_lookups/.
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
npx tsx packages/domain-lotting/evals/fixtures/generate-from-cache.ts \
  --type=upc_lookups --limit=50

# Same idea for manifest rows / photos:
npx tsx ... --type=manifest_rows --limit=30 --min-confidence=high
npx tsx ... --type=photos --limit=30
```

Flags:
- `--type=<manifest_rows|photos|upc_lookups>` — required.
- `--limit=N` — default 50.
- `--min-confidence=<high|medium|low>` — default `high`.
- `--output-dir=<path>` — overrides the default fixture dir.
- `--overwrite` — replace existing files with the same id.
- `--dry-run` — print what would be written without touching disk.

The script auto-detects ASIN vs. UPC vs. EAN from the code shape,
synthesizes a "raw" retailer description for manifest fixtures from the
cached title, and writes photo sidecars with a placeholder `image_path`
the operator must replace with a real file. It does NOT download the
cached `image_urls` — retailer CDN ToS may forbid redistribution.

**Don't run this in CI.** It hits the live database. Run it manually
when refreshing the fixture pool.

## Cost-comparison workflow

The whole point of the harness: pick a quality-per-dollar winner.

```bash
# Baseline run: cheap default (Gemini Flash for vision, Flash-Lite for text).
LLM_MODEL_PHOTO_IDENTIFY_DEFAULT=google/gemini-2.5-flash \
LLM_MODEL_CODE_LOOKUP_DEFAULT=google/gemini-2.5-flash-lite \
npm run eval -- --suite=all --limit=30 \
  > reports/run-gemini.log

mv evals/reports/photo-id-*.json   evals/reports/photo-id-gemini.json
mv evals/reports/upc-lookup-*.json evals/reports/upc-lookup-gemini.json
mv evals/reports/manifest-classify-*.json evals/reports/manifest-classify-gemini.json

# Challenger run: Haiku 4.5 across the board.
LLM_MODEL_PHOTO_IDENTIFY_DEFAULT=anthropic/claude-haiku-4-5 \
LLM_MODEL_CODE_LOOKUP_DEFAULT=anthropic/claude-haiku-4-5 \
npm run eval -- --suite=all --limit=30

# Compare the .md reports side-by-side. Look for:
#   - aggregate metric deltas (similarity, brand/model match, category)
#   - total_cost_usd (does the better model still fit the budget?)
#   - mean / p95 latency (operator-facing tools have to feel responsive)
```

The `pricing.ts` table maps every supported model id to per-1M-token
input/output costs (and per-1k-search costs for grounded-search models
like Sonar and gpt-4o-search). Per-fixture cost is computed by the
`shared.ts` telemetry sink and rolled up into `aggregates.total_cost_usd`
in the report. **If the cost column in the report shows 0 for a model,
that model isn't in `MODEL_PRICING` — add a row before drawing
conclusions.**

### Worked example: Gemini Flash baseline

With the default config (Flash + Flash-Lite + Sonar) and a 30-fixture
suite per type:

- **photo-id (--fast)**: ~30 vision calls × ~1.5K input + 0.5K output
  tokens × $0.075/M input + $0.30/M output ≈ **$0.011 total cost**,
  ~3-5s/fixture.
- **upc-lookup**: ~30 text calls × ~0.4K input + 0.6K output × Flash-Lite
  rates ≈ **$0.0034 total cost**, ~5-8s/fixture (search latency).
- **manifest-classify**: same ballpark as upc-lookup ≈ **$0.0034**.
- **all three suites combined**: ~**$0.04 total** at the cheap defaults,
  ~3-8s per fixture mean latency.

A Haiku 4.5 challenger run on the same 90 fixtures runs ~25–35x more
expensive but typically lifts brand-match and model-match rates by a few
points on the adversarial fixtures (the hard ones — abbreviated Lowe's
descriptions, occluded photos). Whether that's worth $1.00 vs $0.04 is a
budget call; the harness exists so you can put both numbers next to each
other instead of guessing.

## Reading a report

Each run writes two files to `reports/`:

- `<suite>-<timestamp>.json` — full per-task data, machine-readable.
- `<suite>-<timestamp>.md` — human-readable summary table.

Look at the aggregates section first:

- `mean_title_similarity` >= 0.7 is the rough bar for "the model gets it".
- `brand_match_rate` and `model_match_rate` are blunt and unforgiving — that
  is the point. A model that gets the brand right 90% of the time but the
  model number 40% of the time is not actually useful for a liquidation
  auction listing.
- `mean_latency_ms` and `total_cost_usd` are the deciders when accuracy is
  close. The whole reason this harness exists is to say "Haiku is 8% worse
  but 4x cheaper — do we care?" with a number.

## Telemetry wiring (how cost gets into the report)

`runners/shared.ts::installEvalTelemetry()` runs once at the start of
each runner. It:

1. Lazily imports `src/ai/llm.ts` (after the CLI's API-key pre-flight).
2. Calls `setCostEstimator(...)` with the bound estimator from
   `evals/pricing.ts` so each LLM call attaches a `cost_estimate_usd`.
3. Calls `setTelemetrySink(...)` with a sink that buffers events.
4. Per fixture, `consumeTelemetry()` drains all events emitted during
   that call (handles escalation: a Flash → Haiku escalation produces
   two events, summed into one row).

If you change task names in `LlmTask`, also update
`SEARCH_CALLS_BY_TASK_PREFIX` in `pricing.ts` so search-fee attribution
stays correct for grounded-search tasks.

## Things humans need to do before this is fully useful

1. **Drop in real photo files** for the 30 photo sidecars. Most ground-truth
   fields are best-effort guesses based on documented public products —
   verify against the actual physical item (or its retail box) before
   using the photo suite to make a model-pricing decision.
2. **Run the cache generator** once you have ≥100 high-confidence
   `product_lookups` rows. Aim for ~100 fixtures per type before treating
   aggregate numbers as statistically meaningful.
3. **Verify the pricing table** in `evals/pricing.ts` — Perplexity and
   OpenAI search-preview pricing has churned multiple times in the past
   year. The flagged numbers in that file's header are the most likely
   to be stale.
4. **Set `LLM_MAX_ESCALATION_DEPTH=0`** when running an A/B between two
   tier-0 models, otherwise a low-confidence fixture will silently
   escalate to the more-expensive tier in the test under measurement.

## Why no external framework?

The popular options (LangSmith, Promptfoo, OpenAI Evals) buy you a UI and
a hosted run history we don't need yet. We don't want to send fixture data
to a third party, and our metrics are domain-specific (taxonomy-aware
category scoring, price band tolerance) in ways generic frameworks make
awkward. ~600 lines of TypeScript covers it. Revisit when we have >1000
fixtures or want cross-team review tooling.
