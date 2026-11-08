// Imports list — every CSV/XLSX manifest the operator has imported,
// most-recent first. Each row shows the filename, source label,
// classification rate, and total lots created.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';

type ImportRow = {
  id: string;
  filename: string;
  source_label: string | null;
  row_count: number;
  classified_count: number;
  status: string;
  error: string | null;
  created_at: string;
};

export default async function ImportsPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const { data: importsData } = await supabase
    .from('imports')
    .select('id, filename, source_label, row_count, classified_count, status, error, created_at')
    .eq('operator_id', me.operator_id as string)
    .order('created_at', { ascending: false })
    .limit(50);
  const imports = (importsData ?? []) as ImportRow[];

  return (
    <div>
      <PageHeader
        title="Imports"
        action={
          <Link href="/imports/new" className="btn-primary">
            + New import
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5, marginBottom: 16 }}>
        Upload a CSV or XLSX manifest from any retailer. Rows land in a
        manifest pool — they don&apos;t become real lots until you actively
        lot them. Click an import below to review the pool and pick what to
        lot (or drop) when the truck arrives.
      </p>

      {imports.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
            maxWidth: 720,
          }}
        >
          No imports yet. Click <strong>+ New import</strong> to upload your first manifest.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
            maxWidth: 1100,
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) 100px 100px 140px',
              gap: 12,
              padding: '10px 14px',
              background: 'var(--bg-elev)',
              borderBottom: '1px solid var(--border)',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.0,
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
            }}
          >
            <span>Filename</span>
            <span>Source</span>
            <span>Lots</span>
            <span>Auto-cat&apos;d</span>
            <span>When</span>
          </div>
          {imports.map((imp) => {
            const pct =
              imp.row_count > 0 ? Math.round((imp.classified_count / imp.row_count) * 100) : 0;
            const failed = imp.status === 'failed';
            const Wrapper = failed ? 'div' : Link;
            const props = failed ? {} : { href: `/imports/${imp.id}` };
            return (
              // @ts-expect-error — Wrapper union of div / Link doesn't unify cleanly
              <Wrapper
                key={imp.id}
                {...props}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) 100px 100px 140px',
                  gap: 12,
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  textDecoration: 'none',
                  color: 'inherit',
                  cursor: failed ? 'default' : 'pointer',
                }}
              >
                <div
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ color: failed ? 'var(--danger)' : 'var(--fg)', fontWeight: 600 }}>
                    {imp.filename}
                  </span>
                  {failed && imp.error && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
                      {imp.error}
                    </div>
                  )}
                </div>
                <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                  {imp.source_label ?? '—'}
                </span>
                <span style={{ color: 'var(--fg)', fontWeight: 700 }}>{imp.row_count}</span>
                <span style={{ color: pct === 100 ? 'var(--success)' : 'var(--fg-muted)' }}>
                  {pct}%
                </span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                  {/* TODO(tz): imports is an operator-level manifest upload with
                      no warehouse_id, so there is no warehouse zone to resolve.
                      Left in the SSR runtime zone. */}
                  {new Date(imp.created_at).toLocaleString()}
                </span>
              </Wrapper>
            );
          })}
        </div>
      )}
    </div>
  );
}
