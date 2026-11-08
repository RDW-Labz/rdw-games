// PostHog client for the Expo app. Initialized on first signed-in session.

import PostHog from 'posthog-react-native';

let client: PostHog | null = null;
let initPromise: Promise<PostHog | null> | null = null;

export async function getPostHog(): Promise<PostHog | null> {
  if (client) return client;
  if (initPromise) return initPromise;

  const key = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (!key) return null;

  initPromise = (async () => {
    client = new PostHog(key, {
      host: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      flushInterval: 30_000,
      captureAppLifecycleEvents: true,
    });
    return client;
  })();
  return initPromise;
}

export async function identifyUser(userId: string | null) {
  const ph = await getPostHog();
  if (!ph) return;
  if (userId) ph.identify(userId);
  else await ph.reset();
}

// PostHog's TS types want `JsonType` values, not `unknown`. We accept the
// looser shape at the API boundary and stringify anything that doesn't fit
// (rare: this codebase only passes primitives/objects to track()).
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function toJson(v: unknown): JsonValue {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toJson(val);
    return out;
  }
  return String(v);
}

export async function track(event: string, props?: Record<string, unknown>) {
  const ph = await getPostHog();
  if (!ph) return;
  const safe: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(props ?? {})) safe[k] = toJson(v);
  ph.capture(event, safe);
}
