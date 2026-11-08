// Provider-agnostic LLM client for domain-lotting.
//
// Uses the OpenRouter OpenAI-compatible REST API at
// https://openrouter.ai/api/v1 via raw fetch() — NOT the openai npm SDK,
// which pulls in Node-specific shims that break Expo/Metro bundling.
//
// Usage:
//   const result = await complete({ task: 'web_search_lookup', schema: 'json', messages });
//   // → parsed Record<string,unknown> when schema:'json', else string
//
// Model routing: each task has a default model plus optional escalation
// tiers. If the result JSON carries a `confidence` field below
// LLM_CONFIDENCE_THRESHOLD (default 0.65), the next tier is tried
// (capped at LLM_MAX_ESCALATION_DEPTH, default 1). Tasks marked
// escalationEnabled: false skip this logic entirely.

import { getLottingConfig } from '../config';
import { parseJson } from './anthropic';

// ---------------------------------------------------------------------------
// Task taxonomy
// ---------------------------------------------------------------------------

export type LlmTask =
  | 'photo_identify'        // vision + JSON; cheap default, confidence-escalated
  | 'code_lookup'           // text + JSON (UPC/ASIN lookup); cheap default, no escalation
  | 'keyword_search'        // text + JSON (cache keyword search); cheap default, no escalation
  | 'description_generate'  // text only; cheap default, no escalation
  | 'web_search_lookup'     // Perplexity-powered live product+price search; confidence-escalated
  | 'image_enrich'          // image-URL-only search; cheap Sonar with aggressive image prompt
  | 'image_verify'          // vision + JSON; "does this image show this product?" gate
  | 'shelf_scan';           // vision + JSON multi-object; always Sonnet, no escalation

// ---------------------------------------------------------------------------
// Message types (OpenAI-compatible)
// ---------------------------------------------------------------------------

export type LlmImageContent = {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
};

export type LlmTextContent = {
  type: 'text';
  text: string;
};

export type LlmMessageContent = string | Array<LlmTextContent | LlmImageContent>;

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: LlmMessageContent;
};

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export type LlmTelemetryEvent = {
  task: LlmTask;
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** 0 when the provider doesn't return cost in the response. */
  cost_estimate_usd: number;
  latency_ms: number;
  escalation_tier: number;
};

export type LlmTelemetrySink = (event: LlmTelemetryEvent) => void;

/**
 * Compute USD cost from token counts. Injected by the eval harness (or any
 * other observer) so the LLM client itself stays decoupled from a specific
 * pricing table. Returns `null` when the model is unknown to the estimator —
 * `cost_estimate_usd` will fall back to 0 in that case.
 */
export type LlmCostEstimator = (
  model: string,
  inputTokens: number,
  outputTokens: number,
) => number | null;

let _telemetrySink: LlmTelemetrySink = () => {
  // no-op by default
};

let _costEstimator: LlmCostEstimator | null = null;

export function setTelemetrySink(sink: LlmTelemetrySink): void {
  _telemetrySink = sink;
}

export function setCostEstimator(estimator: LlmCostEstimator | null): void {
  _costEstimator = estimator;
}

// ---------------------------------------------------------------------------
// Model routing table
// ---------------------------------------------------------------------------

/** Where this tier's request actually goes. 'openrouter' is the cloud
 *  default; 'ollama' routes to a local LAN-or-tunneled inference
 *  server (Ollama's OpenAI-compatible endpoint at /v1/chat/completions).
 *  Same request/response shape, different base URL + auth. */
export type LlmProvider = 'openrouter' | 'ollama';

type ModelTier = {
  model: string;
  provider: LlmProvider;
};

type TaskConfig = {
  /** Index 0 = default; 1+ = escalation tiers. In practice always ≥1
   *  entry because every task has at least one cloud fallback hard-
   *  coded; widened from the non-empty tuple type so the conditional
   *  Ollama tier spread compiles without an `as any`. The runtime
   *  loop's `if (!tier) break` already handles the empty case. */
  tiers: ModelTier[];
  escalationEnabled: boolean;
  maxTokens: number;
  requiresVision: boolean;
};

function readEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return (process.env as Record<string, string | undefined>)[key];
  }
  return undefined;
}

