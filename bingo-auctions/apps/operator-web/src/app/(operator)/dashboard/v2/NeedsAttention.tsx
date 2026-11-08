import Link from 'next/link';
import { revealMotion } from '@/components/console-v2/motion';
import { stageCardClassName } from '@/components/console-v2/stage-hue';
import { formatCount, rankStagesByUrgency, type FloorStage } from './floor-story';

export type NeedsAttentionProps = {
  stages: FloorStage[];
  /** Page-enter order of the rail; its cards follow 40ms apart. */
  revealIndex?: number;
};

function rankLabel(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function NeedsAttention({ stages, revealIndex = 0 }: NeedsAttentionProps) {
  const ranked = rankStagesByUrgency(stages);
  const urgent = ranked[0];
  const rest = ranked.slice(1);
  const urgentHasWork = urgent != null && urgent.count != null && urgent.count > 0;
  // Floor story: the rail, then cards 02…05 in rank order, then the urgent card
  // last — it lands and pulses once in its stage hue (CSS: v2 motion block).
  const railReveal = revealMotion(revealIndex);
  const urgentReveal = revealMotion(revealIndex + rest.length + 1);

  return (
    <aside
      className={`console-v2-dashboard-rail ${railReveal.className}`}
      style={railReveal.style}
      aria-label="Needs attention"
    >
      {/* Floor story reveal: one faint lime line sweeps the rail once as the
          cards land. Decorative, motion-allowed only (v2 three-refs CSS). */}
      <span className="console-v2-scanline" aria-hidden="true" />
      <p className="console-v2-label-mono" style={{ marginBottom: 'var(--console-space-1)' }}>
        Floor story
      </p>
      <h2
        className="console-v2-display"
        style={{
          margin: 0,
          fontSize: 'var(--console-text-section)',
          lineHeight: 'var(--console-leading-tight)',
          color: 'var(--console-ink)',
        }}
      >
        Needs attention
      </h2>
      <p
        style={{
          margin: 'var(--console-space-2) 0 var(--console-space-4)',
          fontSize: 'var(--console-text-sm)',
          color: 'var(--console-ink-secondary)',
          lineHeight: 'var(--console-leading-control)',
        }}
      >
        Move between stages without losing the work in front of you.
      </p>

      <div className="console-v2-stage-list" aria-label="Stages by urgency">
        {urgent ? (
          <article
            // The most urgent stage is this page's focus: hue tint + glow.
            className={stageCardClassName(urgent.hue, {
              current: true,
              // Corner brackets + single pulse only when the urgent stage has work.
              extra: `console-v2-stage-card--featured ${urgentReveal.className}${
                urgentHasWork ? ' console-v2-motion-pulse-once console-v2-frame-bracket' : ''
              }`,
            })}
            style={urgentReveal.style}
          >
            <span className="console-v2-stage-card__num console-v2-label-mono">{rankLabel(0)}</span>
            <h3 className="console-v2-display" style={{ margin: 0 }}>
              {urgent.label}
            </h3>
            {urgent.count != null && urgent.count > 0 ? (
              <p
                className="console-v2-stage-card__count"
                aria-label={`${formatCount(urgent.count)} ${urgent.countLabel ?? 'waiting'}`}
              >
                <span className="console-v2-stage-card__count-value">{formatCount(urgent.count)}</span>
                {urgent.countLabel ? (
                  <span className="console-v2-stage-card__count-hint">{urgent.countLabel}</span>
                ) : null}
              </p>
            ) : null}
            <p className="console-v2-stage-card__purpose">{urgent.purpose}</p>
            {urgent.primaryAction ? (
              <Link
                href={urgent.primaryAction.href}
                className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable"
              >
                {urgent.primaryAction.label}
              </Link>
            ) : (
              <Link href={urgent.href} className="console-v2-dashboard-stage-link">
                Open {urgent.label.toLowerCase()}
              </Link>
            )}
          </article>
        ) : null}

        {rest.map((s, index) => {
          const cardReveal = revealMotion(revealIndex + 1 + index);
          return (
          <article
            key={s.id}
            className={stageCardClassName(s.hue, {
              extra: `console-v2-stage-card--compact ${cardReveal.className}`,
            })}
            style={cardReveal.style}
          >
            <div className="console-v2-stage-card__compact-row">
              <span className="console-v2-stage-card__num console-v2-label-mono">{rankLabel(index + 1)}</span>
              <h3 className="console-v2-display" style={{ margin: 0, flex: 1 }}>
                {s.label}
              </h3>
              {s.count != null && s.count > 0 ? (
                <span
                  className="console-v2-stage-card__inline-count"
                  title={s.countLabel ?? undefined}
                  aria-label={`${formatCount(s.count)} ${s.countLabel ?? 'waiting'}`}
                >
                  {formatCount(s.count)}
                </span>
              ) : null}
            </div>
            <Link href={s.href} className="console-v2-dashboard-stage-link">
              {s.primaryAction?.label ?? `Open ${s.label.toLowerCase()}`}
            </Link>
          </article>
          );
        })}
      </div>

      <p
        style={{
          marginTop: 'var(--console-space-4)',
          fontSize: 'var(--console-text-helper)',
          color: 'var(--console-ink-secondary)',
        }}
      >
        Stage links, not a progress meter.
      </p>
    </aside>
  );
}
