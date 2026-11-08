import Link from 'next/link';
import { revealMotion } from '@/components/console-v2/motion';
import { DecisionsWaiting, type DecisionQueue } from './DecisionsWaiting';
import { NeedsAttention } from './NeedsAttention';
import { NextToClose, type ClosingLotRow } from './NextToClose';
import { StatCards, type DashboardStat } from './StatCards';
import { WeekFinance } from './WeekFinance';
import { formatCount, type FloorStage } from './floor-story';

export type DashboardV2Props = {
  eyebrow?: string;
  stages: FloorStage[];
  stats: DashboardStat[];
  decisions: DecisionQueue[];
  closingLots: ClosingLotRow[];
  closingTimezoneNote?: string;
  weekCollectedCents: number;
  weekNetRevenueCents: number;
  weekPlatformFeesCents: number;
  reportsHref?: string;
};

export function DashboardV2({
  eyebrow,
  stages,
  stats,
  decisions,
  closingLots,
  closingTimezoneNote,
  weekCollectedCents,
  weekNetRevenueCents,
  weekPlatformFeesCents,
  reportsHref = '/reports/money',
}: DashboardV2Props) {
  // Live chip: the at-the-counter count the Pickup stage already carries (real
  // data, read when the page loaded). No count → no chip.
  const atCounter = stages.find((s) => s.id === 'pickup')?.count ?? null;
  const headReveal = revealMotion(1);

  return (
    <div
      data-console-v2
      className="console-v2-dashboard console-v2-refs-page console-v2-texture-grid console-v2-motion-page-in"
      style={{
        fontFamily: 'var(--console-font-body)',
        color: 'var(--console-ink)',
        margin: 'calc(-2rem)',
        padding: 'var(--console-page-gutter)',
        minHeight: '100%',
      }}
    >
      <div className="console-v2-dashboard-shell">
        <NeedsAttention stages={stages} revealIndex={0} />
        <div className="console-v2-dashboard-work">
          <header
            className={`console-v2-dashboard-head console-v2-page-head ${headReveal.className}`}
            style={headReveal.style}
          >
            <div className="console-v2-page-head__titles">
              {eyebrow || atCounter != null ? (
                <div className="console-v2-page-head__meta">
                  {eyebrow ? <p className="console-v2-label-mono">{eyebrow}</p> : null}
                  {atCounter != null ? (
                    <p className="console-v2-live-chip" style={{ margin: 0 }}>
                      <span className="console-v2-live-chip__dot" aria-hidden="true" />
                      <span className="console-v2-live-chip__label">Live</span>
                      <span>· {formatCount(atCounter)} at the counter</span>
                    </p>
                  ) : null}
                </div>
              ) : null}
              <h1
                className="console-v2-display"
                style={{
                  margin: '0 0 var(--console-space-2)',
                  fontSize: 'var(--console-text-title)',
                  lineHeight: 'var(--console-leading-tight)',
                }}
              >
                See the floor. Move the work.
              </h1>
              <p
                style={{
                  margin: 0,
                  color: 'var(--console-ink-secondary)',
                  maxWidth: '42rem',
                }}
              >
                Start with the next close, the next pickup, or the queue that needs a decision.
              </p>
            </div>
            <div className="console-v2-page-head__actions">
              {/* The header's one primary (shadcn). Lime stays the urgent floor action. */}
              <Link href="/lots/lookup" className="console-v2-btn console-v2-btn--solid console-v2-pressable">
                Look up a lot
              </Link>
            </div>
          </header>

          <StatCards stats={stats} revealStart={2} />

          <p
            style={{
              margin: '0 0 var(--console-space-4)',
              fontSize: 'var(--console-text-sm)',
              color: 'var(--console-ink-secondary)',
            }}
          >
            Counter and unscheduled pickups are separate.
          </p>

          <div className="console-v2-dashboard-main">
            <NextToClose rows={closingLots} timezoneNote={closingTimezoneNote} revealIndex={5} />
            <DecisionsWaiting queues={decisions} revealIndex={6} />
          </div>

          <WeekFinance
            collectedCents={weekCollectedCents}
            netRevenueCents={weekNetRevenueCents}
            platformFeesCents={weekPlatformFeesCents}
            reportsHref={reportsHref}
            revealIndex={7}
          />
        </div>
      </div>
    </div>
  );
}
