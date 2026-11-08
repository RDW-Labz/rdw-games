import type { PickupsV2Props } from '../pickup-types';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function counterRow(index: number, stale: boolean): PickupsV2Props['counter'][number] {
  const pickupId = id(1000 + index);
  return {
    id: pickupId,
    status: 'checked_in',
    scheduledAt: stale ? '2026-10-10T14:00:00Z' : null,
    checkedInAt: stale ? '2026-10-11T08:00:00Z' : '2026-10-13T15:00:00Z',
    completedAt: null,
    invoiceId: id(2000 + index),
    warehouseName: 'Sample warehouse',
    warehouseTimezone: 'America/Chicago',
    invoiceStatus: index % 7 === 0 ? 'partially_refunded' : 'paid',
    customerLabel: `Sample Customer ${String.fromCharCode(65 + (index % 26))}${index}`,
  };
}

function owedFor(index: number) {
  const code = `BRN4982${String(300 + index).padStart(3, '0')}`;
  return {
    code,
    secondary: `BIN-03${String(1100 + index).padStart(4, '0')}`,
    noSticker: false,
  };
}

export const pickupsV2Fixture: PickupsV2Props = {
  warehouses: [{ id: 'wh-sample', name: 'Sample warehouse' }],
  activeWarehouseId: null,
  sessionsEnabled: true,
  missing: [
    {
      outcomeId: id(9001),
      lotCode: 'BRN4982310',
      title: 'Sample desk organizer',
      invoiceId: id(9002),
      bidderLabel: 'Sample Customer H',
      markedAt: '2026-10-12T20:40:00Z',
      warehouseId: 'wh-sample',
    },
    {
      outcomeId: id(9003),
      lotCode: 'BRN4982311',
      title: 'Sample floor lamp',
      invoiceId: id(9004),
      bidderLabel: 'Sample Customer I',
      markedAt: '2026-10-12T21:10:00Z',
      warehouseId: 'wh-sample',
    },
  ],
  counter: Array.from({ length: 24 }, (_, i) => counterRow(i, i < 3)),
  today: Array.from({ length: 18 }, (_, i) => ({
    id: id(3000 + i),
    status: i % 2 === 0 ? 'scheduled' : 'pending',
    scheduledAt: '2026-10-13T16:00:00Z',
    checkedInAt: null,
    completedAt: null,
    invoiceId: id(4000 + i),
    warehouseName: 'Sample warehouse',
    warehouseTimezone: 'America/Chicago',
    invoiceStatus: 'paid',
    customerLabel: `Sample Today ${i + 1}`,
  })),
  waiting: Array.from({ length: 40 }, (_, i) => ({
    id: id(5000 + i),
    status: 'pending',
    scheduledAt: null,
    checkedInAt: null,
    completedAt: null,
    invoiceId: id(6000 + i),
    warehouseName: 'Sample warehouse',
    warehouseTimezone: 'America/Chicago',
    invoiceStatus: i === 0 ? 'pending' : 'paid',
    customerLabel: i === 0 ? 'Sample Unpaid Waiting' : `Sample Waiting ${i + 1}`,
  })),
  recentlyDone: Array.from({ length: 10 }, (_, i) => ({
    id: id(7000 + i),
    status: i % 3 === 0 ? 'no_show' : i % 3 === 1 ? 'forfeited' : 'completed',
    scheduledAt: null,
    checkedInAt: null,
    completedAt: '2026-10-12T21:00:00Z',
    invoiceId: id(8000 + i),
    warehouseName: 'Sample warehouse',
    warehouseTimezone: 'America/Chicago',
    invoiceStatus: 'paid',
    customerLabel: `Sample Done ${i + 1}`,
  })),
  counterDetails: Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => {
      const pickupId = id(1000 + i);
      return [
        pickupId,
        {
          customerLabel: `Sample Customer ${String.fromCharCode(65 + (i % 26))}${i}`,
          owed: [owedFor(i), owedFor(i + 100)],
        },
      ];
    }),
  ),
};

export const pickupsV2FixtureNoMissing: PickupsV2Props = {
  ...pickupsV2Fixture,
  missing: [],
};
