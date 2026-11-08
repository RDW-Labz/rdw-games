import Link from 'next/link';
import type { ReactNode } from 'react';
import { rowMotion } from './motion';

export type SetupStepState = 'done' | 'partial' | 'todo' | 'na';

export type SetupStep = {
  title: string;
  detail: string;
  state: SetupStepState;
  href?: string;
  cta?: string;
};

function stepBorderColor(state: SetupStepState): string {
  if (state === 'done') return 'var(--console-success)';
  if (state === 'partial') return 'var(--console-warning)';
  if (state === 'na') return 'var(--console-line)';
  return 'var(--console-danger)';
}

function StepMarker({ state }: { state: SetupStepState }) {
  const color = stepBorderColor(state);
  if (state === 'done') {
    return (
      <span className="console-v2-setup-step__marker console-v2-setup-step__marker--done" aria-label="complete">
        ✓
      </span>
    );
  }
  if (state === 'partial') {
    return (
      <span
        className="console-v2-setup-step__marker console-v2-setup-step__marker--partial"
        aria-label="in progress"
        style={{ borderColor: color, color }}
      >
        ◐
      </span>
    );
  }
  if (state === 'na') {
    return (
      <span
        className="console-v2-setup-step__marker console-v2-setup-step__marker--na"
        aria-label="not applicable"
        style={{ borderColor: color }}
      />
    );
  }
  return (
    <span
      className="console-v2-setup-step__marker"
      aria-label="not started"
      style={{ borderColor: color }}
    />
  );
}

function defaultCta(step: SetupStep): string {
  if (step.cta) return step.cta;
  if (step.state === 'done') return 'Edit →';
  if (step.state === 'partial') return 'Continue →';
  return 'Start →';
}

export function SetupStepper({
  steps,
  summary,
  stageHue,
}: {
  steps: SetupStep[];
  summary?: ReactNode;
  stageHue?: 'auction' | 'intake' | null;
}) {
  return (
    <section className="console-v2-setup console-v2-motion-reveal" aria-label="Setup steps">
      {summary ? (
        <p className="console-v2-setup-summary" style={{ margin: '0 0 var(--console-space-4)' }}>
          {summary}
        </p>
      ) : null}
      <ol className="console-v2-setup-list">
        {steps.map((step, idx) => (
          <li
            key={step.title}
            className={`console-v2-setup-step ${rowMotion(idx).className}`}
            style={{
              ...rowMotion(idx).style,
              opacity: step.state === 'na' ? 0.72 : 1,
              borderLeftColor: stepBorderColor(step.state),
            }}
          >
            <StepMarker state={step.state} />
            <div className="console-v2-setup-step__body">
              <div className="console-v2-setup-step__title">
                Step {idx + 1} — {step.title}
              </div>
              <div className="console-v2-setup-step__detail">{step.detail}</div>
            </div>
            {step.href && step.state !== 'na' ? (
              <Link
                href={step.href}
                className="console-v2-btn console-v2-btn--secondary console-v2-pressable console-v2-setup-step__cta"
              >
                {defaultCta(step)}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
      {stageHue ? <span className="console-v2-visually-hidden">Stage hue: {stageHue}</span> : null}
    </section>
  );
}
