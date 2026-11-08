import Link from 'next/link';
import { revealMotion } from '@/components/console-v2/motion';
import { stageHueClassName, type StageId } from '@/components/console-v2/stage-hue';

export type DashboardStat = {
  id: string;
  label: string;
  value: string;
  definition?: string;
  href: string;
  stageHue?: StageId;
};

export type StatCardsProps = {
  stats: DashboardStat[];
  /** Page-enter order of the first tile; later tiles follow 40ms apart. */
  revealStart?: number;
};

export function StatCards({ stats, revealStart = 0 }: StatCardsProps) {
  return (
    <div className="console-v2-dashboard-stats" role="list">
      {stats.map((stat, index) => {
        const reveal = revealMotion(revealStart + index);
        return (
        <Link
          key={stat.id}
          href={stat.href}
          className={[
            'console-v2-stat-tile console-v2-pressable',
            reveal.className,
            stageHueClassName(stat.stageHue),
          ]
            .filter(Boolean)
            .join(' ')}
          style={reveal.style}
          role="listitem"
        >
          <div className="console-v2-stat-tile__label console-v2-label-mono">{stat.label}</div>
          <div className="console-v2-stat-tile__value console-v2-display" aria-hidden="true">
            {stat.value}
          </div>
          <span className="console-v2-sr-only">{stat.value}</span>
          {stat.definition ? (
            <p className="console-v2-stat-tile__def">{stat.definition}</p>
          ) : null}
        </Link>
        );
      })}
    </div>
  );
}
