import Link from 'next/link';
import { formatInTimeZone } from '@/lib/datetime';
import { LotIdentity } from '@/components/console-v2/LotIdentity';
import { rowMotion } from '@/components/console-v2/motion';
import type { LotIdentityInput } from '@/components/console-v2/lot-identity';
import { StatusPill } from '@/components/console-v2/StatusPill';
import type { ConsoleGalleryStatus } from '@/components/console-v2/status';
import { PickupActions } from '../PickupActions';
import { invoiceShortId } from '../counter-rows';
import { InvoicePaymentPill, invoiceIsPaidForPickup } from './InvoicePaymentPill';
import type { CounterRowDetailV2, OwedLotChip, PickupRowV2 } from './pickup-types';

const OWED_VISIBLE_CAP = 12;

function owedToLotInput(item: OwedLotChip): LotIdentityInput {
  if (item.secondary) {
    return {
      display_code: item.code,
      sticker_code: item.code,
      lot_code: item.secondary,
    };
  }
  return { lot_code: item.code };
}

function invoiceLinkSuffix(warehouseQuery?: string | null) {
  return warehouseQuery ? `?warehouse=${encodeURIComponent(warehouseQuery)}` : '';
}

export function PickupCounterRow({
  row,
  detail,
  warehouseQuery,
  motionIndex,
}: {
  row: PickupRowV2;
  detail: CounterRowDetailV2;
  warehouseQuery?: string | null;
  motionIndex: number;
}) {
  const owed = detail.owed;
  const owedVisible = owed.slice(0, OWED_VISIBLE_CAP);
  const owedMore = owed.length - owedVisible.length;
  const suffix = invoiceLinkSuffix(warehouseQuery);

  return (
    <article
      className={`console-v2-pickups-counter-row ${rowMotion(motionIndex).className}`}
      style={rowMotion(motionIndex).style}
    >
      <div className="console-v2-pickups-counter-row__identity">
        <h3 className="console-v2-pickups-row-name" title={detail.customerLabel}>
          {detail.customerLabel}
        </h3>
        <Link
          href={`/invoices/${row.invoiceId}${suffix}`}
          className="console-v2-pickups-invoice-link"
        >
          Invoice #{invoiceShortId(row.invoiceId)} ↗
        </Link>
        <div className="console-v2-pickups-row-pills">
          <InvoicePaymentPill status={row.invoiceStatus} />
          <StatusPill status="checked_in" />
        </div>
      </div>
      <div className="console-v2-pickups-counter-row__owed">
        {owed.length === 0 ? (
          <span className="console-v2-pickups-owed-empty">Nothing owed</span>
        ) : (
          <div className="console-v2-pickups-owed-chips">
            {owedVisible.map((item, idx) => (
              <div key={`${item.code}-${idx}`} className="console-v2-pickups-owed-chip">
                <LotIdentity lot={owedToLotInput(item)} showSignatureRule={false} size="md" />
              </div>
            ))}
            {owedMore > 0 ? (
              <span className="console-v2-pickups-owed-more">+{owedMore} more</span>
            ) : null}
          </div>
        )}
      </div>
      <div className="console-v2-pickups-actions-host console-v2-pickups-actions-host--counter">
        <PickupActions
          pickupId={row.id}
          status={row.status}
          invoiceId={row.invoiceId}
          invoiceStatus={row.invoiceStatus}
        />
      </div>
    </article>
  );
}

export function PickupOpenRow({
  row,
  warehouseQuery,
  motionIndex,
  variant,
}: {
  row: PickupRowV2;
  warehouseQuery?: string | null;
  motionIndex: number;
  variant: 'today' | 'waiting';
}) {
  const suffix = invoiceLinkSuffix(warehouseQuery);
  const paid = invoiceIsPaidForPickup(row.invoiceStatus);
  const showCheckInGuard = variant === 'waiting' && !paid && row.status !== 'checked_in';

  return (
    <article
      className={`console-v2-pickups-open-row ${rowMotion(motionIndex).className}${showCheckInGuard ? ' console-v2-pickups-waiting-unpaid' : ''}`}
      style={rowMotion(motionIndex).style}
    >
      <div className="console-v2-pickups-open-row__main">
        <h3 className="console-v2-pickups-row-name" title={row.customerLabel}>
          {row.customerLabel}
        </h3>
        <Link
          href={`/invoices/${row.invoiceId}${suffix}`}
          className="console-v2-pickups-invoice-link"
        >
          Invoice #{invoiceShortId(row.invoiceId)} ↗
        </Link>
        <div className="console-v2-pickups-row-pills">
          <InvoicePaymentPill status={row.invoiceStatus} />
        </div>
        <p className="console-v2-pickups-row-meta">
          {row.warehouseName ?? '—'} ·{' '}
          {row.scheduledAt
            ? formatInTimeZone(row.scheduledAt, row.warehouseTimezone)
            : 'unscheduled'}{' '}
          · {row.status}
        </p>
      </div>
      <div className="console-v2-pickups-open-row__actions">
        {/* Unpaid: v1's own "Not paid — Mark paid (offline) first →" link (inside
            PickupActions) is the real next step — no web check-in exists, so no
            placeholder Check in button here. */}
        <div
          className={`console-v2-pickups-actions-host${variant === 'waiting' ? ' console-v2-pickups-actions-host--waiting' : ''}`}
        >
          <PickupActions
            pickupId={row.id}
            status={row.status}
            invoiceId={row.invoiceId}
            invoiceStatus={row.invoiceStatus}
          />
        </div>
      </div>
    </article>
  );
}

export function PickupDoneRow({
  row,
  warehouseQuery,
  motionIndex,
}: {
  row: PickupRowV2;
  warehouseQuery?: string | null;
  motionIndex: number;
}) {
  const suffix = invoiceLinkSuffix(warehouseQuery);
  const when = row.completedAt
    ? formatInTimeZone(row.completedAt, row.warehouseTimezone)
    : null;

  let outcomeLabel = row.status;
  let outcomeStatus: ConsoleGalleryStatus = 'handed_over';
  if (row.status === 'no_show') {
    outcomeLabel = when ? `No-show · ${when}` : 'No-show';
    outcomeStatus = 'missing';
  } else if (row.status === 'forfeited') {
    outcomeLabel = when ? `Forfeited · ${when}` : 'Forfeited';
    outcomeStatus = 'disposed';
  } else if (row.status === 'completed') {
    outcomeLabel = when ? `Completed · ${when}` : 'Completed';
    outcomeStatus = 'handed_over';
  }

  return (
    <article
      className={`console-v2-pickups-done-row ${rowMotion(motionIndex).className}`}
      style={rowMotion(motionIndex).style}
    >
      <h3 className="console-v2-pickups-row-name" title={row.customerLabel}>
        {row.customerLabel}
      </h3>
      <Link href={`/invoices/${row.invoiceId}${suffix}`} className="console-v2-pickups-invoice-link">
        Invoice #{invoiceShortId(row.invoiceId)} ↗
      </Link>
      <InvoicePaymentPill status={row.invoiceStatus} />
      <StatusPill status={outcomeStatus} label={outcomeLabel} />
    </article>
  );
}
