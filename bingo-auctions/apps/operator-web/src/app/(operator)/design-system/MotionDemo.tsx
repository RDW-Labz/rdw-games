'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/console-v2';
import { MOTION_STAGGER_CAP, motionDelayMs, rowMotion } from '@/components/console-v2/motion';

// Fourteen rows so the cap shows: rows 12–14 share the last step.
const ROW_LABELS = Array.from({ length: MOTION_STAGGER_CAP + 2 }, (_, i) => `Row ${i + 1}`);

export function MotionDemo() {
  const [playKey, setPlayKey] = useState(0);
  const [pulse, setPulse] = useState(false);

  const replay = useCallback(() => {
    setPlayKey((k) => k + 1);
    // Re-adding the class replays the single pulse; it is removed when it ends.
    setPulse(false);
    window.requestAnimationFrame(() => setPulse(true));
  }, []);

  return (
    <div className="console-v2-motion-page-in" style={{ marginTop: 'var(--console-space-3)' }}>
      <div
        key={playKey}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--console-space-2)',
          marginBottom: 'var(--console-space-4)',
        }}
      >
        {ROW_LABELS.map((label, index) => (
          <div
            key={`${playKey}-${label}`}
            className={rowMotion(index).className}
            style={{
              ...rowMotion(index).style,
              padding: 'var(--console-space-3)',
              background: 'var(--console-surface-raised)',
              borderRadius: 'var(--console-radius-control)',
              border: 'var(--console-border-width) solid var(--console-line)',
            }}
          >
            {label} (Sample data) — delay {motionDelayMs(index)}ms
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="primary-lime"
        className={pulse ? 'console-v2-motion-pulse-once' : undefined}
        onClick={replay}
        onAnimationEnd={(event) => {
          if (event.animationName === 'console-v2-pulse') setPulse(false);
        }}
      >
        Replay row-in + pulse
      </Button>
      <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)', marginTop: 'var(--console-space-3)' }}>
        Under <code>prefers-reduced-motion: reduce</code>, every v2 animation, transition and transform is off; content shows in its final state.
      </p>
    </div>
  );
}
