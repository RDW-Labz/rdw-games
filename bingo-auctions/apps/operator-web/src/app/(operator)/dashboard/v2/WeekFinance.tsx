import { revealMotion } from '@/components/console-v2/motion';
import Link from 'next/link';
import { formatCents } from '@auction-platform/shared/money';
import { SectionHeader } from '@/components/console-v2/SectionHeader';

export type WeekFinanceProps = {
  collectedCents: number;
  netRevenueCents: number;
  platformFeesCents: number;
  reportsHref: string;
  /** Page-enter order of the section; its tiles follow 40ms apart. */
  revealIndex?: number;
};

export function WeekFinance({
  collectedCents,
  netRevenueCents,
  platformFeesCents,
  reportsHref,
  revealIndex = 0,
}: WeekFinanceProps) {
  const reveal = revealMotion(revealIndex);
  const tiles = [
    {
      id: 'collected',
      label: '7-day net collected',
      value: formatCents(collectedCents),
      definition: 'Charged incl. tax, minus refunds issued',
      href: reportsHref,
    },
    {
      id: 'revenue',
      label: '7-day net revenue',
      value: formatCents(netRevenueCents),
      definition: 'Bids + premium − refunds; excludes tax; not profit',
      href: reportsHref,
    },
    {
      id: 'fees',
      label: '7-day platform fees',
      value: formatCents(platformFeesCents),
      definition: 'Reported separately; not subtracted from the revenue figure here',
      href: '/invoices',
    },
  ];

  return (
    <section
      className={`console-v2-dashboard-finance ${reveal.className}`}
      style={reveal.style}
      id="week-finance"
    >
      <SectionHeader
        title="The last seven days"
        subtitle="Keep receipts, revenue and fees distinct."
      />
      <div className="console-v2-dashboard-stats console-v2-dashboard-stats--finance">
        {tiles.map((tile, index) => {
          const tileReveal = revealMotion(revealIndex + 1 + index);
          return (
          <Link
            key={tile.id}
            href={tile.href}
            className={`console-v2-stat-tile console-v2-stat-tile--money console-v2-pressable ${tileReveal.className}`}
            style={tileReveal.style}
          >
            <div className="console-v2-stat-tile__label console-v2-label-mono">{tile.label}</div>
            <div className="console-v2-stat-tile__value console-v2-stat-tile__value--money console-v2-display">
              {tile.value}
            </div>
            <p className="console-v2-stat-tile__def">{tile.definition}</p>
          </Link>
          );
        })}
      </div>
    </section>
  );
}
