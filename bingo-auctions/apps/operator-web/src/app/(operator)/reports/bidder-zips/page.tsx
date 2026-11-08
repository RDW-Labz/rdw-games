// Bidders by ZIP: where registered, active and buying bidders live, per
// auction location. One RPC: operator_bidder_location_summary_by_place (mig
// 0438, adds city/state filters), else 0434's operator_bidder_location_summary;
// before 0434 is applied the page shows a calm "needs migration 0434" banner.
// With 0438 the page credits GeoNames (CC BY 4.0) under the table.
//
// Aggregates only. The function rolls ZIP groups under 3 bidders into
// 'Other (fewer than 3)'; this page never reads or shows names, emails or
// phones. Admin/manager only, like the function.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { ReportDateRange } from '@/components/ReportDateRange';
import { loadBidderZips } from './data';
import { ZipFilters } from './ZipFilters';
import { BidderZipBody } from './BidderZipBody';

export const dynamic = 'force-dynamic';

export default async function BidderZipsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; location?: string; zip?: string; state?: string; city?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await getSupabaseServer();
  const report = await loadBidderZips(supabase, sp);
  if (!report.ok && report.status === 'no_user') redirect('/login');
  if (!report.ok && report.status === 'no_operator') redirect('/onboarding');
  if (!report.ok) {
    return (
      <div>
        <PageHeader title="Bidders by ZIP" />
        <p style={{ color: 'var(--fg-muted)' }}>Admins or managers only.</p>
      </div>
    );
  }

  const periodLabel = report.from && report.to ? `${report.from} → ${report.to}` : 'all time';
  const exportQs = new URLSearchParams();
  if (report.from && report.to) {
    exportQs.set('from', report.from);
    exportQs.set('to', report.to);
  }
  if (report.selectedId) exportQs.set('location', report.selectedId);
  if (report.zipPrefix) exportQs.set('zip', report.zipPrefix);
  if (report.places.state) exportQs.set('state', report.places.state);
  if (report.places.city) exportQs.set('city', report.places.city);
  const placeFilter = report.places.state
    ? report.places.city
      ? `${report.places.city}, ${report.places.state}`
      : report.places.state
    : null;
  const exportHref = `/reports/bidder-zips/export${exportQs.toString() ? `?${exportQs}` : ''}`;
  const canExport = report.state.kind === 'ok';

  return (
    <div>
      <PageHeader
        title="Bidders by ZIP"
        action={
          canExport ? (
            <a href={exportHref} style={secondaryButtonStyle}>
              Download CSV
            </a>
          ) : undefined
        }
      />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 860 }}>
        <strong>{report.selectedName}</strong>, {periodLabel}
        {report.zipPrefix ? `, ZIPs starting ${report.zipPrefix}` : ''}
        {placeFilter ? `, ${placeFilter}` : ''}. ZIPs come from bidders themselves.
        {report.places.available
          ? ' City and state come from each ZIP (one main place per ZIP).'
          : ' City and state filters need the ZIP-to-city table (migration 0438); until then, filter by ZIP prefix (for example 726 for the Harrison area).'}
      </p>

      <ZipFilters
        locations={report.locations}
        selectedId={report.selectedId}
        zipPrefix={report.zipPrefix}
        places={report.places}
      />
      <ReportDateRange
        from={report.from}
        to={report.to}
        hint={`Activity in the window, dates in ${report.timeZone}${
          report.selectedId ? ` (${report.selectedName}'s timezone)` : ' (your first warehouse’s timezone)'
        }.`}
      />

      <BidderZipBody
        state={report.state}
        zipPrefix={report.zipPrefix}
        coverage={report.coverage}
        showPlaces={report.places.available}
        placeFilter={placeFilter}
      />
    </div>
  );
}
