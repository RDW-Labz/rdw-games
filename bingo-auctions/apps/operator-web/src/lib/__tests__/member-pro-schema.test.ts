import { describe, expect, it } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
import { memberProSchemaReady } from '../member-pro-schema';

// The real PostgREST client that supabase.from() uses; only the network is
// stubbed, answering the way prod's PostgREST does.
function clientWith(respond: (req: Request) => Response) {
  const seen: string[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(`${req.method} ${new URL(req.url).pathname}`);
    return respond(req);
  };
  const supabase = new PostgrestClient('https://example.supabase.co/rest/v1', {
    fetch: fetchStub as typeof fetch,
  });
  return { supabase, seen };
}

const missingTable = (req: Request) =>
  req.method === 'HEAD'
    ? new Response(null, { status: 404 })
    : new Response(
        JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.member_warehouse_settings' in the schema cache" }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );

describe('memberProSchemaReady', () => {
  it('prod today (0457 not applied, table missing): not ready', async () => {
    const { supabase, seen } = clientWith(missingTable);
    await expect(memberProSchemaReady(supabase)).resolves.toBe(false);
    expect(seen).toEqual(['GET /rest/v1/member_warehouse_settings']);
  });

  it('regression: a HEAD probe on the same missing table comes back error-free', async () => {
    const { supabase } = clientWith(missingTable);
    const head = await supabase.from('member_warehouse_settings').select('id', { head: true, count: 'exact' });
    expect(head.error).toBeNull();
  });

  it('0457 applied (table answers, even with no rows): ready', async () => {
    const { supabase } = clientWith(() => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(memberProSchemaReady(supabase)).resolves.toBe(true);
  });

  it('probe throws (network): not ready, no throw', async () => {
    const throwing = {
      from: () => ({ select: () => ({ limit: () => Promise.reject(new Error('network')) }) }),
    };
    await expect(memberProSchemaReady(throwing)).resolves.toBe(false);
  });
});
