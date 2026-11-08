'use client';

// Tax-document upload + list for self-managed operators (mig 0195).
// Operators on tax_mode='self_managed' keep their own sales-tax permit /
// registration on file here as a compliance record. The file uploads directly
// to the private 'operator-tax-docs' bucket (path '<operator_id>/<uuid>.<ext>',
// storage RLS path-scoped); the row is recorded via the recordTaxDocument
// server action. Download links are short-lived signed URLs minted server-side.

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { recordTaxDocument, archiveTaxDocument } from './actions';

type DocType = 'sales_tax_permit' | 'registration' | 'resale_exemption' | 'other';

export type TaxDocView = {
  id: string;
  file_name: string;
  doc_type: DocType;
  state: string | null;
  created_at: string;
  url: string | null;
};

const DOC_TYPE_LABELS: Record<DocType, string> = {
  sales_tax_permit: 'Sales-tax permit',
  registration: 'State registration',
  resale_exemption: 'Resale / exemption certificate',
  other: 'Other',
};

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const MAX_BYTES = 10 * 1024 * 1024;

export function TaxDocuments({
  operatorId,
  canUpload,
  canArchive,
  docs,
}: {
  operatorId: string;
  canUpload: boolean;
  canArchive: boolean;
  docs: TaxDocView[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<DocType>('sales_tax_permit');
  const [stateCode, setStateCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;

    const ext = EXT_BY_MIME[file.type];
    if (!ext) {
      setError('Upload a PDF, PNG, or JPEG.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const supabase = getSupabaseBrowser();
      const path = `${operatorId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('operator-tax-docs')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        setError(`Upload failed: ${upErr.message}`);
        return;
      }
      const res = await recordTaxDocument({
        storagePath: path,
        fileName: file.name.slice(0, 255),
        docType,
        state: stateCode.trim() ? stateCode.trim().toUpperCase() : null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStateCode('');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onArchive(id: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await archiveTaxDocument(id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeader}>Tax documents</h2>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.5, marginTop: 0 }}>
        Keep your sales-tax permit or registration on file for the
        &ldquo;I collect &amp; remit my own tax&rdquo; mode. Stored privately; only your
        operator staff can view these. PDF, PNG, or JPEG up to 10&nbsp;MB.
      </p>

      {canUpload && (
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            marginBottom: '1rem',
          }}
        >
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--fg-muted)' }}>
            Document type
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocType)}
              disabled={busy}
              style={selectStyle}
            >
              {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--fg-muted)' }}>
            State (optional)
            <input
              type="text"
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value.slice(0, 2))}
              placeholder="AR"
              maxLength={2}
              disabled={busy}
              style={{ ...selectStyle, width: 70, textTransform: 'uppercase' }}
            />
          </label>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} style={uploadButtonStyle}>
            {busy ? 'Uploading…' : 'Upload document'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            style={{ display: 'none' }}
            onChange={onFile}
          />
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '0.6rem 0.75rem',
            background: 'rgba(248, 113, 113, 0.1)',
            border: '1px solid var(--danger, #f87171)',
            color: 'var(--danger, #f87171)',
            borderRadius: 6,
            fontSize: 13,
            marginBottom: '0.75rem',
          }}
        >
          {error}
        </div>
      )}

      {docs.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>No documents uploaded yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.5rem' }}>
          {docs.map((d) => (
            <li
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                padding: '0.6rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                      {d.file_name}
                    </a>
                  ) : (
                    d.file_name
                  )}
                </div>
                <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                  {DOC_TYPE_LABELS[d.doc_type]}
                  {d.state ? ` · ${d.state}` : ''}
                </div>
              </div>
              {canArchive && (
                <button type="button" onClick={() => onArchive(d.id)} disabled={busy} style={removeButtonStyle}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const sectionStyle: React.CSSProperties = {
  padding: '1.25rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  maxWidth: 720,
  marginTop: '1.5rem',
};

const sectionHeader: React.CSSProperties = {
  fontSize: 16,
  margin: 0,
  marginBottom: '0.5rem',
};

const selectStyle: React.CSSProperties = {
  padding: '0.45rem 0.5rem',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
  fontSize: 13,
};

const uploadButtonStyle: React.CSSProperties = {
  padding: '0.5rem 0.9rem',
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

const removeButtonStyle: React.CSSProperties = {
  padding: '0.35rem 0.6rem',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg-muted)',
  fontSize: 12,
  cursor: 'pointer',
  flexShrink: 0,
};
