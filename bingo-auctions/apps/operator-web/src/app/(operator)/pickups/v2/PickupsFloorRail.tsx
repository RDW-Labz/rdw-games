import Link from 'next/link';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { revealMotion } from '@/components/console-v2/motion';
import { stageCardClassName, toStageId } from '@/components/console-v2/stage-hue';

// Purposes match the dashboard floor story (dashboard/v2/build-floor-stages.ts).
const WORKFLOW: Array<{ num: string; label: string; href: string; purpose: string }> = [
  { num: '01', label: 'Intake', href: '/loads', purpose: 'Log what arrived.' },
  { num: '02', label: 'Lotting', href: '/lotting/inventory', purpose: 'Match the label to the record.' },
  { num: '03', label: 'Auction', href: '/auctions', purpose: 'Watch the next close.' },
  { num: '04', label: 'Paid', href: '/invoices', purpose: 'Check the invoice before release.' },
  { num: '05', label: 'Pickup', href: '/pickups', purpose: 'Finish the physical handoff.' },
];

const QUEUE_ANCHORS = [
  { label: 'At the counter', href: '#pickups-v2-counter' },
  { label: 'Today', href: '#pickups-v2-today' },
  { label: 'Waiting', href: '#pickups-v2-waiting' },
  { label: 'Recently done', href: '#pickups-v2-done' },
] as const;

export type PickupsFloorRailProps = {
  atCounterCount: number;
  /** Page-enter order of the rail; its stage cards follow 40ms apart. */
  revealIndex?: number;
};

export function PickupsFloorRail({ atCounterCount, revealIndex = 0 }: PickupsFloorRailProps) {
  const railReveal = revealMotion(revealIndex);
  return (
    <aside
      className={`console-v2-pickups-rail ${railReveal.className}`}
      style={railReveal.style}
      aria-label="Floor story"
    >
      <h2
        className="console-v2-display"
        style={{
          margin: 0,
          fontSize: 'var(--console-text-section)',
          lineHeight: 'var(--console-leading-tight)',
        }}
      >
        Floor story
      </h2>
      <p
        style={{
          margin: 'var(--console-space-2) 0 var(--console-space-4)',
          fontSize: 'var(--console-text-sm)',
          color: 'var(--console-ink-secondary)',
        }}
      >
        Move between stages without losing the work in front of you.
      </p>

      <div className="console-v2-stage-list" aria-label="Workflow stages">
        {WORKFLOW.map((step, index) => {
          const current = step.label === 'Pickup';
          const cardReveal = revealMotion(revealIndex + 1 + index);
          return (
            <article
              key={step.label}
              className={stageCardClassName(toStageId(step.label), {
                current,
                extra: `${cardReveal.className}${current ? ' console-v2-motion-pulse-once' : ''}`,
              })}
              style={cardReveal.style}
            >
              <span className="console-v2-stage-card__num">{step.num}</span>
              <h3
                className="console-v2-display"
                style={{ margin: 0, fontSize: 'var(--console-text-base)' }}
              >
                {step.label}
                {current ? <span className="console-v2-sr-only"> Current section</span> : null}
              </h3>
              {current && atCounterCount > 0 ? (
                <p className="console-v2-stage-card__purpose" style={{ marginTop: 'var(--console-space-2)' }}>
                  <span className="console-v2-stage-card__inline-count">{formatCount(atCounterCount)}</span>
                  <span style={{ color: 'var(--console-ink-secondary)' }}> at the counter</span>
                </p>
              ) : (
                <p className="console-v2-stage-card__purpose">{step.purpose}</p>
              )}
              {current ? (
                <Link href="#pickups-v2-counter" className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable">
                  Check out {formatCount(atCounterCount)} →
                </Link>
              ) : (
                <Link href={step.href} className="console-v2-dashboard-stage-link">
                  Open {step.label.toLowerCase()}
                </Link>
              )}
            </article>
          );
        })}
      </div>

      <nav
        className="console-v2-pickups-queue-nav"
        aria-label="Pickup queues"
        style={{ marginTop: 'var(--console-space-4)' }}
      >
        {QUEUE_ANCHORS.map((a) => (
          <Link key={a.href} href={a.href} className="console-v2-pickups-queue-link">
            {a.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
