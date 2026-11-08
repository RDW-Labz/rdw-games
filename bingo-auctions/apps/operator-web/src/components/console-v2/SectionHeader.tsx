import type { CSSProperties, ReactNode } from 'react';
import { stageHueTokens, type StageId } from './stage-hue';

export type ConsoleStageHue = StageId | null;

export type SectionHeaderProps = {
  title: ReactNode;
  stageHue?: ConsoleStageHue;
  subtitle?: ReactNode;
  style?: CSSProperties;
};

export function SectionHeader({ title, stageHue = null, subtitle, style }: SectionHeaderProps) {
  // Stage sections take the stage's -text; stage-less sections stay off-white.
  const titleColor = stageHueTokens(stageHue).text;

  return (
    <header className="console-v2-section-header" style={style}>
      <div>
        <h2 className="console-v2-section-header__title" style={{ color: titleColor }}>
          {title}
        </h2>
        {subtitle ? (
          <p
            style={{
              margin: 'var(--console-space-1) 0 0',
              fontSize: 'var(--console-text-sm)',
              color: 'var(--console-ink-secondary)',
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </header>
  );
}
