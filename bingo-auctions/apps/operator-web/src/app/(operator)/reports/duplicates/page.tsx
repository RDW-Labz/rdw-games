// Duplicate / ghost-listing audit (Jared patch notes 2026-07-24 #4/#5). After
// the BIN-002580 / BIN-002369 / PNK4859980 incident, staff need a standing
// check for duplicate inventory tied to the same physical item — not one-off
// SQL. Data via duplicate_lot_audit() (mig 0286): one operator-scoped
// SECURITY DEFINER RPC returning duplicate clusters across four checks.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { lotHref, pairCodesWithIds } from '@/lib/console-links';

export const dynamic = 'force-dynamic';

type AuditRow = {
  kind: string;
  key_value: string | null;
  n: number;
  lot_codes: string[] | null;
  lot_ids: string[] | null;
};

const KIND_META: Record<
  string,
  { title: string; blurb: string; severity: 'high' | 'medium' }
> = {
  multi_active_child: {
    title: 'Same item relisted more than once',
    blurb:
      'One source lot has 2+ active (non-canceled) carryover children — the item exists as more than one live listing. This is the exact duplicate the relist guard (mig 0275) now prevents; any row here predates the guard and should be canceled down to a single listing.',
    severity: 'high',
  },
  same_root_active: {
    title: 'Same item live in an auction twice',
    blurb:
      'Two or more lots that trace back to the same original item are BOTH scheduled/live right now — the customer-facing duplicate risk. Cancel all but one before the auction closes.',
    severity: 'high',
  },
  dup_qr: {
    title: 'Duplicate QR token',
    blurb:
      'Two non-deleted lots share a QR token. A unique index should make this impossible — if it appears, escalate; the scan-to-lot resolver may be ambiguous.',
    severity: 'high',
  },
  dup_sticker: {
    title: 'Duplicate box label (sticker)',
    blurb:
      'Two non-deleted lots carry the same physical sticker/legacy label. Usually harmless when one copy is retired (relisted/canceled), but two ACTIVE copies mean a scan is ambiguous.',
    severity: 'medium',
  },
};

export default async function DuplicateAuditPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const { data, error } = await supabase.rpc('duplicate_lot_audit');
  const rows = ((data as AuditRow[] | null) ?? []).filter(Boolean);

  const byKind = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  const orderedKinds = ['multi_active_child', 'same_root_active', 'dup_qr', 'dup_sticker'];
  const totalClusters = rows.length;

  return (
    <div>
      <PageHeader title="Duplicate / ghost audit" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 0.5rem', maxWidth: 820 }}>
        Standing check for duplicate inventory tied to the same physical item. Runs live against
        current data each time you open this page.
      </p>

      {/* BIN vs PNK primer — directly addresses the "a BIN-00000 next to a
          PNK00000 confuses me" note. */}
      <div
        style={{
          padding: '0.85rem 1rem',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          maxWidth: 820,
          marginBottom: '1.5rem',
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>BIN-#### vs PNK/BRN/TEA…</strong> — a{' '}
        <code>BIN-######</code> is the code the system mints; a <code>PNK…/BRN…</code> is the
        legacy label physically on the box. When an item is relisted it keeps the box label as its{' '}
        <em>sticker</em> and gets a fresh <code>BIN-######</code>. So a BIN code sitting next to a
        PNK code is almost always the <strong style={{ color: 'var(--fg)' }}>same one item</strong>,
        not two — this audit only flags rows where they really are separate live listings.
      </div>

      {error && (
        <div
          style={{
            padding: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Couldn&apos;t run the audit: {error.message}. If this persists, the duplicate_lot_audit
          migration (0286) may not be applied yet.
        </div>
      )}

      {!error && totalClusters === 0 && (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
          }}
        >
          No duplicate or ghost listings found. ✅
        </div>
      )}

      {orderedKinds.map((kind) => {
        const list = byKind.get(kind);
        if (!list || list.length === 0) return null;
        const meta = KIND_META[kind] ?? { title: kind, blurb: '', severity: 'medium' as const };
        return (
          <section key={kind} style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.35rem' }}>
              <h2 style={{ fontSize: '1rem', margin: 0 }}>{meta.title}</h2>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background:
                    meta.severity === 'high' ? 'rgba(255,84,112,0.15)' : 'var(--bg-elev)',
                  color: meta.severity === 'high' ? 'var(--danger)' : 'var(--fg-muted)',
                }}
              >
                {meta.severity} · {list.length}
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 0.6rem', maxWidth: 820 }}>
              {meta.blurb}
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="console-table">
                <thead>
                  <tr>
                    <th>Shared value</th>
                    <th style={{ textAlign: 'right' }}>Count</th>
                    <th>Lots involved</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => (
                    <tr key={`${kind}-${i}`}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.key_value ?? '—'}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.n}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {pairCodesWithIds(r.lot_codes, r.lot_ids).map((pair, j, arr) => (
                          <span key={`${pair.code}-${j}`}>
                            {pair.id ? (
                              <Link href={lotHref(pair.id)}>{pair.code}</Link>
                            ) : (
                              pair.code
                            )}
                            {j < arr.length - 1 ? '  ·  ' : ''}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
