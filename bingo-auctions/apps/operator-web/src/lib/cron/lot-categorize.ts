// lot-categorize.ts — fills lots.category_id so items can be found, and so the
// Meta catalog feed has a product_type.
//
// 7,369 lots carry no canonical category. That is 41% of the live catalog feed
// going to Facebook with an empty product_type, which is the field Meta uses to
// decide who an item should be shown to. It costs money on the storefront too:
// over the last 30 days, lots with a real category drew 3.29 bidders and closed
// at $9.02, against 3.15 and $8.41 for uncategorised ones — and the
// uncategorised lots had HIGHER average MSRP ($179 vs $173), so it is not that
// they were worse items. Roughly $1,500/month.
//
// ── TWO TIERS, CHEAPEST FIRST ───────────────────────────────────────────────
// 1. Exact match. Many lots already carry free-text `category` from an import
//    ("Furniture", "Home & Kitchen › Furniture"). Where that text — or its last
//    breadcrumb segment — equals a canonical category name, we can assign it
//    with no model call at all. 719 lots qualify today.
// 2. The model, in batches. Everything else goes to a cheap text model, 25 lots
//    per call, with the canonical list in the prompt and the free text as a
//    hint. Batching is the whole cost story: 25 lots per call rather than 25
//    calls turns the backlog from dollars into cents.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It only ever fills a NULL category_id. A category a human chose is never
// overwritten, so running this repeatedly is safe and it can never fight the
// lotting staff. The model's answer is checked against the canonical list and
// discarded if it invented one — a free-text category field is exactly how the
// current mess (two overlapping taxonomies) came about, and this must not add
// a third.
//
// Writes category_id only, never the legacy free-text `category` column: the
// feed and the storefront both read the joined categories.name, and leaving the
// import's original text intact keeps the provenance readable.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { complete, setTelemetrySink } from '@auction-platform/domain-lotting/ai';
import { setLottingConfig } from '@auction-platform/domain-lotting';
import { startAiCallCapture } from '@/lib/ai-call-log';
import { ensureCostEstimatorRegistered } from '@/lib/register-cost-estimator';
import { checkAiBudget } from '@/lib/ai-budget';

/** Lots per model call. The prompt is a fixed cost per call, so batching is
 *  what makes the backlog affordable; 25 keeps the response comfortably inside
 *  a small model's output window. */
const LOTS_PER_CALL = 25;
/** Model calls per tick. On a five-minute cron this clears ~600 lots/hour, so
 *  the 7.4k backlog is gone in about half a day without a spend spike. */
const CALLS_PER_TICK = 2;

export interface CategorizeResult {
  skipped?: string;
  scanned: number;
  /** Assigned by exact name match — no model call. */
  matchedFree: number;
  /** Assigned by the model. */
  matchedAi: number;
  /** Model returned a name that is not in the canonical list. */
  rejected: number;
  costUsd: number;
  error?: string;
}

type LotRow = {
  id: string;
  title: string | null;
  description: string | null;
  category: string | null;
  status: string;
  operator_id: string;
};

/** Last segment of an Amazon-style breadcrumb: "Home & Kitchen › Bedding" →
 *  "Bedding". Import taxonomies are hierarchical and ours is flat, so the leaf
 *  is the part with a chance of matching. */