// Per-task Ollama tier. When LLM_PROVIDER_<TASK>=ollama is set, we
// prepend this onto the OpenRouter tiers — the existing escalation
// loop then naturally serves as "try local first, fall back to cloud
// on error / empty / low confidence." Returns null when local is not
// enabled for this task.
//
// Default vision model: nemotron3:33b (NVIDIA, 33B multimodal,
// distilled from Qwen3-VL + gpt-oss-120b). Higher quality than the
// llama3.2-vision:11b alternative; specifically trained on OCR + GUI
// which matches our product-label scan use case. Fits on a 3090
// (24GB VRAM) under Ollama's auto-selected Q4 quant, though it's
// tight — expect 3-6s per vision call vs 1-2s with the 11B option,
// and a 2-5s warm-up cost when Ollama swaps it in.
//
// Default text model: hermes3:8b. 8B class is the right size on a
// 3090 — fast, instruction-tuned, comfortably leaves room for the
// 33B vision model to be hot at the same time.
//
// The provider value is checked case-insensitively so 'Ollama' /
// 'OLLAMA' work too. Empty/unset = OpenRouter only (current behavior).
function ollamaTierForTask(
  task: LlmTask,
  defaultModel: string,
): ModelTier | null {
  const upper = task.toUpperCase();
  const providerRaw = readEnv(`LLM_PROVIDER_${upper}`);
  const enabled =
    typeof providerRaw === 'string' && providerRaw.trim().toLowerCase() === 'ollama';
  if (!enabled) return null;
  const model = readEnv(`LLM_MODEL_${upper}_OLLAMA`) ?? defaultModel;
  return { model, provider: 'ollama' };
}

