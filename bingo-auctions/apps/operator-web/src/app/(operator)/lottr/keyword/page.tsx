// LotTR keyword search — Tier 1 desktop entry point for items without
// a UPC. Type brand + model, see results from cache + eBay, save the
// right one as a draft lot.

import { PageHeader } from '@/components/Form';
import { KeywordSearch } from './KeywordSearch';

export default function KeywordSearchPage() {
  const ebayConfigured = Boolean(process.env['EBAY_CLIENT_ID']);

  return (
    <div>
      <PageHeader title="Keyword search" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5 }}>
        For items without a scannable UPC. Type brand + model number for the
        most precise match (e.g. <code>DeWalt DCD771C2</code>). Cache hits
        return instantly; cache misses query eBay Browse and write the
        result back. AI-free.
      </p>

      {!ebayConfigured && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(255, 90, 90, 0.1)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 6,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          <strong>EBAY_CLIENT_ID is not set.</strong> Add eBay Browse API
          credentials to apps/operator-web/.env.local and restart the dev
          server. Until then, search returns only warm cache hits.
        </div>
      )}

      <KeywordSearch />
    </div>
  );
}