function leaf(text: string): string {
  const parts = text.split(/›|>|\//);
  return (parts[parts.length - 1] ?? text).trim();
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function runLotCategorize(): Promise<CategorizeResult> {
  const empty: CategorizeResult = {
    scanned: 0,
    matchedFree: 0,
    matchedAi: 0,
    rejected: 0,
    costUsd: 0,
  };

  const key = process.env.OPENROUTER_API_KEY?.trim();
  const db = getSupabaseAdmin();

  // The canonical list, read from the database rather than hardcoded — adding a
  // category in the admin must not require a deploy for this to start using it.
  const { data: cats, error: catErr } = await db
    .from('categories')
    .select('id, name')
    .order('name');
  if (catErr) return { ...empty, error: catErr.message };

  const categories = (cats ?? []) as Array<{ id: string; name: string }>;
  if (categories.length === 0) return { ...empty, skipped: 'no categories defined' };
  const byName = new Map(categories.map((c) => [norm(c.name), c.id]));

  // Live and scheduled lots first: those are the ones in the catalog feed and
  // on the storefront right now, so they are where a category changes an
  // outcome today. Closed lots still get done, just after.
  const { data: lots, error: lotErr } = await db
    .from('lots')
    .select('id, title, description, category, status, operator_id')
    .is('category_id', null)
    .not('title', 'is', null)
    .in('status', ['live', 'scheduled', 'won', 'unsold', 'in_inventory'])
    .order('status', { ascending: true })
    .limit(LOTS_PER_CALL * CALLS_PER_TICK);
  if (lotErr) return { ...empty, error: lotErr.message };

  const rows = (lots ?? []) as LotRow[];
  if (rows.length === 0) return { ...empty, skipped: 'nothing uncategorised' };

  const result: CategorizeResult = { ...empty, scanned: rows.length };

  /** Assign, but only ever onto a still-NULL category_id. The .is() guard is
   *  not redundant with the SELECT above: a lotter could have categorised the
   *  row in the seconds since, and their choice wins. */
  async function assign(lotId: string, categoryId: string): Promise<boolean> {
    const { error } = await db
      .from('lots')
      .update({ category_id: categoryId })
      .eq('id', lotId)
      .is('category_id', null);
    return !error;
  }

  // ── Tier 1: exact name match, free ────────────────────────────────────────
  const needsAi: LotRow[] = [];
  for (const row of rows) {
    const text = row.category?.trim();
    // "Other" is a real row in the categories table AND the string imports use
    // to mean "we didn't know". Matching it exactly is therefore the one case
    // where the free tier is confidently wrong: it files a loft bed, a hair
    // mask and a toilet-paper holder under Other and, because this job only
    // ever fills NULLs, guarantees nothing looks at them again. Unknown has to
    // reach the model, which is the thing that can actually tell them apart.
    const usableText = text && norm(text) !== 'other' ? text : null;
    const hit = usableText
      ? (byName.get(norm(usableText)) ?? byName.get(norm(leaf(usableText))))
      : undefined;
    // Same trap one level down: "Home & Kitchen > Other" must not leaf-match.
    const safeHit = hit && byName.get('other') === hit ? undefined : hit;
    if (safeHit) {
      if (await assign(row.id, safeHit)) result.matchedFree += 1;
    } else {
      needsAi.push(row);
    }
  }

  if (needsAi.length === 0 || !key) {
    if (!key && needsAi.length > 0) result.skipped = 'OPENROUTER_API_KEY not set; free tier only';
    return result;
  }

  // ── Tier 2: the model, batched ────────────────────────────────────────────
  //
  // One operator per tick. Spend has to be checked against, and charged to, a
  // single operator's monthly cap, and a batch spanning two of them could not
  // be attributed honestly to either. The busiest backlog goes first; the other
  // operator's lots are simply next tick's work.
  const byOperator = new Map<string, LotRow[]>();
  for (const r of needsAi) {
    const list = byOperator.get(r.operator_id) ?? [];
    list.push(r);
    byOperator.set(r.operator_id, list);
  }
  const [operatorId, operatorLots] = [...byOperator.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )[0]!;

  // Respect the operator's monthly AI cap BEFORE spending. Without this the
  // categoriser is a cron that can run 7,000 lots straight past a limit the
  // operator set — and because it also records what it spends (below), the cap
  // it checks against actually includes its own history.
  try {
    await checkAiBudget(operatorId);
  } catch (err) {
    if ((err as Error).message === 'ai_budget_exceeded') {
      return { ...result, skipped: 'ai_budget_exceeded' };
    }
    return { ...result, error: `budget check: ${(err as Error).message}` };
  }

  ensureCostEstimatorRegistered();
  setLottingConfig({ openrouterKey: key });
  const capture = startAiCallCapture();
  setTelemetrySink(capture.sink);

  const names = categories.map((c) => c.name);
  const needsAiForOperator = operatorLots;

  for (let i = 0; i < needsAiForOperator.length; i += LOTS_PER_CALL) {
    const batch = needsAiForOperator.slice(i, i + LOTS_PER_CALL);
    const items = batch.map((r, n) => ({
      n,
      title: (r.title ?? '').slice(0, 160),
      // A short slice of the description is usually enough to disambiguate
      // "Ottoman" or "Metal piece"; sending the whole thing 25 times over is
      // most of what a batch would cost.
      hint: (r.category ?? r.description ?? '').slice(0, 120),
    }));

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = await complete({
        task: 'description_generate',
        schema: 'json',
        messages: [
          {
            role: 'user',
            content:
              'You are categorising items in a liquidation auction. For each item, choose the single best category from this list, copying the name EXACTLY:\n\n' +
              names.map((n) => `- ${n}`).join('\n') +
              '\n\nItems:\n' +
              JSON.stringify(items) +
              '\n\nRespond with JSON only: {"results":[{"n":0,"category":"Furniture"}, ...]}. ' +
              'One entry per item, using the same n. If an item genuinely fits none of the categories, use "Other". ' +
              'Never invent a category name that is not in the list above.',
          },
        ],
      });
    } catch (err) {
      // A model failure is not worth failing the tick over — the rows stay
      // NULL and the next run picks them up. Recording it keeps a silent
      // outage visible in the cron's own output.
      result.error = `llm: ${(err as Error).message}`;
      break;
    }

    const answers = Array.isArray((parsed as { results?: unknown })?.results)
      ? ((parsed as { results: Array<{ n?: number; category?: string }> }).results ?? [])
      : [];

    for (const a of answers) {
      const row = typeof a.n === 'number' ? batch[a.n] : undefined;
      const name = typeof a.category === 'string' ? a.category : '';
      if (!row || !name) continue;
      const id = byName.get(norm(name));
      if (!id) {
        // Hallucinated a category. Dropping it is the point: a free-text
        // category column is how this table ended up with two taxonomies.
        result.rejected += 1;
        continue;
      }
      if (await assign(row.id, id)) result.matchedAi += 1;
    }
  }

  result.costUsd = capture.totalCostUsd();

  // Record the spend. This is not bookkeeping for its own sake: ai_calls is
  // what check_operator_ai_budget() sums, so an unrecorded call is one the cap
  // can never see. A cron that spends invisibly is exactly what the cap exists
  // to prevent, and at 7,000 lots it would have been the largest unlogged
  // consumer on the platform.
  //
  // task is 'lot_categorize' rather than the underlying 'description_generate'
  // so per-task reporting shows it as the system job it is. user_id is NOT NULL
  // on this table and a cron has no user, so it is attributed to a member of
  // the operator it charged — the distinct task name is what stops that reading
  // as a person clicking something.
  if (capture.totalCostUsd() > 0) {
    try {
      const { data: member } = await db
        .from('operator_users')
        .select('user_id')
        .eq('operator_id', operatorId)
        .limit(1)
        .maybeSingle();
      const userId = (member as { user_id?: string } | null)?.user_id;
      if (userId) {
        await db.from('ai_calls').insert({
          operator_id: operatorId,
          user_id: userId,
          task: 'lot_categorize',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          cost_cents: Math.round(capture.totalCostUsd() * 100),
          latency_ms: 0,
          cached: false,
          escalation_tier: 0,
        });
      }
    } catch (err) {
      // Never fail the tick over bookkeeping — the categorising already
      // succeeded and the rows are written.
      console.warn('[lot-categorize] ai_calls insert failed:', (err as Error).message);
    }
  }

  return result;
}