function buildTaskConfigs(): Record<LlmTask, TaskConfig> {
  // Pre-compute every Ollama tier so the conditional spreads below stay
  // readable. Vision tasks get a vision-capable default; text tasks get
  // an 8B instruction-tuned default — both swappable via
  // LLM_MODEL_<TASK>_OLLAMA env vars without code changes.
  const ollamaPhotoIdentify = ollamaTierForTask('photo_identify', 'nemotron3:33b');
  const ollamaCodeLookup = ollamaTierForTask('code_lookup', 'hermes3:8b');
  const ollamaKeywordSearch = ollamaTierForTask('keyword_search', 'hermes3:8b');
  const ollamaDescriptionGen = ollamaTierForTask('description_generate', 'hermes3:8b');
  const ollamaShelfScan = ollamaTierForTask('shelf_scan', 'nemotron3:33b');
  // Web-search tasks: Ollama can't perform web search, so we intentionally
  // skip the local tier and stay on Sonar. Users can override via env if
  // they want, but the default config refuses.
  const ollamaWebSearch = null;
  const ollamaImageEnrich = null;

  // ── Cloud-model defaults (2026-05-14) ─────────────────────────────────
  // Promoted to Gemini 3.1 flash-lite for vision + text tasks. Gemini 3.x
  // generation is meaningfully better at instruction following than 2.5,
  // and flash-lite is still the cheapest stable tier at $0.25/$1.50 per
  // M tokens. shelf_scan stays on Sonnet 4.6 because multi-SKU pallet
  // detection genuinely benefits from the bigger model.
  //
  // maxTokens caps raised across the board after a production audit of
  // OpenRouter logs (2026-05-14) showed Nemotron 30B reasoning hitting
  // 2000-token cutoffs on every photo_identify scan — `finish_reason:
  // length`, no parseable JSON, cascade to Haiku, $0.004 per "free"
  // scan. New caps give reasoning models breathing room AND prevent the
  // cascade from silently doubling cost when a slow first tier loops.
  return {
    photo_identify: {
      tiers: [
        // Local-first tier (only present when LLM_PROVIDER_PHOTO_IDENTIFY=ollama).
        ...(ollamaPhotoIdentify ? [ollamaPhotoIdentify] : []),
        // 2026-07-09: owner reviewed the AI-matrix report (72 cells, real
        // intake photos, Haiku vs Sonnet vs Flash-Lite on the live prompt)
        // and picked Flash-Lite's output — it stays the default. The staff
        // complaints ("confidently wrong single answer", "never saw the
        // top-3 picker") are addressed model-independently by the same-day
        // fixes: the numeric confidence_score is now actually read
        // (normalize/identification.ts) and the prompt requires 2-4
        // alternates unless an exact identifier was literally read.
        // Haiku/Sonnet remain the error-escalation tiers.
        {
          model: readEnv('LLM_MODEL_PHOTO_IDENTIFY_DEFAULT') ?? 'google/gemini-3.1-flash-lite',
          provider: 'openrouter',
        },
        {
          model: readEnv('LLM_MODEL_PHOTO_IDENTIFY_ESCALATE_1') ?? 'anthropic/claude-haiku-4-5',
          provider: 'openrouter',
        },
        {
          model: readEnv('LLM_MODEL_PHOTO_IDENTIFY_ESCALATE_2') ?? 'anthropic/claude-sonnet-4-6',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: true,
      maxTokens: 8000,
      requiresVision: true,
    },

    code_lookup: {
      tiers: [
        ...(ollamaCodeLookup ? [ollamaCodeLookup] : []),
        {
          model: readEnv('LLM_MODEL_CODE_LOOKUP_DEFAULT') ?? 'google/gemini-3.1-flash-lite',
          provider: 'openrouter',
        },
      ],
      // Single-cloud-tier tasks: enable escalation ONLY when an Ollama
      // tier is present, so a local miss/error still falls back to the
      // cloud. Without ollama, behavior is unchanged from before.
      escalationEnabled: Boolean(ollamaCodeLookup),
      maxTokens: 4000,
      requiresVision: false,
    },

    keyword_search: {
      tiers: [
        ...(ollamaKeywordSearch ? [ollamaKeywordSearch] : []),
        {
          model: readEnv('LLM_MODEL_KEYWORD_SEARCH_DEFAULT') ?? 'google/gemini-3.1-flash-lite',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: Boolean(ollamaKeywordSearch),
      maxTokens: 5000,
      requiresVision: false,
    },

    description_generate: {
      tiers: [
        ...(ollamaDescriptionGen ? [ollamaDescriptionGen] : []),
        {
          model:
            readEnv('LLM_MODEL_DESCRIPTION_GENERATE_DEFAULT') ?? 'google/gemini-3.1-flash-lite',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: Boolean(ollamaDescriptionGen),
      maxTokens: 2500,
      requiresVision: false,
    },

    // Web-search tasks stay cloud-only. Sonar's live web-grounding has
    // no local equivalent — letting Ollama serve this path would silently
    // degrade UPC enrichment to a hallucinated catalog row.
    //
    // Default swapped 2026-05-15 from perplexity/sonar → gpt-4o-search-preview
    // after the mega-sim (scripts/lottr-smoke/run-sonar.mjs, run
    // 2026-05-15T01-35) showed:
    //   - sonar      caught MSRP on 6/12 (50%) at $0.0008/call
    //   - sonar-pro  caught MSRP on 4/12 (33%) at $0.0037/call  (WORSE)
    //   - gpt-4o     caught MSRP on 11/12 (92%) at $0.0027/call
    // sonar-pro is genuinely worse than vanilla sonar AND costs 4×; we
    // removed it from the escalation chain entirely. gpt-4o-search-preview
    // is now the default. sonar stays as the only fallback for when
    // gpt-4o is rate-limited or down.
    web_search_lookup: {
      tiers: [
        ...(ollamaWebSearch ? [ollamaWebSearch] : []),
        {
          model:
            readEnv('LLM_MODEL_WEB_SEARCH_LOOKUP_DEFAULT') ?? 'openai/gpt-4o-search-preview',
          provider: 'openrouter',
        },
        {
          model: readEnv('LLM_MODEL_WEB_SEARCH_LOOKUP_ESCALATE_1') ?? 'perplexity/sonar',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: true,
      maxTokens: 6000,
      requiresVision: false,
    },

    image_enrich: {
      tiers: [
        ...(ollamaImageEnrich ? [ollamaImageEnrich] : []),
        {
          model: readEnv('LLM_MODEL_IMAGE_ENRICH_DEFAULT') ?? 'perplexity/sonar',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: false,
      maxTokens: 2000,
      requiresVision: false,
    },

    // Same-product image verification (2026-07-10 stock-image overhaul).
    // One cheap multimodal call per enrichment: candidate stock-image
    // URLs go in as image_url parts (detail:low), the model answers
    // per-image whether it plausibly shows the identified product.
    // Quality filter, not a security gate — callers fail open when the
    // call errors. requiresVision is false on purpose: the caller
    // builds its own image_url content parts from remote URLs (no
    // base64), so the opts.image/images injection path never fires.
    image_verify: {
      tiers: [
        {
          model: readEnv('LLM_MODEL_IMAGE_VERIFY_DEFAULT') ?? 'google/gemini-3.1-flash-lite',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: false,
      maxTokens: 1000,
      requiresVision: false,
    },

    shelf_scan: {
      tiers: [
        ...(ollamaShelfScan ? [ollamaShelfScan] : []),
        {
          model: readEnv('LLM_MODEL_SHELF_SCAN_DEFAULT') ?? 'anthropic/claude-sonnet-4-6',
          provider: 'openrouter',
        },
      ],
      escalationEnabled: Boolean(ollamaShelfScan),
      maxTokens: 8000,
      requiresVision: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Escalation depth (error-failover only)
// ---------------------------------------------------------------------------
//
// LLM_MAX_ESCALATION_DEPTH caps how many fallback tiers we walk through
// when an API call fails or JSON parsing fails. Default 1 = "try one
// backup tier on failure, then surface the error." Confidence-based
// escalation was removed 2026-05-13 — Nemotron's medium-confidence
// returns no longer trigger a (slow) Haiku/Sonnet retry. Quality stays
// at whatever the picked model produces; downstream cost gates use
// the confidence string but don't re-call the model.

function maxEscalationDepth(): number {
  const raw = readEnv('LLM_MAX_ESCALATION_DEPTH');
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 1 : Math.max(0, n);
}

// ---------------------------------------------------------------------------
// OpenRouter HTTP types
// ---------------------------------------------------------------------------

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

type OrMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

type OrMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OrMessageContentPart[];
};

type OrRequest = {
  model: string;
  messages: OrMessage[];
  max_tokens?: number;
  response_format?: { type: 'json_object' };
  /**
   * OpenRouter-specific: setting `usage.include = true` instructs the
   * gateway to include the upstream provider's $-denominated cost on
   * the response. Without this, only token counts come back and we'd
   * need our own pricing table to compute USD — historically that
   * table drifted out of date and ai_calls.cost_cents ended up at 0
   * for every row (production audit 2026-05-15).
   *
   * Provider docs: https://openrouter.ai/docs/use-cases/usage-accounting
   */
  usage?: { include: boolean };
};

type OrResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * Upstream-provider-denominated cost in USD. Only present when the
     * request body included `usage.include = true`. May be 0 for
     * promotional / free-tier models (e.g. some Nemotron variants);
     * may be null/absent for providers that haven't published pricing
     * to OpenRouter. Treat as best-effort.
     */
    cost?: number;
  };
  error?: { message?: string };
};

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_RE = /\b(429|500|502|503|529)\b/;
const MAX_RETRIES = 2;

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) return RETRYABLE_STATUS_RE.test(err.message);
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt >= MAX_RETRIES) throw e;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Low-level OpenRouter call
// ---------------------------------------------------------------------------

async function callOpenRouter(
  apiKey: string,
  req: OrRequest,
  signal?: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number; cost: number }> {
  // Always include usage accounting so ai_calls.cost_cents is populated
  // from the provider's authoritative number, not our local pricing
  // table (which drifts).
  const reqWithUsage: OrRequest = { ...req, usage: { include: true } };

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://auction-platform.internal',
      'X-Title': 'auction-platform/domain-lotting',
    },
    body: JSON.stringify(reqWithUsage),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `OpenRouter ${res.status} ${res.statusText}${body ? ' — ' + body.substring(0, 300) : ''}`,
    );
  }

  const data = (await res.json()) as OrResponse;

  if (data.error) {
    throw new Error(`OpenRouter API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    // Cost in USD. May be 0 for free/promotional tiers or undefined if
    // OpenRouter doesn't have pricing for the provider. Default to 0.
    cost: typeof data.usage?.cost === 'number' && data.usage.cost > 0 ? data.usage.cost : 0,
  };
}

// ---------------------------------------------------------------------------
// Ollama (local) — same OpenAI-compatible /v1/chat/completions shape as
// OpenRouter, just a different base URL + auth. Defaults to the user's
// LAN server at 10.10.10.210:11434 and is configurable via
// LLM_OLLAMA_BASE_URL. Timeout is short by design (default 20s) so a
// stalled/offline server falls back to the cloud tier fast.
// ---------------------------------------------------------------------------

const OLLAMA_DEFAULT_BASE_URL = 'http://10.10.10.210:11434/v1';

function ollamaBaseUrl(): string {
  return readEnv('LLM_OLLAMA_BASE_URL') ?? OLLAMA_DEFAULT_BASE_URL;
}

function ollamaTimeoutMs(): number {
  const raw = readEnv('LLM_OLLAMA_TIMEOUT_MS');
  if (!raw) return 20_000;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 20_000 : Math.max(2_000, n);
}

// Optional Cloudflare Access service-token headers — used when the
// Ollama endpoint is fronted by Cloudflare Access (Zero Trust). Worker
// sets OLLAMA_CF_ACCESS_CLIENT_ID + OLLAMA_CF_ACCESS_CLIENT_SECRET and
// CF accepts the request without an interactive login. When both are
// empty (typical for LAN-only Ollama), the function returns no extra
// headers and the call goes through unauthenticated.
function ollamaCfAccessHeaders(): Record<string, string> {
  const id = readEnv('OLLAMA_CF_ACCESS_CLIENT_ID') ?? '';
  const secret = readEnv('OLLAMA_CF_ACCESS_CLIENT_SECRET') ?? '';
  if (!id || !secret) return {};
  return {
    'CF-Access-Client-Id': id,
    'CF-Access-Client-Secret': secret,
  };
}

async function callOllama(
  req: OrRequest,
  signal?: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const t = setTimeout(() => ctl.abort(), ollamaTimeoutMs());

  let res: Response;
  try {
    res = await fetch(`${ollamaBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ollama ignores the bearer but the SDK shape expects one. The
        // schema doc the user provided uses 'ollama' as the placeholder.
        Authorization: 'Bearer ollama',
        // CF Access service-token auth when the Ollama endpoint is
        // fronted by Cloudflare Zero Trust. No-op when env vars unset.
        ...ollamaCfAccessHeaders(),
      },
      // Ollama dislikes the OpenAI-only response_format hint on some
      // versions. Strip it; the prompt + parseJson() already handle
      // JSON shape on the parsing side.
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.max_tokens,
        stream: false,
      }),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
    // Normalize timeout/abort/network errors with a 502-shaped message
    // so isRetryable() treats them as retryable in the same way.
    const msg = (err as Error).name === 'AbortError' ? 'Ollama 502 timeout' : `Ollama 502 ${(err as Error).message}`;
    throw new Error(msg);
  }
  clearTimeout(t);
  if (signal) signal.removeEventListener('abort', onAbort);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Ollama ${res.status} ${res.statusText}${body ? ' — ' + body.substring(0, 300) : ''}`,
    );
  }

  const data = (await res.json()) as OrResponse;
  if (data.error) {
    throw new Error(`Ollama API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Image helper
// ---------------------------------------------------------------------------

function toDataUri(base64: string, mediaType: string): string {
  if (base64.startsWith('data:')) return base64;
  return `data:${mediaType};base64,${base64}`;
}

// ---------------------------------------------------------------------------
// Main complete() API
// ---------------------------------------------------------------------------

export type CompleteOptions = {
  task: LlmTask;
  messages: LlmMessage[];
  /**
   * Single-image convenience param. Either `image` or `images` may be
   * provided for vision tasks; `images` takes precedence when both set.
   * Kept for backwards compatibility with callers that only ever send
   * one shot. Internally the loop walks the union.
   */
  image?: { base64: string; mediaType: string };
  /**
   * Multi-image input — pass up to 3 angles of the same product. Each
   * image becomes its own `image_url` content part attached to the
   * last user message, in order. Cap is enforced here (we silently
   * truncate to 3) so callers can pass as many as they want and the
   * downstream cost stays predictable.
   */
  images?: Array<{ base64: string; mediaType: string }>;
  /** If 'json', the response is JSON-parsed and returned. */
  schema?: 'json';
  signal?: AbortSignal;
};

// Cap multi-image vision input. 3 angles is the practical max from a
// shutter-button camera flow (hero + 2 condition shots); beyond that
// latency and input-token cost grow without the marginal text-extract
// win that drove this feature.
const MAX_IMAGES_PER_CALL = 3;

export type CompleteResult<Schema extends 'json' | undefined> = Schema extends 'json'
  ? Record<string, unknown> | null
  : string;

export async function complete<Schema extends 'json' | undefined = undefined>(
  opts: CompleteOptions & { schema?: Schema },
): Promise<CompleteResult<Schema>> {
  const cfg = getLottingConfig();
  // OPENROUTER_API_KEY via config takes precedence, then env var.
  const openrouterKey =
    cfg.openrouterKey ?? readEnv('OPENROUTER_API_KEY') ?? '';

  const taskConfigs = buildTaskConfigs();
  const taskCfg = taskConfigs[opts.task];
  // OpenRouter key is required only if at least one tier needs it. If
  // every tier is local (no cloud fallback configured) then a missing
  // key is fine — though in practice we always keep a cloud fallback,
  // so this branch primarily protects fully-local dev setups.
  const needsOpenRouter = taskCfg.tiers.some((t) => t.provider === 'openrouter');
  if (needsOpenRouter && !openrouterKey) {
    throw new Error(
      'domain-lotting LLM: OPENROUTER_API_KEY is not set. ' +
        'Pass openrouterKey in setLottingConfig() or set the env var.',
    );
  }
  const maxDepth = maxEscalationDepth();

  // Build the OpenRouter-format message list.
  function buildOrMessages(): OrMessage[] {
    const out: OrMessage[] = [];
    const lastUserIdx = [...opts.messages].reduceRight(
      (found, m, i) => (found === -1 && m.role === 'user' ? i : found),
      -1,
    );

    opts.messages.forEach((m, i) => {
      const contentParts = ((): OrMessage['content'] => {
        if (typeof m.content === 'string') return m.content;
        return m.content.map((c): OrMessageContentPart => {
          if (c.type === 'image_url') {
            return { type: 'image_url', image_url: c.image_url };
          }
          return { type: 'text', text: (c as LlmTextContent).text };
        });
      })();

      // Inject image(s) into last user message for vision tasks.
      // `images` (array) takes precedence when both are set; otherwise
      // fall back to `image` (single) for backwards compat. Cap at
      // MAX_IMAGES_PER_CALL so a caller passing many doesn't blow the
      // input-token budget.
      const imageList = (() => {
        if (opts.images && opts.images.length > 0) {
          return opts.images.slice(0, MAX_IMAGES_PER_CALL);
        }
        if (opts.image) return [opts.image];
        return [];
      })();

      if (
        imageList.length > 0 &&
        taskCfg.requiresVision &&
        m.role === 'user' &&
        i === lastUserIdx
      ) {
        const imageBlocks: OrMessageContentPart[] = imageList.map((img) => ({
          type: 'image_url',
          image_url: {
            url: toDataUri(img.base64, img.mediaType),
            detail: 'high',
          },
        }));
        const textBlocks: OrMessageContentPart[] =
          typeof contentParts === 'string'
            ? [{ type: 'text', text: contentParts }]
            : contentParts;
        // Image parts first so the model sees them before reading the
        // instruction text (matches how every multimodal example in
        // OpenAI / Anthropic docs structures it).
        out.push({ role: 'user', content: [...imageBlocks, ...textBlocks] });
      } else {
        out.push({ role: m.role, content: contentParts });
      }
    });
    return out;
  }

  const orMessages = buildOrMessages();

  let lastText = '';

  for (let tierIdx = 0; tierIdx < taskCfg.tiers.length; tierIdx++) {
    const tier = taskCfg.tiers[tierIdx];
    if (!tier) break;

    // Respect max escalation depth (depth 0 = default tier).
    if (tierIdx > 0 && tierIdx > maxDepth) break;

    // Models with built-in web search reject `response_format: { type: 'json_object' }`.
    // Perplexity Sonar and OpenAI's *-search-preview models both error out with
    // "Response format 'json_object' is not supported with web_search." We rely
    // on the prompt + parseJson() for these; OpenAI/Anthropic/Gemini chat
    // completions still honor json_object so we keep it for those.
    const isWebSearchModel =
      /^perplexity\//i.test(tier.model) ||
      /sonar/i.test(tier.model) ||
      /-search(-preview)?$/i.test(tier.model);
    const useResponseFormat = opts.schema === 'json' && !isWebSearchModel;

    const req: OrRequest = {
      model: tier.model,
      messages: orMessages,
      max_tokens: taskCfg.maxTokens,
      ...(useResponseFormat ? { response_format: { type: 'json_object' } } : {}),
    };

    const t0 = Date.now();
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let upstreamCostUsd = 0;
    let tierError: Error | null = null;

    try {
      // Per-tier provider dispatch. Ollama tiers go to the local server;
      // openrouter tiers go to the cloud. Same OpenAI-shaped req/response.
      // We DON'T withRetry() the Ollama call — if it's down, we want to
      // fall through to the cloud tier fast, not eat 2 backoff cycles.
      if (tier.provider === 'ollama') {
        const result = await callOllama(req, opts.signal);
        text = result.text;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
      } else {
        const result = await withRetry(() => callOpenRouter(openrouterKey, req, opts.signal));
        text = result.text;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        upstreamCostUsd = result.cost;
      }
    } catch (err) {
      tierError = err as Error;
    }

    const latencyMs = Date.now() - t0;

    // Emit telemetry on BOTH success and failure paths. Failures were
    // previously invisible (the emission was post-try-block), which is
    // why Sonar/gpt-4o-search failures don't show up in ai_calls —
    // production audit 2026-05-15 on the Morphe scan showed zero
    // web_search_lookup rows because the calls were failing silently.
    // Now every attempt is recorded; failed tiers show cost=0 and 0
    // tokens but the row exists so we can correlate to the lot.
    try {
      // Stamp the provider on the model string so ai_calls clearly
      // distinguishes local vs cloud — "ollama/llama3.2-vision:11b"
      // vs "google/gemini-2.5-flash". For openrouter, prefer the
      // upstream-reported cost (always present when usage.include is
      // set); fall back to the local pricing table if we ever lose
      // upstream cost (free models, etc.).
      const stampedModel =
        tier.provider === 'ollama' ? `ollama/${tier.model}` : tier.model;
      let costEstimateUsd = 0;
      if (tier.provider === 'ollama') {
        costEstimateUsd = 0; // your electricity
      } else if (upstreamCostUsd > 0) {
        costEstimateUsd = upstreamCostUsd;
      } else if (_costEstimator) {
        try {
          const c = _costEstimator(tier.model, inputTokens, outputTokens);
          if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
            costEstimateUsd = c;
          }
        } catch {
          // swallow — pricing table is best-effort.
        }
      }
      _telemetrySink({
        task: opts.task,
        model: stampedModel,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_estimate_usd: costEstimateUsd,
        latency_ms: latencyMs,
        escalation_tier: tierIdx,
      });
    } catch {
      // swallow
    }

    if (tierError) {
      // On intermediate tier error with escalation enabled, continue; on
      // the final tier (or non-escalating tasks), rethrow. This is also
      // what makes "ollama-first, openrouter-fallback" work: an Ollama
      // failure on tier 0 falls through to tier 1 (openrouter) below.
      if (taskCfg.escalationEnabled && tierIdx < taskCfg.tiers.length - 1) {
        continue;
      }
      throw tierError;
    }

    lastText = text;

    // No schema — return text immediately.
    if (opts.schema !== 'json') {
      return text as CompleteResult<Schema>;
    }

    // Parse JSON.
    const parsed = parseJson<Record<string, unknown>>(text);

    // Failover on parse failure: if the model returned non-JSON, the
    // next tier gets a shot. This is the only "quality" failover we do
    // — confidence-based escalation was removed (2026-05-13) to land
    // on a single model per task and keep response time predictable.
    // The error-handler above already cascades on API failures.
    if (parsed === null && taskCfg.escalationEnabled && tierIdx < taskCfg.tiers.length - 1) {
      continue;
    }

    // Whatever the model returned — even low confidence — is what the
    // caller gets. Downstream code (cost gate in identification.ts,
    // catalog write-through) decides what to do with it. Keeping the
    // pipeline single-call saves the ~5-15s round trip that a
    // confidence escalation used to add.
    return parsed as CompleteResult<Schema>;
  }

  // Exhausted all tiers.
  if (opts.schema === 'json') {
    return parseJson<Record<string, unknown>>(lastText) as CompleteResult<Schema>;
  }
  return lastText as CompleteResult<Schema>;
}
