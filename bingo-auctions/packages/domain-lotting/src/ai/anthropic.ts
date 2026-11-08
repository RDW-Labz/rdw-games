// Thin Anthropic client used by the lotting AI module. Mirrors the
// callAnthropic + parseJSON helpers from LotTR's src/ai.js, but
// strongly-typed and platform-agnostic (no Vite import.meta.env).

import { getLottingConfig } from '../config';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export type AnthropicMessageContent =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicMessageContent[];
};

export type AnthropicTool = {
  type: string;
  name: string;
};

export type AnthropicCallOptions = {
  tools?: AnthropicTool[];
  maxTokens?: number;
  retries?: number;
};

/**
 * @deprecated Since 2026-05-24 (PERF-8). Use `complete()` from `./llm`
 * instead, which routes through OpenRouter (Gemini Flash by default for
 * cheap tasks, gpt-4o-search-preview / Sonar for web-grounded tasks).
 *
 * The audit (`docs/state/AUDIT-bugs-and-optimizations-2026-05-24.md`)
 * measured a ~17× cost saving ($0.017/call → $0.001/call) on the three
 * `pricing.ts` consumers that previously used this function. Those
 * callers have been migrated; no in-tree code path invokes this any
 * more.
 *
 * Kept for one deploy cycle so external scripts / out-of-tree consumers
 * don't break on import. Will be removed in a follow-up PR after a week
 * of production observation confirms the OpenRouter path is stable.
 */
export async function callAnthropic(
  messages: AnthropicMessage[],
  opts: AnthropicCallOptions = {},
): Promise<string> {
  const cfg = getLottingConfig();
  if (!cfg.anthropicKey) {
    throw new Error(
      'callAnthropic: anthropicKey not configured. Set it via setLottingConfig() before invoking AI lookups.',
    );
  }
  const { tools, maxTokens = 2500, retries = 1 } = opts;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': cfg.anthropicKey,
    'anthropic-version': '2023-06-01',
  };
  if (cfg.allowDirectBrowserAccess) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const body: Record<string, unknown> = {
    model: cfg.anthropicModel ?? DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages,
  };
  if (tools) body['tools'] = tools;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if ((res.status === 529 || res.status === 503) && attempt < retries) {
        await sleep(2000);
        continue;
      }
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(
          `Anthropic ${res.status}: ${res.statusText}${
            errBody ? ' — ' + errBody.substring(0, 200) : ''
          }`,
        );
      }
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      return (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(1500);
    }
  }
  // Unreachable, but TypeScript wants a return.
  throw new Error('Anthropic call exhausted retries');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Robust JSON extraction. Anthropic occasionally wraps JSON in markdown
// code fences or trailing commentary; this parser handles both.
export function parseJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  let clean = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(clean) as T;
  } catch {
    /* fall through */
  }

  // Find outermost { } pair.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(clean.substring(start, i + 1)) as T;
        } catch {
          /* keep scanning */
        }
      }
    }
  }

  // Last-resort cleanup: strip trailing commas, swap single quotes.
  try {
    const a = clean.indexOf('{');
    const b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) {
      let sub = clean.substring(a, b + 1);
      sub = sub.replace(/,\s*([}\]])/g, '$1');
      sub = sub.replace(/'/g, '"');
      return JSON.parse(sub) as T;
    }
  } catch {
    /* give up */
  }

  return null;
}
