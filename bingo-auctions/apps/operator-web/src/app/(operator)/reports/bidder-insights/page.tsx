// Bidder insights (mig 0449): ZIP heat table, activity segments, weekly
// signup cohorts. Admin/manager only, same gate as /reports/bidder-zips
// (mig 0434). Complements /reports/bidders (acquisition/retention funnel)
// and /reports/bidder-zips (per-ZIP + per-location breakdown) rather than
// replacing either.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { ReportDateRange } from '@/components/ReportDateRange';
import { loadBidderInsights } from './data';
import { ZipHeatSection } from './ZipHeatSection';
import { SegmentsSection } from './SegmentsSection';
import { CohortSection } from './CohortSection';

export const dynamic = 'force-dynamic';

export default async function BidderInsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; zip?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await getSupabaseServer();
  const report = await loadBidderInsights(supabase, sp);

  if (!report.ok) {
    if (report.status === 'no_user') redirect('/login');
    if (report.status === 'no_operator') redirect('/onboarding');
    return (
      <div>
        <PageHeader title="Bidder insights" />
        <p style={{ color: 'var(--fg-muted)' }}>Admins or managers only.</p>
      </div>
    );
  }

  const periodLabel = report.from && report.to ? `${report.from} → ${report.to}` : 'all time';

  return (
    <div>
      <PageHeader title="Bidder insights" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 860 }}>
        Where your bidders live, how recently they&apos;ve engaged, and whether new cohorts stick. See also{' '}
        <Link href="/reports/bidders" style={{ color: 'var(--accent)' }}>
          Bidders &amp; retention
        </Link>{' '}
        for the acquisition funnel and{' '}
        <Link href="/reports/bidder-zips" style={{ color: 'var(--accent)' }}>
          Bidders by ZIP
        </Link>{' '}
        for the per-location breakdown. Aggregates only, everywhere on this page.
      </p>

      <ReportDateRange
        from={report.from}
        to={report.to}
        hint="The date range only scopes the ZIP heat table's winners/revenue columns (and the CSV export). Segments and cohorts are always evaluated as of right now."
      />

      <ZipHeatSection state={report.zipHeat} zipPrefix={report.zipPrefix} periodLabel={periodLabel} />
      <SegmentsSection segments={report.segments} segmentsByZip={report.segmentsByZip} />
      <CohortSection cohorts={report.cohorts} />
    </div>
  );
}
