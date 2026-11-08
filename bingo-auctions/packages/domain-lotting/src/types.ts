import type { Category, Condition, Confidence } from './constants';

export type RetailerPrice = {
  retailer: string;
  price: number;
  url: string;
};

export type PriceData = {
  prices: RetailerPrice[];
  stockPhotos: string[];
  msrp: number | null;
  avg: number | null;
  startBid: number | null;
  fullTitle: string;
  specs: string;
};

export type Identification = {
  title: string;
  brand: string;
  /**
   * Manufacturer's model number / SKU / part number. Includes retailer-specific
   * model codes operators commonly scan: Lowe's Item #, Home Depot Internet # /
   * Model #, Walmart Item #, furniture maker codes. Distinct from Amazon
   * identifiers (those go in asin/fnsku/lpn).
   */
  model: string;
  upc: string;
  category: Category;
  /**
   * One leaf of SUBCATEGORIES_BY_PARENT[category]. Empty string when AI
   * couldn't pick one or operator hasn't set yet. Used for finer-grained
   * filtering in reports without inventing new top-level categories.
   */
  subcategory: string;
  condition: Condition | '';
  description: string;
  /**
   * MSRP / List Price / Suggested Retail printed directly on the product or
   * packaging, as a numeric dollar value when visible (e.g. 24.99). null when
   * not printed on the photo. Independent of the enrichment-step MSRP which
   * comes from retailer pages — operators want both surfaced so a box-printed
   * MSRP can be compared against current retail.
   */
  packagingMsrp: number | null;
  searchQuery: string;
  confidence: Confidence;
  notes: string;
};

// Combined output from scanPhoto + lookupCode — ID fields plus price
// data plus the visibleText OCR list (only present from photo scans).
//
// Multi-identifier fields are optional — populated when the lookup resolved
// via a non-UPC identifier (e.g., ASIN from a competitor scrape) so the
// candidate card can show which identifier matched.
export type LotCandidate = Identification &
  PriceData & {
    visibleText?: string[];
    /** Amazon ASIN if known, e.g. B0DK7R7KWV. */
    asin?: string;
    /** Amazon Fulfillment Network SKU if known. */
    fnsku?: string;
    /** Amazon License Plate Number if known. */
    lpn?: string;
    /** Manufacturer part number / model number if known. */
    mpn?: string;
    /**
     * Structured vendor SKUs round-tripped onto the lot (migration 0188).
     * Populated from a manifest row's raw_data at lotting time (e.g. Wayfair
     * ProductSKU / SiteSKU / ManufactureSKU). Optional — only manifest-seeded
     * candidates carry them; catalog/AI candidates leave them undefined.
     * Mirrors the asin/fnsku/lpn optional-string convention above.
     */
    /** Cross-vendor item-level product SKU (Wayfair ProductSKU / Amazon MSKU). */
    productSku?: string;
    /** Site/merchant SKU (Wayfair SiteSKU / Amazon merchant SKU). */
    siteSku?: string;
    /** Manufacturer SKU (Wayfair ManufactureSKU / Lowe's-Walmart Model / MPN). */
    manufactureSku?: string;
    /**
     * Other plausible product matches from the SAME photo scan (Jared recap
     * 2026-07-07: identical retail boxes scanned twice returned different
     * products — staff want to pick from the top guesses instead of
     * discarding a wrong single answer). Vision-only candidates: no price
     * enrichment (that runs for the primary only; the picker's choice can
     * be enriched on demand via the existing lookup paths). Only ever set
     * on the TOP-LEVEL candidate returned by scanPhoto — never nested.
     */
    alternates?: LotCandidate[];
  };

export type ConditionWorkflowData = {
  condition?: string;
  damages?: string[];
  missing?: string[];
  functionality?: 'works' | 'partial' | 'broken' | 'untested';
  assembly?: 'assembled' | 'partial' | 'unassembled' | 'incomplete';
};
