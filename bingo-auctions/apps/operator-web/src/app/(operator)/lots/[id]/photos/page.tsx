import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { PhotoEditor } from './PhotoEditor';

export default async function LotPhotosPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const { data: lot } = await supabase
    .from('lots')
    .select('id, title, photo_urls, operator_id')
    .eq('id', id)
    .single();
  if (!lot) notFound();

  return (
    <div>
      <PageHeader title={`Photos — ${lot.title}`} />
      <PhotoEditor
        lotId={lot.id as string}
        operatorId={lot.operator_id as string}
        initialPhotoUrls={(lot.photo_urls as string[] | null) ?? []}
      />
    </div>
  );
}
