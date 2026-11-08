import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { LotForm } from './LotForm';

export default async function NewLotPage({
  searchParams,
}: {
  searchParams: Promise<{ auctionId?: string }>;
}) {
  const { auctionId } = await searchParams;
  const supabase = await getSupabaseServer();

  const { data: auctions } = await supabase
    .from('auctions')
    .select('id, title, warehouse_id, ends_at, format, starts_at')
    .in('status', ['draft', 'scheduled'])
    .order('starts_at', { ascending: false });

  return (
    <div>
      <PageHeader title="New lot" />
      <LotForm
        auctions={(auctions ?? []) as Array<{
          id: string;
          title: string;
          warehouse_id: string;
          ends_at: string;
          starts_at: string;
          format: 'standard' | 'dutch' | 'last_chance';
        }>}
        defaultAuctionId={auctionId ?? null}
      />
    </div>
  );
}
