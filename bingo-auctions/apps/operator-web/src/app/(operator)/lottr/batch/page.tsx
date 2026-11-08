// LotTR-Pro batch UPC lookup. Server component shell — the heavy
// lifting (fetch / table state / save) lives in the client component.

import Link from 'next/link';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { BatchUpcClassifier } from './BatchUpcClassifier';

export default function BatchUpcPage() {
  return (
    <div>
      <PageHeader
        title="Batch UPC lookup"
        action={
          <Link
            href="/lottr"
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            Back to AI Lotting
          </Link>
        }
      />
      <BatchUpcClassifier />
    </div>
  );
}
