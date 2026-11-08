import type { ReactNode } from 'react';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { FilterSelect } from '@/components/FilterSelect';
import { SectionHeader } from '@/components/console-v2/SectionHeader';
import { revealMotion } from '@/components/console-v2/motion';
import { CustomerSearch } from '../CustomerSearch';
import { MissingItemsQueue } from '../MissingItemsQueue';
import { SessionsToggle } from '../SessionsToggle';
import { PickupCounterRow, PickupDoneRow, PickupOpenRow } from './PickupV2Rows';
import { PickupsFloorRail } from './PickupsFloorRail';
import type { PickupsV2Props } from './pickup-types';

function PickupQueueSection({
  id,
  title,
  stageHue,
  subtitle,
  emptyMessage,
  rowCount,
  revealIndex,
  children,
}: {
  id: string;
  /** Page-enter order (40ms steps, capped — see components/console-v2/motion.ts). */
  revealIndex: number;
  title: string;
  stageHue?: 'pickup';
  subtitle?: string;
  emptyMessage: string;
  rowCount: number;
  children: ReactNode | null;
}) {
  const hasRows = rowCount > 0;
  const reveal = revealMotion(revealIndex);
  return (
    <section id={id} className={`console-v2-pickups-queue ${reveal.className}`} style={reveal.style}>
      <SectionHeader
        title={title}
        stageHue={stageHue ?? null}
        subtitle={subtitle}
        style={{ marginBottom: 'var(--console-space-3)' }}
      />
      {hasRows ? (
        <div className="console-v2-pickups-queue-list">{children}</div>
      ) : (
        <p className="console-v2-pickups-empty">{emptyMessage}</p>
      )}
    </section>
  );
}

export function PickupsV2({
  warehouses,
  activeWarehouseId,
  sessionsEnabled,
  missing,
  counter,
  today,
  waiting,
  recentlyDone,
  counterDetails,
}: PickupsV2Props) {
  const missingCount = missing.length;

  return (
    <div
      data-console-v2
      className="console-v2-pickups console-v2-motion-page-in"
      style={{
        fontFamily: 'var(--console-font-body)',
        color: 'var(--console-ink)',
        margin: 'calc(-2rem)',
        padding: 'var(--console-page-gutter)',
        background: 'var(--console-gradient-frame)',
        minHeight: '100%',
      }}
    >
      <div className="console-v2-pickups-shell">
        <PickupsFloorRail atCounterCount={counter.length} revealIndex={0} />
        <div className="console-v2-pickups-work">
          <header
            className={`console-v2-pickups-head ${revealMotion(1).className}`}
            style={revealMotion(1).style}
          >
            <h1
              className="console-v2-display"
              style={{
                margin: '0 0 var(--console-space-4)',
                fontSize: 'var(--console-text-title)',
                lineHeight: 'var(--console-leading-tight)',
              }}
            >
              Pickups
            </h1>

            <div className="console-v2-pickups-head-tools">
              <div className="console-v2-pickups-header-search">
                <div className="console-v2-pickups-customer-search">
                  <CustomerSearch warehouseQuery={activeWarehouseId} heading="Find customer" />
                </div>
                <div className="console-v2-pickups-pass-row">
                  <SessionsToggle enabled={sessionsEnabled} />
                </div>
              </div>

              {warehouses.length > 0 ? (
                <form method="GET" className="console-v2-pickups-warehouse-form">
                  <FilterSelect
                    name="warehouse"
                    defaultValue={activeWarehouseId ?? ''}
                    ariaLabel="Filter pickups by warehouse"
                  >
                    <option value="">All warehouses</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </FilterSelect>
                  {activeWarehouseId ? (
                    <a href="/pickups" className="console-v2-btn console-v2-btn--ghost console-v2-btn--sm">
                      Clear
                    </a>
                  ) : null}
                </form>
              ) : null}
            </div>
          </header>

          {missingCount > 0 ? (
            <a
              href="#missing-items"
              className={`console-v2-pickups-missing-alert ${revealMotion(2).className}`}
              style={revealMotion(2).style}
            >
              {formatCount(missingCount)} missing item{missingCount === 1 ? '' : 's'} awaiting refund →
            </a>
          ) : null}

          <PickupQueueSection
            id="pickups-v2-counter"
            revealIndex={3}
            title={`At the counter (${formatCount(counter.length)})`}
            stageHue="pickup"
            rowCount={counter.length}
            emptyMessage="No one is checked in at the counter."
          >
            {counter.length > 0
              ? counter.map((row, index) => {
                  const detail = counterDetails[row.id];
                  if (!detail) return null;
                  return (
                    <PickupCounterRow
                      key={row.id}
                      row={row}
                      detail={detail}
                      warehouseQuery={activeWarehouseId}
                      motionIndex={index}
                    />
                  );
                })
              : null}
          </PickupQueueSection>

          <PickupQueueSection
            id="pickups-v2-today"
            revealIndex={4}
            title={`Today (${formatCount(today.length)})`}
            stageHue="pickup"
            rowCount={today.length}
            emptyMessage="No appointments scheduled for today."
          >
            {today.length > 0
              ? today.map((row, index) => (
                  <PickupOpenRow
                    key={row.id}
                    row={row}
                    warehouseQuery={activeWarehouseId}
                    motionIndex={index}
                    variant="today"
                  />
                ))
              : null}
          </PickupQueueSection>

          <PickupQueueSection
            id="pickups-v2-waiting"
            revealIndex={5}
            title={`Waiting (${formatCount(waiting.length)})`}
            stageHue="pickup"
            rowCount={waiting.length}
            subtitle="Other open pickups, including unscheduled and earlier appointments."
            emptyMessage="No one is waiting outside today's schedule."
          >
            {waiting.length > 0
              ? waiting.map((row, index) => (
                  <PickupOpenRow
                    key={row.id}
                    row={row}
                    warehouseQuery={activeWarehouseId}
                    motionIndex={index}
                    variant="waiting"
                  />
                ))
              : null}
          </PickupQueueSection>

          <section
            id="missing-items"
            className={`console-v2-pickups-missing-section ${revealMotion(6).className}`}
            style={revealMotion(6).style}
          >
            <SectionHeader
              title={`Missing items awaiting refund (${formatCount(missingCount)})`}
              stageHue={null}
              style={{
                marginBottom: 'var(--console-space-3)',
                // Stage-less section title — off-white ink (FROZEN carry-over).
                ['--console-section-title-fallback' as string]: 'var(--console-ink)',
              }}
            />
            {missingCount === 0 ? (
              <p className="console-v2-pickups-empty">No missing items need a refund right now.</p>
            ) : (
              <div className="console-v2-pickups-missing-host">
                <MissingItemsQueue rows={missing} warehouseQuery={activeWarehouseId} />
              </div>
            )}
          </section>

          <PickupQueueSection
            id="pickups-v2-done"
            revealIndex={7}
            title={`Recently done (${formatCount(recentlyDone.length)})`}
            rowCount={recentlyDone.length}
            emptyMessage="No completed pickups in the loaded window."
          >
            {recentlyDone.length > 0
              ? recentlyDone.map((row, index) => (
                  <PickupDoneRow
                    key={row.id}
                    row={row}
                    warehouseQuery={activeWarehouseId}
                    motionIndex={index}
                  />
                ))
              : null}
          </PickupQueueSection>
        </div>
      </div>
    </div>
  );
}
