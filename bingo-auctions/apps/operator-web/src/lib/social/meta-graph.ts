// Meta Graph API client — Facebook Page + Instagram publishing.
//
// Deliberately the ONLY file that knows Graph exists. Everything above it deals
// in "post this, take that down", so the composition and scheduling logic can
// be read, reviewed and tested without a token — which matters here because the
// credentials do not exist yet and the rest of the feature should not wait.
//
// ── CREDENTIALS ──────────────────────────────────────────────────────────────
// Read from env at call time, never at module load, so importing this file in a
// test or a build never demands secrets that only production has:
//
//   META_PAGE_ACCESS_TOKEN   system-user token (does NOT expire — a plain page
//                            token lapses in ~60d and the bot dies silently on
//                            a weekend, which is the failure to design out)
//   META_PAGE_ID             the Facebook Page
//   META_IG_USER_ID          the linked Instagram BUSINESS account
//
// These belong in Worker secrets alongside SQUARE_*, never in the database:
// social_posts is readable by any operator staff, and this token can post as
// the business.
//
// ── WHY INSTAGRAM IS TWO CALLS ───────────────────────────────────────────────
// Facebook publishes in one request. Instagram does not: you create a media
// CONTAINER, then publish it, and the container needs a moment to finish
// ingesting the image. Treating IG like FB is the classic first bug here — the
// publish call 400s because the container is not ready.

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface MetaCredentials {
  token: string;
  pageId: string;
  igUserId: string | null;
}

/** Missing credentials are a CONFIGURATION state, not an exception — the
 *  scheduler needs to skip cleanly and say so, not crash a cron run. */
export function readMetaCredentials(): MetaCredentials | null {
  const token = process.env.META_PAGE_ACCESS_TOKEN?.trim();
  const pageId = process.env.META_PAGE_ID?.trim();
  if (!token || !pageId) return null;
  return {
    token,
    pageId,
    igUserId: process.env.META_IG_USER_ID?.trim() || null,
  };
}

export interface PostResult {
  ok: boolean;
  remotePostId?: string;
  permalink?: string;
  error?: string;
}

/** Graph reports failures as HTTP 200 with an `error` body about as often as it
 *  uses a 4xx, so both paths have to be handled or failures look like successes
 *  and social_posts fills with 'posted' rows that never existed. */
async function graph(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const body = new URLSearchParams({ ...params, access_token: token });
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}`, { method: 'POST', body });
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `non-JSON response (HTTP ${res.status})` };
  }

  const apiErr = json.error as { message?: string; code?: number; error_subcode?: number } | undefined;
  if (apiErr) {
    // Surface code + subcode: a permissions failure (code 200 / 10) means App
    // Review is the blocker, which is a completely different fix from a bad
    // token (190). Collapsing them to "failed" costs a debugging round.
    const code = apiErr.code != null ? ` [code ${apiErr.code}${apiErr.error_subcode ? `/${apiErr.error_subcode}` : ''}]` : '';
    return { ok: false, error: `${apiErr.message ?? 'unknown Graph error'}${code}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  return { ok: true, data: json };
}

/** Publish a link post with a caption to the Facebook Page. */
export async function postToFacebookPage(
  creds: MetaCredentials,
  message: string,
  link: string,
): Promise<PostResult> {
  const r = await graph(`${creds.pageId}/feed`, { message, link }, creds.token);
  if (!r.ok) return { ok: false, error: r.error };
  const id = r.data.id as string | undefined;
  if (!id) return { ok: false, error: 'Graph returned no post id' };
  return {
    ok: true,
    remotePostId: id,
    permalink: `https://www.facebook.com/${id.replace('_', '/posts/')}`,
  };
}

/**
 * Publish a single image to Instagram. Two-step, with a bounded wait.
 *
 * The image must be a PUBLICLY reachable URL — Meta fetches it server-side, so
 * a signed or private Supabase URL fails here even though it renders fine in
 * our own console.
 */
export async function postToInstagram(
  creds: MetaCredentials,
  caption: string,
  imageUrl: string,
): Promise<PostResult> {
  if (!creds.igUserId) return { ok: false, error: 'META_IG_USER_ID not configured' };

  const container = await graph(
    `${creds.igUserId}/media`,
    { image_url: imageUrl, caption },
    creds.token,
  );
  if (!container.ok) return { ok: false, error: `container: ${container.error}` };
  const containerId = container.data.id as string | undefined;
  if (!containerId) return { ok: false, error: 'no container id returned' };

  // Ingestion is async. Publishing immediately usually 400s. Poll status
  // rather than sleeping a fixed guess — a large photo takes longer than a
  // small one and a fixed sleep is either too slow or too fragile.
  const ready = await waitForContainer(creds, containerId);
  if (!ready.ok) return ready;

  const published = await graph(
    `${creds.igUserId}/media_publish`,
    { creation_id: containerId },
    creds.token,
  );
  if (!published.ok) return { ok: false, error: `publish: ${published.error}` };
  const id = published.data.id as string | undefined;
  if (!id) return { ok: false, error: 'no media id returned' };

  return { ok: true, remotePostId: id, permalink: `https://www.instagram.com/p/${id}` };
}

async function waitForContainer(
  creds: MetaCredentials,
  containerId: string,
  attempts = 8,
): Promise<PostResult> {
  for (let i = 0; i < attempts; i++) {
    // Linear backoff: ~1s, 2s, 3s … ≈36s total. Comfortably inside a cron
    // invocation, and long enough for the images this app produces.
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    const url = `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(creds.token)}`;
    try {
      const res = await fetch(url);
      const json = (await res.json()) as { status_code?: string; status?: string; error?: { message?: string } };
      if (json.error) return { ok: false, error: `container status: ${json.error.message}` };
      if (json.status_code === 'FINISHED') return { ok: true };
      if (json.status_code === 'ERROR') {
        return { ok: false, error: `container failed: ${json.status ?? 'unknown'}` };
      }
    } catch {
      // Transient — keep polling until attempts run out.
    }
  }
  return { ok: false, error: 'container did not finish in time' };
}

/**
 * Delete a published post. Used by the takedown sweep once an auction closes —
 * a live post pointing at a dead lot is worse than no post.
 *
 * A post already gone (deleted by hand in the Page UI) reports ok, because the
 * desired end state is "not published" and the sweep must be idempotent.
 */
export async function deleteMetaPost(
  creds: MetaCredentials,
  remotePostId: string,
): Promise<PostResult> {
  const url = `${GRAPH}/${remotePostId}?access_token=${encodeURIComponent(creds.token)}`;
  try {
    const res = await fetch(url, { method: 'DELETE' });
    const json = (await res.json()) as { success?: boolean; error?: { message?: string; code?: number } };
    if (json.error) {
      // 100 = "object does not exist" — already gone. That is success.
      if (json.error.code === 100) return { ok: true };
      return { ok: false, error: json.error.message ?? 'delete failed' };
    }
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: `network: ${(err as Error).message}` };
  }
}
