// Deploy order safety: the Member Pro settings pages read tables and columns
// that migration 0457 creates. Until 0457 is applied on a database, the link
// and pages stay hidden instead of erroring. 0457 runs in one transaction, so
// its member_warehouse_settings table stands in for all of it.
//
// The probe is a GET, not a HEAD: supabase-js turns a HEAD 404 with an empty
// body (a missing table) into status 204 with error null, which read as
// "ready" on prod. A GET returns PostgREST's error body, and the probe only
// passes when it gets a real row list back.

type SchemaProbeClient = {
  from: (table: string) => {
    select: (columns: string) => {
      limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

export async function memberProSchemaReady(supabase: SchemaProbeClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('member_warehouse_settings').select('id').limit(1);
    return !error && Array.isArray(data);
  } catch {
    return false;
  }
}

export const MEMBER_PRO_NOT_READY_MESSAGE =
  'Member Pro is not set up on this site yet. This page opens once its database update is applied.';
