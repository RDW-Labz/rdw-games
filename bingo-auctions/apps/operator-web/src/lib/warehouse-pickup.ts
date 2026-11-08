/**
 * Off-site warehouse pickup copy for public lot/auction pages.
 * When customer_notice is empty, callers must not render any warehouse-specific UI.
 */

export type WarehousePickupSource = {
  name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  timezone?: string | null;
  pickup_hours?: Record<string, Array<{ open: string; close: string }>> | null;
  pickup_instructions?: string | null;
  customer_notice?: string | null;
  active?: boolean | null;
};

export type WarehousePickupDescribed = {
  isOffsite: boolean;
  name: string | null;
  addressLines: string[];
  fullAddress: string | null;
  directionsUrl: string | null;
  hoursLines: string[];
  instructions: string | null;
  notice: string | null;
};

const HOURS_DAYS: Array<[string, string]> = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
];

/** Compact "Mon 10:00–18:00" lines from warehouse pickup_hours JSONB. */
export function hoursLines(
  pickupHours: Record<string, Array<{ open: string; close: string }>> | null | undefined,
): string[] {
  if (!pickupHours) return [];
  const lines: string[] = [];
  for (const [key, label] of HOURS_DAYS) {
    const windows = pickupHours[key];
    if (!Array.isArray(windows) || windows.length === 0) continue;
    const spans = windows
      .filter((w) => w && typeof w.open === 'string' && typeof w.close === 'string')
      .map((w) => `${w.open}–${w.close}`)
      .join(', ');
    if (spans) lines.push(`${label} ${spans}`);
  }
  return lines;
}

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function describeWarehousePickup(
  w: WarehousePickupSource | null | undefined,
): WarehousePickupDescribed {
  const empty: WarehousePickupDescribed = {
    isOffsite: false,
    name: null,
    addressLines: [],
    fullAddress: null,
    directionsUrl: null,
    hoursLines: [],
    instructions: null,
    notice: null,
  };
  if (!w) return empty;

  const notice = trimOrNull(w.customer_notice ?? null);
  const isOffsite = notice !== null;

  const line1 = trimOrNull(w.address_line1 ?? null);
  const line2 = trimOrNull(w.address_line2 ?? null);
  const city = trimOrNull(w.city ?? null);
  const state = trimOrNull(w.state ?? null);
  const postal = trimOrNull(w.postal_code ?? null);

  const cityStateZip =
    city && state && postal
      ? `${city}, ${state} ${postal}`
      : city && state
        ? `${city}, ${state}`
        : city ?? state ?? postal;

  const addressLines: string[] = [];
  if (line1) addressLines.push(line1);
  if (line2) addressLines.push(line2);
  if (cityStateZip) addressLines.push(cityStateZip);

  const fullAddressParts = [line1, line2, city, state, postal].filter(Boolean) as string[];
  const fullAddress = fullAddressParts.length > 0 ? fullAddressParts.join(', ') : null;

  const directionsUrl = fullAddress
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress)}`
    : null;

  const hours = hoursLines(w.pickup_hours ?? null);
  const instructions = trimOrNull(w.pickup_instructions ?? null);
  const name = trimOrNull(w.name ?? null);

  return {
    isOffsite,
    name,
    addressLines,
    fullAddress,
    directionsUrl,
    hoursLines: hours,
    instructions,
    notice,
  };
}
