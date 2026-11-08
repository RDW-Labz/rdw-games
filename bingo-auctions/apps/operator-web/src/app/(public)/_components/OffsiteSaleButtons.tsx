import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const MAX_W = 1100;

type OffsiteSaleRow = {
  warehouse_id: string;
  name: string;
  customer_notice: string;
};

async function loadOffsiteSales(): Promise<OffsiteSaleRow[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('public_offsite_sales');
    if (error) return [];
    const rows = (data ?? []) as OffsiteSaleRow[];
    return rows.filter((r) => r.warehouse_id && r.name && r.customer_notice?.trim());
  } catch {
    return [];
  }
}

export async function OffsiteSaleButtons() {
  const sales = await loadOffsiteSales();
  if (sales.length === 0) return null;

  return (
    <section style={{ padding: '1.25rem 1.25rem 0', background: 'var(--bg)' }}>
      <div style={{ maxWidth: MAX_W, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {sales.map((sale) => (
          <div key={sale.warehouse_id}>
            <Link
              href={`/sale/${sale.warehouse_id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '0.85rem 1.25rem',
                borderRadius: 10,
                background: 'var(--accent)',
                color: '#000',
                fontWeight: 800,
                fontSize: '1.05rem',
                textDecoration: 'none',
              }}
            >
              {sale.name} Sale →
            </Link>
            <p
              style={{
                margin: '0.45rem 0 0',
                color: 'var(--fg-muted)',
                fontSize: 14,
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {sale.customer_notice.trim()}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
