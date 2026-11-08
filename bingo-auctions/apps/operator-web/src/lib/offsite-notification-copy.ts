/**
 * Off-site warehouse pickup copy for transactional notifications (email HTML
 * block, push line, SMS line). Returns null when the warehouse is not off-site
 * (no customer_notice) so normal invoices stay byte-identical to today.
 */

import { formatInTimeZone } from '@/lib/datetime';
import type { WarehousePickupDescribed } from '@/lib/warehouse-pickup';

export type OffsiteNotificationCopy = {
  emailHtml: string;
  pushLine: string;
  smsLine: string;
};

const PUSH_SMS_MAX = 110;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PICKUP_WINDOW_FMT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

function formatPickupWindow(
  pickupStartsAt: string | null | undefined,
  pickupEndsAt: string | null | undefined,
  timeZone: string,
): string | null {
  if (!pickupStartsAt && !pickupEndsAt) return null;
  if (pickupStartsAt && pickupEndsAt) {
    return `${formatInTimeZone(pickupStartsAt, timeZone, PICKUP_WINDOW_FMT)} – ${formatInTimeZone(
      pickupEndsAt,
      timeZone,
      PICKUP_WINDOW_FMT,
    )}`;
  }
  if (pickupEndsAt) {
    return `Through ${formatInTimeZone(pickupEndsAt, timeZone, PICKUP_WINDOW_FMT)}`;
  }
  return `From ${formatInTimeZone(pickupStartsAt!, timeZone, PICKUP_WINDOW_FMT)}`;
}

/** Short suffix for push/SMS, e.g. "Sat–Sun only." */
export function summarizePickupHoursForShortLine(hoursLines: string[]): string {
  if (hoursLines.length === 0) return 'See app for hours';
  const dayLabels = hoursLines.map((l) => l.slice(0, 3));
  const timeParts = hoursLines.map((l) => l.slice(4).trim());
  const sameTimes = timeParts.every((t) => t === timeParts[0]);
  if (
    hoursLines.length === 2 &&
    sameTimes &&
    dayLabels.includes('Sat') &&
    dayLabels.includes('Sun')
  ) {
    return 'Sat–Sun only';
  }
  if (hoursLines.length === 1) {
    const line = hoursLines[0]!;
    return line.length > 28 ? `${line.slice(0, 27)}…` : line;
  }
  const joined = dayLabels.join('–');
  return joined.length > 24 ? `${joined.slice(0, 23)}…` : joined;
}

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + '…';
}

function buildShortPickupLine(fullAddress: string | null, hoursLines: string[]): string {
  const addr = fullAddress?.trim() || 'off-site location';
  const suffix = summarizePickupHoursForShortLine(hoursLines);
  const prefix = 'Pickup at ';
  const middle = ' — ';
  const end = '.';
  const fixedLen = prefix.length + middle.length + suffix.length + end.length;
  const addrBudget = Math.max(12, PUSH_SMS_MAX - fixedLen);
  const addrPart = addr.length > addrBudget ? truncateLine(addr, addrBudget) : addr;
  return truncateLine(`${prefix}${addrPart}${middle}${suffix}${end}`, PUSH_SMS_MAX);
}

export function buildOffsiteNotificationCopy(
  pickup: WarehousePickupDescribed,
  pickupStartsAt: string | null | undefined,
  pickupEndsAt: string | null | undefined,
  timeZone: string,
): OffsiteNotificationCopy | null {
  if (!pickup.isOffsite) return null;

  const parts: string[] = [];
  if (pickup.notice) {
    parts.push(`<strong>${escapeHtml(pickup.notice)}</strong>`);
  }
  if (pickup.fullAddress) {
    parts.push(escapeHtml(pickup.fullAddress));
  }
  if (pickup.directionsUrl) {
    parts.push(
      `<a href="${escapeHtml(pickup.directionsUrl)}" style="color:#16a34a;font-weight:700">Get directions</a>`,
    );
  }
  const window = formatPickupWindow(pickupStartsAt, pickupEndsAt, timeZone);
  if (window) {
    parts.push(`<strong>Pickup window:</strong> ${escapeHtml(window)}`);
  }
  for (const h of pickup.hoursLines) {
    parts.push(escapeHtml(h));
  }
  if (pickup.instructions) {
    parts.push(escapeHtml(pickup.instructions));
  }

  const emailHtml = parts.join('<br>');
  const pushLine = buildShortPickupLine(pickup.fullAddress, pickup.hoursLines);
  const smsLine = pushLine;

  return { emailHtml, pushLine, smsLine };
}

/** Append off-site email block after the standard transactional body. */
export function appendOffsiteEmailBlock(bodyHtml: string, offsite: OffsiteNotificationCopy | null | undefined): string {
  if (!offsite?.emailHtml) return bodyHtml;
  return `${bodyHtml}<br><br>${offsite.emailHtml}`;
}
