import Link from 'next/link';
import { revealMotion } from '@/components/console-v2/motion';
import { stageCardClassName, type StageId } from '@/components/console-v2/stage-hue';

const WORKFLOW: Array<{ id: StageId; num: string; label: string; href: string; linkLabel: string }> = [
  { id: 'intake', num: '01', label: 'Intake', href: '/loads', linkLabel: 'Open intake' },
  { id: 'lotting', num: '02', label: 'Lotting', href: '/lotting/inventory', linkLabel: 'Open inventory' },
  { id: 'auction', num: '03', label: 'Auction', href: '/auctions', linkLabel: 'Open auction' },
  { id: 'paid', num: '04', label: 'Paid', href: '/invoices', linkLabel: 'Open paid' },
  { id: 'pickup', num: '05', label: 'Pickup', href: '/pickups', linkLabel: 'Open pickup' },
];

const RECORD_ANCHORS = [
  { label: 'Identity', href: '#lot-v2-identity' },
  { label: 'Photos and facts', href: '#lot-v2-record' },
  { label: 'Invoice and handoff', href: '#lot-v2-ownership' },
  { label: 'Next action', href: '#lot-v2-decisions' },
  { label: 'History', href: '#lot-v2-timeline' },
] as const;

export type LotDetailFloorRailProps = {
  locationNote: string;
  /** The lot's own stage (lotFloorStage); null = off the floor story, no current card. */
  currentStage: StageId | null;
  /** Page-enter order of the rail; its stage cards follow 40ms apart. */
  revealIndex?: number;
};

// locationNote is shown once, in "What is on record" (round-6: never repeat it in the rail).
export function LotDetailFloorRail({
  locationNote: _locationNote,
  currentStage,
  revealIndex = 0,
}: LotDetailFloorRailProps) {
  const railReveal = revealMotion(revealIndex);
  return (
    <aside className={`console-v2-lot-rail ${railReveal.className}`} style={railReveal.style} aria-label="Floor story">
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
          const current = step.id === currentStage;
          const cardReveal = revealMotion(revealIndex + 1 + index);
          return (
            <article
              key={step.id}
              className={stageCardClassName(step.id, {
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
              <Link href={step.href} className="console-v2-dashboard-stage-link">
                {step.linkLabel}
              </Link>
            </article>
          );
        })}
      </div>

      <p
        style={{
          margin: 'var(--console-space-4) 0 var(--console-space-2)',
          fontSize: 'var(--console-text-sm)',
          fontWeight: 'var(--console-weight-strong)',
        }}
      >
        On this record
      </p>
      <nav aria-label="On this record" className="console-v2-lot-record-nav">
        {RECORD_ANCHORS.map((a) => (
          <a key={a.href} href={a.href} className="console-v2-lot-record-link">
            {a.label}
          </a>
        ))}
      </nav>


      <p
        style={{
          margin: 'var(--console-space-4) 0 0',
          fontSize: 'var(--console-text-helper)',
          color: 'var(--console-ink-secondary)',
        }}
      >
        Stage links, not a progress meter.
      </p>
    </aside>
  );
}
