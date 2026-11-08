import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { EditLotForm } from './EditLotForm';

export default async function EditLotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const { data: lot } = await supabase
    .from('lots')
    .select(
      'id, title, description, category, condition, msrp_cents, starting_bid_cents, status, bid_count, auction_id, flat_price_cents, dutch_start_cents, dutch_floor_cents, dutch_decline_per_minute_cents, auctions(format)',
    )
    .eq('id', id)
    .single();
  if (!lot) notFound();

  const format =
    ((lot as { auctions?: { format?: 'standard' | 'dutch' | 'last_chance' } }).auctions
      ?.format as 'standard' | 'dutch' | 'last_chance' | undefined) ?? 'standard';

  return (
    <div>
      <PageHeader title={`Edit lot — ${lot.title}`} />
      <EditLotForm
        lot={{
          id: lot.id as string,
          title: lot.title as string,
          description: (lot.description as string | null) ?? '',
          category: (lot.category as string | null) ?? '',
          condition: lot.condition as 'appears_new' | 'open_box' | 'good' | 'as_is',
          msrp_cents: (lot.msrp_cents as number | null) ?? null,
          starting_bid_cents: lot.starting_bid_cents as number,
          flat_price_cents: (lot.flat_price_cents as number | null) ?? null,
          dutch_start_cents: (lot.dutch_start_cents as number | null) ?? null,
          dutch_floor_cents: (lot.dutch_floor_cents as number | null) ?? null,
          dutch_decline_per_minute_cents:
            (lot.dutch_decline_per_minute_cents as number | null) ?? null,
          bid_count: lot.bid_count as number,
          status: lot.status as string,
          auction_id: lot.auction_id as string,
        }}
        format={format}
      />
    </div>
  );
}
