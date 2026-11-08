export const CONSOLE_GALLERY_STATUSES = [
  'in_inventory',
  'scheduled',
  'live',
  'sold',
  'paid',
  'checked_in',
  'unpaid',
  'refunded',
  'handed_over',
  'missing',
  'disposed',
] as const;

export type ConsoleGalleryStatus = (typeof CONSOLE_GALLERY_STATUSES)[number];

export type StatusPresentation = {
  label: string;
  foreground: string;
  background: string;
  domain: string;
};

const STATUS_MAP: Record<ConsoleGalleryStatus, StatusPresentation> = {
  in_inventory: {
    label: 'In inventory',
    foreground: 'var(--console-status-inventory-fg)',
    background: 'var(--console-status-inventory-bg)',
    domain: 'lot state',
  },
  scheduled: {
    label: 'Scheduled',
    foreground: 'var(--console-status-scheduled-fg)',
    background: 'var(--console-status-scheduled-bg)',
    domain: 'lot/auction state',
  },
  live: {
    label: 'Live',
    foreground: 'var(--console-status-live-fg)',
    background: 'var(--console-status-live-bg)',
    domain: 'lot/auction state',
  },
  sold: {
    label: 'Sold',
    foreground: 'var(--console-status-sold-fg)',
    background: 'var(--console-status-sold-bg)',
    domain: 'sale result',
  },
  paid: {
    label: 'Paid',
    foreground: 'var(--console-status-paid-fg)',
    background: 'var(--console-status-paid-bg)',
    domain: 'invoice payment state',
  },
  checked_in: {
    label: 'Checked in',
    foreground: 'var(--console-status-checked-in-fg)',
    background: 'var(--console-status-checked-in-bg)',
    domain: 'pickup appointment',
  },
  unpaid: {
    label: 'Unpaid',
    foreground: 'var(--console-status-unpaid-fg)',
    background: 'var(--console-status-unpaid-bg)',
    domain: 'invoice payment state',
  },
  refunded: {
    label: 'Refunded',
    foreground: 'var(--console-status-refunded-fg)',
    background: 'var(--console-status-refunded-bg)',
    domain: 'invoice payment state',
  },
  handed_over: {
    label: 'Handed over',
    foreground: 'var(--console-status-handed-fg)',
    background: 'var(--console-status-handed-bg)',
    domain: 'item fulfillment',
  },
  missing: {
    label: 'Missing',
    foreground: 'var(--console-status-missing-fg)',
    background: 'var(--console-status-missing-bg)',
    domain: 'pickup / inventory outcome',
  },
  disposed: {
    label: 'Disposed',
    foreground: 'var(--console-status-disposed-fg)',
    background: 'var(--console-status-disposed-bg)',
    domain: 'retired lot state',
  },
};

/**
 * Raw database values that already have a meaning above (lot_status 'won' is a
 * sale; invoice 'pending' / failed-charge states are unpaid). Pill colour follows
 * the meaning; the label keeps the operator wording.
 */
const STATUS_ALIASES: Record<string, { meaning: ConsoleGalleryStatus; label?: string }> = {
  won: { meaning: 'sold' },
  pending: { meaning: 'unpaid' },
  unpaid_no_show: { meaning: 'unpaid', label: 'Unpaid · no-show' },
  payment_failed_grace: { meaning: 'unpaid', label: 'Payment failed' },
  // Still paid for release (invoiceIsPaidForPickup) — green, not refunded grey.
  partially_refunded: { meaning: 'paid', label: 'Partially refunded' },
};

export function statusPresentation(
  status: ConsoleGalleryStatus | string,
): StatusPresentation {
  const own = (map: object) => Object.prototype.hasOwnProperty.call(map, status);
  if (own(STATUS_MAP)) {
    return STATUS_MAP[status as ConsoleGalleryStatus];
  }
  const alias = own(STATUS_ALIASES) ? STATUS_ALIASES[status] : undefined;
  if (alias) {
    const base = STATUS_MAP[alias.meaning];
    return { ...base, label: alias.label ?? base.label };
  }
  const escaped = String(status).replace(/[<>&]/g, '');
  return {
    label: escaped || 'Unknown',
    foreground: 'var(--console-neutral)',
    background: 'var(--console-neutral-bg)',
    domain: 'unknown',
  };
}
