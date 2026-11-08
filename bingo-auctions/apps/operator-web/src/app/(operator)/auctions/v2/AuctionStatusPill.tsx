import { StatusPill } from '@/components/console-v2/StatusPill';
import { statusPresentation } from '@/components/console-v2/status';

// Auction-list status pill (Braden 2026-10-13): Scheduled teal, Live lime with
// a dot, Draft grey — capitalised. Colours come from the list tokens in the
// v2 lists CSS block. Every other auction status (closed, canceled) keeps its
// meaning-mapped v2 StatusPill; only its label is capitalised.

const LIST_PILL: Record<string, { label: string; tone: 'scheduled' | 'live' | 'draft' }> = {
  scheduled: { label: 'Scheduled', tone: 'scheduled' },
  live: { label: 'Live', tone: 'live' },
  draft: { label: 'Draft', tone: 'draft' },
};

export function capitaliseStatusLabel(label: string): string {
  const spaced = label.replace(/_/g, ' ').trim();
  if (!spaced) return 'Unknown';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function AuctionStatusPill({ status }: { status: string }) {
  const own = Object.prototype.hasOwnProperty.call(LIST_PILL, status) ? LIST_PILL[status] : undefined;
  if (own) {
    return (
      <span className={`console-v2-list-pill console-v2-list-pill--${own.tone}`} title="auction state">
        {own.tone === 'live' ? <span className="console-v2-list-pill__dot" aria-hidden /> : null}
        {own.label}
      </span>
    );
  }
  return <StatusPill status={status} label={capitaliseStatusLabel(statusPresentation(status).label)} />;
}
