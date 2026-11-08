// Shared types for the evaluation harness fixtures and reports.
//
// These mirror the ground-truth shape we expect humans to label with —
// they are intentionally a SUPERSET of the runtime AI output (which lives
// in `../src/types.ts`). Extra fields (msrp_cents, photo_quality_label)
// only exist on the labeled side.

import type { Category, Condition, Confidence } from '../src/constants';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Common ground-truth fields shared by every fixture type. */
export type GroundTruth = {
  /** Human-readable canonical title. */
  title: string;
  brand: string;
  model: string;
  /** Platform taxonomy slug (e.g. 'power-tools'). See db/migrations/0018. */
  category_slug: string;
  /** LotTR-flavored category — the AI output uses this enum, not slugs. */
  category_legacy: Category;
  condition: Condition | '';
  /** Manufacturer suggested retail price, in cents. */
  msrp_cents: number;
};

/** A row from a retailer manifest CSV (Lowe's, Amazon Returns, etc). */
export type LabeledManifestRow = {
  id: string;
  source: 'lowes' | 'amazon' | 'wayfair' | 'home-depot' | 'target' | 'other';
  /** Raw retailer fields exactly as they appeared in the source CSV. */
  raw: {
    description: string;
    retailer_category?: string;
    upc?: string;
    model_number?: string;
    quantity?: number;
    /** Retailer-reported MSRP, in dollars (we coerce to cents in label). */
    retail_price?: number;
  };
  expected: GroundTruth & {
    /** Confidence we'd want the model to express on this row. */
    expected_confidence?: Confidence;
  };
  notes?: string;
};

/** A labeled product photo. */
export type LabeledPhoto = {
  id: string;
  /** Path relative to evals/fixtures/photos/. e.g. 'dewalt-drill-001.jpg' */
  image_path: string;
  /** image/jpeg | image/png | image/webp */
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Quality label so we can slice metrics by image difficulty. */
  photo_quality_label: 'clear' | 'blurry' | 'angled' | 'occluded' | 'dark';
  expected: GroundTruth & {
    /** Optional UPC if it's readable in the photo. */
    upc?: string;
    expected_confidence?: Confidence;
  };
  notes?: string;
};

/** A labeled UPC/ASIN lookup. */
export type LabeledUpcLookup = {
  id: string;
  /** UPC, EAN, or ASIN. */
  code: string;
  code_type: 'upc' | 'ean' | 'asin';
  expected: GroundTruth;
  notes?: string;
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Per-task telemetry captured by every runner. */
export type TaskTelemetry = {
  fixture_id: string;
  /** Resolved model id (read from telemetry hook on the LLM client). */
  model_id: string;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  /** USD, computed from token counts and a price table; null if unknown. */
  cost_usd: number | null;
  /** Whether the call returned anything parseable at all. */
  ok: boolean;
  error?: string;
};

/** Per-task scoring (one entry per fixture, per metric). */
export type TaskScore = {
  fixture_id: string;
  metrics: {
    title_similarity?: number;
    description_similarity?: number;
    brand_match?: 0 | 1;
    model_match?: 0 | 1;
    category_score?: number; // 0 | 0.5 | 1
    condition_match?: 0 | 1;
    price_within_band?: 0 | 1;
    price_mae_cents?: number;
  };
  expected: GroundTruth;
  actual: Partial<GroundTruth> & { msrp_cents?: number };
};

/** A complete eval run report. */
export type EvalReport = {
  suite: 'photo-id' | 'manifest-classify' | 'upc-lookup';
  run_id: string;
  started_at: string;
  finished_at: string;
  /** Model tier or specific model id requested at the CLI. */
  requested_model: string | null;
  fixture_count: number;
  /** Aggregate scores — means across the suite. */
  aggregates: {
    mean_title_similarity?: number;
    mean_description_similarity?: number;
    brand_match_rate?: number;
    model_match_rate?: number;
    mean_category_score?: number;
    condition_match_rate?: number;
    price_within_band_rate?: number;
    mean_price_mae_cents?: number;
    mean_latency_ms: number;
    p95_latency_ms: number;
    total_cost_usd: number;
    error_rate: number;
  };
  tasks: Array<TaskTelemetry & TaskScore>;
};
