'use client';

import { useCallback, useId, type KeyboardEvent, type ReactNode } from 'react';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

export type TabItem = {
  id: string;
  label: string;
  panel: ReactNode;
};

export type TabsProps = {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  /** Forces pseudo-state on the active tab for gallery screenshots. */
  tabForceState?: GalleryVisualState;
};

export function Tabs({ tabs, activeId, onChange, ariaLabel = 'Sections', tabForceState }: TabsProps) {
  const baseId = useId();

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = (index + delta + tabs.length) % tabs.length;
      onChange(tabs[next]!.id);
      const el = document.getElementById(`${baseId}-tab-${tabs[next]!.id}`);
      el?.focus();
    },
    [baseId, onChange, tabs],
  );

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div>
      <div role="tablist" aria-label={ariaLabel} className="console-v2-tabs__list">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            className="console-v2-tabs__tab console-v2-pressable"
            aria-selected={tab.id === activeId}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={tab.id === activeId ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            {...(tab.id === activeId ? galleryStateProps(tabForceState) : {})}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.id}`}
          aria-labelledby={`${baseId}-tab-${active.id}`}
          style={{ marginTop: 'var(--console-space-4)' }}
        >
          {active.panel}
        </div>
      ) : null}
    </div>
  );
}
