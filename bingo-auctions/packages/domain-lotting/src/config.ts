// Runtime configuration for the lotting AI calls. Apps inject their
// Anthropic key (and optional Cluer AI host for operators running
// their own on-prem model) at startup via setLottingConfig().
//
// The package is platform-agnostic — it makes raw fetch() calls and
// has no opinions about how secrets are loaded. The host app is
// responsible for reading its own env (process.env / EXPO_PUBLIC_… /
// import.meta.env) and registering values here.

export type LottingConfig = {
  /** Anthropic API key. Optional — only needed for Tier 2 AI fallback
   *  (scanPhoto/identifyPhoto/lookupCode/fetchPrices). */
  anthropicKey?: string;
  /** Anthropic model id. Defaults to claude-sonnet-4-20250514. */
  anthropicModel?: string;
  /** OpenRouter API key. Required for Tier 1 live lookups via
   *  web-search-enabled models (Perplexity Sonar etc.). Without this,
   *  lookups fall back to cache-only mode.
   *  Get a key at https://openrouter.ai/keys */
  openrouterKey?: string;
  /** eBay Browse API credentials — DEPRECATED / OPTIONAL.
   *
   *  eBay API access was denied (2025-05). The platform now uses
   *  OpenRouter web-search models (Perplexity Sonar) as the live-data
   *  source.  If eBay access is later restored, set these credentials and
   *  the eBay path will re-activate automatically alongside OpenRouter.
   *  Without these set, the eBay code-paths silently skip (no error).
   */
  ebay?: {
    clientId: string;
    clientSecret: string;
    /** 'PRODUCTION' (default) or 'SANDBOX'. */
    env?: 'PRODUCTION' | 'SANDBOX';
    /** Optional marketplace; defaults to EBAY_US. */
    marketplaceId?: string;
  };
  /** Optional Cluer AI server (OpenAI-compatible) for offline lookups. */
  cluer?: {
    host: string;
    apiKey?: string;
    model?: string;
    cfClientId?: string;
    cfClientSecret?: string;
  };
  /** 'auto' = Cluer first then Anthropic for web search, 'anthropic' =
   *  always Anthropic, 'cluer' = always Cluer (no web search). */
  mode?: 'auto' | 'anthropic' | 'cluer';
  /** Required to call from a browser without a server proxy. Set true
   *  on web; ignored on React Native. */
  allowDirectBrowserAccess?: boolean;
  /** Optional unblocked HTML fetcher for retailer product pages.
   *
   *  2026-07-10 (stock-image audit): url-fetcher's raw Worker fetch() is
   *  bot-blocked by most retailer WAFs (datacenter IP), which capped scraped
   *  stock-image coverage at ~1.6% of lots. The host app already owns an
   *  egress chain that solves this (operator-web's fetchViaEgress → Bright
   *  Data Web Unlocker → Playwright relay) — this hook lets it inject that
   *  chain without domain-lotting depending on app code. Return null on
   *  miss/blocked so the caller can fall back to the direct fetch. */
  fetchHtml?: (url: string) => Promise<{ html: string; finalUrl: string } | null>;
  /** Optional image mirror for enrichment candidates on hosts NOT in
   *  ALLOWED_IMAGE_HOSTS.
   *
   *  2026-07-10 (stock-image overhaul P1): page-extracted og:image /
   *  JSON-LD images from smaller retailers were silently discarded by
   *  the allowlist even though the page itself vouched for them. When
   *  this hook is set (operator-web injects mirrorImageToStorage with
   *  allowAnyHttpsHost via its service-role client), image-enrich
   *  downloads those candidates into the stock-images bucket and
   *  attaches the storage URL we own instead of hotlinking. Return the
   *  canonical storage URL, or null on any failure (caller skips that
   *  candidate). Server-side only — never set this on mobile. */
  mirrorImage?: (url: string) => Promise<string | null>;
};

let current: LottingConfig | null = null;

export function setLottingConfig(cfg: LottingConfig): void {
  current = cfg;
}

export function getLottingConfig(): LottingConfig {
  if (!current) {
    throw new Error(
      'domain-lotting is not configured. Call setLottingConfig({anthropicKey, ...}) at app startup.',
    );
  }
  return current;
}

export function hasLottingConfig(): boolean {
  return current !== null;
}
