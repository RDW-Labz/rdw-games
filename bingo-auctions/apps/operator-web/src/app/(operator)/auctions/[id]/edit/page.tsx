import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { EditAuctionForm } from './EditAuctionForm';

export default async function EditAuctionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: a } = await supabase
    .from('auctions')
    .select(
      'id, title, description, status, starts_at, ends_at, last_lot_ends_at, pickup_starts_at, pickup_ends_at, soft_close_minutes, buyer_premium_bps, format, bid_increment_schedule, prebid_enabled',
    )
    .eq('id', id)
    .single();
  if (!a) notFound();

  return (
    <div>
      <PageHeader title={`Edit auction — ${a.title}`} />
      <EditAuctionForm
        auction={a as {
          id: string;
          title: string;
          description: string | null;
          status: string;
          starts_at: string;
          ends_at: string;
          last_lot_ends_at: string | null;
          pickup_starts_at: string;
          pickup_ends_at: string;
          soft_close_minutes: number;
          prebid_enabled: boolean;
          buyer_premium_bps: number;
          format: 'standard' | 'dutch' | 'last_chance';
          bid_increment_schedule:
            | import('@auction-platform/shared').BidIncrementTier[]
            | null;
        }}
      />
    </div>
  );
}
