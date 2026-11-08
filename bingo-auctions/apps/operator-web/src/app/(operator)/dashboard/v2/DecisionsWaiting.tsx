import { revealMotion } from '@/components/console-v2/motion';
import Link from 'next/link';
import { formatCount } from './floor-story';
import { Card } from '@/components/console-v2/Card';
import { SectionHeader } from '@/components/console-v2/SectionHeader';

export type DecisionQueue = {
  id: string;
  label: string;
  count: number;
  href: string;
};

export type DecisionsWaitingProps = {
  queues: DecisionQueue[];
  /** Page-enter order (40ms steps, capped — components/console-v2/motion.ts). */
  revealIndex?: number;
};

export function DecisionsWaiting({ queues, revealIndex = 0 }: DecisionsWaitingProps) {
  const reveal = revealMotion(revealIndex);
  return (
    <div
      id="decisions-waiting"
      className={`console-v2-dashboard-decisions ${reveal.className}`}
      style={reveal.style}
    >
    <Card>
      <SectionHeader
        title="Decisions waiting"
        subtitle="Keep each queue's next step visible."
      />
      <div className="console-v2-decision-list">
        {queues.map((q) => (
          <Link key={q.id} href={q.href} className="console-v2-decision-row console-v2-pressable">
            <span>{q.label}</span>
            <span className="console-v2-decision-row__badge" aria-label={`${formatCount(q.count)} open`}>
              {formatCount(q.count)}
            </span>
          </Link>
        ))}
      </div>
      <p
        style={{
          margin: 'var(--console-space-2) 0 0',
          fontSize: 'var(--console-text-sm)',
          color: 'var(--console-ink-secondary)',
        }}
      >
        Separate queues; no combined total.
      </p>
    </Card>
    </div>
  );
}
