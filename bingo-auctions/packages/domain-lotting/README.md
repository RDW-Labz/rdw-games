# @auction-platform/domain-lotting

Platform-agnostic business logic for lot classification and product enrichment.
Works in Next.js (server-side), Expo/React Native, and Node workers.

---

## Lookup ladder

Every UPC scan or keyword search follows the same path:

```
caller
  |
  v
[1] product_lookups cache   <-- warm hit returns in ~5ms, no API cost
  |  miss or stale
  v
[2] OpenRouter web-search   <-- Perplexity Sonar performs live web grounding;
  |  (default path)              returns active listings + sold comps as JSON
  |  confidence-escalated:
  |    tier 0: perplexity/sonar (default)
  |    tier 1: perplexity/sonar-pro
  |    tier 2: openai/gpt-4o-search-preview
  |
  v
[3] upsert into product_lookups  <-- cached for 14 days; future callers hit [1]
```

eBay is kept as a deprecated optional layer (`lookup/ebay.ts`). If
`EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` are set in the future, the eBay client
is available but it is not wired into the lookup flow in the current version.

---

## Environment variables

### Required for live lookups

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key. Get one at https://openrouter.ai/keys |

### Optional — Tier 2 AI fallback (photo classifier, AI-enrich)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for Tier 2 AI (photo_identify, shelf_scan escalation) |

### Model routing overrides

Every task has an env-var override for each tier. If not set, the defaults
from the table below are used.

| Task | Default model | Env var |
|---|---|---|
| `photo_identify` default | `google/gemini-2.5-flash` | `LLM_MODEL_PHOTO_IDENTIFY_DEFAULT` |
| `photo_identify` escalate-1 | `anthropic/claude-haiku-4-5` | `LLM_MODEL_PHOTO_IDENTIFY_ESCALATE_1` |
| `photo_identify` escalate-2 | `anthropic/claude-sonnet-4-6` | `LLM_MODEL_PHOTO_IDENTIFY_ESCALATE_2` |
| `code_lookup` default | `google/gemini-2.5-flash-lite` | `LLM_MODEL_CODE_LOOKUP_DEFAULT` |
| `keyword_search` default | `google/gemini-2.5-flash-lite` | `LLM_MODEL_KEYWORD_SEARCH_DEFAULT` |
| `description_generate` default | `google/gemini-2.5-flash-lite` | `LLM_MODEL_DESCRIPTION_GENERATE_DEFAULT` |
| `web_search_lookup` default | `perplexity/sonar` | `LLM_MODEL_WEB_SEARCH_LOOKUP_DEFAULT` |
| `web_search_lookup` escalate-1 | `perplexity/sonar-pro` | `LLM_MODEL_WEB_SEARCH_LOOKUP_ESCALATE_1` |
| `web_search_lookup` escalate-2 | `openai/gpt-4o-search-preview` | `LLM_MODEL_WEB_SEARCH_LOOKUP_ESCALATE_2` |
| `shelf_scan` default | `anthropic/claude-sonnet-4-6` | `LLM_MODEL_SHELF_SCAN_DEFAULT` |

### Escalation tuning

| Variable | Default | Description |
|---|---|---|
| `LLM_CONFIDENCE_THRESHOLD` | `0.65` | Numeric confidence below this triggers escalation to the next tier |
| `LLM_MAX_ESCALATION_DEPTH` | `1` | Maximum number of escalation tiers to attempt (0 = never escalate) |

### Worker

| Variable | Default | Description |
|---|---|---|
| `PRODUCT_CACHE_WARM_CONCURRENCY` | `5` | BullMQ worker concurrency for product-cache-warm jobs |

---

## `web_search_lookup` task semantics

The `web_search_lookup` task sends a structured JSON prompt to Perplexity
Sonar (or its escalation tiers). The model performs live web grounding
**internally** — we do not supply search results. The model queries retail
sites, extracts current prices and recent sold transactions, and returns
them in a schema we specify.

This means:
- No need to integrate retailer APIs or manage API keys per retailer.
- Freshness depends on the model's training / retrieval lag (Sonar: ~days;
  GPT-4o-search-preview: real-time).
- Results are non-deterministic — the same UPC may return different prices
  on consecutive calls. This is expected; the cache TTL (14 days) smooths it.

**Image URLs from Perplexity are filtered through `isSafeImageUrl()`** before
storage. Only hosts in the explicit `ALLOWED_IMAGE_HOSTS` allowlist in
`lookup/merge.ts` pass through. This is a security boundary — do not add
wildcard patterns.

---

## Escalation guidance

Perplexity Sonar is fast and cheap; use it for the bulk warm-up worker.
For high-value lots where accurate pricing matters (e.g. items >$500 MSRP),
set `LLM_MAX_ESCALATION_DEPTH=2` to allow the full three-tier cascade.

GPT-4o-search-preview (tier 2 escalation) is significantly more expensive.
Consider using it only via explicit operator action (not the nightly refresh).

---

## Known limitations

- **Perplexity sometimes returns no image URLs.** The merge function falls
  back gracefully: `image_urls` will be empty, and the lot will show a
  placeholder image in the UI. A later photo-scan (Tier 2) can fill this in.
- **Brand / model not extracted by default.** OpenRouter results don't have
  dedicated brand/model fields. The `mergeOpenRouterResults()` function sets
  both to `null` and relies on a downstream AI pass to fill them. Lots where
  brand resolution matters should trigger a `description_generate` or
  `photo_identify` call.
- **Sold-comp availability varies.** Perplexity Sonar can find sold listings
  on eBay and other platforms but coverage is inconsistent. When `sold_comps`
  is empty, `median_sold_cents` is null and `start_bid_cents` falls back to
  `avg_asking_cents * 0.25`.
