// Same-product image verification — the quality gate of the 2026-07-10
// stock-image overhaul.
//
// Problem it solves: the URL-Finder + page-fetch enrichment path extracts
// og:image / JSON-LD images from whatever retailer pages the search model
// surfaced. Most are right; some are a *related* product, a category
// banner, a retailer logo, or an "image unavailable" placeholder. Staff
// reported wrong stock images attached to lots ("still bad stock image
// scraping", 2026-07-10). Before this file there was NO check that an
// attached image actually depicts the identified product.
//
// One multimodal call per enrichment (NOT per image): all candidate URLs
// go in as image_url parts with detail:'low', the model returns a JSON
// verdict per image. gemini-3.1-flash-lite at detail:low costs roughly
// $0.0002-0.0005/call — negligible next to the $0.04-0.06 URL-Finder
// spend it protects.
//
// This is a QUALITY filter, not a security gate. The security boundary
// stays where it was: https-only, host checks, content-type + magic-byte
// sniffing in mirror-images.ts, and the fact that we serve mirrored bytes
// from our own bucket. Callers therefore FAIL OPEN when this call errors
// or returns unparseable JSON — a flaky verifier must never zero out
// coverage.

import { complete, type LlmMessage } from './llm';

export type ImageVerifyProduct = {
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  upc?: string | null;
  // The lot description — the operator's authoritative text. It reliably names
  // the real color/appearance even when the identified title's color guess is
  // wrong (2026-07-13 feedback), so the color check compares against it.
  description?: string | null;
};

// Hard cap on images per verification call. Enrichment produces ≤6
// candidates in practice; more than 8 low-detail images stops being
// "cheap" and the tail candidates are never attached anyway.
const MAX_IMAGES_PER_VERIFY = 8;

function productDescription(p: ImageVerifyProduct): string {
  const parts: string[] = [];
  if (p.title) parts.push(`Title: ${p.title}`);
  if (p.brand) parts.push(`Brand: ${p.brand}`);
  if (p.model) parts.push(`Model: ${p.model}`);
  if (p.upc) parts.push(`UPC: ${p.upc}`);
  if (p.description) parts.push(`Description: ${p.description}`);
  return parts.join('\n');
}

/**
 * Ask a cheap vision model which of `urls` plausibly depict `product`.
 *
 * Returns a boolean per URL (same order/length as the input, truncated
 * to MAX_IMAGES_PER_VERIFY), or `null` when verification could not run
 * (no product text to compare against, call error, unparseable JSON).
 * Callers should treat `null` as "unverified — keep current behavior",
 * i.e. fail open.
 */
export async function verifyImagesMatchProduct(
  product: ImageVerifyProduct,
  urls: string[],
): Promise<boolean[] | null> {
  const desc = productDescription(product);
  if (!desc) return null; // nothing to compare against
  const candidates = urls.slice(0, MAX_IMAGES_PER_VERIFY);
  if (candidates.length === 0) return null;

  const prompt =
    `You are checking candidate stock photos for an auction listing.\n\n` +
    `Product:\n${desc}\n\n` +
    `You were shown ${candidates.length} image(s), in order. For EACH image, ` +
    `decide whether it plausibly shows this exact product (a retailer stock ` +
    `photo of the same item).\n\n` +
    `COLOR: if the product text above names a specific color, an image showing ` +
    `a clearly DIFFERENT color is NOT a match — answer false for it. If no ` +
    `color is named, ignore color and treat finish/color variants of the same ` +
    `model as a match.\n\n` +
    `Answer false when the image is: a clearly different product, a category ` +
    `or promotional banner, a store/brand logo, a size chart or infographic, ` +
    `a blank/"image unavailable" placeholder, or otherwise not a product ` +
    `photo of this item.\n\n` +
    `Respond with ONLY this JSON, no prose:\n` +
    `{"matches": [true, false, ...]}  // exactly ${candidates.length} booleans, in image order`;

  // Build the multimodal message ourselves (remote image_url parts, not
  // base64) — complete()'s opts.images injection is for camera captures.
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [
        ...candidates.map((url) => ({
          type: 'image_url' as const,
          image_url: { url, detail: 'low' as const },
        })),
        { type: 'text' as const, text: prompt },
      ],
    },
  ];

  let parsed: Record<string, unknown> | null;
  try {
    parsed = await complete({ task: 'image_verify', schema: 'json', messages });
  } catch {
    return null;
  }
  if (!parsed) return null;

  const raw = (parsed as { matches?: unknown }).matches;
  if (!Array.isArray(raw)) return null;

  // Normalize to exactly candidates.length booleans. A short / sloppy
  // answer fails open (missing slots default to true) — never punish an
  // image because the model miscounted.
  return candidates.map((_, i) => {
    const v = raw[i];
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return true;
  });
}
